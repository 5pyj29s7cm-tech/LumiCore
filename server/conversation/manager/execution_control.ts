import { getConversationActionTurn } from "../action_turn_ledger";
import { readDatabaseTables, commitDatabaseTables } from "../../../db_layer";
import type { Conversation } from "./contracts";
import { isUserObservedTaskCompletion, normalizeConversationActionState, type ConversationActionContinuationState } from "../../cognition/action_continuation";
import { finalizeConversationActionTask, syncConversationActionTaskLedger } from "../ledger/task_lifecycle";
import { conversationTaskStatusOwnsExecutionLease, isTerminalConversationTaskStatus } from "../../cognition/task_execution_ledger";
import { finalizeConversationActionRequestInDb, finalizeManagerActionTurnFromAssistant, releaseManagerActionTurnLease, cancelManagerActionTurns } from "../action_execution_runtime";
import { hydrateConversationActionState } from "../action_state_hydration";
import { type SupersedeConversationActionExecutionRequestInput, type SupersedeConversationActionExecutionRequestResult, finalizeForegroundRequest } from "../foreground_finalization";

export function cancelConversationActionExecution(
  conversationId: string,
  userId: string,
  reason = 'Cancelled by the user.',
  expectedRequestId?: string,
): ConversationActionContinuationState | null {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  const conversation = (db.conversations || []).find((item: Conversation) => (
    item.id === conversationId && item.userId === userId
  ));
  if (conversation) hydrateConversationActionState(db, conversation);
  const previous = normalizeConversationActionState(conversation?.actionContinuationState);
  if (!conversation || !previous) return null;
  if (expectedRequestId && previous.activeRequestId !== expectedRequestId) return previous;
  const requestId = String(
    expectedRequestId
    || previous.activeRequestId
    || conversation.pendingActionContinuation?.requestId
    || '',
  ).trim();
  cancelManagerActionTurns({
    conversationId,
    userId,
    requestId: requestId || undefined,
    reason,
  });
  const finalized = finalizeConversationActionTask(db, {
    conversation,
    state: previous,
    outcome: 'cancelled',
    requestId,
    assistantState: reason,
  });
  commitDatabaseTables(db);
  return finalized?.state || previous;
}

export function completeConversationActionFromUserObservation(
  conversationId: string,
  userId: string,
  userText: string,
  ownership?: { taskId: string; requestId: string; userMessageId: string },
): ConversationActionContinuationState | null {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  const conversation = (db.conversations || []).find((item: Conversation) => (
    item.id === conversationId && item.userId === userId
  ));
  if (conversation) hydrateConversationActionState(db, conversation);
  const previous = normalizeConversationActionState(conversation?.actionContinuationState);
  if (!conversation || !previous || !isUserObservedTaskCompletion(userText, previous)) return null;
  if (ownership) {
    if (!ownership.taskId || previous.taskId !== ownership.taskId) return null;
    const acceptedObservation = (db.interactions || []).find((row: any) => (
      row.id === ownership.userMessageId
      && row.userId === userId
      && row.conversationId === conversationId
      && row.role === 'user'
      && String(row.requestId || row.externalMessageId || '') === ownership.requestId
      && String(row.message || row.content || '').trim() === userText.trim()
    ));
    if (!ownership.requestId || !acceptedObservation) return null;
    const turn = getConversationActionTurn({ conversationId, userId, requestId: ownership.requestId });
    if (turn?.taskId && turn.taskId !== previous.taskId) return null;
  }
  const finalized = finalizeConversationActionTask(db, {
    conversation,
    state: previous,
    outcome: 'completed',
    requestId: ownership?.requestId || previous.activeRequestId,
    assistantState: userText,
    completionSource: 'user_observation',
    userText,
  });
  if (finalized?.state.status !== 'completed') return null;
  // A closed task cannot keep an old pairing slot that a later "continue"
  // could mistake for a still-pending execution. Do not touch another owner.
  if (conversation.pendingActionContinuation?.requestId === previous.activeRequestId) {
    delete conversation.pendingActionContinuation;
  }
  commitDatabaseTables(db);
  return finalized?.state || previous;
}

/**
 * Release the request lease after one foreground executor exits. A task can
 * never remain "executing" when no request still owns it.
 */
export function settleConversationActionExecutionRequest(
  conversationId: string,
  userId: string,
  requestId: string,
  fallbackBlocker = 'The execution request ended without a terminal tool receipt.',
): ConversationActionContinuationState | null {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  const conversation = (db.conversations || []).find((item: Conversation) => (
    item.id === conversationId && item.userId === userId
  ));
  if (conversation) hydrateConversationActionState(db, conversation);
  const previous = normalizeConversationActionState(conversation?.actionContinuationState);
  if (!conversation) return previous;
  const actionTurn = getConversationActionTurn({ conversationId, userId, requestId });
  if (actionTurn?.status === 'persistence_unknown') {
    // A failed terminal fence is authoritative. A voice/task finally block or
    // delayed replay must not recompute a completed projection from receipts.
    return previous;
  }
  const settled = finalizeConversationActionRequestInDb(db, conversation, requestId, {
    fallbackBlocker,
  });
  const assistant = (db.interactions || []).find((row: any) => (
    row.userId === userId
    && row.conversationId === conversationId
    && row.role === 'assistant'
    && (
      String(row.requestId || '') === requestId
      || String(row.externalMessageId || '') === requestId
    )
  ));
  if (assistant) {
    finalizeManagerActionTurnFromAssistant({
      conversationId,
      userId,
      requestId,
      assistantMessageId: assistant.id,
      reason: 'settled after durable assistant transcript was found',
      now: assistant.receivedAt || assistant.timestamp,
    });
  } else {
    releaseManagerActionTurnLease({
      conversationId,
      userId,
      requestId,
      reason: fallbackBlocker,
    });
  }
  commitDatabaseTables(db);
  return settled;
}

/**
 * End only the transport request that yielded to an exact continuation.
 *
 * The shared foreground finalizer updates the task, live/pending projection,
 * and action turn in one database mutation. The task remains blocked and
 * resumable, while the known old request is recorded as cancelled with an
 * explicit supersession reason instead of being quarantined as persistence
 * unknown. A later request may therefore bind the same task id safely.
 */
export function supersedeConversationActionExecutionRequest(
  input: SupersedeConversationActionExecutionRequestInput,
): SupersedeConversationActionExecutionRequestResult {
  const expectedTaskId = String(input.expectedTaskId || '').trim();
  if (!expectedTaskId) throw new TypeError('expectedTaskId is required');
  const requestedReason = String(input.reason || '').replace(/\s+/g, ' ').trim();
  const reason = /^superseded:/i.test(requestedReason)
    ? requestedReason
    : `superseded: ${requestedReason || 'Foreground request yielded to an exact continuation.'}`;
  const result = finalizeForegroundRequest({
    conversationId: input.conversationId,
    userId: input.userId,
    requestId: input.requestId,
    expectedTaskId,
    outcome: 'superseded',
    reason,
    now: input.now,
    deferLocalOwnerClear: input.deferLocalOwnerClear,
  });
  return {
    ...result,
    requestedOutcome: 'superseded',
    superseded: Boolean(
      result.converged
      && result.effectiveOutcome === 'superseded'
      && result.actionTurnStatus === 'cancelled'
      && result.taskStatus === 'blocked'
    ),
  };
}

export function setConversationActionExecutionStatus(
  conversationId: string,
  userId: string,
  status: NonNullable<ConversationActionContinuationState['status']>,
  options: { blocker?: string; assistantState?: string; requestId?: string } = {},
): ConversationActionContinuationState | null {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  const conversation = (db.conversations || []).find((item: Conversation) => (
    item.id === conversationId && item.userId === userId
  ));
  if (conversation) hydrateConversationActionState(db, conversation);
  const previous = normalizeConversationActionState(conversation?.actionContinuationState);
  if (!conversation || !previous) return null;
  const unfinished = !isTerminalConversationTaskStatus(status);
  const requestIdForLease = String(
    options.requestId
    || previous.activeRequestId
    || conversation.pendingActionContinuation?.requestId
    || '',
  ).trim();
  if (['completed', 'failed', 'cancelled', 'blocked'].includes(status)) {
    const finalized = finalizeConversationActionTask(db, {
      conversation,
      state: previous,
      outcome: status as 'completed' | 'failed' | 'cancelled' | 'blocked',
      requestId: requestIdForLease,
      blocker: options.blocker,
      assistantState: options.assistantState,
      retainPendingAction: true,
    });
    if (status === 'cancelled' && requestIdForLease) {
      cancelManagerActionTurns({
        conversationId,
        userId,
        requestId: requestIdForLease,
        reason: options.blocker || options.assistantState || 'Task cancelled.',
      });
    }
    commitDatabaseTables(db);
    return finalized?.state || previous;
  }
  // A task can remain resumable while no executor owns it. The accepted turn,
  // however, stays fenced until its assistant terminal crosses the strict DB
  // boundary; otherwise a failed flush could release it while a false success
  // projection is still waiting in the debounced writer.
  const requestLeaseActive = conversationTaskStatusOwnsExecutionLease(status);
  conversation.actionContinuationState = {
    ...previous,
    version: 2,
    status,
    unfinished,
    latestBlocker: options.blocker !== undefined ? options.blocker : previous.latestBlocker,
    assistantState: options.assistantState !== undefined
      ? options.assistantState
      : previous.assistantState,
    activeRequestId: requestLeaseActive
      ? options.requestId !== undefined
        ? options.requestId || undefined
        : previous.activeRequestId
      : undefined,
    revision: (previous.revision || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  syncConversationActionTaskLedger(db, {
    conversation,
    state: conversation.actionContinuationState,
  });
  commitDatabaseTables(db);
  return conversation.actionContinuationState;
}
