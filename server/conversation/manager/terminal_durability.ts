import { finalizeConversationActionTurn, quarantineConversationActionTurnPersistenceInDb } from "../action_turn_ledger";
import { normalizeCompletionFeedbackForPersistence } from "../completion_feedback";
import { readDatabaseTables, commitDatabaseTables } from "../../../db_layer";
import type { Conversation } from "./contracts";
import { normalizeConversationActionState } from "../../cognition/action_continuation";
import { parseStoredObject as parsePersistedObject } from "../../tools/receipt_payload";
import { finalizeConversationActionTask } from "../ledger/task_lifecycle";
import { type ConversationTerminalDurabilityStage, stopManagerActionTurnHeartbeat, managerActionTurnLeases, managerActionTurnKey, finalizeManagerActionTurnFromAssistantImmediately, type ConversationTerminalPersistenceUnknownProjection } from "../action_execution_runtime";

/**
 * Release staged action turns only after the first strict transcript/task
 * flush has succeeded. The durable assistant row can recover this projection
 * after a crash, so the post-fence turn update may use the normal debounced
 * database writer.
 */
export function commitConversationTerminalDurabilityStage(
  stage: ConversationTerminalDurabilityStage,
): number {
  if (stage.settled) return 0;
  stage.settled = true;
  let committed = 0;
  for (const entry of stage.turns.values()) {
    if (entry.desiredStatus === 'cancelled') {
      stopManagerActionTurnHeartbeat(entry);
      const result = finalizeConversationActionTurn({
        conversationId: entry.conversationId,
        userId: entry.userId,
        requestId: entry.requestId,
        status: 'cancelled',
        terminalMessageId: entry.assistantMessageId || undefined,
        reason: entry.reason || 'cancelled terminal persisted',
        force: true,
        now: entry.now,
      });
      managerActionTurnLeases.delete(managerActionTurnKey(entry));
      if (result.finalized) committed += 1;
      continue;
    }
    finalizeManagerActionTurnFromAssistantImmediately({
      conversationId: entry.conversationId,
      userId: entry.userId,
      requestId: entry.requestId,
      assistantMessageId: entry.assistantMessageId,
      reason: entry.reason,
      now: entry.now,
    });
    committed += 1;
  }
  return committed;
}

/**
 * Replace every staged success projection synchronously before a failed
 * terminal fence can be retried or picked up by the normal delayed writer.
 * The action-turn transition uses the same live DB object, so transcript,
 * continuation, durable task and lease can never be observed as a mixed
 * success/unknown in memory.
 */
export function quarantineConversationTerminalDurabilityStage(
  stage: ConversationTerminalDurabilityStage,
  projection: ConversationTerminalPersistenceUnknownProjection,
): number {
  if (stage.turns.size === 0) return 0;
  const text = String(projection.text || 'The terminal persistence outcome is unknown.')
    .replace(/\0/g, '')
    .trim()
    .slice(0, 8_000) || 'The terminal persistence outcome is unknown.';
  const reason = String(projection.reason || 'Terminal persistence outcome is unknown.')
    .replace(/\0/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 380) || 'Terminal persistence outcome is unknown.';
  const blocker = `persistence_unknown: ${reason}`;
  const completionFeedback = normalizeCompletionFeedbackForPersistence(
    projection.completionFeedback || {
      status: 'unknown',
      incomplete: ['The terminal result could not be durably verified.'],
      blockers: [reason],
      nextSteps: ['Review the task state before retrying the action.'],
    },
  );
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  let quarantined = 0;

  for (const entry of stage.turns.values()) {
    const now = new Date().toISOString();
    const assistant = (db.interactions || []).find((row: any) => (
      row.userId === entry.userId
      && row.conversationId === entry.conversationId
      && row.role === 'assistant'
      && (
        row.id === entry.assistantMessageId
        || String(row.requestId || '') === entry.requestId
        || String(row.externalMessageId || '') === entry.requestId
      )
    ));
    if (assistant) {
      assistant.message = text;
      assistant.content = text;
      assistant.response = '';
      assistant.toolCalls = [];
      assistant.toolReceiptLedger = '';
      assistant.cognitiveIntent = 'persistence_unknown';
      if (completionFeedback) assistant.completionFeedback = completionFeedback;
    }

    const turn = (db.conversationActionTurns || []).find((candidate: any) => (
      candidate.conversationId === entry.conversationId
      && candidate.userId === entry.userId
      && candidate.requestId === entry.requestId
    ));
    const conversation = (db.conversations || []).find((candidate: Conversation) => (
      candidate.id === entry.conversationId && candidate.userId === entry.userId
    ));
    const currentState = normalizeConversationActionState(conversation?.actionContinuationState);
    const taskId = String(turn?.taskId || (
      currentState?.activeRequestId === entry.requestId ? currentState.taskId : ''
    ) || '').trim();
    const durableTask = taskId
      ? (db.conversationActionTasks || []).find((candidate: any) => (
          candidate.id === taskId
          && candidate.conversationId === entry.conversationId
          && candidate.userId === entry.userId
        ))
      : null;
    const taskContext = parsePersistedObject(durableTask?.context);
    const taskState = normalizeConversationActionState(taskContext.actionState);
    const pendingOwnsRequest = conversation?.pendingActionContinuation?.requestId === entry.requestId;
    const currentOwnsTask = Boolean(
      currentState
      && (
        currentState.activeRequestId === entry.requestId
        || (taskId && currentState.taskId === taskId)
        || pendingOwnsRequest
      ),
    );
    const previous = currentOwnsTask ? currentState : taskState;
    if (conversation && previous) {
      finalizeConversationActionTask(db, {
        conversation,
        state: previous,
        outcome: 'persistence_unknown',
        requestId: entry.requestId,
        blocker,
        assistantState: text,
        now,
      });
    }

    quarantineConversationActionTurnPersistenceInDb(db, {
      conversationId: entry.conversationId,
      userId: entry.userId,
      requestId: entry.requestId,
      reason: blocker,
      now,
    });
    stopManagerActionTurnHeartbeat(entry);
    managerActionTurnLeases.delete(managerActionTurnKey(entry));
    quarantined += 1;
  }

  stage.settled = true;
  if (quarantined > 0) commitDatabaseTables(db);
  return quarantined;
}
