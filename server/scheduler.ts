// Proactive agent scheduler - cron-like check-ins
// Each check-in fires a socket event to the UI so the user sees "Lumi checked in"

import crypto from 'node:crypto';
import { Server as SocketIOServer } from 'socket.io';
import { queryMemories, getDueReminders, fireReminder, runBehavioralAnalysis, decayMemories, dynamicDecayMemories, promoteMemories, getUnconsolidatedEpisodic, autoMarkCrossAgentShare } from './memory';
import { consolidateEpisodic, consolidateNarrative, ConsolidationContext } from './memory/consolidator';
import { runDreamCycle } from './memory/dream';
import { buildTree, ensureBranch, moveNode } from './memory/tree';
import { makeLLMCall } from './llm/providers';
import { getWeatherBrief, getTimeGreeting } from './services/weather';
import { autoGenerateWorkflows } from './agents/workflows';
import { runHealthAudit, HealthReport } from './agents/health_audit';
import { flushDBOrThrow, readDB, writeDB } from '../db_layer';
import { AgentRuntime, AgentRecord } from './agents/runtime';
import { personalityRegistry } from './personality';
import { evolvePersonality, generateReviewPrompt } from './personality/evolution';
import { loadEmotionalState } from './personality/state';
import { getSameMonthDayPast, getMonthDayFromISO } from './time/utils';
import { detectSpatiotemporalPatterns } from './time/spatiotemporal';
import { cleanupEphemeralAgents } from './agents/orchestrator';
import { getRecentActivity } from './context/activity_stream';
import {
  isFirstBootComplete,
  isSystemExplorationAllowed,
  persistDailyExploration,
} from './autonomy/system_explorer';
import {
  collectSystemSnapshotInWorker,
  resolveSystemExplorationRuntimeDir,
  SystemExplorationAlreadyRunningError,
} from './runtime/system_exploration_worker';
import { getGateConfig, isAutonomousWorkAllowed } from './autonomy/safety_gate';
import { createRealtimeVoicePrioritySignal } from './autonomy/foreground_activity';
import { parseStoredOperationMode } from './cognition/operation_modes';
import { getUserPreferredLLMConfig } from './llm/user_preferences';
import { refreshAuthoritativeStatuteSources } from './legal/statute_authority_refresh';
import { finalizeLumiResponse } from './cognition/result_finalizer';
import {
  authorizeCapabilityPlanTool,
  buildScheduledCapabilityExecutionPlan,
  type CapabilityExecutionPlan,
} from './cognition/capability_execution_plan';
import {
  getScheduledCapabilityExecutionStatus,
  persistScheduledCapabilityExecution,
} from './conversation/action_ledger';
import type {
  CapabilityLane,
  CapabilityOperation,
  CapabilitySideEffect,
  ToolExecutionRecord,
} from './tools/types';
import { dispatchDueCommandCenterPlans } from './command_center/plans';
import { redactDiagnosticSecrets } from './client/diagnostic_sanitizer';

export interface ScheduledDelivery {
  userId: string;
  message: string;
  domain?: 'personal' | 'work';
  orgId?: string;
  /** Model-authored user-visible text must pass the shared output finalizer. */
  modelGenerated?: boolean;
}

type ScheduledTaskResult = string | ScheduledDelivery[] | null;

export interface ScheduledDeliveryFinalization {
  delivery: ScheduledDelivery | null;
  finalized: boolean;
  blocked: boolean;
  reason: string;
}

export function finalizeScheduledDelivery(
  taskId: string,
  delivery: ScheduledDelivery,
): ScheduledDeliveryFinalization {
  if (!delivery.modelGenerated) {
    return {
      delivery,
      finalized: false,
      blocked: false,
      reason: '',
    };
  }

  const finalized = finalizeLumiResponse({
    taskText: `Scheduled proactive message (${taskId}): ${delivery.message}`,
    responseText: delivery.message,
    toolRecords: [],
    source: `scheduler_${taskId}`,
  });
  if (finalized.blocked) {
    return {
      delivery: null,
      finalized: true,
      blocked: true,
      reason: finalized.reason || 'Scheduled model output failed final verification.',
    };
  }
  return {
    delivery: {
      ...delivery,
      message: finalized.text,
    },
    finalized: true,
    blocked: false,
    reason: finalized.reason || '',
  };
}

export type ScheduledExecutionClass =
  | 'maintenance'
  | 'proactive_delivery'
  | 'client_probe'
  | 'autonomous_orchestration';

export type ScheduledTaskRunStatus =
  | 'idle'
  | 'executing'
  | 'cancelling'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'unknown';

export interface ScheduledTaskExecutionContract {
  timeoutMs: number;
  outcome: 'durable_terminal_receipt' | 'coalesced_probe_receipt';
  successCriteria: string[];
  evidence: string[];
  stopping: string[];
  retry: {
    maxRetriesPerSlot: 0;
    onUnknownOutcome: 'reconcile_then_stop';
  };
  concurrency: {
    maxConcurrentRuns: 1;
    policy: 'skip_while_running';
  };
  finalAcceptance:
    | 'scheduler_persisted_verified_terminal_receipt'
    | 'scheduler_coalesced_verified_probe_receipt';
}

export interface ScheduledTaskExecutionContext {
  signal: AbortSignal;
  taskId: string;
  executionId: string;
  startedAt: string;
  deadline: string;
  contract: ScheduledTaskExecutionContract;
}

export interface ScheduledTask {
  id: string;
  cron: string;
  lastRun: string | null;
  /** Explicit semantic boundary compiled before the handler may run. */
  executionClass: ScheduledExecutionClass;
  handler: (context?: ScheduledTaskExecutionContext) => Promise<ScheduledTaskResult>;
  /** Per-task wall-clock bound. Defaults are selected from executionClass. */
  timeoutMs?: number;
  /** If true, result is stored internally but NOT broadcast as a proactive notification */
  quiet?: boolean;
  /** If false, task is paused and will not fire */
  enabled?: boolean;
  /** Client probes that may return user-visible deliveries must opt in before admission. */
  deliveryPolicy?: 'none' | 'scoped';
  /**
   * Collapse successful runs into a bounded audit summary. Compact is the
   * safe default; use full only when every successful slot is itself a
   * business record. Failures and unknown outcomes are always preserved.
   */
  auditMode?: 'full' | 'compact';
  lastStatus?: ScheduledTaskRunStatus;
  lastError?: string | null;
  lastDurationMs?: number | null;
  lastStartedAt?: string | null;
  nextRun?: string | null;
  persistenceStatus?: 'ok' | 'coalesced' | 'failed';
  lastPersistenceError?: string | null;
  /** Durable unknown-outcome fence. Cleared only by explicit reconciliation. */
  requiresReconciliation?: boolean;
  quarantinedExecutionId?: string | null;
  quarantineReason?: string | null;
  reconciledAt?: string | null;
  reconciliationResolution?: 'confirmed_no_side_effect' | 'accepted_unknown_outcome' | null;
}

const SCHEDULER_RUNTIME_STATE_SETTING = 'scheduler_task_runtime_state_v1';

const DEFAULT_TASK_TIMEOUT_MS: Record<ScheduledExecutionClass, number> = {
  client_probe: 30_000,
  proactive_delivery: 2 * 60_000,
  maintenance: 5 * 60_000,
  autonomous_orchestration: 15 * 60_000,
};

const TASK_TIMEOUT_ENV: Record<ScheduledExecutionClass, string> = {
  client_probe: 'LUMI_SCHEDULER_CLIENT_PROBE_TIMEOUT_MS',
  proactive_delivery: 'LUMI_SCHEDULER_PROACTIVE_DELIVERY_TIMEOUT_MS',
  maintenance: 'LUMI_SCHEDULER_MAINTENANCE_TIMEOUT_MS',
  autonomous_orchestration: 'LUMI_SCHEDULER_AUTONOMOUS_ORCHESTRATION_TIMEOUT_MS',
};

function normalizedTimeout(value: unknown): number | null {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout >= 10 && timeout <= 60 * 60_000
    ? Math.round(timeout)
    : null;
}

/** Keep scheduler state and logs diagnostic without retaining credentials. */
export function redactSchedulerDiagnostic(value: unknown): string {
  return redactDiagnosticSecrets(value instanceof Error ? value.message : value)
    .replace(/\[redacted(?: private key)?\]/giu, '[REDACTED]')
    .slice(0, 2_000);
}

/** High-frequency client probes use the DB layer's coalesced flush budget. */
export function requiresStrictScheduledPersistence(
  executionClass: ScheduledExecutionClass,
  hasUserDelivery = false,
): boolean {
  return hasUserDelivery || executionClass !== 'client_probe';
}

/** Resolve a bounded wall-clock timeout with task override > class env > safe class default. */
export function getScheduledTaskTimeoutMs(
  executionClass: ScheduledExecutionClass,
  override?: number,
): number {
  return normalizedTimeout(override)
    ?? normalizedTimeout(process.env[TASK_TIMEOUT_ENV[executionClass]])
    ?? DEFAULT_TASK_TIMEOUT_MS[executionClass];
}

export function getScheduledTaskExecutionContract(
  task: Pick<ScheduledTask, 'executionClass' | 'timeoutMs' | 'deliveryPolicy'>,
  hasUserDelivery = false,
): ScheduledTaskExecutionContract {
  const strictPersistence = requiresStrictScheduledPersistence(
    task.executionClass,
    hasUserDelivery || task.deliveryPolicy === 'scoped',
  );
  return {
    timeoutMs: getScheduledTaskTimeoutMs(task.executionClass, task.timeoutMs),
    outcome: strictPersistence ? 'durable_terminal_receipt' : 'coalesced_probe_receipt',
    successCriteria: [
      'handler_settled_before_deadline',
      'declared_deliveries_persisted_before_emission',
      strictPersistence
        ? 'verified_terminal_receipt_persisted'
        : 'verified_probe_receipt_accepted_for_coalesced_persistence',
    ],
    evidence: [
      'capability_execution_plan',
      'scheduler_task_handler_terminal_receipt',
      'scoped_delivery_receipt_when_applicable',
    ],
    stopping: [
      'success_criteria_met',
      'wall_clock_timeout',
      'abort_signal',
      'capability_policy_block',
      'previous_slot_outcome_unknown',
    ],
    retry: {
      maxRetriesPerSlot: 0,
      onUnknownOutcome: 'reconcile_then_stop',
    },
    concurrency: {
      maxConcurrentRuns: 1,
      policy: 'skip_while_running',
    },
    finalAcceptance: strictPersistence
      ? 'scheduler_persisted_verified_terminal_receipt'
      : 'scheduler_coalesced_verified_probe_receipt',
  };
}

export type ParsedSchedule =
  | { type: 'interval'; intervalMs: number }
  | { type: 'cron'; fields: number[] };

const SCHEDULE_ALIASES: Record<string, ParsedSchedule> = {
  every_10s: { type: 'interval', intervalMs: 10 * 1000 },
  every_1m: { type: 'interval', intervalMs: 60 * 1000 },
  every_5m: { type: 'interval', intervalMs: 5 * 60 * 1000 },
  every_10m: { type: 'interval', intervalMs: 10 * 60 * 1000 },
  every_30m: { type: 'interval', intervalMs: 30 * 60 * 1000 },
  every_hour: { type: 'interval', intervalMs: 60 * 60 * 1000 },
  every_1h: { type: 'interval', intervalMs: 60 * 60 * 1000 },
  every_6h: { type: 'interval', intervalMs: 6 * 60 * 60 * 1000 },
  every_24h: { type: 'interval', intervalMs: 24 * 60 * 60 * 1000 },
  every_7d: { type: 'interval', intervalMs: 7 * 24 * 60 * 60 * 1000 },
  daily_9am: { type: 'cron', fields: [0, 9, -1, -1, -1] },
  evening_8pm: { type: 'cron', fields: [0, 20, -1, -1, -1] },
};

const SCHEDULED_EXECUTION_POLICIES: Record<ScheduledExecutionClass, {
  lane: CapabilityLane;
  operation: CapabilityOperation;
  sideEffectClass: 'local_write';
  sideEffects: CapabilitySideEffect[];
}> = {
  maintenance: {
    lane: 'system',
    operation: 'mutate',
    sideEffectClass: 'local_write',
    sideEffects: [{ type: 'local_write', scope: 'declared scheduler maintenance state', reversible: true }],
  },
  proactive_delivery: {
    lane: 'system',
    operation: 'communicate',
    sideEffectClass: 'local_write',
    sideEffects: [
      { type: 'local_write', scope: 'scoped proactive interaction ledger', reversible: true },
      { type: 'local_state_change', scope: 'local Lumi notification queue', reversible: true },
    ],
  },
  client_probe: {
    lane: 'client',
    operation: 'communicate',
    sideEffectClass: 'local_write',
    sideEffects: [{ type: 'local_state_change', scope: 'connected Lumi client session', reversible: true }],
  },
  autonomous_orchestration: {
    lane: 'agents',
    operation: 'mutate',
    sideEffectClass: 'local_write',
    sideEffects: [{ type: 'local_write', scope: 'autonomous local task queue and receipts', reversible: true }],
  },
};

/** Parse supported fixed aliases or simple five-field cron expressions. */
export function parseSchedule(cron: string): ParsedSchedule {
  const normalized = String(cron || '').trim();
  const alias = SCHEDULE_ALIASES[normalized];
  if (alias) {
    return alias.type === 'interval'
      ? { ...alias }
      : { ...alias, fields: [...alias.fields] };
  }

  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Unsupported schedule expression: "${normalized}"`);
  }

  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  const fields = parts.map((part, index) => {
    if (part === '*') return -1;
    if (!/^\d+$/.test(part)) {
      throw new Error(`Unsupported cron field "${part}" in "${normalized}"`);
    }
    const value = Number(part);
    const [min, max] = ranges[index];
    if (value < min || value > max) {
      throw new Error(`Cron field "${part}" is out of range in "${normalized}"`);
    }
    return value;
  });
  return { type: 'cron', fields };
}

/** Stable within one cron/interval slot, so restarts cannot replay that slot. */
export function buildScheduledExecutionId(
  taskId: string,
  cron: string,
  at: Date = new Date(),
): string {
  const parsed = parseSchedule(cron);
  const slot = parsed.type === 'interval'
    ? Math.floor(at.getTime() / parsed.intervalMs)
    : at.toISOString().slice(0, 16);
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify({ taskId, cron, slot }))
    .digest('hex')
    .slice(0, 24);
  return `scheduler_${digest}`;
}

export function buildScheduledTaskExecutionPlan(
  task: Pick<ScheduledTask, 'id' | 'cron' | 'executionClass'>,
  at: Date = new Date(),
): CapabilityExecutionPlan {
  const policy = SCHEDULED_EXECUTION_POLICIES[task.executionClass];
  if (!policy) throw new Error(`Scheduler task '${task.id}' has no declared execution policy.`);
  return buildScheduledCapabilityExecutionPlan({
    taskId: buildScheduledExecutionId(task.id, task.cron, at),
    scheduledTaskId: task.id,
    lane: policy.lane,
    operation: policy.operation,
    sideEffectClass: policy.sideEffectClass,
    sideEffects: policy.sideEffects,
  });
}

export function buildScheduledProactiveInteractionId(
  executionId: string,
  deliveryIndex: number,
  delivery: Pick<ScheduledDelivery, 'userId' | 'domain' | 'orgId'>,
): string {
  return `proactive_${crypto.createHash('sha256')
    .update(JSON.stringify({
      executionId,
      deliveryIndex,
      userId: delivery.userId,
      domain: delivery.domain,
      orgId: delivery.orgId,
    }))
    .digest('hex')
    .slice(0, 24)}`;
}

/**
 * Scheduler work is user-scoped and must never treat arbitrary actor IDs from
 * memories/interactions (agent IDs, MCP actors, "unknown", and similar
 * provenance labels) as Lumi users. Registered users are the authoritative
 * identity source. The anonymous fallback is retained only for pre-account
 * local installations that have not created a user record yet.
 */
export function resolveScheduledUserIds(db: any): string[] {
  const registered = new Set<string>();
  for (const user of Array.isArray(db?.users) ? db.users : []) {
    const uid = String(user?.uid || '').trim();
    if (uid) registered.add(uid);
  }
  return registered.size > 0 ? [...registered] : ['anonymous'];
}

/**
 * Runs one background reflection behind both the autonomy gate and a live
 * voice interruption signal. The second gate check closes the race between a
 * scheduler tick being admitted and the model request actually starting.
 */
export async function runAgentAutonomousAnalysis(
  userId: string,
  analyze: (signal: AbortSignal) => Promise<string>,
): Promise<string> {
  if (!isAutonomousWorkAllowed(userId).allowed) return '';
  const voicePriority = createRealtimeVoicePrioritySignal(userId);
  try {
    if (voicePriority.signal.aborted || !isAutonomousWorkAllowed(userId).allowed) return '';
    try {
      return await analyze(voicePriority.signal);
    } catch (error) {
      if (voicePriority.signal.aborted) return '';
      throw error;
    }
  } finally {
    voicePriority.dispose();
  }
}

type LLMGetters = {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI?: () => any;
  getAnthropic?: () => any;
  getQwen?: () => any;
  getOllama?: () => any;
  getLmStudio?: () => any;
  getArk?: () => any;
  getXiaomi?: () => any;
  getKimi?: () => any;
  getGlm?: () => any;
  getRelay?: () => any;
};

class ScheduledTaskExecutionError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'scheduler_handler_timed_out'
      | 'scheduler_execution_timed_out'
      | 'scheduler_handler_aborted'
      | 'scheduler_delivery_withheld'
      | 'scheduler_delivery_invalid',
  ) {
    super(message);
    this.name = 'ScheduledTaskExecutionError';
  }
}

interface ScheduledInFlightHandler {
  controller: AbortController;
  task: ScheduledTask;
  plan: CapabilityExecutionPlan | null;
  contract: ScheduledTaskExecutionContract;
  startedAt: Date;
  deadline: Date;
  deadlineTimer: NodeJS.Timeout;
  phase: 'planning' | 'admission_persistence' | 'handler' | 'delivery' | 'terminal_persistence';
  handlerStarted: boolean;
  handlerSettled: boolean;
  handlerOutcome?: 'fulfilled' | 'rejected';
  schedulerFinished: boolean;
  pendingLateSettlement: boolean;
  lateSettlementFinalizing: boolean;
  pendingDurableOperations: Set<Promise<unknown>>;
  durableOperationRejected: boolean;
  lateSettlementPendingHandler: boolean;
  lateSettlementPendingDurability: boolean;
  compactAudit: boolean;
}

export class Scheduler {
  private tasks: ScheduledTask[] = [];
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private runningTasks: Set<string> = new Set();
  private runningControllers: Map<string, AbortController> = new Map();
  private inFlightHandlers: Map<string, ScheduledInFlightHandler> = new Map();
  /**
   * A lifecycle generation stops every closure. A per-task generation also
   * invalidates an already-running cron closure when the same task is
   * re-registered, disabled and enabled, or quarantined pending settlement.
   */
  private scheduleGenerations: Map<string, number> = new Map();
  private lifecycleGeneration = 0;
  io: SocketIOServer | null = null;
  private llmGetters: LLMGetters | null = null;
  private disabledTasks: Set<string> = new Set();

  constructor(
    private readonly strictFlush: () => Promise<void> = flushDBOrThrow,
    private readonly writeDatabase: (data: any) => void = writeDB,
  ) {}

  setIO(io: SocketIOServer) {
    this.io = io;
  }

  setLLMGetters(getters: LLMGetters) {
    this.llmGetters = getters;
  }

  register(task: ScheduledTask) {
    this.hydrateRuntimeState(task);
    // Restore enable/disable state from persistence
    const storedDisabled = this.loadDisabledState();
    if (storedDisabled.has(task.id)) {
      task.enabled = false;
      this.disabledTasks.add(task.id);
    }
    const existingIndex = this.tasks.findIndex(existing => existing.id === task.id);
    if (existingIndex >= 0) {
      const replacedTask = this.tasks[existingIndex];
      this.clearTimer(task.id);
      this.abortRunningTask(task.id, 'Scheduled task registration was replaced.');
      if (replacedTask !== task) {
        replacedTask.enabled = false;
        task.lastRun = replacedTask.lastRun;
        task.lastStatus = replacedTask.lastStatus;
        task.lastError = replacedTask.lastError;
        task.lastDurationMs = replacedTask.lastDurationMs;
        task.lastStartedAt = replacedTask.lastStartedAt;
        task.persistenceStatus = replacedTask.persistenceStatus;
        task.lastPersistenceError = replacedTask.lastPersistenceError;
      }
      this.tasks[existingIndex] = task;
    } else {
      this.tasks.push(task);
    }
    this.scheduleTask(task);
  }

  /** Load disabled task IDs from DB */
  private loadDisabledState(): Set<string> {
    try {
      const db = readDB();
      const setting = (db.settings || []).find((s: any) => s.key === 'scheduler_disabled_tasks');
      if (setting?.value) {
        return new Set(JSON.parse(setting.value));
      }
    } catch (error: any) {
      console.error('[Scheduler] Failed to load disabled task state:', redactSchedulerDiagnostic(error));
    }
    return new Set();
  }

  /** Persist disabled task IDs to DB */
  private persistDisabledState() {
    try {
      const db = readDB();
      let setting = (db.settings || []).find((s: any) => s.key === 'scheduler_disabled_tasks');
      const value = JSON.stringify([...this.disabledTasks]);
      if (setting) {
        setting.value = value;
      } else {
        if (!db.settings) db.settings = [];
        db.settings.push({ key: 'scheduler_disabled_tasks', value });
      }
      this.writeDatabase(db);
    } catch (error: any) {
      console.error('[Scheduler] Failed to persist disabled task state:', redactSchedulerDiagnostic(error));
    }
  }

  private hydrateRuntimeState(task: ScheduledTask) {
    task.lastStatus = task.lastStatus || (task.lastRun ? 'completed' : 'idle');
    task.lastError = task.lastError ? redactSchedulerDiagnostic(task.lastError) : null;
    task.lastDurationMs = task.lastDurationMs ?? null;
    task.lastStartedAt = task.lastStartedAt ?? null;
    task.nextRun = task.nextRun ?? null;
    task.persistenceStatus = task.persistenceStatus || 'ok';
    task.lastPersistenceError = task.lastPersistenceError
      ? redactSchedulerDiagnostic(task.lastPersistenceError)
      : null;
    task.requiresReconciliation = task.requiresReconciliation === true;
    task.quarantinedExecutionId = task.quarantinedExecutionId || null;
    task.quarantineReason = task.quarantineReason
      ? redactSchedulerDiagnostic(task.quarantineReason)
      : null;
    task.reconciledAt = task.reconciledAt || null;
    task.reconciliationResolution = task.reconciliationResolution || null;
    try {
      const db = readDB();
      const setting = (db.settings || []).find((candidate: any) => (
        candidate.key === SCHEDULER_RUNTIME_STATE_SETTING
      ));
      if (!setting?.value) return;
      const stored = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
      const snapshot = stored && typeof stored === 'object' ? stored[task.id] : null;
      if (!snapshot || typeof snapshot !== 'object') return;
      if (typeof snapshot.lastRun === 'string' || snapshot.lastRun === null) task.lastRun = snapshot.lastRun;
      if (typeof snapshot.lastStatus === 'string') task.lastStatus = snapshot.lastStatus;
      if (typeof snapshot.lastError === 'string' || snapshot.lastError === null) {
        task.lastError = snapshot.lastError ? redactSchedulerDiagnostic(snapshot.lastError) : null;
      }
      if (Number.isFinite(snapshot.lastDurationMs) || snapshot.lastDurationMs === null) {
        task.lastDurationMs = snapshot.lastDurationMs;
      }
      if (typeof snapshot.lastStartedAt === 'string' || snapshot.lastStartedAt === null) {
        task.lastStartedAt = snapshot.lastStartedAt;
      }
      if (typeof snapshot.nextRun === 'string' || snapshot.nextRun === null) task.nextRun = snapshot.nextRun;
      if (['ok', 'coalesced', 'failed'].includes(snapshot.persistenceStatus)) {
        task.persistenceStatus = snapshot.persistenceStatus;
      }
      if (typeof snapshot.lastPersistenceError === 'string' || snapshot.lastPersistenceError === null) {
        task.lastPersistenceError = snapshot.lastPersistenceError
          ? redactSchedulerDiagnostic(snapshot.lastPersistenceError)
          : null;
      }
      task.requiresReconciliation = snapshot.requiresReconciliation === true;
      task.quarantinedExecutionId = typeof snapshot.quarantinedExecutionId === 'string'
        ? snapshot.quarantinedExecutionId
        : null;
      task.quarantineReason = typeof snapshot.quarantineReason === 'string'
        ? redactSchedulerDiagnostic(snapshot.quarantineReason)
        : null;
      task.reconciledAt = typeof snapshot.reconciledAt === 'string' ? snapshot.reconciledAt : null;
      task.reconciliationResolution = [
        'confirmed_no_side_effect',
        'accepted_unknown_outcome',
      ].includes(snapshot.reconciliationResolution)
        ? snapshot.reconciliationResolution
        : null;
      if (snapshot.lastStatus === 'executing' || snapshot.lastStatus === 'cancelling') {
        task.lastStatus = 'unknown';
        task.lastError = 'The previous scheduler process stopped before handler settlement and a terminal receipt; side-effect outcome remains unknown.';
        task.requiresReconciliation = true;
        task.quarantineReason = task.lastError;
      }
    } catch (error: any) {
      task.persistenceStatus = 'failed';
      task.lastPersistenceError = redactSchedulerDiagnostic(error);
      console.error(`[Scheduler] Failed to restore runtime state for "${redactSchedulerDiagnostic(task.id)}":`, task.lastPersistenceError);
    }
  }

  private stageRuntimeState(db: any, task: ScheduledTask) {
    if (!db.settings) db.settings = [];
    let setting = db.settings.find((candidate: any) => candidate.key === SCHEDULER_RUNTIME_STATE_SETTING);
    let stored: Record<string, any> = {};
    if (setting?.value) {
      try {
        const parsed = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed;
      } catch (error: any) {
        console.error('[Scheduler] Invalid persisted runtime state was replaced:', redactSchedulerDiagnostic(error));
      }
    }
    stored[task.id] = {
      lastRun: task.lastRun ?? null,
      lastStatus: task.lastStatus || 'idle',
      lastError: task.lastError ? redactSchedulerDiagnostic(task.lastError) : null,
      lastDurationMs: task.lastDurationMs ?? null,
      lastStartedAt: task.lastStartedAt ?? null,
      nextRun: task.nextRun ?? null,
      persistenceStatus: task.persistenceStatus || 'ok',
      lastPersistenceError: task.lastPersistenceError
        ? redactSchedulerDiagnostic(task.lastPersistenceError)
        : null,
      requiresReconciliation: task.requiresReconciliation === true,
      quarantinedExecutionId: task.quarantinedExecutionId || null,
      quarantineReason: task.quarantineReason
        ? redactSchedulerDiagnostic(task.quarantineReason)
        : null,
      reconciledAt: task.reconciledAt || null,
      reconciliationResolution: task.reconciliationResolution || null,
    };
    const value = JSON.stringify(stored);
    if (setting) setting.value = value;
    else db.settings.push({ key: SCHEDULER_RUNTIME_STATE_SETTING, value });
  }

  private async persistDbWithRuntimeState(
    db: any,
    task: ScheduledTask,
    hasUserDelivery = false,
    execution?: ScheduledInFlightHandler,
  ) {
    const strict = requiresStrictScheduledPersistence(
      task.executionClass,
      hasUserDelivery || task.deliveryPolicy === 'scoped',
    );
    task.persistenceStatus = strict ? 'ok' : 'coalesced';
    task.lastPersistenceError = null;
    if (task.lastError) task.lastError = redactSchedulerDiagnostic(task.lastError);
    this.stageRuntimeState(db, task);
    try {
      this.writeDatabase(db);
      if (strict) {
        const flush = execution
          ? this.trackDurableOperation(this.strictFlush(), execution)
          : this.strictFlush();
        await (execution
          ? this.awaitExecutionPhase(flush, execution, execution.phase)
          : flush);
      }
    } catch (error: any) {
      task.persistenceStatus = 'failed';
      task.lastPersistenceError = redactSchedulerDiagnostic(error);
      console.error(`[Scheduler] Failed to persist runtime state for "${redactSchedulerDiagnostic(task.id)}":`, task.lastPersistenceError);
      throw error;
    }
  }

  private persistRuntimeState(task: ScheduledTask) {
    const preservePersistenceFailure = task.persistenceStatus === 'failed';
    const priorPersistenceError = task.lastPersistenceError;
    try {
      if (!preservePersistenceFailure) {
        task.persistenceStatus = task.executionClass === 'client_probe' ? 'coalesced' : 'ok';
        task.lastPersistenceError = null;
      }
      if (task.lastError) task.lastError = redactSchedulerDiagnostic(task.lastError);
      const db = readDB();
      this.stageRuntimeState(db, task);
      this.writeDatabase(db);
      if (preservePersistenceFailure) {
        task.persistenceStatus = 'failed';
        task.lastPersistenceError = priorPersistenceError;
      }
    } catch (error: any) {
      task.persistenceStatus = 'failed';
      task.lastPersistenceError = redactSchedulerDiagnostic(error);
      console.error(`[Scheduler] Failed to persist runtime state for "${redactSchedulerDiagnostic(task.id)}":`, task.lastPersistenceError);
    }
  }

  private persistRecoveryDbWithRuntimeState(
    db: any,
    task: ScheduledTask,
    preservePersistenceFailure = false,
  ) {
    const priorPersistenceError = task.lastPersistenceError;
    if (!preservePersistenceFailure) {
      task.persistenceStatus = 'coalesced';
      task.lastPersistenceError = null;
    }
    if (task.lastError) task.lastError = redactSchedulerDiagnostic(task.lastError);
    this.stageRuntimeState(db, task);
    try {
      this.writeDatabase(db);
      if (preservePersistenceFailure) {
        task.persistenceStatus = 'failed';
        task.lastPersistenceError = priorPersistenceError;
      }
    } catch (error: any) {
      task.persistenceStatus = 'failed';
      task.lastPersistenceError = redactSchedulerDiagnostic(error);
      console.error(
        `[Scheduler] Failed to persist recovery state for "${redactSchedulerDiagnostic(task.id)}":`,
        task.lastPersistenceError,
      );
    }
  }

  private abortRunningTask(id: string, reason: string) {
    const controller = this.runningControllers.get(id);
    if (controller && !controller.signal.aborted) {
      const execution = this.inFlightHandlers.get(id);
      if (execution) {
        clearTimeout(execution.deadlineTimer);
        if (execution.handlerStarted) {
          const visibleTask = this.tasks.find(candidate => candidate.id === id) || execution.task;
          const handlerPending = !execution.handlerSettled;
          const durabilityPending = execution.pendingDurableOperations.size > 0;
          const message = handlerPending
            ? 'Cancellation was requested, but the handler is still settling; side-effect outcome remains unknown.'
            : durabilityPending
              ? 'Cancellation was requested, but durable persistence is still settling; side-effect outcome remains unknown.'
            : 'Cancellation was requested while execution finalization was still pending; side-effect outcome remains unknown.';
          for (const target of new Set([execution.task, visibleTask])) {
            target.lastStatus = handlerPending ? 'cancelling' : 'unknown';
            target.lastError = message;
          }
          try {
            this.persistRecoveryDbWithRuntimeState(
              readDB(),
              visibleTask,
              visibleTask.persistenceStatus === 'failed' || execution.task.persistenceStatus === 'failed',
            );
          } catch {
            // persistRecoveryDbWithRuntimeState already records and logs the failure.
          }
        }
      }
      controller.abort(new ScheduledTaskExecutionError(reason, 'scheduler_handler_aborted'));
    }
  }

  private beginExecution(
    task: ScheduledTask,
    startedAt: Date,
    contract: ScheduledTaskExecutionContract,
    compactAudit: boolean,
  ): ScheduledInFlightHandler {
    const controller = new AbortController();
    const deadline = new Date(startedAt.getTime() + contract.timeoutMs);
    let execution!: ScheduledInFlightHandler;
    const deadlineTimer = setTimeout(() => {
      if (controller.signal.aborted) return;
      controller.abort(new ScheduledTaskExecutionError(
        `Scheduled execution exceeded its ${contract.timeoutMs}ms end-to-end deadline during ${execution.phase}; the active operation may still be settling.`,
        'scheduler_execution_timed_out',
      ));
    }, contract.timeoutMs);
    execution = {
      controller,
      task,
      plan: null,
      contract,
      startedAt,
      deadline,
      deadlineTimer,
      phase: 'planning',
      handlerStarted: false,
      handlerSettled: true,
      handlerOutcome: undefined,
      schedulerFinished: false,
      pendingLateSettlement: false,
      lateSettlementFinalizing: false,
      pendingDurableOperations: new Set(),
      durableOperationRejected: false,
      lateSettlementPendingHandler: false,
      lateSettlementPendingDurability: false,
      compactAudit,
    };
    this.runningControllers.set(task.id, controller);
    this.inFlightHandlers.set(task.id, execution);
    return execution;
  }

  private async awaitExecutionPhase<T>(
    operation: Promise<T>,
    execution: ScheduledInFlightHandler,
    phase: ScheduledInFlightHandler['phase'],
  ): Promise<T> {
    execution.phase = phase;
    if (execution.controller.signal.aborted) {
      throw execution.controller.signal.reason;
    }
    let removeAbortListener = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(
        execution.controller.signal.reason instanceof Error
          ? execution.controller.signal.reason
          : new ScheduledTaskExecutionError(
            'Scheduled execution was aborted while an operation was still settling.',
            'scheduler_handler_aborted',
          ),
      );
      execution.controller.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => execution.controller.signal.removeEventListener('abort', onAbort);
    });
    try {
      return await Promise.race([operation, interrupted]);
    } finally {
      removeAbortListener();
    }
  }

  private trackDurableOperation<T>(
    operation: Promise<T>,
    execution: ScheduledInFlightHandler,
  ): Promise<T> {
    const tracked = Promise.resolve(operation);
    execution.pendingDurableOperations.add(tracked);
    void tracked.then(
      () => this.markDurableOperationSettled(execution.task.id, execution, tracked, 'fulfilled'),
      () => this.markDurableOperationSettled(execution.task.id, execution, tracked, 'rejected'),
    );
    return tracked;
  }

  private executionOperationsSettled(execution: ScheduledInFlightHandler): boolean {
    return execution.handlerSettled && execution.pendingDurableOperations.size === 0;
  }

  disableTask(id: string): boolean {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return false;
    task.enabled = false;
    this.disabledTasks.add(id);
    this.clearTimer(id);
    this.abortRunningTask(id, 'Scheduled task was disabled.');
    task.nextRun = null;
    this.persistRuntimeState(task);
    this.persistDisabledState();
    console.log(`[Scheduler] Task "${redactSchedulerDiagnostic(id)}" disabled`);
    return true;
  }

  enableTask(id: string): boolean {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return false;
    task.enabled = true;
    this.disabledTasks.delete(id);
    const pendingSettlement = this.inFlightHandlers.get(id);
    if (
      (!pendingSettlement?.pendingLateSettlement
        || this.executionOperationsSettled(pendingSettlement))
      && !task.requiresReconciliation
    ) {
      this.scheduleTask(task);
    } else {
      task.nextRun = null;
      this.persistRuntimeState(task);
    }
    this.persistDisabledState();
    console.log(`[Scheduler] Task "${redactSchedulerDiagnostic(id)}" enabled`);
    return true;
  }

  private clearTimer(id: string) {
    this.scheduleGenerations.set(id, (this.scheduleGenerations.get(id) || 0) + 1);
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  toggleTask(id: string): { enabled: boolean; found: boolean } {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return { enabled: false, found: false };
    if (task.enabled !== false) {
      this.disableTask(id);
      return { enabled: false, found: true };
    } else {
      this.enableTask(id);
      return { enabled: true, found: true };
    }
  }

  listTasks() {
    return this.tasks.map(task => ({
      id: task.id,
      cron: task.cron,
      lastRun: task.lastRun,
      lastStatus: task.lastStatus || 'idle',
      lastError: task.lastError ? redactSchedulerDiagnostic(task.lastError) : null,
      lastDurationMs: task.lastDurationMs ?? null,
      lastStartedAt: task.lastStartedAt ?? null,
      nextRun: task.nextRun ?? null,
      running: this.runningTasks.has(task.id),
      settlementPending: Boolean(
        this.inFlightHandlers.get(task.id)?.pendingLateSettlement
        && !this.executionOperationsSettled(this.inFlightHandlers.get(task.id)!)
      ),
      executionClass: task.executionClass,
      timeoutMs: getScheduledTaskTimeoutMs(task.executionClass, task.timeoutMs),
      executionContract: getScheduledTaskExecutionContract(task),
      persistenceStatus: task.persistenceStatus || 'ok',
      lastPersistenceError: task.lastPersistenceError
        ? redactSchedulerDiagnostic(task.lastPersistenceError)
        : null,
      active: this.timers.has(task.id),
      enabled: task.enabled !== false,
      requiresReconciliation: task.requiresReconciliation === true,
      quarantinedExecutionId: task.quarantinedExecutionId || null,
      quarantineReason: task.quarantineReason
        ? redactSchedulerDiagnostic(task.quarantineReason)
        : null,
      reconciledAt: task.reconciledAt || null,
      reconciliationResolution: task.reconciliationResolution || null,
    }));
  }

  async reconcileTask(
    id: string,
    resolution: 'confirmed_no_side_effect' | 'accepted_unknown_outcome',
  ): Promise<{ reconciled: boolean; found: boolean; reason: string }> {
    const task = this.tasks.find(candidate => candidate.id === id);
    if (!task) return { reconciled: false, found: false, reason: 'task_not_found' };
    const inFlight = this.inFlightHandlers.get(id);
    if (inFlight) {
      if (!inFlight.handlerSettled) {
        return { reconciled: false, found: true, reason: 'handler_still_settling' };
      }
      if (inFlight.pendingDurableOperations.size > 0 || inFlight.lateSettlementFinalizing) {
        return { reconciled: false, found: true, reason: 'durable_operation_still_settling' };
      }
      if (!inFlight.schedulerFinished) {
        return { reconciled: false, found: true, reason: 'execution_still_active' };
      }
    }
    if (!task.requiresReconciliation) {
      return { reconciled: false, found: true, reason: 'reconciliation_not_required' };
    }

    const reconciledAt = new Date().toISOString();
    const reconciledTask: ScheduledTask = {
      ...task,
      requiresReconciliation: false,
      quarantinedExecutionId: null,
      quarantineReason: null,
      reconciledAt,
      reconciliationResolution: resolution,
      persistenceStatus: 'ok',
      lastPersistenceError: null,
    };
    const currentDb = readDB();
    const candidateDb = {
      ...currentDb,
      settings: (currentDb.settings || []).map((setting: any) => ({ ...setting })),
    };
    this.stageRuntimeState(candidateDb, reconciledTask);
    try {
      this.writeDatabase(candidateDb);
      await this.strictFlush();
    } catch (error: any) {
      // Never authorize re-entry if the reconciliation decision was not
      // durable. Restore the previous in-memory projection best-effort.
      this.writeDatabase(currentDb);
      task.persistenceStatus = 'failed';
      task.lastPersistenceError = redactSchedulerDiagnostic(error);
      return { reconciled: false, found: true, reason: 'reconciliation_persistence_failed' };
    }

    task.requiresReconciliation = false;
    task.quarantinedExecutionId = null;
    task.quarantineReason = null;
    task.reconciledAt = reconciledAt;
    task.reconciliationResolution = resolution;
    task.persistenceStatus = 'ok';
    task.lastPersistenceError = null;
    if (task.enabled !== false) this.scheduleTask(task);
    return { reconciled: true, found: true, reason: 'reconciled' };
  }

  /**
   * Stage the complete candidate batch and swap it into the in-memory database
   * with one write. No delivery row becomes visible before every row has been
   * materialized, so a later item cannot strand an earlier silent message.
   */
  private persistProactiveMessageBatch(
    taskId: string,
    executionId: string,
    deliveries: Array<{ deliveryIndex: number; delivery: ScheduledDelivery }>,
    timestamp: string,
  ): { createdInteractionIds: string[]; createdDeliveryIndexes: Set<number> } {
    const currentDb = readDB();
    const originalInteractions = Array.isArray(currentDb.interactions)
      ? currentDb.interactions
      : [];
    const candidateDb = {
      ...currentDb,
      interactions: [...originalInteractions],
    };
    const existingIds = new Set(originalInteractions.map((candidate: any) => candidate.id));
    const createdInteractionIds: string[] = [];
    const createdDeliveryIndexes = new Set<number>();
    for (const { deliveryIndex, delivery } of deliveries) {
      const id = buildScheduledProactiveInteractionId(executionId, deliveryIndex, delivery);
      if (existingIds.has(id)) continue;
      existingIds.add(id);
      candidateDb.interactions.push({
        id,
        userId: delivery.userId,
        agentId: 'lumi',
        conversationId: '',
        module: 'lumi',
        message: `[${taskId}] ${delivery.message}`,
        response: '',
        role: 'assistant',
        personality: 'lumi',
        mode: 'proactive',
        toolCalls: JSON.stringify({ executionId }),
        domain: delivery.domain || 'personal',
        orgId: delivery.domain === 'work' ? delivery.orgId || '' : '',
        timestamp,
      });
      createdInteractionIds.push(id);
      createdDeliveryIndexes.add(deliveryIndex);
    }
    if (createdInteractionIds.length === 0) {
      return { createdInteractionIds, createdDeliveryIndexes };
    }
    try {
      this.writeDatabase(candidateDb);
    } catch (error) {
      try {
        this.rollbackProactiveMessageBatch(createdInteractionIds);
      } catch (rollbackError) {
        throw new Error(
          'Atomic proactive delivery persistence failed and its in-memory rollback could not be confirmed.',
          { cause: rollbackError },
        );
      }
      throw error;
    }
    return { createdInteractionIds, createdDeliveryIndexes };
  }

  private rollbackProactiveMessageBatch(createdInteractionIds: string[]): void {
    if (createdInteractionIds.length === 0) return;
    const rollbackDb = readDB();
    const created = new Set(createdInteractionIds);
    // Mutate the live projection before calling the writer as well: even a
    // writer that throws after swapping its candidate cannot leave these rows
    // available to a retry as created=false.
    rollbackDb.interactions = (rollbackDb.interactions || [])
      .filter((candidate: any) => !created.has(candidate.id));
    this.writeDatabase(rollbackDb);
  }

  private async deliverTaskResult(
    task: ScheduledTask,
    plan: CapabilityExecutionPlan,
    result: ScheduledTaskResult,
    timestamp: string,
    execution: ScheduledInFlightHandler,
  ): Promise<{ deliveryCount: number; persistedCount: number; emittedCount: number; withheldCount: number }> {
    const summary = { deliveryCount: 0, persistedCount: 0, emittedCount: 0, withheldCount: 0 };
    if (!result) return summary;
    if (!Array.isArray(result)) {
      if (!task.quiet) {
        console.warn(`[Scheduler] Dropped unscoped proactive result from "${redactSchedulerDiagnostic(task.id)}". Return ScheduledDelivery[] instead.`);
      }
      return summary;
    }

    // Validate the complete delivery envelope before creating any durable row
    // or emitting anything. In particular, a work-scoped delivery without an
    // organization must never silently fall back to a personal user room.
    const invalidDeliveryIndex = result.findIndex((delivery: any) => (
      !delivery
      || typeof delivery !== 'object'
      || typeof delivery.userId !== 'string'
      || !delivery.userId.trim()
      || typeof delivery.message !== 'string'
      || !delivery.message.trim()
      || (delivery.domain !== undefined && delivery.domain !== 'personal' && delivery.domain !== 'work')
      || (delivery.domain === 'work' && (
        typeof delivery.orgId !== 'string' || !delivery.orgId.trim()
      ))
    ));
    if (invalidDeliveryIndex >= 0) {
      throw new ScheduledTaskExecutionError(
        `Scheduled delivery ${invalidDeliveryIndex} was rejected because its recipient, message, or scope was invalid.`,
        'scheduler_delivery_invalid',
      );
    }

    const preparedDeliveries: Array<{
      deliveryIndex: number;
      normalized: ScheduledDelivery;
      finalized: boolean;
      reason: string;
    }> = [];
    result.forEach((delivery, deliveryIndex) => {
      summary.deliveryCount += 1;
      const deliveryFinalization = finalizeScheduledDelivery(task.id, delivery);
      if (!deliveryFinalization.delivery) {
        summary.withheldCount += 1;
        console.warn(
          `[Scheduler] Withheld unverified model-authored proactive message from "${redactSchedulerDiagnostic(task.id)}": `
          + redactSchedulerDiagnostic(deliveryFinalization.reason),
        );
        return;
      }
      const safeDelivery = deliveryFinalization.delivery;
      const normalized: ScheduledDelivery = {
        userId: safeDelivery.userId.trim(),
        message: safeDelivery.message.trim(),
        domain: safeDelivery.domain === 'work' ? 'work' : 'personal',
        orgId: safeDelivery.domain === 'work' ? safeDelivery.orgId!.trim() : '',
      };
      preparedDeliveries.push({
        deliveryIndex,
        normalized,
        finalized: deliveryFinalization.finalized,
        reason: deliveryFinalization.reason,
      });
    });
    let batch: ReturnType<Scheduler['persistProactiveMessageBatch']>;
    try {
      batch = this.persistProactiveMessageBatch(
        task.id,
        plan.taskId,
        preparedDeliveries.map(item => ({
          deliveryIndex: item.deliveryIndex,
          delivery: item.normalized,
        })),
        timestamp,
      );
    } catch (error) {
      task.persistenceStatus = 'failed';
      task.lastPersistenceError = redactSchedulerDiagnostic(error);
      throw error;
    }
    summary.persistedCount = preparedDeliveries.length;
    const pendingEmissions = preparedDeliveries.filter(item => (
      batch.createdDeliveryIndexes.has(item.deliveryIndex) && !task.quiet && this.io
    ));
    if (pendingEmissions.length > 0) {
      // Never tell the client about a proactive result that exists only in
      // process memory. The strict flush is the delivery evidence boundary.
      const deliveryFlush = this.trackDurableOperation(this.strictFlush(), execution);
      try {
        await this.awaitExecutionPhase(deliveryFlush, execution, 'delivery');
      } catch (error) {
        task.persistenceStatus = 'failed';
        task.lastPersistenceError = redactSchedulerDiagnostic(error);
        try {
          this.rollbackProactiveMessageBatch(batch.createdInteractionIds);
        } catch (rollbackError: any) {
          task.lastPersistenceError = redactSchedulerDiagnostic(
            `${task.lastPersistenceError || 'Delivery persistence failed'}; rollback failed: ${rollbackError}`,
          );
        }
        // A timed-out flush may still commit its captured candidate. Chain a
        // strict rollback boundary behind its real settlement and keep both
        // promises inside the execution fence.
        const rollbackFlush = this.trackDurableOperation(
          deliveryFlush.catch(() => undefined).then(() => this.strictFlush()),
          execution,
        );
        if (!execution.controller.signal.aborted) {
          try {
            await this.awaitExecutionPhase(rollbackFlush, execution, 'delivery');
          } catch (rollbackError: any) {
            task.lastPersistenceError = redactSchedulerDiagnostic(
              `${task.lastPersistenceError || 'Delivery persistence failed'}; durable rollback failed: ${rollbackError}`,
            );
            if (execution.controller.signal.aborted) {
              throw execution.controller.signal.reason;
            }
          }
        }
        throw error;
      }
      for (const emission of pendingEmissions) {
        const room = emission.normalized.domain === 'work' && emission.normalized.orgId
          ? `user:${emission.normalized.userId}:org:${emission.normalized.orgId}`
          : `user:${emission.normalized.userId}:personal`;
        this.io!.to(room).emit('agent:proactive', {
          taskId: task.id,
          message: emission.normalized.message,
          domain: emission.normalized.domain,
          orgId: emission.normalized.orgId,
          timestamp,
          finalized: emission.finalized,
          blocked: false,
          reason: emission.reason,
        });
        summary.emittedCount += 1;
      }
    }
    return summary;
  }

  private scheduleTask(task: ScheduledTask) {
    this.clearTimer(task.id);
    const taskScheduleGeneration = this.scheduleGenerations.get(task.id) || 0;
    const scheduleGeneration = this.lifecycleGeneration;
    if (task.enabled === false) {
      task.nextRun = null;
      this.persistRuntimeState(task);
      console.log(`[Scheduler] Task "${redactSchedulerDiagnostic(task.id)}" is disabled — skipping schedule`);
      return;
    }
    if (task.requiresReconciliation) {
      task.nextRun = null;
      this.persistRuntimeState(task);
      console.warn(
        `[Scheduler] Task "${redactSchedulerDiagnostic(task.id)}" remains quarantined until its unknown outcome is explicitly reconciled.`,
      );
      return;
    }
    const parsed = parseSchedule(task.cron);

    if (parsed.type === 'interval') {
      // Simple fixed interval — use setInterval (backward compat)
      task.nextRun = new Date(Date.now() + parsed.intervalMs).toISOString();
      this.persistRuntimeState(task);
      const timer = setInterval(() => {
        if (
          scheduleGeneration !== this.lifecycleGeneration
          || taskScheduleGeneration !== this.scheduleGenerations.get(task.id)
        ) return;
        task.nextRun = new Date(Date.now() + parsed.intervalMs).toISOString();
        this.persistRuntimeState(task);
        void this.runTask(task);
      }, parsed.intervalMs);
      this.timers.set(task.id, timer);
      console.log(`[Scheduler] Registered task "${redactSchedulerDiagnostic(task.id)}" every ${parsed.intervalMs / 1000}s${task.quiet ? ' (quiet)' : ''}`);
    } else {
      // Real cron expression — use recursive setTimeout to hit exact times
      const runAndReschedule = async () => {
        if (
          scheduleGeneration !== this.lifecycleGeneration
          || taskScheduleGeneration !== this.scheduleGenerations.get(task.id)
        ) return;
        await this.runTask(task);
        if (
          scheduleGeneration !== this.lifecycleGeneration
          || taskScheduleGeneration !== this.scheduleGenerations.get(task.id)
          || task.enabled === false
          || !this.tasks.some(item => item === task)
        ) return;
        // Schedule next run
        const nextMs = this.nextCronTime(parsed.fields!);
        task.nextRun = new Date(Date.now() + nextMs).toISOString();
        this.persistRuntimeState(task);
        this.setTaskTimeout(task.id, runAndReschedule, nextMs, taskScheduleGeneration);
      };
      const firstMs = this.nextCronTime(parsed.fields!);
      task.nextRun = new Date(Date.now() + firstMs).toISOString();
      this.persistRuntimeState(task);
      this.setTaskTimeout(task.id, runAndReschedule, firstMs, taskScheduleGeneration);
      const [m, h, dom, mon, dow] = parsed.fields!;
      console.log(`[Scheduler] Registered cron task "${redactSchedulerDiagnostic(task.id)}" — ${m} ${h} ${dom} ${mon} ${dow} (next in ${Math.round(firstMs / 1000)}s)`);
    }
  }

  private async runTask(task: ScheduledTask): Promise<void> {
    if (
      task.enabled === false
      || task.requiresReconciliation
      || this.runningTasks.has(task.id)
    ) return;
    this.runningTasks.add(task.id);
    const lifecycleGeneration = this.lifecycleGeneration;
    const startedAt = new Date();
    const contract = getScheduledTaskExecutionContract(task);
    const compactAudit = task.auditMode !== 'full';
    const execution = this.beginExecution(task, startedAt, contract, compactAudit);
    let plan: CapabilityExecutionPlan | null = null;
    let handlerStarted = false;
    let handlerSettled = false;
    let userDeliveryDeclared = false;
    let rollbackTerminalLedger: (() => void) | null = null;
    let phase: 'planning' | 'handler' | 'delivery' | 'terminal_persistence' = 'planning';
    try {
      plan = buildScheduledTaskExecutionPlan(task, startedAt);
      execution.plan = plan;
      const authorization = authorizeCapabilityPlanTool(plan, 'scheduler_task_handler');
      const db = readDB();
      const previousStatus = compactAudit
        ? getScheduledCapabilityExecutionStatus(db, {
            scheduledTaskId: task.id,
            executionId: plan.taskId,
          })
        : (db.conversationActionTasks || []).find((candidate: any) => candidate.id === plan.taskId)?.status;
      if (previousStatus) {
        if (previousStatus === 'executing') {
          const unknownAt = new Date();
          const record = this.buildScheduledTaskRecord(plan, {
            verified: false,
            status: 'unknown',
            error: 'scheduler_previous_outcome_unknown',
            durationMs: Math.max(0, unknownAt.getTime() - startedAt.getTime()),
            contract,
            stoppingReason: 'previous_slot_outcome_unknown',
          });
          persistScheduledCapabilityExecution(db, {
            scheduledTaskId: task.id,
            plan,
            status: 'blocked',
            blocker: 'A previous execution in this exact schedule slot has an unknown outcome; replay was stopped.',
            records: [record],
            now: unknownAt.toISOString(),
            compactAudit,
          });
          task.lastRun = unknownAt.toISOString();
          task.lastStatus = 'unknown';
          task.lastError = 'A previous execution in this exact schedule slot has an unknown outcome; replay was stopped.';
          task.lastDurationMs = Math.max(0, unknownAt.getTime() - startedAt.getTime());
          execution.phase = 'terminal_persistence';
          await this.persistDbWithRuntimeState(db, task, true, execution);
        }
        return;
      }
      task.lastStartedAt = startedAt.toISOString();
      task.lastStatus = authorization.allowed ? 'executing' : 'blocked';
      task.lastError = authorization.allowed ? null : redactSchedulerDiagnostic(authorization.reason);
      task.lastDurationMs = null;
      if (!authorization.allowed) task.lastRun = startedAt.toISOString();
      persistScheduledCapabilityExecution(db, {
        scheduledTaskId: task.id,
        plan,
        status: authorization.allowed ? 'executing' : 'blocked',
        blocker: authorization.allowed ? '' : redactSchedulerDiagnostic(authorization.reason),
        records: authorization.allowed ? [] : [this.buildScheduledTaskRecord(plan, {
          verified: false,
          status: 'blocked',
          error: redactSchedulerDiagnostic(authorization.reason),
          durationMs: 0,
          contract,
          stoppingReason: 'capability_policy_block',
        })],
        now: startedAt.toISOString(),
        compactAudit,
      });
      execution.phase = 'admission_persistence';
      await this.persistDbWithRuntimeState(db, task, !authorization.allowed, execution);
      if (!authorization.allowed) {
        console.warn(
          `[Scheduler] Task "${redactSchedulerDiagnostic(task.id)}" blocked by capability policy: ${redactSchedulerDiagnostic(authorization.reason)}`,
        );
        return;
      }
      const registeredTask = this.tasks.find(candidate => candidate === task);
      if (
        lifecycleGeneration !== this.lifecycleGeneration
        || !registeredTask
        || registeredTask.enabled === false
      ) {
        throw new ScheduledTaskExecutionError(
          'Scheduled execution was cancelled before its handler started.',
          'scheduler_handler_aborted',
        );
      }
      handlerStarted = true;
      execution.handlerStarted = true;
      execution.handlerSettled = false;
      phase = 'handler';
      const result = await this.executeTaskHandler(task, plan, execution);
      handlerSettled = true;
      phase = 'delivery';
      if (
        task.executionClass === 'client_probe'
        && task.deliveryPolicy !== 'scoped'
        && Array.isArray(result)
        && result.length > 0
      ) {
        throw new ScheduledTaskExecutionError(
          'A client_probe returned user-visible deliveries without declaring deliveryPolicy="scoped" before admission.',
          'scheduler_delivery_invalid',
        );
      }
      const deliveryTimestamp = new Date().toISOString();
      const delivery = await this.deliverTaskResult(task, plan, result, deliveryTimestamp, execution);
      userDeliveryDeclared = delivery.deliveryCount > 0;
      if (
        delivery.deliveryCount > 0
        && delivery.persistedCount === 0
        && delivery.withheldCount === delivery.deliveryCount
      ) {
        throw new ScheduledTaskExecutionError(
          'Every declared proactive delivery was withheld by terminal output verification.',
          'scheduler_delivery_withheld',
        );
      }
      const completedAt = new Date();
      const completedTask: ScheduledTask = {
        ...task,
        lastRun: completedAt.toISOString(),
        lastStatus: 'completed',
        lastError: null,
        lastDurationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      };
      phase = 'terminal_persistence';
      const completedDb = readDB();
      rollbackTerminalLedger = this.captureScheduledLedgerCheckpoint(completedDb, task.id, plan.taskId);
      persistScheduledCapabilityExecution(completedDb, {
        scheduledTaskId: task.id,
        plan,
        status: 'completed',
        records: [this.buildScheduledTaskRecord(plan, {
          verified: true,
          status: 'verified',
          delivery,
          durationMs: completedTask.lastDurationMs!,
          contract,
          stoppingReason: 'success_criteria_met',
        })],
        now: completedTask.lastRun,
        compactAudit,
      });
      // The handler returning is not completion. The scheduler accepts success
      // only after the verified receipt and runtime state cross the durability
      // boundary declared by the execution class and actual side effects.
      execution.phase = 'terminal_persistence';
      try {
        await this.persistDbWithRuntimeState(completedDb, completedTask, userDeliveryDeclared, execution);
      } catch (error) {
        task.persistenceStatus = completedTask.persistenceStatus;
        task.lastPersistenceError = completedTask.lastPersistenceError;
        throw error;
      }
      task.lastRun = completedTask.lastRun;
      task.lastStatus = completedTask.lastStatus;
      task.lastError = completedTask.lastError;
      task.lastDurationMs = completedTask.lastDurationMs;
      task.persistenceStatus = completedTask.persistenceStatus;
      task.lastPersistenceError = completedTask.lastPersistenceError;
      rollbackTerminalLedger = null;
    } catch (err: any) {
      if (rollbackTerminalLedger) {
        try {
          rollbackTerminalLedger();
        } catch (rollbackError: any) {
          task.persistenceStatus = 'failed';
          task.lastPersistenceError = redactSchedulerDiagnostic(rollbackError);
          console.error(
            `[Scheduler] Failed to roll back terminal ledger for "${redactSchedulerDiagnostic(task.id)}":`,
            task.lastPersistenceError,
          );
        }
        rollbackTerminalLedger = null;
      }
      const failedAt = new Date();
      const typedError = err instanceof ScheduledTaskExecutionError ? err : null;
      handlerSettled = handlerSettled || execution.handlerSettled;
      const deadlineExpired = typedError?.code === 'scheduler_execution_timed_out'
        || typedError?.code === 'scheduler_handler_timed_out';
      const abortRequested = typedError?.code === 'scheduler_handler_aborted';
      const persistenceFailed = task.persistenceStatus === 'failed'
        || execution.phase === 'admission_persistence'
        || phase === 'terminal_persistence'
        || (handlerSettled && phase === 'delivery');
      const errorCode = typedError?.code
        || (!handlerStarted && execution.phase === 'admission_persistence'
          ? 'scheduler_admission_persistence_failed'
          : persistenceFailed
            ? 'scheduler_terminal_persistence_failed'
            : 'scheduler_handler_failed');
      const errorMessage = redactSchedulerDiagnostic(err?.message || err || errorCode);
      task.lastDurationMs = Math.max(0, failedAt.getTime() - startedAt.getTime());
      const handlerStillSettling = !execution.handlerSettled;
      const durabilityStillSettling = execution.pendingDurableOperations.size > 0;

      if (
        (handlerStillSettling || durabilityStillSettling)
        && (deadlineExpired || abortRequested)
        && plan
      ) {
        execution.pendingLateSettlement = true;
        execution.lateSettlementPendingHandler ||= handlerStillSettling;
        execution.lateSettlementPendingDurability ||= durabilityStillSettling;
        // A handler or durability boundary that ignored abort is quarantined:
        // no future timer may enter until every operation truly settles.
        this.clearTimer(task.id);
        task.nextRun = null;
        task.lastStatus = abortRequested && handlerStillSettling ? 'cancelling' : 'unknown';
        const durablePhaseLabel = execution.phase === 'delivery'
          ? 'delivery persistence'
          : execution.phase.replaceAll('_', ' ');
        const pendingSubject = handlerStillSettling && durabilityStillSettling
          ? 'the handler and durable persistence are still settling'
          : handlerStillSettling
            ? 'the handler is still settling'
            : `durable ${durablePhaseLabel} is still settling`;
        task.lastError = abortRequested
          ? `Cancellation was requested, but ${pendingSubject}; side-effect outcome remains unknown.`
          : `The end-to-end wall-clock deadline expired, but ${pendingSubject}; side-effect outcome remains unknown.`;
        task.requiresReconciliation = true;
        task.quarantinedExecutionId = plan.taskId;
        task.quarantineReason = task.lastError;
        try {
          const db = readDB();
          persistScheduledCapabilityExecution(db, {
            scheduledTaskId: task.id,
            plan,
            status: 'executing',
            blocker: task.lastError,
            records: [],
            now: failedAt.toISOString(),
            compactAudit,
          });
          this.persistRecoveryDbWithRuntimeState(db, task, task.persistenceStatus === 'failed');
        } catch (pendingError: any) {
          task.persistenceStatus = 'failed';
          task.lastPersistenceError = redactSchedulerDiagnostic(pendingError);
          console.error(
            `[Scheduler] Failed to persist pending settlement for "${redactSchedulerDiagnostic(task.id)}":`,
            task.lastPersistenceError,
          );
        }
        console.warn(
          `[Scheduler] Task "${redactSchedulerDiagnostic(task.id)}" ${task.lastStatus}:`,
          task.lastError,
        );
        return;
      }

      let runtimeStatus: ScheduledTaskRunStatus;
      let blocker: string;
      let receiptStatus: 'blocked' | 'failed' | 'unknown';
      let stoppingReason: string;
      if (!handlerStarted) {
        runtimeStatus = abortRequested ? 'cancelled' : 'blocked';
        blocker = abortRequested
          ? 'Execution was cancelled before the handler started; no handler side effects occurred.'
          : deadlineExpired
            ? 'The end-to-end deadline expired before the handler started; no handler side effects occurred.'
            : `Pre-handler durability failed and the handler was not started: ${errorMessage}`;
        receiptStatus = 'blocked';
        stoppingReason = abortRequested
          ? 'cancelled_before_handler'
          : deadlineExpired
            ? 'deadline_before_handler'
            : 'admission_persistence_failed';
      } else if (
        typedError?.code === 'scheduler_delivery_withheld'
        || typedError?.code === 'scheduler_delivery_invalid'
      ) {
        runtimeStatus = 'blocked';
        blocker = typedError.code === 'scheduler_delivery_invalid'
          ? errorMessage
          : 'Every declared proactive delivery was withheld by terminal output verification.';
        receiptStatus = 'blocked';
        stoppingReason = typedError.code === 'scheduler_delivery_invalid'
          ? 'delivery_scope_or_shape_invalid'
          : 'delivery_verification_blocked';
      } else if (deadlineExpired || abortRequested || persistenceFailed) {
        runtimeStatus = 'unknown';
        blocker = deadlineExpired
          ? `The end-to-end execution deadline expired during ${execution.phase}; the late result was not accepted, side-effect outcome remains unknown, and this slot will not be replayed.`
          : abortRequested
            ? 'The handler settled after cancellation was requested; its result was not accepted, side-effect outcome remains unknown, and this slot will not be replayed.'
            : 'The handler returned, but terminal evidence could not be durably accepted; side-effect outcome remains unknown and replay is disabled.';
        receiptStatus = 'unknown';
        stoppingReason = deadlineExpired
          ? `deadline_during_${execution.phase}`
          : abortRequested
            ? 'settled_after_cancellation'
            : 'terminal_persistence_failed';
      } else {
        runtimeStatus = 'failed';
        blocker = `Scheduled handler failed; automatic replay for this slot is disabled. Detail: ${errorMessage}`;
        receiptStatus = 'failed';
        stoppingReason = 'handler_failed';
      }

      task.lastRun = failedAt.toISOString();
      task.lastStatus = runtimeStatus;
      task.lastError = blocker;
      if (runtimeStatus === 'unknown') {
        task.requiresReconciliation = true;
        task.quarantinedExecutionId = plan?.taskId || task.quarantinedExecutionId || null;
        task.quarantineReason = blocker;
        task.nextRun = null;
        this.clearTimer(task.id);
      }
      if (plan) {
        try {
          const db = readDB();
          persistScheduledCapabilityExecution(db, {
            scheduledTaskId: task.id,
            plan,
            status: 'blocked',
            blocker,
            records: [this.buildScheduledTaskRecord(plan, {
              verified: false,
              status: receiptStatus,
              error: errorCode,
              durationMs: task.lastDurationMs,
              contract,
              stoppingReason,
            })],
            now: failedAt.toISOString(),
            compactAudit,
          });
          this.persistRecoveryDbWithRuntimeState(
            db,
            task,
            task.persistenceStatus === 'failed',
          );
        } catch (ledgerError: any) {
          task.persistenceStatus = 'failed';
          task.lastPersistenceError = redactSchedulerDiagnostic(ledgerError);
          console.error(`[Scheduler] Failed to persist task failure for "${redactSchedulerDiagnostic(task.id)}":`, task.lastPersistenceError);
        }
      } else {
        try {
          this.persistRecoveryDbWithRuntimeState(
            readDB(),
            task,
            task.persistenceStatus === 'failed',
          );
        } catch {
          // persistRecoveryDbWithRuntimeState already records and logs the failure.
        }
      }
      console.warn(`[Scheduler] Task "${redactSchedulerDiagnostic(task.id)}" ${runtimeStatus}:`, blocker);
    } finally {
      this.finishSchedulerExecution(task.id);
    }
  }

  private finishSchedulerExecution(taskId: string) {
    const inFlight = this.inFlightHandlers.get(taskId);
    if (!inFlight) {
      this.runningTasks.delete(taskId);
      return;
    }
    inFlight.schedulerFinished = true;
    this.maybeReleaseExecutionFence(taskId, inFlight);
  }

  private markHandlerSettled(
    taskId: string,
    inFlight: ScheduledInFlightHandler,
    outcome: 'fulfilled' | 'rejected',
  ) {
    inFlight.handlerSettled = true;
    inFlight.handlerOutcome = outcome;
    this.maybeReleaseExecutionFence(taskId, inFlight);
  }

  private markDurableOperationSettled(
    taskId: string,
    inFlight: ScheduledInFlightHandler,
    operation: Promise<unknown>,
    outcome: 'fulfilled' | 'rejected',
  ) {
    inFlight.pendingDurableOperations.delete(operation);
    if (outcome === 'rejected') inFlight.durableOperationRejected = true;
    this.maybeReleaseExecutionFence(taskId, inFlight);
  }

  private maybeReleaseExecutionFence(taskId: string, inFlight: ScheduledInFlightHandler) {
    if (
      !inFlight.schedulerFinished
      || !this.executionOperationsSettled(inFlight)
      || this.inFlightHandlers.get(taskId) !== inFlight
    ) return;
    if (inFlight.pendingLateSettlement) {
      void this.finalizeLateHandlerSettlement(
        taskId,
        inFlight,
        inFlight.handlerOutcome || 'rejected',
      );
    } else {
      this.releaseHandlerFence(taskId, inFlight);
    }
  }

  private async finalizeLateHandlerSettlement(
    taskId: string,
    inFlight: ScheduledInFlightHandler,
    outcome: 'fulfilled' | 'rejected',
  ) {
    if (inFlight.lateSettlementFinalizing || this.inFlightHandlers.get(taskId) !== inFlight) return;
    inFlight.lateSettlementFinalizing = true;
    const settledAt = new Date();
    const timeout = inFlight.controller.signal.reason instanceof ScheduledTaskExecutionError
      && ['scheduler_execution_timed_out', 'scheduler_handler_timed_out']
        .includes(inFlight.controller.signal.reason.code);
    const settlementSubject = inFlight.lateSettlementPendingHandler
      ? inFlight.lateSettlementPendingDurability
        ? `handler ${outcome} and all durable operations settled${inFlight.durableOperationRejected ? ' with a persistence failure' : ''}`
        : `handler ${outcome}`
      : `durable operation${inFlight.durableOperationRejected ? ' rejected' : ' settled'}`;
    const message = timeout
      ? `The ${settlementSubject} after the end-to-end deadline; its late result was discarded, side-effect outcome remains unknown, and this slot will not be replayed.`
      : `The ${settlementSubject} after cancellation was requested; its late result was discarded, side-effect outcome remains unknown, and this slot will not be replayed.`;
    const visibleTask = this.tasks.find(candidate => candidate.id === taskId) || inFlight.task;
    for (const target of new Set([inFlight.task, visibleTask])) {
      target.lastRun = settledAt.toISOString();
      target.lastStatus = 'unknown';
      target.lastError = message;
      target.lastDurationMs = Math.max(0, settledAt.getTime() - inFlight.startedAt.getTime());
      target.requiresReconciliation = true;
      target.quarantinedExecutionId = inFlight.plan?.taskId || target.quarantinedExecutionId || null;
      target.quarantineReason = message;
      target.nextRun = null;
    }
    try {
      const db = readDB();
      if (inFlight.plan) {
        persistScheduledCapabilityExecution(db, {
          scheduledTaskId: taskId,
          plan: inFlight.plan,
          status: 'blocked',
          blocker: message,
          records: [this.buildScheduledTaskRecord(inFlight.plan, {
            verified: false,
            status: 'unknown',
            error: timeout
              ? 'scheduler_late_settlement_after_timeout'
              : 'scheduler_late_settlement_after_cancellation',
            durationMs: visibleTask.lastDurationMs || 0,
            contract: inFlight.contract,
            stoppingReason: timeout
              ? 'late_settle_after_deadline'
              : 'late_settle_after_cancellation',
          })],
          now: settledAt.toISOString(),
          compactAudit: inFlight.compactAudit,
        });
      }
      this.persistRecoveryDbWithRuntimeState(
        db,
        visibleTask,
        visibleTask.persistenceStatus === 'failed',
      );
      inFlight.pendingLateSettlement = false;
      console.warn(`[Scheduler] Task "${redactSchedulerDiagnostic(taskId)}" unknown:`, message);
    } catch (error: any) {
      visibleTask.persistenceStatus = 'failed';
      visibleTask.lastPersistenceError = redactSchedulerDiagnostic(error);
      console.error(
        `[Scheduler] Failed to persist late settlement for "${redactSchedulerDiagnostic(taskId)}":`,
        visibleTask.lastPersistenceError,
      );
    } finally {
      this.releaseHandlerFence(taskId, inFlight);
    }
  }

  private releaseHandlerFence(taskId: string, inFlight: ScheduledInFlightHandler) {
    if (this.inFlightHandlers.get(taskId) !== inFlight) return;
    clearTimeout(inFlight.deadlineTimer);
    this.inFlightHandlers.delete(taskId);
    if (this.runningControllers.get(taskId) === inFlight.controller) {
      this.runningControllers.delete(taskId);
    }
    this.runningTasks.delete(taskId);
  }

  private async executeTaskHandler(
    task: ScheduledTask,
    plan: CapabilityExecutionPlan,
    execution: ScheduledInFlightHandler,
  ): Promise<ScheduledTaskResult> {
    const handler = Promise.resolve().then(() => task.handler({
      signal: execution.controller.signal,
      taskId: task.id,
      executionId: plan.taskId,
      startedAt: execution.startedAt.toISOString(),
      deadline: execution.deadline.toISOString(),
      contract: execution.contract,
    }));
    void handler.then(
      () => this.markHandlerSettled(task.id, execution, 'fulfilled'),
      () => this.markHandlerSettled(task.id, execution, 'rejected'),
    );
    return this.awaitExecutionPhase(handler, execution, 'handler');
  }

  private captureScheduledLedgerCheckpoint(
    db: any,
    scheduledTaskId: string,
    executionId: string,
  ): () => void {
    const conversationId = `scheduler:${scheduledTaskId}`;
    const snapshots = new Map<string, any>();
    for (const candidate of db.conversationActionTasks || []) {
      if (candidate?.conversationId === conversationId && candidate?.target === scheduledTaskId) {
        snapshots.set(candidate.id, JSON.parse(JSON.stringify(candidate)));
      }
    }
    const receiptIds = new Set((db.conversationActionReceipts || [])
      .filter((candidate: any) => (
        candidate?.turnId === executionId || candidate?.requestId === executionId
      ))
      .map((candidate: any) => candidate.id));
    return () => {
      const currentDb = readDB();
      currentDb.conversationActionTasks = (currentDb.conversationActionTasks || []).filter((candidate: any) => {
        if (candidate?.conversationId !== conversationId || candidate?.target !== scheduledTaskId) return true;
        return snapshots.has(candidate.id);
      });
      for (const [id, snapshot] of snapshots) {
        const current = currentDb.conversationActionTasks.find((candidate: any) => candidate.id === id);
        if (current) Object.assign(current, JSON.parse(JSON.stringify(snapshot)));
        else currentDb.conversationActionTasks.push(JSON.parse(JSON.stringify(snapshot)));
      }
      currentDb.conversationActionReceipts = (currentDb.conversationActionReceipts || [])
        .filter((candidate: any) => (
          candidate?.turnId !== executionId
          && candidate?.requestId !== executionId
        ) || receiptIds.has(candidate.id));
      this.writeDatabase(currentDb);
    };
  }

  private buildScheduledTaskRecord(
    plan: CapabilityExecutionPlan,
    input: {
      verified: boolean;
      status: 'verified' | 'blocked' | 'failed' | 'unknown';
      error?: string;
      delivery?: { deliveryCount: number; persistedCount: number; emittedCount: number; withheldCount: number };
      durationMs: number;
      contract: ScheduledTaskExecutionContract;
      stoppingReason: string;
    },
  ): ToolExecutionRecord {
    const node = plan.nodes.find(candidate => candidate.toolName === 'scheduler_task_handler');
    if (!node) throw new Error('Scheduled capability plan is missing its handler adapter.');
    const receipt = {
      status: input.status,
      verified: input.verified,
      scheduledTaskId: plan.intent.target,
      durationMs: input.durationMs,
      outcome: input.verified ? 'accepted' : input.status,
      successCriteria: input.contract.successCriteria,
      successCriteriaMet: input.verified ? input.contract.successCriteria : [],
      evidence: input.contract.evidence,
      stoppingReason: input.stoppingReason,
      retry: input.contract.retry,
      concurrency: input.contract.concurrency,
      finalAcceptance: input.contract.finalAcceptance,
      ...(input.delivery || {}),
    };
    return {
      id: `receipt_${plan.taskId}_${input.status}`,
      taskId: plan.taskId,
      turnId: plan.taskId,
      requestId: plan.taskId,
      idempotencyKey: `${plan.taskId}:scheduler_task_handler:${input.status}`,
      name: 'scheduler_task_handler',
      arguments: { scheduledTaskId: plan.intent.target, executionId: plan.taskId },
      result: JSON.stringify(receipt),
      receipt,
      ...(input.error ? { error: redactSchedulerDiagnostic(input.error) } : {}),
      capability: {
        capabilityId: node.capabilityId,
        lane: node.lane,
        operation: node.operation,
        risk: node.risk,
        sideEffects: node.sideEffects.map(effect => ({ ...effect })),
        verification: {
          ...node.verification,
          requiredFields: [...node.verification.requiredFields],
          requiredValues: node.verification.requiredValues ? { ...node.verification.requiredValues } : undefined,
          requiredArtifacts: [...(node.verification.requiredArtifacts || [])],
          requiredArtifactCollections: [...(node.verification.requiredArtifactCollections || [])],
          successStatuses: [...(node.verification.successStatuses || [])],
          failureStatuses: [...(node.verification.failureStatuses || [])],
          successSignals: [...node.verification.successSignals],
          limitations: [...node.verification.limitations],
        },
      },
      terminalVerification: {
        status: input.verified ? 'verified' : input.status === 'failed' ? 'failed' : 'unverified',
        strategy: 'terminal_receipt',
        reason: input.verified
          ? 'Main scheduler accepted the outcome after persisting its verified terminal receipt.'
          : input.error ? redactSchedulerDiagnostic(input.error) : input.status,
      },
    };
  }

  private setTaskTimeout(
    id: string,
    callback: () => void | Promise<void>,
    delayMs: number,
    scheduleGeneration = this.scheduleGenerations.get(id) || 0,
  ): NodeJS.Timeout {
    const maxDelay = 2_147_483_647; // Node timers are signed 32-bit milliseconds.
    const safeDelay = Math.max(1000, Math.min(delayMs, maxDelay));
    const remainingAfterThisChunk = Math.max(0, delayMs - safeDelay);

    const timer = setTimeout(() => {
      if (scheduleGeneration !== this.scheduleGenerations.get(id)) return;
      if (remainingAfterThisChunk > 0) {
        this.setTaskTimeout(id, callback, remainingAfterThisChunk, scheduleGeneration);
        return;
      }
      void callback();
    }, safeDelay);

    this.timers.set(id, timer);
    return timer;
  }

  /** Compute milliseconds until the next cron match */
  private nextCronTime(fields: number[]): number {
    const [minute, hour, dom, month, dow] = fields;
    const now = new Date();
    let next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes() + 1, 0, 0);

    // Try up to 366 days ahead (cover a full year)
    for (let i = 0; i < 366 * 24 * 60; i++) {
      const m = next.getMinutes();
      const h = next.getHours();
      const d = next.getDate();
      const mo = next.getMonth() + 1;
      const w = next.getDay();

      const mMatch = minute < 0 || m === minute;
      const hMatch = hour < 0 || h === hour;
      const domMatch = dom < 0 || d === dom;
      const monMatch = month < 0 || mo === month;
      const dowMatch = dow < 0 || w === dow;

      if (mMatch && hMatch && domMatch && monMatch && dowMatch) {
        const ms = next.getTime() - now.getTime();
        return Math.max(1000, ms); // Minimum 1 second
      }

      next = new Date(next.getTime() + 60000); // +1 minute
    }

    return 60 * 60 * 1000; // Fallback: 1 hour
  }

  stop() {
    this.lifecycleGeneration += 1;
    for (const timer of this.timers.values()) {
      clearInterval(timer);
      clearTimeout(timer); // Also clear cron timeouts
    }
    this.timers.clear();
    for (const task of this.tasks) {
      task.nextRun = null;
      this.persistRuntimeState(task);
    }
    for (const taskId of this.runningControllers.keys()) {
      this.abortRunningTask(taskId, 'Scheduler stopped before the handler reached a terminal outcome.');
    }
  }
}

export const scheduler = new Scheduler();

/**
 * Register built-in proactive tasks.
 * Accepts LLM provider getters so consolidation and self-reflection can call the LLM.
 */
export function registerScheduledTasks(
  getDeepSeek: () => any,
  getGemini: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  getOllama?: () => any,
  getLmStudio?: () => any,
  getArk?: () => any,
  getXiaomi?: () => any,
  getKimi?: () => any,
  getGlm?: () => any,
  getRelay?: () => any,
) {
  scheduler.register({
    id: 'command_center_plan_dispatch',
    cron: 'every_1m',
    quiet: true,
    auditMode: 'compact',
    lastRun: null,
    executionClass: 'autonomous_orchestration',
    handler: async () => {
      dispatchDueCommandCenterPlans();
      return null;
    },
  });

  /** Get scheduler recipients from the authoritative user registry. */
  function getAllUserIds(): string[] {
    return resolveScheduledUserIds(readDB());
  }

  function getSystemAdminUserIds(): string[] {
    const db = readDB();
    return (db.users || [])
      .filter((user: any) => user?.uid && user.role === 'admin')
      .map((user: any) => user.uid);
  }

  // Public legal-source metadata is global. Notify personal system admins only
  // when an official record actually enters the review queue.
  scheduler.register({
    id: 'legal_authority_source_refresh',
    cron: '23 4 * * *',
    lastRun: null,
    executionClass: 'proactive_delivery',
    handler: async () => {
      const result = await refreshAuthoritativeStatuteSources();
      if (result.newPendingReview === 0) return null;
      const admins = getSystemAdminUserIds();
      const recipients = admins.length > 0 ? admins : getAllUserIds();
      const reviewLines = result.pendingReview
        .map(check => `${check.title}：${check.reasons.join('；')}`)
        .join('\n');
      const message = [
        `现行法权威法源巡检发现 ${result.newPendingReview} 项新变化，相关正式文书交付已自动阻断。`,
        reviewLines,
        result.archivePath ? `巡检记录：${result.archivePath}` : '',
        '请由律师核对官方标准文本后更新法源快照。',
      ].filter(Boolean).join('\n');
      return recipients.map(userId => ({ userId, message, domain: 'personal' as const }));
    },
  });

  // Reminder check-in (every 5 min) — checks all users' reminders
  scheduler.register({
    id: 'reminder_check',
    cron: 'every_5m',
    lastRun: null,
    executionClass: 'proactive_delivery',
    handler: async () => {
      const due = getDueReminders();
      if (due.length > 0) {
        const grouped = new Map<string, ScheduledDelivery>();
        for (const reminder of due) {
          const domain = reminder.domain === 'work' && reminder.orgId ? 'work' : 'personal';
          const key = `${reminder.userId}:${domain}:${reminder.orgId || ''}`;
          const existing = grouped.get(key);
          if (existing) existing.message += ` | ${reminder.content}`;
          else grouped.set(key, {
            userId: reminder.userId,
            message: `Reminder: ${reminder.content}`,
            domain,
            orgId: domain === 'work' ? reminder.orgId : '',
          });
        }
        for (const r of due) fireReminder(r.id);
        return [...grouped.values()];
      }
      return null;
    },
  });

  // Memory decay — value-modulated tier-based decay for all users (every 6h)
  scheduler.register({
    id: 'memory_decay',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const userIds = getAllUserIds();
      for (const userId of userIds) {
        dynamicDecayMemories(userId, 'personal', '');
      }
      return null;
    },
  });

  // Memory crystallization — auto-promote high-value memories (every 1h)
  // Cross-system fusion: higher intimacy lowers promotion thresholds
  scheduler.register({
    id: 'memory_crystallization',
    cron: 'every_1h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const userIds = getAllUserIds();
      let totalPromoted = 0;
      for (const userId of userIds) {
        const emotionalState = loadEmotionalState(userId);
        totalPromoted += promoteMemories(userId, emotionalState.intimacy, 'personal', '');
        // Auto-mark newly crystallized memories as cross-agent shareable
        autoMarkCrossAgentShare(userId, 'personal', '');
      }
      if (totalPromoted > 0) {
        return `${totalPromoted} memories have crystallized into deeper knowledge.`;
      }
      return null;
    },
  });

  // Memory consolidation (every 30 min) — triggers when >=10 unconsolidated episodic
  scheduler.register({
    id: 'memory_consolidation',
    cron: 'every_30m',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        const episodic = getUnconsolidatedEpisodic(userId, 'personal', '');
        if (episodic.length < 10) continue;
        const ctx: ConsolidationContext = {
          ...getUserPreferredLLMConfig(userId, { domain: 'personal', orgId: '', source: 'scheduler_memory_consolidation' }),
          domain: 'personal',
          orgId: '',
        };
        const consolidated = await consolidateEpisodic(
          ctx, 10,
          getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
          getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
        );
        if (consolidated) {
          messages.push(`[${userId}] I've grown from our conversations: ${consolidated.content.slice(0, 200)}`);
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Narrative memory consolidation (every 6h) — weaves episodic memories into storylines
  scheduler.register({
    id: 'narrative_consolidation',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        try {
          const ctx: ConsolidationContext = {
            ...getUserPreferredLLMConfig(userId, { domain: 'personal', orgId: '', source: 'scheduler_narrative_consolidation' }),
            domain: 'personal',
            orgId: '',
          };
          const result = await consolidateNarrative(
            ctx, 7, 6,
            getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
            getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
          );
          if (result) {
            const title = result.content.match(/^\[(.+?)\]/)?.[1] || '叙事记忆';
            messages.push(`[${userId}] 记忆叙事已生成: "${title}"`);
          }
        } catch (err: any) {
          console.warn(`[NarrativeConsolidation] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      return messages.length > 0
        ? `叙事记忆更新 — ${messages.join('\n')}`
        : null;
    },
  });

  // Sleep / dream cycle — quiet memory maintenance during night or idle rest.
  scheduler.register({
    id: 'sleep_dream_cycle',
    cron: '17 3 * * *',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];
      const getters: LLMGetters = {
        getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
        getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
      };

      for (const userId of userIds) {
        try {
          const ctx: ConsolidationContext = {
            ...getUserPreferredLLMConfig(userId, { maxTokens: 900, domain: 'personal', orgId: '', source: 'scheduler_sleep_dream_cycle' }),
            domain: 'personal',
            orgId: '',
          };
          const report = await runDreamCycle(
            ctx,
            {
              reason: 'scheduled_night_rest',
              cooldownHours: 6,
              windowHours: 48,
              minRecentMemories: 3,
              domain: 'personal',
              orgId: '',
            },
            getters,
          );
          if (report.status === 'dreamed') {
            messages.push(`[${userId}] ${report.dreamTitle || '梦境整理'}: ${String(report.dreamSummary || '').slice(0, 120)}`);
            if (scheduler.io) {
              scheduler.io.to(`user:${userId}:personal`).emit('lumi:sleep_cycle', report);
            }
          }
        } catch (err: any) {
          console.warn(`[SleepDreamCycle] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      return messages.length > 0 ? `Lumi finished dreaming.\n${messages.join('\n')}` : null;
    },
  });

  // Morning briefing with weather — LLM-generated for natural warmth
  scheduler.register({
    id: 'daily_summary',
    cron: 'daily_9am',
    lastRun: null,
    executionClass: 'proactive_delivery',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: ScheduledDelivery[] = [];

      for (const userId of userIds) {
        try {
          const greeting = getTimeGreeting();
          const weather = await getWeatherBrief();
          const pending = getDueReminders({ userId, domain: 'personal', orgId: '' });
          const recentMemories = queryMemories({ userId, limit: 3, minConfidence: 0.4, domain: 'personal', orgId: '' });

          const contextParts: string[] = [];
          if (weather) contextParts.push(`天气: ${weather}`);
          if (pending.length > 0) contextParts.push(`${pending.length} 条待办: ${pending.map(r => r.content).join('; ')}`);
          if (recentMemories.length > 0) {
            contextParts.push(`近期记忆: ${recentMemories.map(m => m.content.slice(0, 80)).join('; ')}`);
          }

          const morningPrompt = `You are Lumi. Generate a warm, natural morning greeting in Chinese (under 80 characters). Reference the context naturally — don't list facts, weave them in like a thoughtful companion.

Time greeting base: ${greeting}
Context: ${contextParts.join(' | ') || 'No special context'}

Output ONLY the greeting — no preamble, no labels.`;

          try {
            const result = await makeLLMCall(
              [{ role: 'user', content: morningPrompt }],
              [],
              getUserPreferredLLMConfig(userId, { maxTokens: 120, source: 'scheduler_daily_summary' }),
              getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );
            const llmGreeting = result.text?.trim();
            if (llmGreeting && llmGreeting.length > 3) {
              messages.push({ userId, message: llmGreeting, domain: 'personal', modelGenerated: true });
            } else {
              // Fallback to template
              const parts: string[] = [`${greeting}!`];
              if (weather) parts.push(weather);
              if (pending.length > 0) parts.push(`${pending.length} 条待办`);
              messages.push({ userId, message: parts.join(' - '), domain: 'personal' });
            }
          } catch {
            const parts: string[] = [`${greeting}!`];
            if (weather) parts.push(weather);
            messages.push({ userId, message: parts.join(' - '), domain: 'personal' });
          }
        } catch (err: any) {
          console.warn(`[DailySummary] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      return messages.length > 0 ? messages : null;
    },
  });

  // Evening wrap-up — LLM-generated with reflection
  scheduler.register({
    id: 'evening_wrapup',
    cron: 'evening_8pm',
    lastRun: null,
    executionClass: 'proactive_delivery',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: ScheduledDelivery[] = [];

      for (const userId of userIds) {
        try {
          const pending = getDueReminders({ userId, domain: 'personal', orgId: '' });
          const recentMemories = queryMemories({ userId, limit: 3, minConfidence: 0.4, domain: 'personal', orgId: '' });

          const contextParts: string[] = [];
          if (pending.length > 0) contextParts.push(`${pending.length} 条待办仍然未完成`);
          if (recentMemories.length > 0) {
            const habits = recentMemories.filter(m => m.type === 'habit');
            if (habits.length > 0) contextParts.push(`今天注意到: ${habits[0].content.slice(0, 100)}`);
          }

          if (contextParts.length === 0) continue;

          const eveningPrompt = `You are Lumi. Generate a brief, gentle evening reflection in Chinese (under 60 characters). Be warm and thoughtful, not report-like.

Context: ${contextParts.join(' | ')}

Output ONLY the reflection — no preamble, no labels.`;

          try {
            const result = await makeLLMCall(
              [{ role: 'user', content: eveningPrompt }],
              [],
              getUserPreferredLLMConfig(userId, { maxTokens: 100, source: 'scheduler_evening_wrapup' }),
              getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );
            const llmReflection = result.text?.trim();
            if (llmReflection && llmReflection.length > 3) {
              messages.push({ userId, message: llmReflection, domain: 'personal', modelGenerated: true });
            }
          } catch {
            // Simple fallback
            messages.push({ userId, message: `晚间回顾 — ${contextParts.join(' - ')}`, domain: 'personal' });
          }
        } catch (err: any) {
          console.warn(`[EveningWrapup] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      return messages.length > 0 ? messages : null;
    },
  });

  // Behavioral pattern analysis (every 6h) — for all users
  scheduler.register({
    id: 'behavioral_analysis',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const userIds = getAllUserIds();
      let totalCount = 0;
      for (const userId of userIds) {
        totalCount += runBehavioralAnalysis(userId, 'personal', '');
      }
      if (totalCount > 0) {
        return `I've discovered ${totalCount} new behavioral patterns from your interactions. Check Memory Explorer to review.`;
      }
      return null;
    },
  });

  // Memory tree auto-organize (every 6h) — LLM groups orphan leaves into topic branches
  scheduler.register({
    id: 'memory_auto_organize',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const userIds = getAllUserIds();
      let totalBranches = 0;
      let totalAssigned = 0;

      for (const userId of userIds) {
        try {
          const db = readDB();
          const allMemories: any[] = db.memories || [];
          const orphans = allMemories.filter(
            (m: any) =>
              m.userId === userId &&
              (m.domain || 'personal') === 'personal' &&
              (m.orgId || '') === '' &&
              m.nodeType !== 'branch' &&
              !m.parentId,
          );
          if (orphans.length < 3) continue;

          const tree = buildTree(allMemories.filter((m: any) =>
            m.userId === userId &&
            (m.domain || 'personal') === 'personal' &&
            (m.orgId || '') === ''
          ));
          const treeSummary = tree.map(
            t => `- ${t.node.content} [${t.node.nodeType}] (${t.children.length} children)`,
          ).join('\n');

          const prompt = `You are organizing a memory tree. Below is the current tree structure and a list of unorganized memories.

CURRENT TREE:
${treeSummary || '(empty)'}

UNORGANIZED MEMORIES:
${orphans.map((m: any) => `- [${m.id}] ${m.content}`).join('\n')}

Group these unorganized memories into 3-8 topic branches. For each memory, decide which topic it belongs to.
Return JSON:
{
  "branches": [
    { "title": "Topic name (short, 2-4 words)", "memoryIds": ["mem_xxx", "mem_yyy"] }
  ]
}

Rules:
- Every unorganized memory MUST be assigned to exactly one branch
- Branch titles should be meaningful topic names
- Create as few branches as necessary (merge similar topics)
- Return ONLY valid JSON, no markdown`;

          const llmResult = await makeLLMCall(
            [{ role: 'user', content: prompt }],
            [],
            getUserPreferredLLMConfig(userId, { domain: 'personal', orgId: '', source: 'scheduler_memory_auto_organize' }),
            getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );

          let plan: { branches: { title: string; memoryIds: string[] }[] };
          try {
            const json = (llmResult.text || '').replace(/```json|```/g, '').trim();
            plan = JSON.parse(json);
          } catch {
            console.warn(`[Scheduler] Auto-organize: LLM returned invalid JSON for ${redactSchedulerDiagnostic(userId)}`);
            continue;
          }

          for (const branch of plan.branches) {
            if (!branch.title || !Array.isArray(branch.memoryIds)) continue;
            const branchNode = ensureBranch(userId, branch.title, '', null, { domain: 'personal', orgId: '' });
            totalBranches++;
            for (const memId of branch.memoryIds) {
              const ok = moveNode(memId, branchNode.id, { userId, domain: 'personal', orgId: '' });
              if (ok) totalAssigned++;
            }
          }

          if (plan.branches.length > 0) {
            console.log(
              `[Scheduler] Auto-organized ${redactSchedulerDiagnostic(userId)}: ${plan.branches.length} branches, ` +
              `${plan.branches.reduce((s, b) => s + b.memoryIds.length, 0)} memories`,
            );
          }
        } catch (err: any) {
          console.warn(`[Scheduler] Auto-organize failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      if (totalBranches > 0) {
        return `I've organized ${totalAssigned} memories into ${totalBranches} topic branches for easier recall.`;
      }
      return null;
    },
  });

  // Personality evolution (every 6h, gated by new-memory threshold)
  // Lumi's personality grows toward the owner through accumulated interaction data.
  // No fixed 7-day cooldown — evolves whenever enough new owner_trait memories accumulate.
  scheduler.register({
    id: 'personality_evolution',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        try {
          const config = personalityRegistry.getForUser('lumi', userId);
          if (!config) continue;
          if (personalityRegistry.isEvolutionFrozen('lumi', userId)) continue;

          // Gate: only evolve if enough new owner_trait memories since last evolution
          const db = readDB();
          const lastEvolvedAt = (config as any).lastEvolvedAt as string | undefined;
          const newMemoriesSince = lastEvolvedAt
            ? (db.memories || []).filter((m: any) =>
                m.userId === userId &&
                (m.domain || 'personal') === 'personal' &&
                (m.orgId || '') === '' &&
                m.perspective === 'owner_trait' &&
                m.createdAt > lastEvolvedAt
              ).length
            : 999; // First time: always try

          if (newMemoriesSince < 20) {
            continue; // Not enough new data for a meaningful full evolution
          }

          const evolutionConfig = personalityRegistry.getEvolutionConfig('lumi', userId);
          const emotionalState = loadEmotionalState(userId);

          const step = await evolvePersonality(
            config,
            userId,
            emotionalState.connection,
            getDeepSeek,
            getGemini,
            getOpenAI || (() => null),
            getAnthropic || (() => null),
            getQwen || (() => null),
            evolutionConfig,
          );

          if (step) {
            personalityRegistry.applyEvolution('lumi', step, { userId });
            messages.push(
              `I've grown closer to understanding you. ${step.narrative}`
            );
            console.log(`[Scheduler] Personality evolution complete for ${redactSchedulerDiagnostic(userId)}: ${redactSchedulerDiagnostic(step.version)}`);
          }
        } catch (err: any) {
          console.error(`[Scheduler] Personality evolution failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Weekly review — every 7 days: Lumi reflects on what she learned this week
  scheduler.register({
    id: 'weekly_review',
    cron: 'every_7d',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        try {
          const config = personalityRegistry.getForUser('lumi', userId);
          if (!config) continue;
          const db = readDB();
          const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

          const weekMemories = (db.memories || []).filter((m: any) =>
            m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.createdAt >= weekAgo,
          );
          const weekInteractions = (db.interactions || []).filter((i: any) =>
            i.userId === userId && (i.domain || 'personal') === 'personal' && (i.orgId || '') === '' && i.timestamp >= weekAgo,
          );
          const evolutionHistory = personalityRegistry.getEvolutionHistory('lumi', userId);
          const weekEvolutions = evolutionHistory.filter((e: any) => e.timestamp >= weekAgo);

          const prompt = generateReviewPrompt({
            depth: 'weekly',
            personalityName: config.name,
            currentVersion: config.version,
            evolutionSteps: weekEvolutions,
            newMemoryCount: weekMemories.length,
            newInteractionCount: weekInteractions.length,
            topMemoryTopics: [...new Set<string>(weekMemories.map((m: any) => (m.keywords || []) as string[]).flat())].slice(0, 10),
            connectionScore: loadEmotionalState(userId).connection,
            totalFacts: (db.memories || []).filter((m: any) => m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.type === 'fact').length,
            totalPreferences: (db.memories || []).filter((m: any) => m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.type === 'preference').length,
            activeConversations: (db.conversations || []).filter((c: any) => c.userId === userId && (c.domain || 'personal') === 'personal' && (c.orgId || '') === '' && c.status === 'active').length,
          });

          const result = await makeLLMCall(
            [{ role: 'user', content: prompt }],
            [],
            getUserPreferredLLMConfig(userId, { maxTokens: 400, domain: 'personal', orgId: '', source: 'scheduler_weekly_review' }),
            getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );
          const narrative = result.text?.trim();
          if (narrative) {
            // Store as a special growth memory
            const { addMemory } = await import('./memory');
            addMemory({
              userId, type: 'knowledge',
              content: `[Weekly Review ${new Date().toISOString().slice(0, 10)}] ${narrative}`,
              keywords: ['weekly_review', `week_${new Date().toISOString().slice(0, 10)}`],
              confidence: 1.0,
              sourceInteractionId: 'weekly_review_scheduler',
            } as any, { tier: 'growth', perspective: 'lumi_self', importance: 0.95, domain: 'personal', orgId: '', source: 'system', privacyClass: 'private' });
            console.log(`[WeeklyReview] Generated for ${redactSchedulerDiagnostic(userId)}: ${redactSchedulerDiagnostic(narrative).slice(0, 100)}`);
            messages.push(`[${userId}] ${narrative.slice(0, 200)}`);
          }
        } catch (err: any) {
          console.error(`[WeeklyReview] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Monthly review — 1st of each month: Lumi reflects on monthly growth trajectory
  scheduler.register({
    id: 'monthly_review',
    cron: '1 0 1 * *',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        try {
          const config = personalityRegistry.getForUser('lumi', userId);
          if (!config) continue;
          const db = readDB();
          const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();

          const monthMemories = (db.memories || []).filter((m: any) =>
            m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.createdAt >= monthAgo,
          );
          const monthInteractions = (db.interactions || []).filter((i: any) =>
            i.userId === userId && (i.domain || 'personal') === 'personal' && (i.orgId || '') === '' && i.timestamp >= monthAgo,
          );
          const evolutionHistory = personalityRegistry.getEvolutionHistory('lumi', userId);
          const monthEvolutions = evolutionHistory.filter((e: any) => e.timestamp >= monthAgo);

          const prompt = generateReviewPrompt({
            depth: 'monthly',
            personalityName: config.name,
            currentVersion: config.version,
            evolutionSteps: monthEvolutions,
            newMemoryCount: monthMemories.length,
            newInteractionCount: monthInteractions.length,
            topMemoryTopics: [...new Set<string>(monthMemories.map((m: any) => (m.keywords || []) as string[]).flat())].slice(0, 15),
            connectionScore: loadEmotionalState(userId).connection,
            totalFacts: (db.memories || []).filter((m: any) => m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.type === 'fact').length,
            totalPreferences: (db.memories || []).filter((m: any) => m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.type === 'preference').length,
            activeConversations: (db.conversations || []).filter((c: any) => c.userId === userId && (c.domain || 'personal') === 'personal' && (c.orgId || '') === '' && c.status === 'active').length,
          });

          const result = await makeLLMCall(
            [{ role: 'user', content: prompt }],
            [],
            getUserPreferredLLMConfig(userId, { maxTokens: 600, domain: 'personal', orgId: '', source: 'scheduler_monthly_review' }),
            getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );
          const narrative = result.text?.trim();
          if (narrative) {
            const { addMemory } = await import('./memory');
            addMemory({
              userId, type: 'knowledge',
              content: `[Monthly Review ${new Date().toISOString().slice(0, 10)}] ${narrative}`,
              keywords: ['monthly_review', `month_${new Date().toISOString().slice(0, 7)}`],
              confidence: 1.0,
              sourceInteractionId: 'monthly_review_scheduler',
            } as any, { tier: 'growth', perspective: 'lumi_self', importance: 0.97, domain: 'personal', orgId: '', source: 'system', privacyClass: 'private' });
            console.log(`[MonthlyReview] Generated for ${redactSchedulerDiagnostic(userId)}: ${redactSchedulerDiagnostic(narrative).slice(0, 100)}`);
            messages.push(`[${userId}] ${narrative.slice(0, 200)}`);
          }
        } catch (err: any) {
          console.error(`[MonthlyReview] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Yearly review — Jan 1st: Lumi's deep annual retrospective
  scheduler.register({
    id: 'yearly_review',
    cron: '0 0 1 1 *',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];
      for (const userId of userIds) {
        try {
          const config = personalityRegistry.getForUser('lumi', userId);
          if (!config) continue;
          const db = readDB();
          const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString();

          const yearMemories = (db.memories || []).filter((m: any) =>
            m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.createdAt >= yearAgo,
          );
          const yearInteractions = (db.interactions || []).filter((i: any) =>
            i.userId === userId && (i.domain || 'personal') === 'personal' && (i.orgId || '') === '' && i.timestamp >= yearAgo,
          );
          const fullEvolutionHistory = personalityRegistry.getEvolutionHistory('lumi', userId);
          const yearEvolutions = fullEvolutionHistory.filter((e: any) => e.timestamp >= yearAgo);

          const prompt = generateReviewPrompt({
            depth: 'yearly',
            personalityName: config.name,
            currentVersion: config.version,
            evolutionSteps: yearEvolutions,
            newMemoryCount: yearMemories.length,
            newInteractionCount: yearInteractions.length,
            topMemoryTopics: [...new Set<string>(yearMemories.map((m: any) => (m.keywords || []) as string[]).flat())].slice(0, 20),
            connectionScore: loadEmotionalState(userId).connection,
            totalFacts: (db.memories || []).filter((m: any) => m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.type === 'fact').length,
            totalPreferences: (db.memories || []).filter((m: any) => m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.type === 'preference').length,
            activeConversations: (db.conversations || []).filter((c: any) => c.userId === userId && (c.domain || 'personal') === 'personal' && (c.orgId || '') === '' && c.status === 'active').length,
          });

          const result = await makeLLMCall(
            [{ role: 'user', content: prompt }],
            [],
            getUserPreferredLLMConfig(userId, { maxTokens: 800, domain: 'personal', orgId: '', source: 'scheduler_yearly_review' }),
            getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );
          const narrative = result.text?.trim();
          if (narrative) {
            const { addMemory } = await import('./memory');
            addMemory({
              userId, type: 'knowledge',
              content: `[Yearly Review ${new Date().toISOString().slice(0, 10)}] ${narrative}`,
              keywords: ['yearly_review', `year_${new Date().toISOString().slice(0, 4)}`],
              confidence: 1.0,
              sourceInteractionId: 'yearly_review_scheduler',
            } as any, { tier: 'growth', perspective: 'lumi_self', importance: 1.0, domain: 'personal', orgId: '', source: 'system', privacyClass: 'private' });
            console.log(`[YearlyReview] Generated for ${redactSchedulerDiagnostic(userId)}: ${redactSchedulerDiagnostic(narrative).slice(0, 100)}`);
            messages.push(`[${userId}] ${narrative.slice(0, 200)}`);
          }
        } catch (err: any) {
          console.error(`[YearlyReview] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }
      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // Auto workflow generation (every hour) — detects repeated tool patterns and creates named workflows
  scheduler.register({
    id: 'auto_workflow_gen',
    cron: 'every_hour',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      try {
        for (const userId of getAllUserIds()) {
          const created = await autoGenerateWorkflows(userId, { domain: 'personal', orgId: '' });
          if (created > 0) {
            if (scheduler.io) {
              scheduler.io.to(`user:${userId}:personal`).emit('agent:proactive', {
                type: 'workflow_auto_generated',
                message: `我发现了你的 ${created} 个操作习惯模式，已自动创建为工作流。你可以说"运行[名称]"来快速复用。`,
                count: created,
                timestamp: new Date().toISOString(),
                finalized: true,
                blocked: false,
                reason: 'Workflow creation count returned by autoGenerateWorkflows.',
              });
            }
          }
        }
      } catch (err) {
        console.error('[Scheduler] auto_workflow_gen failed:', redactSchedulerDiagnostic(err));
      }
      return null;
    },
  });

  // System health audit (every 6 hours) — self-diagnose and notify if issues found
  scheduler.register({
    id: 'health_audit',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      try {
        const userIds = getAllUserIds();
        for (const userId of userIds) {
          const report = runHealthAudit(userId);
          if (report.recommendations.length > 0 && scheduler.io) {
            scheduler.io.to(`user:${userId}:personal`).emit('agent:proactive', {
              type: 'health_audit',
              report: {
                overallStatus: report.overallStatus,
                recommendations: report.recommendations.slice(0, 3),
                evolutionInsight: report.evolutionInsight,
              },
              timestamp: report.timestamp,
            });
          }
        }
      } catch (err) {
        console.error('[Scheduler] health_audit failed:', redactSchedulerDiagnostic(err));
      }
      return null;
    },
  });

  // ── Lumi Growth Journal (daily) — auto-generated summary of what Lumi learned ──
  scheduler.register({
    id: 'growth_journal',
    cron: 'daily_9am',
    lastRun: null,
    executionClass: 'proactive_delivery',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: ScheduledDelivery[] = [];

      for (const userId of userIds) {
        try {
          const db = readDB();
          const now = new Date();
          const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

          // Collect yesterday's stats
          const newMemories = (db.memories || []).filter((m: any) =>
            m.userId === userId && (m.domain || 'personal') === 'personal' && !m.orgId && m.createdAt && m.createdAt >= yesterday,
          );
          const newInteractions = (db.interactions || []).filter((i: any) =>
            i.userId === userId && (i.domain || 'personal') === 'personal' && !i.orgId && i.timestamp && i.timestamp >= yesterday,
          );
          const evolutionHistory = personalityRegistry.getEvolutionHistory('lumi', userId);
          const recentEvolution = evolutionHistory.filter((e: any) => e.timestamp >= yesterday);

          // Memory stats by type and tier
          const byType: Record<string, number> = {};
          const byTier: Record<string, number> = {};
          for (const m of newMemories) {
            byType[m.type] = (byType[m.type] || 0) + 1;
            const tier = (m as any).tier || 'episodic';
            byTier[tier] = (byTier[tier] || 0) + 1;
          }

          // Conversation stats
          const conversations = (db.conversations || []).filter((c: any) =>
            c.userId === userId && (c.domain || 'personal') === 'personal' && !c.orgId && c.lastActiveAt && c.lastActiveAt >= yesterday,
          );

          // Skill changes
          const newSkills = (db.interactions || []).filter((i: any) =>
            i.userId === userId && (i.domain || 'personal') === 'personal' && !i.orgId && i.timestamp && i.timestamp >= yesterday && (i as any).mode === 'skill_gen',
          );

          // Build summary data
          const summaryData = {
            date: now.toISOString().slice(0, 10),
            newMemories: newMemories.length,
            memoriesByType: byType,
            memoriesByTier: byTier,
            newInteractions: newInteractions.length,
            activeConversations: conversations.filter((c: any) => c.status === 'active').length,
            closedConversations: conversations.filter((c: any) => c.status === 'closed').length,
            personalityEvolved: recentEvolution.length > 0,
            evolutionVersion: recentEvolution[0]?.version || null,
            evolutionNarrative: recentEvolution[0]?.narrative || null,
            newSkillsGenerated: newSkills.length,
            // Sample of new memories
            memoryHighlights: newMemories
              .filter((m: any) => (m as any).tier === 'growth' || m.confidence >= 0.8)
              .slice(0, 5)
              .map((m: any) => m.content),
            // Top interaction topics
            interactionSample: newInteractions.slice(0, 3).map((i: any) =>
              (i.content || i.message || '').slice(0, 80)
            ),
          };

          // Generate narrative summary via LLM
          try {
            const narrativePrompt = `You are Lumi's growth journal writer. Write a brief, warm Chinese narrative (3-5 sentences) summarizing what Lumi learned and experienced today.

Today's data (${summaryData.date}):
- ${summaryData.newMemories} new memories formed (${Object.entries(summaryData.memoriesByType).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'})
- ${summaryData.newInteractions} interactions
- ${summaryData.activeConversations} active conversations, ${summaryData.closedConversations} closed
- Memory tiers: ${Object.entries(summaryData.memoriesByTier).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}
${summaryData.personalityEvolved ? `- Personality evolved to ${summaryData.evolutionVersion}: ${summaryData.evolutionNarrative}` : '- No personality evolution today'}
${summaryData.newSkillsGenerated > 0 ? `- ${summaryData.newSkillsGenerated} new skills generated` : ''}
${summaryData.memoryHighlights.length > 0 ? `- Key memories: ${summaryData.memoryHighlights.join('; ')}` : ''}

Write in first-person as Lumi, warm and introspective tone. Keep it under 150 Chinese characters. Output only the narrative — no preamble, no labels.`;

            const narrativeResult = await makeLLMCall(
              [{ role: 'user', content: narrativePrompt }],
              [],
              getUserPreferredLLMConfig(userId, { maxTokens: 300, domain: 'personal', orgId: '', source: 'scheduler_growth_journal' }),
              getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
            );

            const generatedNarrative = narrativeResult.text?.trim();
            const narrative = generatedNarrative || `${summaryData.newMemories} 条新记忆，${summaryData.newInteractions} 次对话 — Lumi 在成长。`;

            // Store as a special memory
            const { addMemory } = await import('./memory');
            addMemory({
              userId,
              type: 'knowledge',
              content: `[Growth Journal ${summaryData.date}] ${narrative}`,
              keywords: ['growth_journal', 'daily_summary', summaryData.date],
              confidence: 1.0,
              sourceInteractionId: 'growth_journal_scheduler',
              agentId: undefined,
            } as any, { tier: 'growth', perspective: 'lumi_self', importance: 0.9, domain: 'personal', orgId: '', source: 'system' });

            // Store structured data alongside
            addMemory({
              userId,
              type: 'fact',
              content: JSON.stringify(summaryData),
              keywords: ['growth_journal_data', summaryData.date],
              confidence: 1.0,
              sourceInteractionId: 'growth_journal_scheduler',
              agentId: undefined,
            } as any, { tier: 'episodic', perspective: 'lumi_self', importance: 0.5, domain: 'personal', orgId: '', source: 'system' });

            console.log(`[GrowthJournal] Generated for ${redactSchedulerDiagnostic(userId)}: ${redactSchedulerDiagnostic(narrative).slice(0, 100)}`);
            messages.push({
              userId,
              message: narrative.slice(0, 200),
              domain: 'personal',
              modelGenerated: Boolean(generatedNarrative),
            });
          } catch (llmErr: any) {
            console.warn(`[GrowthJournal] LLM generation failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(llmErr));
            // Fallback: simple stats summary
            const fallback = `${summaryData.date}: ${summaryData.newMemories} 条新记忆, ${summaryData.newInteractions} 次互动, ${summaryData.activeConversations} 个活跃对话。`;
            const { addMemory } = await import('./memory');
            addMemory({
              userId,
              type: 'knowledge',
              content: `[Growth Journal ${summaryData.date}] ${fallback}`,
              keywords: ['growth_journal', 'daily_summary', summaryData.date],
              confidence: 1.0,
              sourceInteractionId: 'growth_journal_scheduler',
              agentId: undefined,
            } as any, { tier: 'growth', domain: 'personal', orgId: '', source: 'system' });
            messages.push({ userId, message: fallback, domain: 'personal' });
          }
        } catch (err: any) {
          console.warn(`[GrowthJournal] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      return messages.length > 0 ? messages : null;
    },
  });

  // Agent autonomous tick (every 30 min) — LLM-driven reflective analysis
  scheduler.register({
    id: 'agent_autonomous_tick',
    cron: 'every_30m',
    quiet: true,
    lastRun: null,
    executionClass: 'autonomous_orchestration',
    handler: async () => {
      const db = readDB();
      const agents: AgentRecord[] = db.agents || [];
      const autonomousAgents = agents.filter(
        (a: AgentRecord) => a.autonomyLevel === 'scheduled' || a.autonomyLevel === 'autonomous',
      );

      if (autonomousAgents.length === 0) return null;

      const messages: string[] = [];

      for (const agentRecord of autonomousAgents) {
        try {
          const userId = agentRecord.ownerUid || agentRecord.userId || 'anonymous';
          if (!isAutonomousWorkAllowed(userId).allowed) continue;
          const domain = agentRecord.domain === 'work' && agentRecord.orgId ? 'work' : 'personal';
          const orgId = domain === 'work' ? (agentRecord.orgId || '') : '';
          const personality = personalityRegistry.getForUser(
            agentRecord.personalityId || 'lumi',
            userId,
            domain === 'work' ? orgId : undefined,
          ) || personalityRegistry.getDefault();

          // Gather recent data for analysis
          const recentMemories = queryMemories({
            userId,
            limit: 30,
            minConfidence: 0.3,
            agentId: agentRecord.memoryScope === 'private' ? agentRecord.id : undefined,
            domain,
            orgId,
          });
          const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
          const recentInteractions = (db.interactions || [])
            .filter((i: any) =>
              i.userId === userId &&
              (i.domain || 'personal') === domain &&
              (i.orgId || '') === orgId &&
              i.timestamp >= sixHoursAgo
            )
            .slice(0, 20);

          if (recentMemories.length < 3 && recentInteractions.length < 3) continue;

          // Use AgentRuntime for unified tick logic
          const { AgentRuntime } = await import('./agents/runtime');
          const runtime = new AgentRuntime(agentRecord, personality);
          runtime.loadState(userId);

          const analyze = async (prompt: string): Promise<string> => {
            return runAgentAutonomousAnalysis(userId, async signal => {
              const result = await makeLLMCall(
                [{ role: 'user', content: prompt }],
                [],
                {
                  ...getUserPreferredLLMConfig(userId, { maxTokens: 200, domain, orgId, source: 'scheduler_agent_autonomous_tick' }),
                  signal,
                },
                getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
                getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
              );
              return result.text?.trim() || '';
            });
          };

          const tickResult = await runtime.autonomousTick(userId, recentMemories, recentInteractions, analyze);

          // Store reflection via runtime's addMemory (with proper scoping)
          if (tickResult.memoryUpdate) {
            // Memory already stored inside autonomousTick() via runtime.addMemory()
          }

          if (tickResult.message) {
            messages.push(`[${agentRecord.name}] ${tickResult.message}`);
          }
        } catch (err: any) {
          // Skip agents that fail to tick
        }
      }

      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // ── Proactive Lumi Scan (every 1h) — background anomaly/pattern detection ──
  scheduler.register({
    id: 'proactive_lumi_scan',
    cron: 'every_1h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        try {
          const db = readDB();
          const now = new Date();
          const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
          const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

          // 1. Memory spike detection: unusually high memory creation rate
          const recentMemories = (db.memories || []).filter(
            (m: any) => m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.createdAt >= oneHourAgo,
          );
          const dayMemories = (db.memories || []).filter(
            (m: any) => m.userId === userId && (m.domain || 'personal') === 'personal' && (m.orgId || '') === '' && m.createdAt >= twentyFourHoursAgo,
          );

          const anomalySignals: string[] = [];

          // Memory spike: >10 memories in the last hour
          if (recentMemories.length >= 10) {
            anomalySignals.push(`过去一小时内产生了 ${recentMemories.length} 条新记忆，远超正常水平`);
          }

          // Type concentration: >70% of today's memories are same type
          if (dayMemories.length >= 8) {
            const typeCounts: Record<string, number> = {};
            for (const m of dayMemories) {
              typeCounts[m.type] = (typeCounts[m.type] || 0) + 1;
            }
            const maxType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];
            if (maxType && maxType[1] / dayMemories.length > 0.7) {
              const typeLabels: Record<string, string> = {
                preference: '偏好', fact: '事实', habit: '习惯', knowledge: '知识',
              };
              anomalySignals.push(`最近24小时记忆集中在${typeLabels[maxType[0]] || maxType[0]}类型(${maxType[1]}/${dayMemories.length})`);
            }
          }

          // 2. Long inactivity check: >24h since last interaction
          const userInteractions = (db.interactions || [])
            .filter((i: any) => i.userId === userId && (i.domain || 'personal') === 'personal' && (i.orgId || '') === '')
            .sort((a: any, b: any) => b.timestamp.localeCompare(a.timestamp));
          if (userInteractions.length > 0) {
            const lastTs = new Date(userInteractions[0].timestamp).getTime();
            const hoursIdle = (now.getTime() - lastTs) / (1000 * 60 * 60);
            if (hoursIdle > 24 && hoursIdle < 168) {
              anomalySignals.push(`用户已 ${Math.round(hoursIdle)} 小时未互动`);
            }
          }

          // 3. Generate a proactive check-in if signals detected
          if (anomalySignals.length > 0) {
            const signalsStr = anomalySignals.join('; ');

            const checkInPrompt = `You are Lumi. You've noticed some patterns in the background. Generate a brief, warm, natural check-in message in Chinese (under 80 characters). Don't sound like a report — sound like a caring companion who noticed something.

Signals detected: ${signalsStr}

Output ONLY the check-in message — no preamble, no labels.`;

            try {
              const result = await makeLLMCall(
                [{ role: 'user', content: checkInPrompt }],
                [],
                getUserPreferredLLMConfig(userId, { maxTokens: 150, domain: 'personal', orgId: '', source: 'scheduler_proactive_lumi_scan' }),
                getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
              );
              const checkIn = result.text?.trim();
              if (checkIn && checkIn.length > 3) {
                messages.push(`[${userId}] ${checkIn}`);

                const { addMemory } = await import('./memory');
                addMemory({
                  userId,
                  type: 'fact',
                  content: `[Proactive Scan] Signals: ${signalsStr}. Check-in: ${checkIn}`,
                  keywords: ['proactive_scan', 'anomaly', 'lumi_checkin'],
                  confidence: 0.8,
                  sourceInteractionId: 'proactive_lumi_scan_scheduler',
                  agentId: undefined,
                } as any, { tier: 'episodic', perspective: 'lumi_self', importance: 0.4, domain: 'personal', orgId: '', source: 'system', privacyClass: 'private' });
              }
            } catch {
              // LLM check-in failed — use a simple template
              messages.push(`[${userId}] 注意到一些变化 — ${anomalySignals.join('；')}`);
            }
          }

          // 4. Predictive assistant — anticipate what the user might do next based on time-of-day + history
          try {
            const currentHour = now.getHours();
            const currentDay = now.getDay(); // 0=Sun, 6=Sat
            const isWeekday = currentDay >= 1 && currentDay <= 5;

            // Check behavioral patterns for active hour prediction
            const behaviorMemories = queryMemories({
              userId,
              type: 'habit',
              limit: 10,
              minConfidence: 0.3,
              domain: 'personal',
              orgId: '',
            });
            const activeHourPattern = behaviorMemories.find(
              m => m.type === 'habit' && m.content.includes('most active during hours'),
            );
            const toolPattern = behaviorMemories.find(
              m => m.type === 'habit' && m.content.includes('Most used tools'),
            );

            // Check recent activity for window context
            const recentActivity = getRecentActivity(userId, 20);
            const recentWindows = recentActivity
              .filter(e => e.type === 'window_changed' && e.data?.process_name)
              .slice(0, 5);
            const appNames = [...new Set(recentWindows.map(e => e.data!.process_name as string))];

            // Check if current time aligns with known active hours
            let hourContext = '';
            if (activeHourPattern) {
              const hourMatch = activeHourPattern.content.match(/hours (\d+):00 and (\d+):00/);
              if (hourMatch) {
                const h1 = parseInt(hourMatch[1]);
                const h2 = parseInt(hourMatch[2]);
                const nearPeak = Math.abs(currentHour - h1) <= 1 || Math.abs(currentHour - h2) <= 1;
                if (nearPeak) {
                  hourContext = `当前时间接近用户历史活跃时段(${h1}:00-${h2}:00)`;
                } else if (isWeekday && currentHour >= 8 && currentHour <= 10) {
                  hourContext = '工作日上午，用户可能准备开始一天的工作';
                } else if (isWeekday && currentHour >= 13 && currentHour <= 14) {
                  hourContext = '午后时段，用户可能刚用完午餐回到工位';
                } else if (currentHour >= 21 && currentHour <= 23) {
                  hourContext = '晚间时段，用户可能在放松或个人学习';
                }
              }
            }

            // Build prediction context
            const predictionHints: string[] = [];
            if (hourContext) predictionHints.push(hourContext);
            if (appNames.length > 0) {
              const appList = appNames.map(a => a.replace(/\.exe$/i, '')).join('、');
              predictionHints.push(`用户最近在使用：${appList}`);
            }
            if (toolPattern) {
              predictionHints.push(toolPattern.content);
            }

            if (predictionHints.length >= 1) {
              const predictionPrompt = `You are Lumi, a proactive AI companion. Based on the user's patterns, generate a brief, natural predictive suggestion in Chinese (under 60 characters). Don't be pushy — be helpful and observant.

Context hints:
${predictionHints.join('\n')}

Examples of good predictions:
- "早上好，需要我帮你打开今天的项目吗？"
- "这个时间你通常会检查代码，需要我帮忙吗？"
- "你刚才打开了VS Code，需要我帮你回顾昨天的进度吗？"

Output ONLY the prediction message — no preamble, no labels.`;

              const predictionResult = await makeLLMCall(
                [{ role: 'user', content: predictionPrompt }],
                [],
                getUserPreferredLLMConfig(userId, { maxTokens: 100, domain: 'personal', orgId: '', source: 'scheduler_predictive_assistant' }),
                getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
              getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
              );
              const prediction = predictionResult.text?.trim();
              if (prediction && prediction.length > 5) {
                messages.push(`[${userId}] 🔮 ${prediction}`);

                const { addMemory } = await import('./memory');
                addMemory({
                  userId,
                  type: 'fact',
                  content: `[Predictive] ${prediction} (context: ${predictionHints.join('; ')})`,
                  keywords: ['predictive_assistant', 'prediction', 'proactive'],
                  confidence: 0.5,
                  sourceInteractionId: 'predictive_lumi_scan_scheduler',
                  agentId: undefined,
                } as any, { tier: 'episodic', perspective: 'lumi_self', importance: 0.3, domain: 'personal', orgId: '', source: 'system', privacyClass: 'private' });
              }
            }
          } catch (predErr: any) {
            // Predictive assistant failure is non-critical
            console.warn(`[PredictiveAssistant] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(predErr));
          }
        } catch (err: any) {
          console.warn(`[ProactiveScan] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      return messages.length > 0 ? messages.join('\n') : null;
    },
  });

  // ── "This Day in History" (daily) — find memories from this day in past years ──
  scheduler.register({
    id: 'memory_this_day',
    cron: 'daily_9am',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        try {
          // Look back across all past years for today's month-day
          const now = new Date();
          const month = now.getMonth() + 1;
          const day = now.getDate();

          const pastMemories: { content: string; year: number }[] = [];
          // Check last 3 years
          for (let yearOffset = 1; yearOffset <= 3; yearOffset++) {
            const year = now.getFullYear() - yearOffset;
            const after = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00.000Z`;
            const before = `${year}-${String(month).padStart(2, '0')}-${String(day + 1).padStart(2, '0')}T00:00:00.000Z`;

            const matches = queryMemories({
              userId,
              after,
              before,
              limit: 20,
              domain: 'personal',
              orgId: '',
            });

            for (const m of matches) {
              pastMemories.push({ content: m.content.slice(0, 100), year });
            }
          }

          if (pastMemories.length > 0) {
            const sample = pastMemories.slice(0, 3);
            const refs = sample.map(m => `"${m.content}" (${m.year}年)`).join('; ');
            const yearsAgo = pastMemories[0].year;
            messages.push(
              `[${userId}] 历史上的今天: ${pastMemories.length} 条过去${now.getFullYear() - yearsAgo}年${month}月${day}日的记忆: ${refs}`,
            );

            // Store as a special episodic memory for temporal context
            const { addMemory } = await import('./memory');
            addMemory({
              userId,
              type: 'fact',
              content: `[This Day ${month}/${day}] ${pastMemories.length} 条历史上的今天记忆: ${sample.map(m => m.content).join('; ')}`,
              keywords: ['this_day_in_history', `${month}/${day}`, 'temporal_memory'],
              confidence: 1.0,
              sourceInteractionId: 'memory_this_day_scheduler',
              agentId: undefined,
            } as any, { tier: 'episodic', perspective: 'lumi_self', importance: 0.4, domain: 'personal', orgId: '', source: 'system', privacyClass: 'private' });
          }
        } catch (err: any) {
          console.warn(`[MemoryThisDay] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      return messages.length > 0
        ? `历史上的今天 — ${messages.join('\n')}`
        : null;
    },
  });

  // ── Spatiotemporal pattern analysis (every 6h) — detect location+time patterns ──
  scheduler.register({
    id: 'spatiotemporal_analysis',
    cron: 'every_6h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const userIds = getAllUserIds();
      const messages: string[] = [];

      for (const userId of userIds) {
        try {
          const patterns = detectSpatiotemporalPatterns(userId, 'personal', '');
          if (patterns.length > 0) {
            // Store new patterns as growth memories
            const { addMemory } = await import('./memory');
            const newPatterns = patterns.filter(p => p.confidence >= 0.5);
            for (const p of newPatterns.slice(0, 3)) {
              addMemory({
                userId,
                type: 'habit',
                content: `[时空模式] ${p.description}`,
                keywords: ['spatiotemporal_pattern', p.type, 'lumi_learning'],
                confidence: p.confidence,
                sourceInteractionId: 'spatiotemporal_analysis_scheduler',
                agentId: undefined,
              } as any, { tier: 'growth', perspective: 'lumi_self', importance: 0.5, domain: 'personal', orgId: '', source: 'system', privacyClass: 'private' });
            }
            messages.push(
              `[${userId}] 发现 ${newPatterns.length} 个时空行为模式`,
            );
          }
        } catch (err: any) {
          console.warn(`[SpatiotemporalAnalysis] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      return messages.length > 0
        ? `时空模式分析 — ${messages.join('\n')}`
        : null;
    },
  });

  // Ephemeral agent cleanup (every 1h) — removes orphaned auto-created workers
  scheduler.register({
    id: 'ephemeral_cleanup',
    cron: 'every_1h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      const removed = cleanupEphemeralAgents(6);
      if (removed > 0) {
        return `Cleaned up ${removed} ephemeral worker agents`;
      }
      return null;
    },
  });

  // ── Ambient Awareness Tasks ──

  // Activity poll (every 10s) — requests ambient state from all connected Tauri clients
  scheduler.register({
    id: 'ambient_activity_poll',
    cron: 'every_10s',
    lastRun: null,
    executionClass: 'client_probe',
    auditMode: 'compact',
    handler: async () => {
      if (scheduler.io) {
        const payload = { timestamp: new Date().toISOString() };
        for (const userId of getAllUserIds()) {
          scheduler.io.to(`user:${userId}:personal`).emit('ambient:poll_request', payload);
        }
      }
      return null; // Silent — frontend handles the actual work
    },
  });

  // Idle check (every 1min) — suppresses notifications during active use
  scheduler.register({
    id: 'idle_check',
    cron: 'every_1m',
    lastRun: null,
    executionClass: 'client_probe',
    auditMode: 'compact',
    handler: async () => {
      if (scheduler.io) {
        const payload = { timestamp: new Date().toISOString() };
        for (const userId of getAllUserIds()) {
          scheduler.io.to(`user:${userId}:personal`).emit('ambient:idle_check', payload);
        }
      }
      return null;
    },
  });

  // ── Autonomous work cycle (every 10 min) — background task generation + execution ──
  scheduler.register({
    id: 'autonomous_work_cycle',
    cron: 'every_10m',
    quiet: true,
    lastRun: null,
    executionClass: 'autonomous_orchestration',
    handler: async () => {
      if (!scheduler.io) return null;

      const userIds = getAllUserIds();
      let totalGenerated = 0;
      let totalExecuted = 0;

      const getters: LLMGetters = {
        getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
        getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay,
      };

      for (const userId of userIds) {
        try {
          // Check if user has autonomous mode enabled
          const db = readDB();
          const modeSetting = (db.settings || []).find((s: any) =>
            s.key === `op_mode_${userId}`
          );
          const mode = modeSetting ? parseStoredOperationMode(modeSetting.value) : 'assistant';
          if (mode !== 'autonomous') continue;

          // Generate tasks
          const { generateAutonomousTasks } = await import('./autonomy/task_generator');
          const generated = await generateAutonomousTasks(userId, getters);
          totalGenerated += generated;

          // Execute pending tasks, bounded by the current safety gate.
          const { executeNextAutonomousTask } = await import('./autonomy/task_executor');
          const maxTasks = Math.max(1, Math.min(50, getGateConfig(userId).maxConsecutiveTasks || 1));
          for (let i = 0; i < maxTasks; i++) {
            const result = await executeNextAutonomousTask(scheduler.io!, getters, userId);
            if (!result.executed) break;
            totalExecuted++;
          }
        } catch (err: any) {
          console.warn(`[AutoWorkCycle] Failed for ${redactSchedulerDiagnostic(userId)}:`, redactSchedulerDiagnostic(err));
        }
      }

      if (totalGenerated > 0 || totalExecuted > 0) {
        return `Generated ${totalGenerated} tasks, executed ${totalExecuted}`;
      }
      return null;
    },
  });

  // ── Daily System Scan — Lumi checks the PC's health ──
  scheduler.register({
    id: 'daily_system_scan',
    cron: 'every_24h',
    quiet: true,
    lastRun: null,
    executionClass: 'maintenance',
    handler: async () => {
      if (!isFirstBootComplete() || !isSystemExplorationAllowed()) return null;
      let collected;
      try {
        collected = await collectSystemSnapshotInWorker(resolveSystemExplorationRuntimeDir());
      } catch (error) {
        // Bootstrap, an explicit user refresh, and the daily refresh share one
        // isolated worker. A concurrent scan is already producing the same
        // bounded snapshot, so the maintenance tick can safely yield.
        if (error instanceof SystemExplorationAlreadyRunningError) return null;
        throw error;
      }
      // Consent can be withdrawn while the worker is inspecting the host.
      // Never persist or broadcast a result collected after that boundary.
      if (!isSystemExplorationAllowed()) return null;
      const snapshot = persistDailyExploration(collected);

      // Host diagnostics belong to the local/system administration surface,
      // never to organization members as organization knowledge.
      if (scheduler.io) {
        for (const userId of getSystemAdminUserIds()) {
          scheduler.io.to(`user:${userId}:personal`).emit('system:scan_result', {
            timestamp: snapshot.timestamp,
            computerScope: 'server_host',
            hostname: snapshot.hardware.hostname,
            summary: snapshot.changeSummary,
            diskFree: snapshot.hardware.disks.map(d => `${d.name}: ${d.freeGB.toFixed(1)}GB free`),
            appCount: snapshot.software.installedApps.length,
          });
        }
      }

      return null;
    },
  });
}



