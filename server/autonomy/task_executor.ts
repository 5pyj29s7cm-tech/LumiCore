/**
 * Autonomous Task Executor — processes the autonomous task queue.
 * Executes tasks via runWithTools with tighter safety policy than user-initiated autonomous mode.
 */
import {
  attachAutonomousExecutionPlan,
  checkpointAutonomousTask,
  dequeue,
  markRunning,
  markCompleted,
  markCancelled,
  getRunningTask,
  heartbeatAutonomousTask,
  isTaskCancellationRequested,
  isTaskPauseRequested,
  markPaused,
  requestPauseAutonomousTask,
  recordAutonomousTaskFailure,
} from './task_queue';
import { getGateConfig, isAutonomousWorkAllowed, recordAutonomousTokens } from './safety_gate';
import { runWithTools } from '../llm/adapter';
import { toolRegistry, type ToolRegistry } from '../tools/registry';
import { ToolContext, ToolExecutionRecord } from '../tools/types';
import { canAutoApproveAction } from '../tools/action_constitution';
import { Server as SocketIOServer } from 'socket.io';
import type { AutonomousTask } from './task_queue';
import { getUserPreferredLLMConfig } from '../llm/user_preferences';
import { formatLumiConstitutionForPrompt } from '../personality/constitution';
import { getPlan, updatePlan, updatePlanStep } from './planner';
import { createDesktopRelay } from '../socket/desktop_relay';
import type { PlanScope } from './planner';
import { isRealtimeUserActive } from './foreground_activity';
import { finalizeLumiResponse } from '../cognition/result_finalizer';
import {
  buildActionContract,
  hasCoreActionEvidence,
} from '../cognition/action_contract';
import {
  buildLumiExecutionPipeline,
  type LumiExecutionPipeline,
} from '../cognition/execution_pipeline';
import { sanitizeCapabilityExecutionPlan } from '../conversation/action_ledger';
import { snapshotDurableToolRecords } from '../cognition/durable_task_recovery';

interface LLMGetters {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI?: () => any;
  getAnthropic?: () => any;
  getQwen?: () => any;
  getXiaomi?: () => any;
  getKimi?: () => any;
  getGlm?: () => any;
  getRelay?: () => any;
}

/** Tight tool policy for autonomous background work — more conservative than user-initiated mode */
const AUTONOMOUS_POLICY = {
  allowedTools: ['*'],
  requireConfirmation: [],
  forbiddenTools: [
    'delete_file',
    'run_command',   // shell remains available but gated below
    'system_command',
  ],
  maxIterations: 50,
};

const LOCAL_BODY_LEARNING_TOOLS = [
  'desktop_system_info',
  'desktop_list_apps',
  'desktop_list_files',
  'desktop_path_info',
  'desktop_running_processes',
  'desktop_active_window',
  'get_active_window_info',
  'get_running_processes',
  'desktop_idle_time',
  'desktop_poll_activity',
  'adapter_registry_list',
  'work_product_plan',
  'work_product_verify',
];

export function isLocalBodyLearningTask(task: Pick<AutonomousTask, 'title' | 'description'>): boolean {
  return /本机身体|local machine body|desktop body|local body|desktop_body_map|local_machine_awareness/i
    .test(`${task.title || ''}\n${task.description || ''}`);
}

export function buildAutonomousToolPolicy(
  task: Pick<AutonomousTask, 'title' | 'description'> & Partial<Pick<AutonomousTask, 'executionPlan' | 'recovery'>>,
  maxIterations: number,
) {
  const recoveryToolBoundary = task.recovery?.planRevisions?.length && task.executionPlan
    ? Array.from(new Set(task.executionPlan.nodes
        .map(node => node.toolName)
        .filter((name): name is string => Boolean(name))))
    : [];
  const narrowForRecovery = (policy: typeof AUTONOMOUS_POLICY) => recoveryToolBoundary.length > 0
    ? { ...policy, allowedTools: recoveryToolBoundary }
    : policy;
  if (isLocalBodyLearningTask(task)) {
    return narrowForRecovery({
      allowedTools: LOCAL_BODY_LEARNING_TOOLS,
      requireConfirmation: [],
      forbiddenTools: AUTONOMOUS_POLICY.forbiddenTools,
      maxIterations: Math.min(maxIterations, 16),
    });
  }
  return narrowForRecovery({ ...AUTONOMOUS_POLICY, maxIterations });
}

export function buildAutonomousCapabilityPipeline(
  task: Pick<AutonomousTask, 'id' | 'userId' | 'description' | 'source' | 'title'>
    & Partial<Pick<AutonomousTask, 'executionPlan' | 'recovery'>>,
  maxIterations: number,
  registry: ToolRegistry = toolRegistry,
): LumiExecutionPipeline {
  const policy = buildAutonomousToolPolicy(task, maxIterations);
  return buildLumiExecutionPipeline({
    dispatch: {
      userId: task.userId,
      text: task.description || task.title,
      channel: task.source === 'scheduler' ? 'scheduler' : 'agent',
      source: `autonomous:${task.source}`,
      operationMode: 'autonomous',
      targetIsLumi: true,
      surface: 'work',
    },
    registry,
    personalityToolPolicy: policy,
    decisionText: task.description || task.title,
    traceText: task.description || task.title,
    source: `autonomous:${task.source}`,
    taskId: task.id,
  });
}

function clipPlanResult(value: string, max = 1800): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

const INCOMPLETE_AUTONOMOUS_TOOL_STATUSES = new Set([
  'blocked',
  'cancelled',
  'canceled',
  'draft',
  'error',
  'failed',
  'in_progress',
  'partial',
  'pending',
  'prepared',
  'queued',
  'requires_setup',
  'submitted_unverified',
  'timeout',
  'timed_out',
  'unknown',
  'unverified',
]);

function parseStructuredToolResult(value: string): Record<string, unknown> | null {
  let parsed: unknown = String(value || '').trim();
  for (let attempt = 0; attempt < 3 && typeof parsed === 'string'; attempt += 1) {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

export function isSuccessfulAutonomousToolRecord(record: ToolExecutionRecord): boolean {
  if (record.error || !String(record.result || '').trim()) return false;
  const payload = parseStructuredToolResult(record.result);
  if (!payload) return true;
  if (
    payload.ok === false
    || payload.success === false
    || payload.verified === false
    || payload.completed === false
    || payload.completionMarkerExists === false
  ) {
    return false;
  }
  if (typeof payload.error === 'string' && payload.error.trim()) return false;
  const status = typeof payload.status === 'string' ? payload.status.trim().toLowerCase() : '';
  return !status || !INCOMPLETE_AUTONOMOUS_TOOL_STATUSES.has(status);
}

function autonomousResponseReportsIncomplete(value: string): boolean {
  const text = String(value || '').trim();
  if (!text) return true;
  return /(?:\b(?:could\s+not|couldn't|unable\s+to|failed\s+to|not\s+completed|not\s+finished|incomplete|unfinished|blocked|requires?\s+(?:user\s+)?confirmation)\b|(?:\u672a\u5b8c\u6210|\u6ca1\u6709\u5b8c\u6210|\u65e0\u6cd5\u5b8c\u6210|\u4e0d\u80fd\u5b8c\u6210|\u53d7\u963b|\u6267\u884c\u5931\u8d25|\u9700\u8981\u7528\u6237\u786e\u8ba4))/iu.test(text);
}

export interface AutonomousTaskOutcome {
  text: string;
  blocked: boolean;
  verified: boolean;
  reason: string;
  successfulToolRecords: ToolExecutionRecord[];
}

export function evaluateAutonomousTaskOutcome(
  taskText: string,
  responseText: string,
  toolRecords: ToolExecutionRecord[],
): AutonomousTaskOutcome {
  const candidateText = String(responseText || '').trim();
  const finalized = finalizeLumiResponse({
    taskText,
    responseText: candidateText || 'Autonomous task returned no final summary.',
    toolRecords,
    source: 'autonomous',
  });
  const successfulToolRecords = toolRecords.filter(isSuccessfulAutonomousToolRecord);
  const actionContract = buildActionContract(taskText);
  const missingSummary = !candidateText;
  const reportedIncomplete = autonomousResponseReportsIncomplete(candidateText);
  const missingEvidence = successfulToolRecords.length === 0;
  const missingCoreEvidence = actionContract.applies
    && !hasCoreActionEvidence(actionContract, toolRecords, taskText);
  const verified = (
    !finalized.blocked
    && !missingSummary
    && !reportedIncomplete
    && !missingEvidence
    && !missingCoreEvidence
  );
  const reason = finalized.blocked
    ? finalized.reason || 'Autonomous completion claim was not supported by its tool ledger.'
    : missingCoreEvidence
      ? `Missing core evidence for autonomous ${actionContract.kind}.`
      : missingEvidence
      ? 'No successful autonomous tool evidence was recorded.'
      : missingSummary
        ? 'Autonomous execution returned no final summary.'
        : reportedIncomplete
          ? 'Autonomous execution reported that the task was incomplete or blocked.'
          : finalized.reason || '';

  return {
    text: finalized.text,
    blocked: finalized.blocked || !verified,
    verified,
    reason,
    successfulToolRecords,
  };
}

function upsertToolLedger(ledger: ToolExecutionRecord[], record: ToolExecutionRecord): void {
  const id = String(record.id || '').trim();
  const index = id
    ? ledger.findIndex(item => item.id === id)
    : ledger.findIndex(item => (
        item.name === record.name
        && JSON.stringify(item.arguments || {}) === JSON.stringify(record.arguments || {})
      ));
  const normalized: ToolExecutionRecord = {
    ...record,
    arguments: { ...(record.arguments || {}) },
    result: record.result || '',
  };
  if (index >= 0) ledger[index] = normalized;
  else ledger.push(normalized);
}

function planScopeForTask(task: AutonomousTask): PlanScope {
  return { userId: task.userId, domain: 'personal', orgId: '' };
}

function markLinkedPlanRunning(task: AutonomousTask) {
  if (!task.planId) return;
  const scope = planScopeForTask(task);
  const plan = getPlan(task.planId, scope);
  if (!plan || plan.status !== 'active') return;
  const step = plan.steps.find(item => item.status === 'in_progress')
    || plan.steps.find(item => item.status === 'pending');
  if (step) {
    updatePlanStep(plan.id, step.id, {
      status: 'in_progress',
      result: `Autonomous task started: ${task.title}`,
    }, scope);
  }
}

function markLinkedPlanCompleted(task: AutonomousTask, summary: string) {
  if (!task.planId) return;
  const scope = planScopeForTask(task);
  const plan = getPlan(task.planId, scope);
  if (!plan) return;
  const clipped = clipPlanResult(summary);
  const step = plan.steps.find(item => item.status === 'in_progress')
    || plan.steps.find(item => item.status === 'pending');
  if (!step) return;
  const updatedPlan = updatePlanStep(plan.id, step.id, {
    status: 'done',
    result: clipped,
  }, scope);
  if (updatedPlan?.status === 'completed') {
    updatePlan(plan.id, { result: clipped }, scope);
  }
}

function markLinkedPlanFailed(task: AutonomousTask, error: string) {
  if (!task.planId) return;
  const scope = planScopeForTask(task);
  const plan = getPlan(task.planId, scope);
  if (!plan) return;
  const clipped = clipPlanResult(`自主学习受阻：${error}`, 1000);
  const step = plan.steps.find(item => item.status === 'in_progress')
    || plan.steps.find(item => item.status === 'pending');

  if (step) {
    updatePlanStep(plan.id, step.id, {
      status: 'skipped',
      result: clipped,
    }, scope);
  }

  updatePlan(plan.id, {
    status: 'paused',
    result: clipped,
  }, scope);
}

function markLinkedPlanCancelled(task: AutonomousTask) {
  if (!task.planId) return;
  const scope = planScopeForTask(task);
  const plan = getPlan(task.planId, scope);
  if (!plan) return;
  const message = 'Autonomous task cancelled by user';
  const step = plan.steps.find(item => item.status === 'in_progress');
  if (step) updatePlanStep(plan.id, step.id, { status: 'skipped', result: message }, scope);
  updatePlan(plan.id, { status: 'cancelled', result: message }, scope);
}

export async function executeNextAutonomousTask(
  io: SocketIOServer,
  getters: LLMGetters,
  userId?: string,
): Promise<{ executed: boolean; taskId?: string; result?: string }> {
  if (userId && isRealtimeUserActive(userId)) {
    return { executed: false, result: 'Live user voice session has priority' };
  }
  // Don't start a new task if one is already running
  if (getRunningTask(userId)) {
    return { executed: false, result: 'Task already running' };
  }

  const task = dequeue(userId);
  if (!task) return { executed: false };

  const gate = isAutonomousWorkAllowed(task.userId);
  if (!gate.allowed) {
    return { executed: false, taskId: task.id, result: `Blocked by safety gate: ${gate.reason || 'not allowed'}` };
  }

  const running = markRunning(task.id);
  if (!running) return { executed: false };
  if (!running.leaseId) return { executed: false, taskId: task.id, result: 'Task lease was not created' };
  let leaseLost = false;
  const leaseHeartbeat = setInterval(() => {
    const renewed = heartbeatAutonomousTask(task.id, running.leaseId!);
    if (!renewed) {
      leaseLost = true;
      clearInterval(leaseHeartbeat);
    }
  }, 20_000);
  if (typeof (leaseHeartbeat as any).unref === 'function') (leaseHeartbeat as any).unref();
  markLinkedPlanRunning(running);
  let releaseDesktopControlLease = () => undefined;
  const toolLedger: ToolExecutionRecord[] = [];
  let sideEffectClass = running.executionPlan?.risk.sideEffectClass;

  io.to(`user:${task.userId}:personal`).emit('autonomous:task_started', {
    taskId: task.id,
    title: task.title,
    mode: task.mode,
    timestamp: new Date().toISOString(),
  });

  try {
    const currentGate = getGateConfig(task.userId);
    const maxIterations = currentGate.autonomyLevel === 'full' ? 50 : 30;
    // Build desktop relay using the user's registered desktop client, not a broad user-room broadcast.
    const desktopRelay = createDesktopRelay({
      io,
      userId: task.userId,
      domain: 'personal',
      orgId: '',
      source: 'autonomous',
      taskId: task.id,
      onControlPaused: () => {
        requestPauseAutonomousTask(task.id, task.userId);
      },
    });
    releaseDesktopControlLease = () => desktopRelay.releaseControlLease('autonomous_task_complete');

    const executionPipeline = buildAutonomousCapabilityPipeline(running, maxIterations);
    sideEffectClass = executionPipeline.executionPlan.risk.sideEffectClass;
    attachAutonomousExecutionPlan(
      running.id,
      sanitizeCapabilityExecutionPlan(executionPipeline.executionPlan, new Date().toISOString()),
      running.leaseId,
    );
    checkpointAutonomousTask(running.id, {
      phase: 'planned',
      receiptIds: running.checkpoint?.receiptIds,
      receipts: running.checkpoint?.receipts,
      detail: `Capability plan persisted for attempt ${running.attempt || 1}`,
    }, running.leaseId);
    if (executionPipeline.executionPlan.risk.sideEffectClass === 'external_commit') {
      throw new Error('Autonomous external commit blocked: an action-time immutable user confirmation is required.');
    }
    const toolPolicy = executionPipeline.execution.toolPolicy;

    const context: ToolContext = {
      userId: task.userId,
      taskId: running.id,
      desktopRelay: task.mode === 'desktop' ? desktopRelay : undefined,
      requestConfirmation: async (toolName, args) => canAutoApproveAction(toolName, args, { actionIntent: task.description }),
      actionIntent: task.description,
      routedTaskText: executionPipeline.turnIntent.flow.routeText,
      toolPolicy,
      isCancelled: () => isTaskCancellationRequested(task.id, task.userId)
        || isTaskPauseRequested(task.id, task.userId)
        || isRealtimeUserActive(task.userId)
        || leaseLost,
      autonomous: true,
      source: 'autonomous',
      idempotencyKey: running.idempotencyKey,
    };

    const messages = [
      { role: 'system' as const, content: [
        `You are Lumi executing an autonomous background task. You work independently without user interaction. Be efficient and direct. Current task mode: ${task.mode}.`,
        formatLumiConstitutionForPrompt(),
        executionPipeline.capabilityPlan.promptOverlay,
        ...(running.recovery?.planRevisions?.length
          ? [`This is durable recovery attempt ${running.attempt}. Follow the latest persisted recovery revision: ${running.recovery.planRevisions.at(-1)?.strategy}. Do not repeat any side effect from a prior receipt. If exact prior state cannot be reconciled, stop and report the blocker.`]
          : []),
        'For concrete deliverables, define the work product with work_product_plan, verify it with work_product_verify or domain-specific verification tools, repair failed criteria, and only then mark the task complete. If confirmation or missing input blocks progress, report the blocker.',
        'For autonomous web learning, you may use public web_search, url_fetch, and authority_research. Treat them as observation: cite URLs, retrieval time, confidence, and uncertainty. Choose research topics from the user industry habits in the task context: common platforms, vocabulary, deliverable formats, verification standards, compliance boundaries, and repeated real workflows. Avoid generic trend learning unless it clearly improves that user’s industry workflow. For desktop AI/tool catalog learning, use desktop_ai_list_targets and desktop_ai_discovery_plan, then produce source-grounded candidate JSON for later registration. Do not use login-required, paid, captcha, QR/OTP, private, or account-authorization pages as completed sources. Do not call authority_research_save, desktop_ai_register_target, or other long-term knowledge/configuration writes unless the task itself contains explicit user authorization; otherwise produce source-grounded knowledge or target candidates for later absorption.',
        'For autonomous local machine/body learning, only use observation tools for OS info, top-level file/folder landmarks, launchable apps, active/running processes, idle/activity signals, and adapter inventory. Do not open apps or files, click, type, capture screenshots, run commands, read file contents, move/copy/delete files, or infer private facts from filenames. Produce a local body map with evidence, uncertainty, useful app/file landmarks, industry-relevant tools, and next exploration items that need user confirmation.',
        'Store internal reports and other files created by this background task with write_file. Lumi confines those files to its dedicated autonomy report data directory; never present a source-project path as the saved location.',
      ].join('\n\n') },
      { role: 'user' as const, content: task.description },
    ];

    const result = await runWithTools(
      messages,
      toolRegistry,
      getUserPreferredLLMConfig(task.userId, { maxTokens: 2000 }),
      (record) => {
        upsertToolLedger(toolLedger, record);
        if (record.result !== undefined || record.error !== undefined) {
          checkpointAutonomousTask(running.id, {
            phase: 'tool_execution',
            iteration: toolLedger.length,
            receiptIds: Array.from(new Set([
              ...(running.checkpoint?.receiptIds || []),
              ...toolLedger.map(item => item.id).filter((id): id is string => Boolean(id)),
            ])),
            receipts: [
              ...(running.checkpoint?.receipts || []),
              ...snapshotDurableToolRecords(toolLedger),
            ],
            detail: `${toolLedger.length} terminal tool call(s) observed`,
          }, running.leaseId);
        }
      },
      maxIterations,
      getters.getDeepSeek, getters.getGemini,
      getters.getOpenAI || (() => null),
      getters.getAnthropic || (() => null),
      getters.getQwen || (() => null),
      undefined, // onStreamChunk
      context,
      undefined, undefined, // ollama, lmstudio
      undefined, // ark
      getters.getXiaomi, getters.getKimi, getters.getGlm, getters.getRelay,
    );

    for (const record of result.toolCalls) upsertToolLedger(toolLedger, record);
    const toolCallCount = toolLedger.length;
    const tokensUsed = result.usageRecords.reduce((sum, r) => sum + r.totalTokens, 0);
    recordAutonomousTokens(task.userId, tokensUsed);

    if (isTaskPauseRequested(task.id, task.userId)) {
      markPaused(task.id);
      io.to(`user:${task.userId}:personal`).emit('autonomous:task_paused', {
        taskId: task.id,
        title: task.title,
        timestamp: new Date().toISOString(),
      });
      return { executed: true, taskId: task.id, result: 'Paused' };
    }
    if (isTaskCancellationRequested(task.id, task.userId) || isRealtimeUserActive(task.userId)) {
      const reason = isRealtimeUserActive(task.userId)
        ? 'Cancelled because a live user voice session took priority'
        : 'Cancelled by user';
      markCancelled(task.id, reason);
      markLinkedPlanCancelled(task);
      io.to(`user:${task.userId}:personal`).emit('autonomous:task_cancelled', {
        taskId: task.id,
        title: task.title,
        timestamp: new Date().toISOString(),
      });
      return { executed: true, taskId: task.id, result: 'Cancelled by user' };
    }

    const outcome = evaluateAutonomousTaskOutcome(
      `${task.title}\n${task.description}`.trim(),
      result.text,
      toolLedger,
    );
    if (!outcome.verified) {
      const failureReason = outcome.reason || 'Autonomous completion could not be verified.';
      const receiptSnapshots = snapshotDurableToolRecords(toolLedger);
      checkpointAutonomousTask(task.id, {
        phase: 'failed_verification',
        receiptIds: toolLedger.map(item => item.id).filter((id): id is string => Boolean(id)),
        receipts: receiptSnapshots,
        detail: failureReason,
      }, running.leaseId);
      const settled = recordAutonomousTaskFailure(task.id, {
        error: failureReason,
        verificationFailure: true,
        receiptSnapshots,
        sideEffectClass: executionPipeline.executionPlan.risk.sideEffectClass,
        leaseLost,
      }, running.leaseId);
      if (!settled) {
        return { executed: true, taskId: task.id, result: 'Task lease was lost; stale completion was discarded.' };
      }
      const willRetry = settled.status === 'pending';
      if (!willRetry) markLinkedPlanFailed(task, failureReason);
      io.to(`user:${task.userId}:personal`).emit(willRetry ? 'autonomous:task_retry_scheduled' : 'autonomous:task_failed', {
        taskId: task.id,
        title: task.title,
        error: failureReason,
        result: outcome.text,
        toolCallsCount: toolCallCount,
        tokensUsed,
        finalized: !willRetry,
        blocked: !willRetry,
        verified: false,
        reason: outcome.reason,
        status: settled.status,
        nextAttemptAt: settled.nextAttemptAt,
        diagnosis: settled.recovery?.diagnoses.at(-1),
        timestamp: new Date().toISOString(),
      });
      console.warn(
        `[AutoExecutor] Task "${task.title}" not marked complete: ${outcome.reason} `
        + `(${outcome.successfulToolRecords.length}/${toolCallCount} successful tools)`,
      );
      return {
        executed: true,
        taskId: task.id,
        result: willRetry ? `Retry scheduled: ${settled.nextAttemptAt}` : outcome.text || failureReason,
      };
    }

    const summary = outcome.text;
    checkpointAutonomousTask(task.id, {
      phase: 'verified',
      receiptIds: toolLedger.map(item => item.id).filter((id): id is string => Boolean(id)),
      receipts: snapshotDurableToolRecords(toolLedger),
      detail: outcome.reason || 'Completion verified',
    }, running.leaseId);
    const completed = markCompleted(task.id, summary, toolCallCount, tokensUsed, {
      finalized: true,
      blocked: false,
      verified: true,
      verificationReason: outcome.reason,
    }, running.leaseId);
    if (!completed) {
      return { executed: true, taskId: task.id, result: 'Task lease was lost; stale completion was discarded.' };
    }
    markLinkedPlanCompleted(task, summary);

    io.to(`user:${task.userId}:personal`).emit('autonomous:task_completed', {
      taskId: task.id,
      title: task.title,
      result: summary,
      toolCallsCount: toolCallCount,
      tokensUsed,
      finalized: true,
      blocked: false,
      verified: true,
      reason: outcome.reason,
      timestamp: new Date().toISOString(),
    });

    console.log(`[AutoExecutor] Task "${task.title}" completed: ${toolCallCount} tools, ${tokensUsed} tokens`);
    return { executed: true, taskId: task.id, result: summary };
  } catch (err: any) {
    const errorMsg = err.message || 'Unknown error';
    if (isTaskPauseRequested(task.id, task.userId)) {
      markPaused(task.id);
      io.to(`user:${task.userId}:personal`).emit('autonomous:task_paused', {
        taskId: task.id,
        title: task.title,
        timestamp: new Date().toISOString(),
      });
      return { executed: true, taskId: task.id, result: 'Paused' };
    }
    if (isTaskCancellationRequested(task.id, task.userId) || isRealtimeUserActive(task.userId)) {
      const reason = isRealtimeUserActive(task.userId)
        ? 'Cancelled because a live user voice session took priority'
        : errorMsg;
      markCancelled(task.id, reason);
      markLinkedPlanCancelled(task);
      io.to(`user:${task.userId}:personal`).emit('autonomous:task_cancelled', {
        taskId: task.id,
        title: task.title,
        timestamp: new Date().toISOString(),
      });
      return { executed: true, taskId: task.id, result: 'Cancelled by user' };
    }
    const checkpointed = checkpointAutonomousTask(task.id, {
      phase: 'failed',
      receiptIds: Array.from(new Set([
        ...(running.checkpoint?.receiptIds || []),
        ...toolLedger.map(item => item.id).filter((id): id is string => Boolean(id)),
      ])),
      receipts: [
        ...(running.checkpoint?.receipts || []),
        ...snapshotDurableToolRecords(toolLedger),
      ],
      detail: errorMsg,
    }, running.leaseId);
    if (!checkpointed) {
      return { executed: true, taskId: task.id, result: 'Task lease was lost; stale failure was discarded.' };
    }
    const settled = recordAutonomousTaskFailure(task.id, {
      error: errorMsg,
      receiptSnapshots: checkpointed.checkpoint?.receipts || [],
      sideEffectClass,
      leaseLost,
    }, running.leaseId);
    if (!settled) {
      return { executed: true, taskId: task.id, result: 'Task lease was lost; stale failure was discarded.' };
    }
    const willRetry = settled.status === 'pending';
    if (!willRetry) markLinkedPlanFailed(task, errorMsg);

    io.to(`user:${task.userId}:personal`).emit(willRetry ? 'autonomous:task_retry_scheduled' : 'autonomous:task_failed', {
      taskId: task.id,
      title: task.title,
      error: errorMsg,
      status: settled.status,
      nextAttemptAt: settled.nextAttemptAt,
      diagnosis: settled.recovery?.diagnoses.at(-1),
      timestamp: new Date().toISOString(),
    });

    console.warn(`[AutoExecutor] Task "${task.title}" failed:`, errorMsg);
    return {
      executed: true,
      taskId: task.id,
      result: willRetry ? `Retry scheduled: ${settled.nextAttemptAt}` : `Failed: ${errorMsg}`,
    };
  } finally {
    clearInterval(leaseHeartbeat);
    releaseDesktopControlLease();
  }
}
