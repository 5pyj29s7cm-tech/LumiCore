import crypto from 'node:crypto';
import type {
  ConversationActionReceiptRow,
  ConversationActionTaskRow,
  PersistedCapabilityExecutionPlan,
} from '../conversation/action_ledger';
import { readConversationFocusThread, type ConversationFocusThread } from '../conversation/focus_threads';

export type RuntimeAttentionLevel = 'ready' | 'working' | 'attention';

export interface RuntimeEvidenceReceipt {
  receiptId: string;
  taskId: string;
  toolName: string;
  targetIdentity: string;
  outcome: string;
  verification: 'verified' | 'unverified' | 'failed';
  requestId: string;
  idempotencyRef: string;
  createdAt: string;
}

export interface RuntimeTaskProjection {
  taskId: string;
  parentTaskId: string;
  goal: string;
  target: string;
  intentKind: string;
  operation: string;
  status: string;
  blocker: string;
  activeRequest: boolean;
  completionSource: string;
  revision: number;
  updatedAt: string;
  focus: ConversationFocusThread;
  plan?: {
    planId: string;
    sideEffectClass: string;
    requiresConfirmation: boolean;
    nodeCount: number;
    decisionAuthority: string;
    scriptAuthority: string;
  };
  evidence: {
    total: number;
    verified: number;
    failed: number;
    unknown: number;
    latest: RuntimeEvidenceReceipt[];
  };
}

export interface StructuredRuntimeStatus {
  schemaVersion: 1;
  snapshotId: string;
  generatedAt: string;
  scope: { domain: 'personal' | 'work'; orgId: string };
  level: RuntimeAttentionLevel;
  attentionReasons: string[];
  counts: {
    activeTasks: number;
    waitingConfirmation: number;
    blockedTasks: number;
    verifiedReceipts: number;
    failedReceipts: number;
    unknownReceipts: number;
    autonomousActive: number;
    durableBlocked: number;
  };
  tasks: RuntimeTaskProjection[];
  durableWork: Array<{
    taskId: string;
    runtime: 'autonomous';
    status: string;
    title: string;
    checkpoint: string;
    updatedAt: string;
  }>;
  runtime: {
    toolMetrics?: Record<string, any>;
    capabilityMetrics?: Record<string, any>;
    voiceLatency?: Record<string, any>;
    supervisor?: Record<string, any>;
    readOnlyContextCache?: Record<string, any>;
  };
  safety: {
    externalCommitConfirmationRequired: true;
    unknownExternalOutcomeReplayBlocked: true;
    legacyExternalFallbackDisabled: true;
    payloadsExcluded: true;
  };
}

function compact(value: unknown, limit = 700): string {
  return String(value || '')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret))\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function parseObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function projectReceipt(row: ConversationActionReceiptRow): RuntimeEvidenceReceipt {
  const envelope = parseObject(row.envelope);
  const verification = String(envelope.verification?.status || 'unverified');
  return {
    receiptId: compact(row.id, 180),
    taskId: compact(row.taskId, 180),
    toolName: compact(row.toolName, 160),
    targetIdentity: compact(row.targetIdentity, 300),
    outcome: compact(row.outcome || envelope.status, 60),
    verification: verification === 'verified' || verification === 'failed' ? verification : 'unverified',
    requestId: compact(row.requestId, 180),
    idempotencyRef: compact(row.idempotencyKey, 16),
    createdAt: compact(row.createdAt, 80),
  };
}

function projectPlan(task: ConversationActionTaskRow): RuntimeTaskProjection['plan'] | undefined {
  const context = parseObject(task.context);
  const plan = parseObject(context.executionPlan) as PersistedCapabilityExecutionPlan | Record<string, any>;
  if (!plan.planId) return undefined;
  return {
    planId: compact(plan.planId, 180),
    sideEffectClass: compact(plan.risk?.sideEffectClass, 60),
    requiresConfirmation: Boolean(plan.risk?.requiresConfirmation),
    nodeCount: Array.isArray(plan.nodes) ? plan.nodes.length : 0,
    decisionAuthority: compact(plan.decisionAuthority, 80),
    scriptAuthority: compact(plan.scriptAuthority, 80),
  };
}

function outcomeIsUnknown(outcome: string): boolean {
  return outcome === 'unknown_outcome' || outcome === 'timeout' || outcome === 'target_mismatch';
}

function projectTask(task: ConversationActionTaskRow, receipts: ConversationActionReceiptRow[]): RuntimeTaskProjection {
  const evidence = receipts
    .filter(receipt => receipt.taskId === task.id)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .map(projectReceipt);
  return {
    taskId: compact(task.id, 180),
    parentTaskId: compact(task.parentTaskId, 180),
    goal: compact(task.goal, 700),
    target: compact(task.target, 300),
    intentKind: compact(task.intentKind, 80),
    operation: compact(task.operation, 80),
    status: compact(task.status, 60),
    blocker: compact(task.blocker, 500),
    activeRequest: Boolean(task.activeRequestId),
    completionSource: compact(task.completionSource, 80),
    revision: Math.max(1, Number(task.revision) || 1),
    updatedAt: compact(task.updatedAt, 80),
    focus: readConversationFocusThread(task),
    ...(projectPlan(task) ? { plan: projectPlan(task) } : {}),
    evidence: {
      total: evidence.length,
      verified: evidence.filter(receipt => receipt.outcome === 'verified_success' && receipt.verification === 'verified').length,
      failed: evidence.filter(receipt => receipt.outcome === 'failed' || receipt.verification === 'failed').length,
      unknown: evidence.filter(receipt => outcomeIsUnknown(receipt.outcome)).length,
      latest: evidence.slice(0, 5),
    },
  };
}

function isActionActiveStatus(status: string): boolean {
  return ['created', 'planning', 'executing', 'verifying', 'waiting_confirmation'].includes(status);
}

function isDurableActiveStatus(status: string): boolean {
  return ['queued', 'pending', 'running', 'pausing', 'cancelling'].includes(status);
}

function hashSnapshot(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

export function buildStructuredRuntimeStatus(
  db: any,
  input: {
    userId: string;
    domain: 'personal' | 'work';
    orgId?: string;
    now?: string;
    runtime?: StructuredRuntimeStatus['runtime'];
  },
): StructuredRuntimeStatus {
  const orgId = input.domain === 'work' ? compact(input.orgId, 180) : '';
  const actionTasks = (Array.isArray(db?.conversationActionTasks) ? db.conversationActionTasks : [])
    .filter((task: ConversationActionTaskRow) => (
      task.userId === input.userId
      && (task.domain || 'personal') === input.domain
      && (input.domain !== 'work' || task.orgId === orgId)
    )) as ConversationActionTaskRow[];
  const actionReceipts = (Array.isArray(db?.conversationActionReceipts) ? db.conversationActionReceipts : [])
    .filter((receipt: ConversationActionReceiptRow) => actionTasks.some(task => task.id === receipt.taskId)) as ConversationActionReceiptRow[];
  const allTaskProjections = actionTasks
    .sort((left, right) => {
      const activeDifference = Number(isActionActiveStatus(right.status)) - Number(isActionActiveStatus(left.status));
      return activeDifference || String(right.updatedAt).localeCompare(String(left.updatedAt));
    })
    .map(task => projectTask(task, actionReceipts));
  const tasks = allTaskProjections.slice(0, 12);

  const autonomous = input.domain === 'personal'
    ? (Array.isArray(db?.autonomousTasks) ? db.autonomousTasks : [])
      .filter((task: any) => task.userId === input.userId)
      .map((task: any) => ({
        taskId: compact(task.id, 180),
        runtime: 'autonomous' as const,
        status: compact(task.status, 60),
        title: compact(task.title, 500),
        checkpoint: compact(task.checkpoint?.phase, 120),
        updatedAt: compact(task.updatedAt || task.createdAt, 80),
      }))
    : [];
  const durableWork = autonomous
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, 12);

  const activeTasks = allTaskProjections.filter(task => ['created', 'planning', 'executing', 'verifying'].includes(task.status)).length;
  const waitingConfirmation = allTaskProjections.filter(task => task.status === 'waiting_confirmation').length;
  const blockedTasks = allTaskProjections.filter(task => task.status === 'blocked').length;
  const verifiedReceipts = allTaskProjections.reduce((sum, task) => sum + task.evidence.verified, 0);
  const failedReceipts = allTaskProjections.reduce((sum, task) => sum + task.evidence.failed, 0);
  const unknownReceipts = allTaskProjections.reduce((sum, task) => sum + task.evidence.unknown, 0);
  const autonomousActive = autonomous.filter(task => isDurableActiveStatus(task.status)).length;
  const durableBlocked = durableWork.filter(task => task.status === 'blocked' || task.status === 'failed').length;
  const attentionReasons = [
    ...(waitingConfirmation > 0 ? ['waiting_confirmation'] : []),
    ...(blockedTasks > 0 ? ['blocked_task'] : []),
    ...(failedReceipts > 0 ? ['failed_receipt'] : []),
    ...(unknownReceipts > 0 ? ['unknown_or_unverified_outcome'] : []),
    ...(durableBlocked > 0 ? ['durable_work_blocked'] : []),
  ];
  const level: RuntimeAttentionLevel = attentionReasons.length > 0
    ? 'attention'
    : activeTasks + autonomousActive > 0
      ? 'working'
      : 'ready';
  const structuralState = {
    scope: { domain: input.domain, orgId },
    level,
    attentionReasons,
    tasks,
    durableWork,
  };

  return {
    schemaVersion: 1,
    snapshotId: `runtime_${hashSnapshot(structuralState)}`,
    generatedAt: input.now || new Date().toISOString(),
    scope: structuralState.scope,
    level,
    attentionReasons,
    counts: {
      activeTasks,
      waitingConfirmation,
      blockedTasks,
      verifiedReceipts,
      failedReceipts,
      unknownReceipts,
      autonomousActive,
      durableBlocked,
    },
    tasks,
    durableWork,
    runtime: input.runtime || {},
    safety: {
      externalCommitConfirmationRequired: true,
      unknownExternalOutcomeReplayBlocked: true,
      legacyExternalFallbackDisabled: true,
      payloadsExcluded: true,
    },
  };
}
