import type { Conversation } from "./contracts";
import { normalizeConversationActionState } from "../../cognition/action_continuation";
import { parseStoredObject as parsePersistedObject } from "../../tools/receipt_payload";
import type { ConversationActionTerminalDisposition } from "../ledger/contracts";
import { isTerminalConversationTaskStatus } from "../../cognition/task_execution_ledger";

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
}): ConversationActionTerminalDisposition | null {
  if (input.role !== 'assistant' || input.skipActionContinuation) return null;
  const disposition = normalizeConversationActionTerminalDisposition(input.terminalDisposition);
  if (!disposition || disposition.requestId !== String(input.requestId || '').trim()) return null;
  const pending = input.conversation.pendingActionContinuation;
  const state = normalizeConversationActionState(input.conversation.actionContinuationState);
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
