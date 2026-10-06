import { readDatabaseTables, commitDatabaseTables } from "../../../db_layer";
import type { Conversation } from "./contracts";
import { parseStoredObject as parsePersistedObject } from "../../tools/receipt_payload";
import { finalizeConversationActionRequestInDb, finalizeManagerActionTurnFromAssistant, acquireManagerActionTurnLease } from "../action_execution_runtime";
import type { BoundConversationActionExecutionTurn, BindConversationActionExecutionTurnInput } from "../conversation_lifecycle";
import { detachUnrelatedConversationActionState, hydrateConversationActionState } from "../action_state_hydration";

export function finalizePersistedAssistantActionTurnInDb(
  db: any,
  input: {
    conversationId: string;
    userId: string;
    requestId: string;
    assistantMessageId: string;
    assistantText: string;
    now: string;
  },
): void {
  const conversation = (db.conversations || []).find((item: Conversation) => (
    item.id === input.conversationId && item.userId === input.userId
  ));
  if (conversation) {
    finalizeConversationActionRequestInDb(db, conversation, input.requestId, {
      assistantState: input.assistantText,
      fallbackBlocker: 'The terminal assistant record has no verified task outcome.',
      now: input.now,
    });
  }
  const boundTurn = (db.conversationActionTurns || []).find((candidate: any) => (
    candidate.conversationId === input.conversationId
    && candidate.userId === input.userId
    && candidate.requestId === input.requestId
  ));
  const boundTask = boundTurn?.taskId
    ? (db.conversationActionTasks || []).find((candidate: any) => (
      candidate.id === boundTurn.taskId
      && candidate.conversationId === input.conversationId
      && candidate.userId === input.userId
    ))
    : null;
  const taskOutcome = ['blocked', 'completed', 'cancelled', 'failed']
    .includes(String(boundTask?.status || ''))
    ? String(boundTask.status)
    : '';
  const taskFinalization = parsePersistedObject(parsePersistedObject(boundTask?.context).taskFinalization);
  // A cancelled task's later history replay cannot retroactively cancel an
  // unrelated earlier turn. Only this request's persisted adjudication may
  // choose cancellation instead of the normal assistant terminal status.
  const cancelledThisRequest = taskOutcome === 'cancelled'
    && taskFinalization.outcome === 'cancelled'
    && taskFinalization.requestId === input.requestId;
  finalizeManagerActionTurnFromAssistant({
    conversationId: input.conversationId,
    userId: input.userId,
    requestId: input.requestId,
    assistantMessageId: input.assistantMessageId,
    ...(cancelledThisRequest ? { desiredStatus: 'cancelled' as const } : {}),
    reason: taskOutcome ? `task_outcome:${taskOutcome}` : undefined,
    now: input.now,
  });
}

interface BindConversationActionExecutionTurnResult {
  turn: BoundConversationActionExecutionTurn | null;
  failure: 'busy' | 'stale' | null;
}

export function bindConversationActionExecutionTurnInDb(
  db: any,
  conversation: Conversation,
  input: BindConversationActionExecutionTurnInput,
  reuseExistingLease: boolean,
): BindConversationActionExecutionTurnResult {
  const requestId = String(input.requestId || '').trim();
  const userMessageId = String(input.userMessageId || '').trim();
  if (!requestId || !userMessageId) return { turn: null, failure: 'stale' };
  const row = (db.interactions || []).find((item: any) => (
    item.userId === input.userId
    && item.conversationId === input.conversationId
    && item.role === 'user'
    && item.id === userMessageId
    && (
      String(item.requestId || '') === requestId
      || String(item.externalMessageId || '') === requestId
    )
  ));
  if (!row) return { turn: null, failure: 'stale' };
  const lease = acquireManagerActionTurnLease({
    conversationId: input.conversationId,
    userId: input.userId,
    requestId,
    reuseExistingLease,
  });
  if (lease.acquired === false) return { turn: null, failure: lease.reason };

  if (!input.preserveExistingTask) {
    detachUnrelatedConversationActionState(db, conversation, input.userText, new Date().toISOString());
  }
  const updatedAt = String(row.receivedAt || row.timestamp || new Date().toISOString());
  conversation.pendingActionContinuation = {
    userText: input.userText,
    messageId: row.id,
    requestId,
    updatedAt,
  };
  return {
    turn: {
      conversationId: conversation.id,
      messageId: row.id,
      requestId,
      leaseOwnerId: lease.ownerId,
      updatedAt,
    },
    failure: null,
  };
}

/**
 * Bind one already-persisted user transcript to the action pipeline only after
 * that request owns the serial execution lease. A different pending request is
 * never overwritten; the caller must wait for its terminal writeback first.
 */
export function bindConversationActionExecutionTurn(
  input: BindConversationActionExecutionTurnInput,
): BoundConversationActionExecutionTurn | null {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  const conversation = (db.conversations || []).find((item: Conversation) => (
    item.id === input.conversationId && item.userId === input.userId
  ));
  if (!conversation) return null;
  hydrateConversationActionState(db, conversation, input.userText);
  const binding = bindConversationActionExecutionTurnInDb(db, conversation, input, false);
  if (!binding.turn) return null;
  conversation.lastActiveAt = new Date().toISOString();
  commitDatabaseTables(db);
  return binding.turn;
}
