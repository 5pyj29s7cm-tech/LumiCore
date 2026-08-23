import type { Server as SocketIOServer } from 'socket.io';
import {
  cancelBackgroundTask,
  checkpointBackgroundTask,
  claimBackgroundTask,
  completeBackgroundTask,
  heartbeatBackgroundTask,
  isBackgroundTaskCancellationRequested,
  isBackgroundTaskPauseRequested,
  listBackgroundTasks,
  pauseBackgroundTask,
  recordBackgroundTaskFailure,
  type BackgroundDelegationTask,
} from './background_tasks';
import {
  formatBackgroundDelegationFailure,
} from './background_delegation';
import {
  isTerminalOrchestrationToolEvent,
  runOrchestratedTask,
  type LlmGetters,
} from './orchestrator';
import type { ToolExecutionRecord } from '../tools/types';
import { finalizeLumiResponse } from '../cognition/result_finalizer';
import { sanitizeExecutionResponseForDelivery } from '../cognition/execution_guard_recovery';
import {
  addMessage,
  getConversationModelExecutionRecovery,
  persistConversationModelExecutionResult,
} from '../conversation/manager';
import { pushNotification } from '../routes/notifications';
import { CN_BACKGROUND_DELEGATION_MESSAGES } from '../regions/packs/cn/background_delegation_messages';
import { isDurableTaskReady, snapshotDurableToolRecords } from '../cognition/durable_task_recovery';
import {
  buildTaskCompletionFeedback,
  buildTaskTerminalReceipt,
  validateCompletionTerminalReceipt,
} from '../cognition/acceptance_evidence';
import type { TaskCompletionFeedback, TaskTerminalReceipt } from '../cognition/acceptance_evidence';
import { settleBackgroundConversationActionTask } from '../conversation/action_ledger';
import { readDB, writeDB } from '../../db_layer';
import { formatCnTaskCompletionFeedback } from '../regions/packs/cn/task_completion_feedback_messages';

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_CONCURRENCY = 2;
const CLAIM_AGE_MS = 250;

export interface DurableBackgroundTaskSupervisorOptions {
  io: SocketIOServer;
  llmGetters: LlmGetters;
  pollMs?: number;
  concurrency?: number;
  claimAgeMs?: number;
  taskExecutor?: (task: BackgroundDelegationTask) => Promise<void>;
  /** A parent lifecycle supervisor may own scheduling and call tick(). */
  autoSchedule?: boolean;
}

export interface DurableBackgroundTaskSupervisor {
  tick(): Promise<number>;
  stop(): void;
  activeTaskIds(): string[];
}

function roomFor(task: BackgroundDelegationTask): string {
  return task.context?.domain === 'work' && task.context.orgId
    ? `org:${task.context.orgId}`
    : `user:${task.userId}:personal`;
}

function emitTask(io: SocketIOServer, task: BackgroundDelegationTask): void {
  io.to(roomFor(task)).emit('agent:background_task_update', {
    taskId: task.id,
    task,
    source: 'background_delegation',
    requestId: task.id,
    conversationId: task.context?.conversationId || '',
    recovered: (task.recoveryCount || 0) > 0,
  });
}

function mergeReceiptSnapshots<T extends { id: string }>(...groups: Array<T[] | undefined>): T[] {
  const byId = new Map<string, T>();
  for (const group of groups) {
    for (const receipt of group || []) byId.set(receipt.id, receipt);
  }
  return Array.from(byId.values()).slice(-80);
}

function persistResult(task: BackgroundDelegationTask, content: string, toolCalls: ToolExecutionRecord[], blocked: boolean): boolean {
  const context = task.context;
  if (!context?.conversationId) return false;
  addMessage({
    userId: task.userId,
    agentId: context.conversationAgentId || '',
    conversationId: context.conversationId,
    role: 'assistant',
    content,
    personality: context.personalityId || 'lumi',
    domain: context.domain || 'personal',
    orgId: context.orgId || '',
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    cognitiveIntent: blocked ? 'work_product_guard' : undefined,
    source: 'background_delegation_recovery',
    skipActionContinuation: true,
  });
  return true;
}

function formatTaskResult(
  baseText: string,
  task: BackgroundDelegationTask,
  feedback: TaskCompletionFeedback,
  receipt?: TaskTerminalReceipt | null,
): string {
  if (/[^\x00-\xff]/u.test(task.prompt || task.title)) {
    return formatCnTaskCompletionFeedback(baseText, task.title, feedback, receipt);
  }
  const status = feedback.status === 'completed'
    ? 'verified complete'
    : feedback.status === 'working'
      ? 'still running'
      : feedback.status === 'cancelled'
        ? 'cancelled'
        : 'not complete';
  const evidence = [
    ...(receipt?.toolNames?.length ? [`terminal tool receipts: ${receipt.toolNames.join(', ')}`] : []),
    ...(receipt?.workerIds?.length ? [`agent receipts: ${receipt.workerIds.length}`] : []),
    ...(receipt?.receiptId ? [`acceptance receipt: ${receipt.receiptId}`] : []),
  ];
  const lines = [String(baseText || '').trim(), '', 'Execution feedback', `- Status: ${status}`];
  if (feedback.status === 'completed') lines.push(`- Completed: ${task.title}`);
  if (evidence.length > 0) lines.push(`- Evidence: ${evidence.join('; ')}`);
  if (feedback.status !== 'completed') lines.push(`- Incomplete: ${task.title}`);
  if (feedback.blockers.length > 0) lines.push(`- Blocker: ${feedback.blockers.slice(0, 4).join('; ')}`);
  if (feedback.status !== 'completed' && feedback.status !== 'cancelled') {
    lines.push('- Next: the goal, plan, and existing receipts are retained; Lumi will resume from the unverified step without replaying confirmed external side effects.');
  }
  return lines.filter((line, index) => line || index > 0).join('\n').trim();
}

function emitConversationResultUpdated(io: SocketIOServer, task: BackgroundDelegationTask): void {
  const conversationId = task.context?.conversationId;
  if (!conversationId) return;
  io.to(roomFor(task)).emit('chat:conversation_updated', {
    conversationId,
    agentId: task.context?.conversationAgentId || '',
    source: 'background_delegation',
    requestId: task.id,
  });
}

function settlePlanLedger(
  task: BackgroundDelegationTask,
  toolCalls: ToolExecutionRecord[],
  status: 'completed' | 'blocked' | 'cancelled',
  detail: string,
): void {
  if (task.reason !== 'command_center_scheduled_plan' && task.reason !== 'command_center_manual_run') return;
  const taskId = task.context?.actionTaskId;
  if (!taskId) return;
  const finalRecord: ToolExecutionRecord = {
    id: `receipt_${task.id}_final`,
    taskId,
    requestId: task.id,
    idempotencyKey: `${task.id}:background_orchestration_finalizer`,
    name: 'background_orchestration_finalizer',
    arguments: { backgroundTaskId: task.id },
    result: JSON.stringify({
      status: status === 'completed' ? 'verified' : status,
      verified: status === 'completed',
      backgroundTaskId: task.id,
      detail,
    }),
    ...(status === 'blocked' ? { error: detail || 'Background execution was blocked.' } : {}),
    terminalVerification: {
      status: status === 'completed' ? 'verified' : status === 'blocked' ? 'failed' : 'unverified',
      strategy: 'terminal_receipt',
      reason: detail,
    },
  };
  const db = readDB();
  settleBackgroundConversationActionTask(db, {
    taskId,
    userId: task.userId,
    records: [...toolCalls, finalRecord],
    status,
    blocker: status === 'blocked' ? detail : '',
    requestId: task.id,
  });
  writeDB(db);
}

async function executeRecoveredTask(
  task: BackgroundDelegationTask,
  io: SocketIOServer,
  llmGetters: LlmGetters,
): Promise<void> {
  const claimed = claimBackgroundTask(task.id, { owner: 'durable-background-supervisor', durationMs: 45_000 });
  if (!claimed || claimed.status !== 'running' || !claimed.leaseId) return;
  emitTask(io, claimed);

  const leaseId = claimed.leaseId;
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    const renewed = heartbeatBackgroundTask(claimed.id, leaseId, 45_000);
    if (!renewed) {
      leaseLost = true;
      clearInterval(heartbeat);
    }
  }, 15_000);
  if (typeof (heartbeat as any).unref === 'function') (heartbeat as any).unref();

  const toolRecords: ToolExecutionRecord[] = [];
  try {
    const context = claimed.context || {};
    const recoveryDirective = claimed.recovery?.planRevisions.at(-1);
    const modelRecovery = context.conversationId && context.actionTaskId
      ? getConversationModelExecutionRecovery({
          conversationId: context.conversationId,
          userId: claimed.userId,
          taskId: context.actionTaskId,
        })
      : null;
    checkpointBackgroundTask(claimed.id, {
      phase: 'orchestrating',
      completedNodeIds: claimed.checkpoint?.completedNodeIds,
      receiptIds: Array.from(new Set([
        ...(claimed.checkpoint?.receiptIds || []),
        ...(modelRecovery?.receipts?.map(receipt => `${receipt.graphId}:${receipt.nodeId}`) || []),
      ])).slice(-80),
      receipts: claimed.checkpoint?.receipts,
      detail: `Recovered attempt ${claimed.attempt}`,
    }, leaseId);

    const result = await runOrchestratedTask(
      claimed.prompt,
      {
        userId: claimed.userId,
        personalityId: context.personalityId,
        domain: context.domain || 'personal',
        orgId: context.orgId || '',
        toolPolicy: context.toolPolicy,
        taskId: context.actionTaskId || claimed.id,
        resumeNodeReceipts: modelRecovery?.receipts,
        recoveryDirective,
        availableAgentIds: claimed.workers.map(worker => worker.id).filter((id): id is string => Boolean(id)),
        forceOrchestration: context.forceOrchestration !== false,
        isCancelled: () => isBackgroundTaskCancellationRequested(claimed.id)
          || isBackgroundTaskPauseRequested(claimed.id)
          || leaseLost,
      },
      {
        provider: (context.provider || 'auto') as any,
        model: context.model || '',
        userId: claimed.userId,
        domain: context.domain || 'personal',
        orgId: context.orgId || '',
        selectionMode: context.selectionMode,
        fallbackCandidates: context.fallbackCandidates,
        allowCloudFallback: context.allowCloudFallback,
        conversationId: context.conversationId || '',
        requestId: claimed.id,
        interactionId: context.interactionId || '',
        source: 'background_delegation_recovery',
      },
      llmGetters,
      undefined,
      (record) => {
        if (!isTerminalOrchestrationToolEvent(record)) return;
        toolRecords.push({
          ...record,
          arguments: { ...(record.arguments || {}) },
          result: record.result || '',
        });
        checkpointBackgroundTask(claimed.id, {
          phase: 'tool_execution',
          completedNodeIds: claimed.checkpoint?.completedNodeIds,
          receiptIds: Array.from(new Set([
            ...(claimed.checkpoint?.receiptIds || []),
            ...toolRecords.map(item => item.id),
          ])).slice(-80),
          receipts: mergeReceiptSnapshots(
            claimed.checkpoint?.receipts,
            snapshotDurableToolRecords(toolRecords),
          ),
          detail: `${toolRecords.length} terminal tool call(s) observed`,
        }, leaseId);
      },
    );

    if (isBackgroundTaskPauseRequested(claimed.id)) {
      const paused = pauseBackgroundTask(claimed.id);
      if (paused) emitTask(io, paused);
      return;
    }
    if (isBackgroundTaskCancellationRequested(claimed.id)) {
      throw new Error('Workflow cancelled');
    }
    if (!result) throw new Error('No worker agent accepted the recovered delegated task.');

    if (context.conversationId && context.actionTaskId) {
      persistConversationModelExecutionResult({
        conversationId: context.conversationId,
        userId: claimed.userId,
        taskId: context.actionTaskId,
        workflowResult: result.workflowResult,
      });
    }
    const candidate = CN_BACKGROUND_DELEGATION_MESSAGES.recoveredResult(claimed.title, result.responseText);
    const finalized = finalizeLumiResponse({
      taskText: claimed.prompt,
      responseText: candidate,
      toolRecords,
      source: 'background_delegation',
    });
    const terminalReceipt = buildTaskTerminalReceipt({
      taskId: claimed.id,
      runtime: 'background',
      outcome: finalized.blocked ? 'blocked' : 'completed',
      toolRecords,
      nodeReceipts: result.workflowResult.nodeReceipts,
      arbitrationReceipt: result.workflowResult.arbitrationReceipt,
      reasonCode: finalized.blocked ? 'final_response_verification_failed' : undefined,
      reason: finalized.reason || undefined,
    });
    const acceptance = finalized.blocked
      ? { accepted: false, diagnosticCode: terminalReceipt.reasonCode, reason: terminalReceipt.reason }
      : validateCompletionTerminalReceipt(terminalReceipt, {
          taskId: claimed.id,
          runtime: 'background',
        });
    checkpointBackgroundTask(claimed.id, {
      phase: acceptance.accepted ? 'verified' : 'failed_verification',
      receiptIds: toolRecords.map(item => item.id),
      receipts: snapshotDurableToolRecords(toolRecords),
      detail: acceptance.reason || finalized.reason || 'Final response verified',
    }, leaseId);
    const settled = finalized.blocked || !acceptance.accepted
      ? recordBackgroundTaskFailure(claimed.id, {
          error: acceptance.reason || finalized.reason || 'Missing verified completion evidence.',
          verificationFailure: true,
          toolRecords,
          leaseLost,
        }, leaseId)
      : completeBackgroundTask(claimed.id, finalized.text, terminalReceipt, leaseId);
    if (!settled) throw new Error('Recovered task state could not be settled.');
    if (settled.status === 'queued') {
      emitTask(io, settled);
      pushNotification(claimed.userId, {
        type: 'background_result',
        title: 'Background task recovery scheduled',
        message: `Verification did not pass; Lumi will retry safely after ${settled.nextAttemptAt || 'the backoff window'}.`.slice(0, 180),
      });
      return;
    }
    const blocked = settled.status !== 'completed';
    settlePlanLedger(claimed, toolRecords, blocked ? 'blocked' : 'completed', acceptance.reason || finalized.reason || finalized.text);
    const completionFeedback = buildTaskCompletionFeedback(
      settled.terminalReceipt,
      claimed.title,
      { status: settled.status, reason: acceptance.reason || finalized.reason },
    );
    const resultText = formatTaskResult(finalized.text, claimed, completionFeedback, settled.terminalReceipt);
    if (persistResult(claimed, resultText, toolRecords, blocked)) emitConversationResultUpdated(io, claimed);
    emitTask(io, settled);
    io.to(roomFor(claimed)).emit('agent:response', sanitizeExecutionResponseForDelivery({
      text: resultText,
      agentName: 'Lumi',
      source: 'background_delegation',
      requestId: claimed.id,
      taskId: claimed.id,
      conversationId: context.conversationId || '',
      finalized: true,
      blocked,
      reason: acceptance.reason || finalized.reason || '',
      completionFeedback,
      recovered: true,
    }, { task: claimed.prompt, toolRecords }));
    pushNotification(claimed.userId, {
      type: blocked ? 'background_error' : 'background_result',
      title: blocked
        ? CN_BACKGROUND_DELEGATION_MESSAGES.recoveredBlockedTitle
        : CN_BACKGROUND_DELEGATION_MESSAGES.recoveredCompletedTitle,
      message: resultText.slice(0, 180),
    });
  } catch (error) {
    if (isBackgroundTaskPauseRequested(claimed.id)) {
      const paused = pauseBackgroundTask(claimed.id);
      if (paused) emitTask(io, paused);
      return;
    }
    if (isBackgroundTaskCancellationRequested(claimed.id)) {
      const cancelled = cancelBackgroundTask(claimed.id);
      if (cancelled) emitTask(io, cancelled);
      settlePlanLedger(claimed, toolRecords, 'cancelled', 'Background task cancelled.');
      return;
    }
    const message = error instanceof Error ? error.message : String(error || 'Unknown error');
    const failureText = formatBackgroundDelegationFailure(error, /[\u3400-\u9fff]/u.test(claimed.prompt));
    const failed = recordBackgroundTaskFailure(claimed.id, {
      error: message,
      toolRecords,
      leaseLost,
    }, leaseId);
    if (!failed) return;
    emitTask(io, failed);
    if (failed.status === 'queued') {
      pushNotification(claimed.userId, {
        type: 'background_result',
        title: 'Background task retry scheduled',
        message: `${failureText} Retry after ${failed.nextAttemptAt || 'backoff'}.`.slice(0, 180),
      });
      return;
    }
    settlePlanLedger(claimed, toolRecords, 'blocked', message);
    const completionFeedback = buildTaskCompletionFeedback(
      failed.terminalReceipt,
      claimed.title,
      { status: failed.status, reason: message },
    );
    const resultText = formatTaskResult(failureText, claimed, completionFeedback, failed.terminalReceipt);
    if (persistResult(claimed, resultText, toolRecords, true)) emitConversationResultUpdated(io, claimed);
    io.to(roomFor(claimed)).emit('agent:response', sanitizeExecutionResponseForDelivery({
      text: resultText,
      agentName: 'Lumi',
      source: 'background_delegation',
      requestId: claimed.id,
      taskId: claimed.id,
      conversationId: claimed.context?.conversationId || '',
      finalized: true,
      blocked: true,
      reason: failed.terminalReceipt?.reason || message,
      completionFeedback,
      recovered: true,
    }, { task: claimed.prompt, toolRecords }));
    pushNotification(claimed.userId, {
      type: 'background_error',
      title: CN_BACKGROUND_DELEGATION_MESSAGES.recoveryFailedTitle,
      message: `${failureText} (${message})`.slice(0, 180),
    });
  } finally {
    clearInterval(heartbeat);
  }
}

export function startDurableBackgroundTaskSupervisor(
  options: DurableBackgroundTaskSupervisorOptions,
): DurableBackgroundTaskSupervisor {
  const active = new Set<string>();
  const concurrency = Math.max(1, Math.min(8, options.concurrency || DEFAULT_CONCURRENCY));
  const claimAgeMs = Math.max(0, options.claimAgeMs ?? CLAIM_AGE_MS);
  const taskExecutor = options.taskExecutor
    || ((task: BackgroundDelegationTask) => executeRecoveredTask(task, options.io, options.llmGetters));
  let stopped = false;
  let ticking = false;

  const tick = async (): Promise<number> => {
    if (stopped || ticking) return 0;
    ticking = true;
    let started = 0;
    try {
      const candidates = listBackgroundTasks()
        .filter(task => task.status === 'queued')
        .filter(task => isDurableTaskReady(task.nextAttemptAt))
        .filter(task => Date.now() - new Date(task.updatedAt).getTime() >= claimAgeMs)
        .filter(task => !active.has(task.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const task of candidates) {
        if (active.size >= concurrency) break;
        active.add(task.id);
        started += 1;
        void taskExecutor(task)
          .catch(error => console.warn('[BackgroundSupervisor] Task execution failed:', error))
          .finally(() => active.delete(task.id));
      }
      return started;
    } finally {
      ticking = false;
    }
  };

  const timer = options.autoSchedule === false
    ? null
    : setInterval(() => { void tick(); }, Math.max(250, options.pollMs || DEFAULT_POLL_MS));
  if (timer && typeof (timer as any).unref === 'function') (timer as any).unref();
  if (options.autoSchedule !== false) void tick();
  return {
    tick,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
    activeTaskIds: () => Array.from(active),
  };
}
