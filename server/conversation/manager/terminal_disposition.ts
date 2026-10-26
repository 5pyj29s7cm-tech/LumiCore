import type { Conversation } from "./contracts";
import { normalizeConversationActionState } from "../../cognition/action_continuation";
import { parseStoredObject as parsePersistedObject } from "../../tools/receipt_payload";
import type { ConversationActionTerminalDisposition } from "../ledger/contracts";
import { isTerminalConversationTaskStatus } from "../../cognition/task_execution_ledger";
import { needsCompletionEvidence, guardCompletionClaims } from "../../work_product/completion_guard";
import { classifyToolRecordTaskDurability } from "../../cognition/continuation/tool_receipts";
import type { ToolExecutionRecord } from "../../tools/types";

/** The final response, rather than optional observations, delivers inline analysis. */
export function isCompletedObservationOnlyDelivery(input: {
  taskText: string;
  currentInstruction?: string;
  taskCapsule?: { goal?: string; currentInstruction?: string } | null;
  assistantText?: string;
  completionFeedback?: unknown;
  toolRecords?: ToolExecutionRecord[];
  requestId?: string;
  taskId?: string;
}): boolean {
  const feedback = parsePersistedObject(input.completionFeedback);
  const response = String(input.assistantText || '');
  return feedback.status === 'completed'
    && (!Array.isArray(feedback.incomplete) || feedback.incomplete.length === 0)
    && (!Array.isArray(feedback.blockers) || feedback.blockers.length === 0)
    && Boolean(String(input.assistantText || '').trim())
    && [input.taskText, input.currentInstruction, input.taskCapsule?.goal, input.taskCapsule?.currentInstruction]
      .filter((text): text is string => Boolean(text?.trim()))
      .every(text => !needsCompletionEvidence(text))
    && (input.toolRecords || []).every(record => classifyToolRecordTaskDurability(record) === 'observation_only')
    && !guardCompletionClaims({
      task: input.taskText, response,
      toolCalls: input.toolRecords || [], requestId: input.requestId, taskId: input.taskId,
    }).blocked;
}

function normalizeConversationActionTerminalDisposition(
  value: unknown,
): ConversationActionTerminalDisposition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.outcome !== 'blocked' && candidate.outcome !== 'cancelled') return null;
  const taskId = String(candidate.taskId || '').trim().slice(0, 180);
  const requestId = String(candidate.requestId || '').trim().slice(0, 180);
  const reason = String(
    candidate.reason || 'The foreground request ended without a verified complete result.',
  ).replace(/\s+/g, ' ').trim().slice(0, 380);
  if (!taskId || !requestId || !reason) return null;
  return { outcome: candidate.outcome, taskId, requestId, reason };
}

/**
 * Fence a transport's terminal adjudication to the exact still-open action
 * turn and task. A transport may submit this semantic result, but it cannot
 * use it to rewrite a task owned by another request or any durable terminal.
 */
export function resolveConversationActionTerminalDisposition(input: {
  db: any;
  conversation: Conversation;
  role: string;
  requestId?: string;
  skipActionContinuation?: boolean;
  terminalDisposition?: unknown;
  assistantText?: string;
  completionFeedback?: unknown;
  toolRecords?: ToolExecutionRecord[];
}): ConversationActionTerminalDisposition | null {
  if (input.role !== 'assistant' || input.skipActionContinuation) return null;
  const pending = input.conversation.pendingActionContinuation;
  const state = normalizeConversationActionState(input.conversation.actionContinuationState);
  const disposition = normalizeConversationActionTerminalDisposition(input.terminalDisposition)
    || (state?.taskId && isCompletedObservationOnlyDelivery({
      taskText: state.goal, currentInstruction: state.latestInstruction, taskCapsule: state.taskCapsule,
      assistantText: input.assistantText,
      completionFeedback: input.completionFeedback, toolRecords: input.toolRecords,
      requestId: input.requestId, taskId: state.taskId,
    }) ? {
      outcome: 'completed' as const, taskId: state.taskId,
      requestId: String(input.requestId || '').trim(), reason: 'finalized_response_completed',
    } : null);
  if (!disposition || disposition.requestId !== String(input.requestId || '').trim()) return null;
  if (
    !pending
    || pending.requestId !== disposition.requestId
    || !state
    || state.taskId !== disposition.taskId
    || isTerminalConversationTaskStatus(state.status)
  ) return null;

  const task = (input.db.conversationActionTasks || []).find((candidate: any) => (
    candidate.id === disposition.taskId
    && candidate.conversationId === input.conversation.id
    && candidate.userId === input.conversation.userId
  ));
  const turn = (input.db.conversationActionTurns || []).find((candidate: any) => (
    candidate.conversationId === input.conversation.id
    && candidate.userId === input.conversation.userId
    && candidate.requestId === disposition.requestId
    && candidate.taskId === disposition.taskId
    && (candidate.status === 'accepted' || candidate.status === 'leased')
  ));
  if (!task || !turn || isTerminalConversationTaskStatus(task.status)) return null;

  const taskFinalization = parsePersistedObject(parsePersistedObject(task.context).taskFinalization);
  const ownsActiveLease = state.activeRequestId === disposition.requestId
    && task.activeRequestId === disposition.requestId;
  const ownsExactPreblockedRequest = state.status === 'blocked'
    && task.status === 'blocked'
    && !state.activeRequestId
    && !task.activeRequestId
    && taskFinalization.outcome === 'blocked'
    && taskFinalization.requestId === disposition.requestId;
  return ownsActiveLease || ownsExactPreblockedRequest ? disposition : null;
}
