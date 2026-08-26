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
import { projectBackgroundTask } from './background_task_public';
import {
  formatBackgroundDelegationFailure,
} from './background_delegation';
import {
  isTerminalOrchestrationToolEvent,
  runOrchestratedTask,
  type LlmGetters,
  type OrchestrationToolEvent,
} from './orchestrator';
import type { ToolExecutionRecord } from '../tools/types';
import { finalizeLumiResponse } from '../cognition/result_finalizer';
import { sanitizeExecutionResponseForDelivery } from '../cognition/execution_guard_recovery';
import {
  addMessage,
  getConversationModelExecutionRecovery,
  persistConversationModelExecutionCheckpoint,
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
import { flushDBOrThrow, readDB, writeDB } from '../../db_layer';
import { formatCnTaskCompletionFeedback } from '../regions/packs/cn/task_completion_feedback_messages';
import { redactDiagnosticSecrets } from '../client/diagnostic_sanitizer';

const DEFAULT_POLL_MS = 1_000;
const DEFAULT_CONCURRENCY = 2;
const CLAIM_AGE_MS = 250;

class BackgroundTaskPersistenceBoundaryError extends Error {
  constructor(boundary: string, error: unknown) {
    super(`${boundary}: ${redactDiagnosticSecrets(
      error instanceof Error ? error.message : String(error || 'unknown persistence error'),
    )}`);
    this.name = 'BackgroundTaskPersistenceBoundaryError';
  }
}

async function flushBackgroundTaskBoundary(boundary: string): Promise<void> {
  try {
    await flushDBOrThrow();
  } catch (error) {
    throw new BackgroundTaskPersistenceBoundaryError(boundary, error);
  }
}

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

type BackgroundTaskScope =
  | { valid: true; domain: 'personal' | 'work'; orgId: string; room: string }
  | { valid: false; reason: string };

function resolveBackgroundTaskScope(task: BackgroundDelegationTask): BackgroundTaskScope {
  const rawDomain = task.context?.domain;
  if (rawDomain === 'work') {
    const orgId = String(task.context?.orgId || '').trim();
    return orgId
      ? {
          valid: true,
          domain: 'work',
          orgId,
          // A background delegation belongs to one authenticated member even
          // when its data scope is an organization. Organization rooms are for
          // explicitly shared organization events, not private task output.
          room: `user:${task.userId}:org:${orgId}`,
        }
      : {
          valid: false,
          reason: 'Background task scope policy denied execution: work domain requires a non-empty orgId.',
        };
  }
  if (rawDomain !== undefined && rawDomain !== 'personal') {
    return {
      valid: false,
      reason: 'Background task scope policy denied execution: domain is malformed.',
    };
  }
  return {
    valid: true,
    domain: 'personal',
    orgId: '',
    room: `user:${task.userId}:personal`,
  };
}

function roomFor(task: BackgroundDelegationTask): string | null {
  const scope = resolveBackgroundTaskScope(task);
  return scope.valid ? scope.room : null;
}

function pushBackgroundNotification(
  task: BackgroundDelegationTask,
  notification: Parameters<typeof pushNotification>[1],
): void {
  const scope = resolveBackgroundTaskScope(task);
  // The notification store is currently user-personal and has no org scope.
  // Never copy work-domain content into it until it can enforce org isolation.
  if (scope.valid === false || scope.domain === 'work') return;
  pushNotification(task.userId, notification);
}

export function emitBackgroundTaskUpdate(io: SocketIOServer, task: BackgroundDelegationTask): void {
  const room = roomFor(task);
  if (!room) return;
  io.to(room).emit('agent:background_task_update', {
    taskId: task.id,
    task: projectBackgroundTask(task),
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

function upsertObservedToolRecord(
  records: ToolExecutionRecord[],
  incoming: OrchestrationToolEvent | ToolExecutionRecord,
): ToolExecutionRecord {
  const incomingId = String(incoming.id || incoming.idempotencyKey || '').trim();
  let index = incomingId
    ? records.findIndex(candidate => candidate.id === incomingId || candidate.idempotencyKey === incomingId)
    : -1;
  if (index < 0 && incoming.adapterStarted !== true) {
    // Canonical events normally carry a stable id. This fallback only pairs a
    // legacy terminal event with the most recent same-tool uncertainty fence.
    for (let candidateIndex = records.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
      const candidate = records[candidateIndex];
      if (candidate.adapterStarted === true && candidate.name === incoming.name) {
        index = candidateIndex;
        break;
      }
    }
  }
  const previous = index >= 0 ? records[index] : undefined;
  const { lifecycle: _lifecycle, ...record } = incoming as OrchestrationToolEvent;
  const normalized: ToolExecutionRecord = {
    ...record,
    id: incomingId || previous?.id,
    arguments: { ...(record.arguments || previous?.arguments || {}) },
    result: record.result || '',
  };
  if (index >= 0) records[index] = normalized;
  else records.push(normalized);
  return normalized;
}

function buildAdapterStartedFence(
  task: BackgroundDelegationTask,
  record: OrchestrationToolEvent,
  sequence: number,
): ToolExecutionRecord {
  const startedAt = new Date().toISOString();
  const id = String(record.id || record.idempotencyKey || `background_adapter_${task.id}_${sequence}`);
  const taskId = String(record.taskId || task.context?.actionTaskId || task.id);
  const turnId = String(record.turnId || task.context?.sourceRequestId || task.id);
  const requestId = String(record.requestId || task.id);
  const idempotencyKey = String(record.idempotencyKey || id);
  const reason = 'The tool adapter started, but no terminal receipt has been observed; side-effect outcome is unknown.';
  return {
    ...record,
    id,
    taskId,
    turnId,
    requestId,
    idempotencyKey,
    arguments: { ...(record.arguments || {}) },
    result: '',
    adapterStarted: true,
    error: reason,
    terminalVerification: {
      status: 'unverified',
      strategy: record.capability?.verification.strategy || 'terminal_receipt',
      reason,
    },
    envelope: {
      version: 1,
      status: 'unknown_outcome',
      toolName: record.name,
      taskId,
      turnId,
      requestId,
      idempotencyKey,
      targetIdentity: '',
      startedAt,
      completedAt: startedAt,
      error: reason,
      verification: { status: 'unverified', reason },
    },
  };
}

function persistResult(task: BackgroundDelegationTask, content: string, toolCalls: ToolExecutionRecord[], blocked: boolean): boolean {
  const context = task.context;
  if (!context?.conversationId) return false;
  const scope = resolveBackgroundTaskScope(task);
  if (scope.valid === false) return false;
  addMessage({
    userId: task.userId,
    agentId: context.conversationAgentId || '',
    conversationId: context.conversationId,
    role: 'assistant',
    content,
    personality: context.personalityId || 'lumi',
    domain: scope.domain,
    orgId: scope.orgId,
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
  const room = roomFor(task);
  if (!conversationId || !room) return;
  io.to(room).emit('chat:conversation_updated', {
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

export async function executeRecoveredTask(
  task: BackgroundDelegationTask,
  io: SocketIOServer,
  llmGetters: LlmGetters,
): Promise<void> {
  const claimed = claimBackgroundTask(task.id, { owner: 'durable-background-supervisor', durationMs: 45_000 });
  if (!claimed || claimed.status !== 'running' || !claimed.leaseId) return;
  const scope = resolveBackgroundTaskScope(claimed);
  if (scope.valid === false) {
    const blocked = recordBackgroundTaskFailure(claimed.id, {
      error: scope.reason,
      verificationFailure: false,
      toolRecords: [],
    }, claimed.leaseId);
    if (!blocked || blocked.status !== 'blocked') {
      throw new Error('Malformed background task scope could not be durably blocked.');
    }
    settlePlanLedger(claimed, [], 'blocked', scope.reason);
    await flushBackgroundTaskBoundary('Malformed work-scope block was not durably persisted');
    // There is intentionally no personal fallback room or notification for a
    // malformed work scope. Its contents remain quarantined in durable state.
    return;
  }
  const actionTaskId = String(claimed.context?.actionTaskId || '').trim();
  if (actionTaskId && actionTaskId !== claimed.id) {
    const reason = 'Background task identity policy denied execution: actionTaskId must equal the claimed durable task id.';
    const blocked = recordBackgroundTaskFailure(claimed.id, {
      error: reason,
      verificationFailure: false,
      toolRecords: [],
    }, claimed.leaseId);
    if (!blocked || blocked.status !== 'blocked') {
      throw new Error('Mismatched background/action task identity could not be durably blocked.');
    }
    settlePlanLedger(claimed, [], 'blocked', reason);
    await flushBackgroundTaskBoundary('Background task identity block was not durably persisted');
    emitBackgroundTaskUpdate(io, blocked);
    return;
  }
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
    let completedModelNodeIds = Array.from(new Set([
      ...(claimed.checkpoint?.completedNodeIds || []),
      ...(modelRecovery?.receipts?.map(receipt => receipt.nodeId) || []),
    ]));
    let modelReceiptIds = Array.from(new Set([
      ...(claimed.checkpoint?.receiptIds || []),
      ...(modelRecovery?.receipts?.map(receipt => `${receipt.graphId}:${receipt.nodeId}`) || []),
    ])).slice(-80);
    const initialCheckpoint = checkpointBackgroundTask(claimed.id, {
      phase: 'orchestrating',
      completedNodeIds: completedModelNodeIds,
      receiptIds: modelReceiptIds,
      receipts: claimed.checkpoint?.receipts,
      detail: `Recovered attempt ${claimed.attempt}`,
    }, leaseId);
    if (!initialCheckpoint) {
      throw new Error('Background delegation could not persist its initial execution checkpoint.');
    }
    await flushBackgroundTaskBoundary('Initial background execution checkpoint was not durably persisted');
    emitBackgroundTaskUpdate(io, initialCheckpoint);

    const result = await runOrchestratedTask(
      claimed.prompt,
      {
        userId: claimed.userId,
        personalityId: context.personalityId,
        domain: scope.domain,
        orgId: scope.orgId,
        toolPolicy: context.toolPolicy,
        taskId: context.actionTaskId || claimed.id,
        dataRoutingPolicy: context.dataRoutingPolicy,
        resumeNodeReceipts: modelRecovery?.receipts,
        resumeExecutionGraph: modelRecovery?.graph,
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
        domain: scope.domain,
        orgId: scope.orgId,
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
      async (record) => {
        if (record.lifecycle === 'adapter_started') {
          const fence = buildAdapterStartedFence(claimed, record, toolRecords.length + 1);
          upsertObservedToolRecord(toolRecords, fence);
          const durableStartCheckpoint = checkpointBackgroundTask(claimed.id, {
            phase: 'tool_adapter_started',
            completedNodeIds: completedModelNodeIds,
            receiptIds: Array.from(new Set([
              ...modelReceiptIds,
              ...toolRecords.map(item => item.id),
            ])).slice(-80),
            receipts: mergeReceiptSnapshots(
              claimed.checkpoint?.receipts,
              snapshotDurableToolRecords(toolRecords),
            ),
            detail: `${record.name} adapter started; awaiting a terminal tool receipt`,
          }, leaseId);
          if (!durableStartCheckpoint) {
            throw new Error('Background delegation lost its execution lease before the adapter-start fence was persisted.');
          }
          await flushBackgroundTaskBoundary('Adapter-start uncertainty fence was not durably persisted');
          return;
        }
        if (!isTerminalOrchestrationToolEvent(record)) return;
        upsertObservedToolRecord(toolRecords, {
          ...record,
          arguments: { ...(record.arguments || {}) },
          result: record.result || '',
        });
        const durableToolCheckpoint = checkpointBackgroundTask(claimed.id, {
          phase: 'tool_execution',
          completedNodeIds: completedModelNodeIds,
          receiptIds: Array.from(new Set([
            ...modelReceiptIds,
            ...toolRecords.map(item => item.id),
          ])).slice(-80),
          receipts: mergeReceiptSnapshots(
            claimed.checkpoint?.receipts,
            snapshotDurableToolRecords(toolRecords),
          ),
          detail: `${toolRecords.length} terminal tool call(s) observed`,
        }, leaseId);
        if (!durableToolCheckpoint) {
          throw new Error('Background delegation lost its execution lease before the tool receipt was persisted.');
        }
        await flushBackgroundTaskBoundary('Terminal tool checkpoint was not durably persisted');
      },
      async (workflowCheckpoint) => {
        completedModelNodeIds = [...workflowCheckpoint.completedNodeIds];
        modelReceiptIds = Array.from(new Set([
          ...modelReceiptIds,
          ...workflowCheckpoint.nodeReceipts.map(receipt => `${receipt.graphId}:${receipt.nodeId}`),
        ])).slice(-80);
        const durableCheckpoint = checkpointBackgroundTask(claimed.id, {
          phase: `model_${workflowCheckpoint.phase}`,
          completedNodeIds: completedModelNodeIds,
          receiptIds: Array.from(new Set([
            ...modelReceiptIds,
            ...toolRecords.map(item => item.id),
          ])).slice(-80),
          receipts: mergeReceiptSnapshots(
            claimed.checkpoint?.receipts,
            snapshotDurableToolRecords(toolRecords),
          ),
          detail: `${workflowCheckpoint.nodeReceipts.length}/${workflowCheckpoint.executionGraph.nodes.length} model node receipt(s) persisted`,
        }, leaseId);
        if (!durableCheckpoint) {
          throw new Error('Background delegation lost its execution lease before the model checkpoint was persisted.');
        }
        if (context.conversationId && context.actionTaskId) {
          const persisted = persistConversationModelExecutionCheckpoint({
            conversationId: context.conversationId,
            userId: claimed.userId,
            taskId: context.actionTaskId,
            executionGraph: workflowCheckpoint.executionGraph,
            nodeReceipts: workflowCheckpoint.nodeReceipts,
            privateNodeHandoffs: workflowCheckpoint.privateNodeHandoffs,
            arbitrationReceipt: workflowCheckpoint.arbitrationReceipt,
          });
          if (!persisted) {
            throw new Error('Background delegation could not persist its conversation model checkpoint.');
          }
        }
        await flushBackgroundTaskBoundary('Model execution checkpoint was not durably persisted');
      },
    );

    if (isBackgroundTaskCancellationRequested(claimed.id)) {
      throw new Error('Workflow cancelled');
    }
    if (isBackgroundTaskPauseRequested(claimed.id)) {
      const paused = pauseBackgroundTask(claimed.id);
      if (paused) await flushBackgroundTaskBoundary('Paused background state was not durably persisted');
      if (paused) emitBackgroundTaskUpdate(io, paused);
      return;
    }
    if (!result) throw new Error('No worker agent accepted the recovered delegated task.');

    if (context.conversationId && context.actionTaskId) {
      const persisted = persistConversationModelExecutionResult({
        conversationId: context.conversationId,
        userId: claimed.userId,
        taskId: context.actionTaskId,
        workflowResult: result.workflowResult,
      });
      if (!persisted) {
        throw new Error('Background delegation could not persist its final conversation model execution result.');
      }
      await flushBackgroundTaskBoundary('Final conversation model result was not durably persisted');
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
    const finalCheckpoint = checkpointBackgroundTask(claimed.id, {
      phase: acceptance.accepted ? 'verified' : 'failed_verification',
      completedNodeIds: completedModelNodeIds,
      receiptIds: Array.from(new Set([
        ...modelReceiptIds,
        ...toolRecords.map(item => item.id),
      ])).slice(-80),
      receipts: mergeReceiptSnapshots(
        claimed.checkpoint?.receipts,
        snapshotDurableToolRecords(toolRecords),
      ),
      detail: acceptance.reason || finalized.reason || 'Final response verified',
    }, leaseId);
    if (!finalCheckpoint) {
      throw new Error('Background delegation could not persist its final verification checkpoint.');
    }
    await flushBackgroundTaskBoundary('Final verification checkpoint was not durably persisted');
    const settled = finalized.blocked || !acceptance.accepted
      ? recordBackgroundTaskFailure(claimed.id, {
          error: acceptance.reason || finalized.reason || 'Missing verified completion evidence.',
          verificationFailure: true,
          toolRecords,
          leaseLost,
        }, leaseId)
      : completeBackgroundTask(claimed.id, finalized.text, terminalReceipt, leaseId);
    if (!settled) throw new Error('Recovered task state could not be settled.');

    if (settled.status === 'completed') {
      settlePlanLedger(claimed, toolRecords, 'completed', finalized.text);
    } else if (settled.status === 'blocked' || settled.status === 'failed') {
      settlePlanLedger(
        claimed,
        toolRecords,
        'blocked',
        settled.terminalReceipt?.reason || acceptance.reason || finalized.reason || 'Background execution failed.',
      );
    } else if (settled.status === 'cancelled') {
      settlePlanLedger(claimed, toolRecords, 'cancelled', 'Background task cancelled.');
    }
    await flushBackgroundTaskBoundary('Terminal background settlement was not durably persisted');

    if (settled.status === 'paused') {
      emitBackgroundTaskUpdate(io, settled);
      return;
    }
    if (settled.status === 'cancelled') {
      // Cancellation is a terminal user decision, not a blocked execution and
      // must never be projected as a blocked final assistant response.
      emitBackgroundTaskUpdate(io, settled);
      return;
    }
    if (settled.status === 'queued') {
      emitBackgroundTaskUpdate(io, settled);
      pushBackgroundNotification(claimed, {
        type: 'background_result',
        title: 'Background task recovery scheduled',
        message: `Verification did not pass; Lumi will retry safely after ${settled.nextAttemptAt || 'the backoff window'}.`.slice(0, 180),
      });
      return;
    }
    if (!['completed', 'blocked', 'failed'].includes(settled.status)) {
      throw new Error(`Recovered task returned an unexpected settlement status: ${settled.status}`);
    }
    const blocked = settled.status === 'blocked';
    const failed = settled.status === 'failed';
    const incomplete = blocked || failed;
    const completionReason = settled.terminalReceipt?.reason || acceptance.reason || finalized.reason || '';
    const completionFeedback = buildTaskCompletionFeedback(
      settled.terminalReceipt,
      claimed.title,
      { status: settled.status, reason: completionReason },
    );
    const resultText = formatTaskResult(finalized.text, claimed, completionFeedback, settled.terminalReceipt);
    const conversationResultPersisted = persistResult(claimed, resultText, toolRecords, incomplete);
    // The terminal task row, plan ledger and assistant result form one public
    // completion boundary. Do not tell clients the task finished until all
    // three projections are durable.
    await flushBackgroundTaskBoundary('Public background completion projection was not durably persisted');
    if (conversationResultPersisted) emitConversationResultUpdated(io, claimed);
    emitBackgroundTaskUpdate(io, settled);
    io.to(scope.room).emit('agent:response', sanitizeExecutionResponseForDelivery({
      text: resultText,
      agentName: 'Lumi',
      source: 'background_delegation',
      requestId: claimed.id,
      taskId: claimed.id,
      conversationId: context.conversationId || '',
      finalized: true,
      blocked: incomplete,
      reason: completionReason,
      completionFeedback,
      recovered: true,
    }, { task: claimed.prompt, toolRecords }));
    pushBackgroundNotification(claimed, {
      type: blocked || failed ? 'background_error' : 'background_result',
      title: blocked || failed
        ? CN_BACKGROUND_DELEGATION_MESSAGES.recoveredBlockedTitle
        : CN_BACKGROUND_DELEGATION_MESSAGES.recoveredCompletedTitle,
      message: resultText.slice(0, 180),
    });
  } catch (error) {
    if (isBackgroundTaskCancellationRequested(claimed.id)) {
      const cancelled = cancelBackgroundTask(claimed.id);
      if (cancelled) {
        settlePlanLedger(claimed, toolRecords, 'cancelled', 'Background task cancelled.');
        await flushBackgroundTaskBoundary('Cancelled background state was not durably persisted');
        emitBackgroundTaskUpdate(io, cancelled);
      }
      return;
    }
    if (isBackgroundTaskPauseRequested(claimed.id)) {
      const paused = pauseBackgroundTask(claimed.id);
      if (paused) await flushBackgroundTaskBoundary('Paused background state was not durably persisted');
      if (paused) emitBackgroundTaskUpdate(io, paused);
      return;
    }
    const message = error instanceof Error ? error.message : String(error || 'Unknown error');
    const failureText = formatBackgroundDelegationFailure(error, /[\u3400-\u9fff]/u.test(claimed.prompt));
    const failed = recordBackgroundTaskFailure(claimed.id, {
      error: message,
      toolRecords,
      leaseLost,
    }, leaseId);
    if (!failed) {
      // A terminal mutation may already exist in memory when its strict flush
      // fails. Never swallow that durability failure or emit a public result.
      if (error instanceof BackgroundTaskPersistenceBoundaryError) throw error;
      return;
    }

    if (failed.status === 'cancelled') {
      settlePlanLedger(claimed, toolRecords, 'cancelled', 'Background task cancelled.');
    } else if (failed.status === 'blocked' || failed.status === 'failed') {
      settlePlanLedger(claimed, toolRecords, 'blocked', failed.terminalReceipt?.reason || message);
    }
    await flushBackgroundTaskBoundary('Background failure settlement was not durably persisted');

    if (failed.status === 'paused') {
      emitBackgroundTaskUpdate(io, failed);
      return;
    }
    if (failed.status === 'cancelled') {
      emitBackgroundTaskUpdate(io, failed);
      return;
    }
    if (failed.status === 'queued') {
      emitBackgroundTaskUpdate(io, failed);
      pushBackgroundNotification(claimed, {
        type: 'background_result',
        title: 'Background task retry scheduled',
        message: `${failureText} Retry after ${failed.nextAttemptAt || 'backoff'}.`.slice(0, 180),
      });
      return;
    }
    if (failed.status !== 'blocked' && failed.status !== 'failed') {
      throw new Error(`Background failure returned an unexpected settlement status: ${failed.status}`);
    }
    const completionFeedback = buildTaskCompletionFeedback(
      failed.terminalReceipt,
      claimed.title,
      { status: failed.status, reason: message },
    );
    const resultText = formatTaskResult(failureText, claimed, completionFeedback, failed.terminalReceipt);
    const conversationResultPersisted = persistResult(claimed, resultText, toolRecords, true);
    await flushBackgroundTaskBoundary('Public background failure projection was not durably persisted');
    if (conversationResultPersisted) emitConversationResultUpdated(io, claimed);
    emitBackgroundTaskUpdate(io, failed);
    io.to(scope.room).emit('agent:response', sanitizeExecutionResponseForDelivery({
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
    pushBackgroundNotification(claimed, {
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
