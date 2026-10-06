import type { ToolPolicy } from "../../personality/types";
import { CONVERSATION_TASK_STATUSES, conversationTaskStatusOwnsExecutionLease, isTerminalConversationTaskStatus, normalizeConversationTaskReceipt, snapshotTaskPolicy, taskCompletionFromReceipts, type ConversationTaskReceipt, type ConversationTaskStatus } from "../task_execution_ledger";
import { buildTaskCapsuleV1, normalizeTaskCapsuleV1 } from "../../conversation/task_capsule";
import { isUnconfirmedRuntimeCandidate } from "../../conversation/task_target_anchor";
import type { ConversationActionContinuationState } from './contracts';
import { compact, compactAssistantState } from './history_values';

export function normalizeConversationActionState(
  value: Partial<ConversationActionContinuationState> | null | undefined,
): ConversationActionContinuationState | null {
  if (!value || typeof value !== 'object') return null;
  const goal = compact(value.goal, 700);
  if (!goal) return null;
  const statusValue = compact(value.status, 40) as ConversationTaskStatus;
  const status: ConversationTaskStatus = (CONVERSATION_TASK_STATUSES as readonly string[]).includes(statusValue)
    ? statusValue
    : value.unfinished ? 'blocked' : 'completed';
  const receipts = (Array.isArray(value.receipts) ? value.receipts : [])
    .map((receipt: any): ConversationTaskReceipt | null => normalizeConversationTaskReceipt(receipt))
    .filter((receipt): receipt is ConversationTaskReceipt => Boolean(receipt))
    .slice(-40);
  const storedCapsule = normalizeTaskCapsuleV1(value.taskCapsule);
  const receiptCompletion = receipts.length > 0
    ? taskCompletionFromReceipts(goal, receipts, storedCapsule)
    : null;
  const unfinished = isTerminalConversationTaskStatus(status)
    ? false
    : Boolean(value.unfinished);
  const requestLeaseActive = conversationTaskStatusOwnsExecutionLease(status);
  const normalizedState: ConversationActionContinuationState = {
    version: Number(value.version) === 1 && !value.taskId ? 1 : 2,
    taskId: compact(value.taskId, 180) || undefined,
    status,
    policySnapshot: snapshotTaskPolicy(value.policySnapshot as ToolPolicy) || undefined,
    receipts,
    activeRequestId: requestLeaseActive
      ? compact(value.activeRequestId, 180) || undefined
      : undefined,
    supersededTaskId: compact(value.supersededTaskId, 180) || undefined,
    revision: Math.max(0, Math.trunc(Number(value.revision) || 0)),
    goal,
    latestInstruction: compact(value.latestInstruction || goal, 700),
    latestInstructionRef: compact(value.latestInstructionRef, 180) || undefined,
    appTarget: compact(value.appTarget, 160),
    sourcePaths: Array.from(new Set(Array.isArray(value.sourcePaths) ? value.sourcePaths : []))
      .map(path => compact(path, 500))
      .filter(Boolean)
      .filter(candidate => !isUnconfirmedRuntimeCandidate(
        candidate,
        `${value.latestInstruction || ''}\n${goal}`,
      ))
      .slice(0, 8),
    latestBlocker: status === 'completed' || status === 'waiting_confirmation' || status === 'cancelled'
      ? ''
      : value.latestBlocker === 'model_failed_before_tool_execution'
        ? value.latestBlocker : compact(receiptCompletion?.blocker || value.latestBlocker, 380),
    unfinished,
    evidenceTools: Array.from(new Set(Array.isArray(value.evidenceTools) ? value.evidenceTools : []))
      .map(name => compact(name, 120))
      .filter(Boolean)
      .slice(-10),
    assistantState: compactAssistantState(value.assistantState, status),
    toolSummaries: Array.from(new Set(Array.isArray(value.toolSummaries) ? value.toolSummaries : []))
      .map(summary => compact(summary, 700))
      .filter(Boolean)
      .slice(-10),
    updatedAt: compact(value.updatedAt, 80) || new Date(0).toISOString(),
    evidenceMessageId: compact(value.evidenceMessageId, 160) || undefined,
    completionSource: value.completionSource === 'user_observation'
      ? 'user_observation'
      : value.completionSource === 'tool_receipt'
        ? 'tool_receipt'
        : undefined,
    terminalPersistence: value.terminalPersistence?.status === 'persistence_unknown'
      ? {
          status: 'persistence_unknown',
          requestId: compact(value.terminalPersistence.requestId, 180),
          quarantinedAt: compact(value.terminalPersistence.quarantinedAt, 80),
        }
      : undefined,
  };
  const previousCapsule = storedCapsule
    && (!normalizedState.taskId || storedCapsule.taskId === normalizedState.taskId)
    ? storedCapsule
    : null;
  const taskCapsule = buildTaskCapsuleV1(normalizedState, {
    previousCapsule,
    observedAt: normalizedState.updatedAt,
  });
  return {
    ...normalizedState,
    ...(taskCapsule ? { taskCapsule } : {}),
  };
}
