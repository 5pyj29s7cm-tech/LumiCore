import type { Server as SocketIOServer } from 'socket.io';
import {
  cancelBackgroundTask,
  checkpointBackgroundTask,
  claimBackgroundTask,
  completeBackgroundTask,
  failBackgroundTask,
  heartbeatBackgroundTask,
  isBackgroundTaskCancellationRequested,
  isBackgroundTaskPauseRequested,
  listBackgroundTasks,
  pauseBackgroundTask,
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
import {
  addMessage,
  getConversationModelExecutionRecovery,
  persistConversationModelExecutionResult,
} from '../conversation/manager';
import { pushNotification } from '../routes/notifications';
import { CN_BACKGROUND_DELEGATION_MESSAGES } from '../regions/packs/cn/background_delegation_messages';

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

function persistResult(task: BackgroundDelegationTask, content: string, toolCalls: ToolExecutionRecord[], blocked: boolean): void {
  const context = task.context;
  if (!context?.conversationId) return;
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
  const heartbeat = setInterval(() => {
    const renewed = heartbeatBackgroundTask(claimed.id, leaseId, 45_000);
    if (!renewed) clearInterval(heartbeat);
  }, 15_000);
  if (typeof (heartbeat as any).unref === 'function') (heartbeat as any).unref();

  const toolRecords: ToolExecutionRecord[] = [];
  try {
    const context = claimed.context || {};
    const modelRecovery = context.conversationId && context.actionTaskId
      ? getConversationModelExecutionRecovery({
          conversationId: context.conversationId,
          userId: claimed.userId,
          taskId: context.actionTaskId,
        })
      : null;
    checkpointBackgroundTask(claimed.id, {
      phase: 'orchestrating',
      receiptIds: modelRecovery?.receipts?.map(receipt => `${receipt.graphId}:${receipt.nodeId}`) || [],
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
        availableAgentIds: claimed.workers.map(worker => worker.id).filter((id): id is string => Boolean(id)),
        forceOrchestration: context.forceOrchestration !== false,
        isCancelled: () => isBackgroundTaskCancellationRequested(claimed.id)
          || isBackgroundTaskPauseRequested(claimed.id),
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
          id: record.id,
          name: record.name,
          arguments: record.arguments || {},
          result: record.result || '',
          error: record.error,
        });
        checkpointBackgroundTask(claimed.id, {
          phase: 'tool_execution',
          receiptIds: toolRecords.map(item => item.id),
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
    checkpointBackgroundTask(claimed.id, {
      phase: finalized.blocked ? 'failed_verification' : 'verified',
      receiptIds: toolRecords.map(item => item.id),
      detail: finalized.reason || 'Final response verified',
    }, leaseId);
    const settled = finalized.blocked
      ? failBackgroundTask(claimed.id, finalized.reason || 'Missing verified completion evidence.')
      : completeBackgroundTask(claimed.id, finalized.text);
    if (!settled) throw new Error('Recovered task state could not be settled.');
    persistResult(claimed, finalized.text, toolRecords, finalized.blocked);
    emitTask(io, settled);
    io.to(roomFor(claimed)).emit('agent:response', {
      text: finalized.text,
      agentName: 'Lumi',
      source: 'background_delegation',
      requestId: claimed.id,
      taskId: claimed.id,
      conversationId: context.conversationId || '',
      finalized: true,
      blocked: finalized.blocked,
      reason: finalized.reason || '',
      recovered: true,
    });
    pushNotification(claimed.userId, {
      type: finalized.blocked ? 'background_error' : 'background_result',
      title: finalized.blocked
        ? CN_BACKGROUND_DELEGATION_MESSAGES.recoveredBlockedTitle
        : CN_BACKGROUND_DELEGATION_MESSAGES.recoveredCompletedTitle,
      message: finalized.text.slice(0, 180),
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
      return;
    }
    const message = error instanceof Error ? error.message : String(error || 'Unknown error');
    const failureText = formatBackgroundDelegationFailure(error, /[\u3400-\u9fff]/u.test(claimed.prompt));
    const failed = failBackgroundTask(claimed.id, failureText);
    if (failed) emitTask(io, failed);
    persistResult(claimed, failureText, toolRecords, true);
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

  const timer = setInterval(() => { void tick(); }, Math.max(250, options.pollMs || DEFAULT_POLL_MS));
  if (typeof (timer as any).unref === 'function') (timer as any).unref();
  void tick();
  return {
    tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    activeTaskIds: () => Array.from(active),
  };
}
