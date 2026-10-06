import { bindConversationActionTurnTask, getConversationActionTurn } from "../action_turn_ledger";
import { readDatabaseTables, commitDatabaseTables } from "../../../db_layer";
import type { Conversation } from "./contracts";
import { prepareConversationActionTaskState } from "../../cognition/action_continuation";
import { attachConversationExecutionPlan } from "../ledger/plans";
import { syncConversationActionTaskLedger } from "../ledger/task_lifecycle";
import { getConversationActionStateByTaskId } from "../ledger/queries";
import type { ToolPolicy } from "../../personality/types";
import type { CapabilityExecutionPlan } from "../../cognition/capability_execution_plan";
import { releaseManagerActionTurnLease } from "../action_execution_runtime";
import { detachUnrelatedConversationActionState, hydrateConversationActionState } from "../action_state_hydration";
import { bindConversationActionExecutionTurnInDb } from './turn_binding';

type PreparedConversationActionExecution = ReturnType<typeof prepareConversationActionTaskState>;

export type RejectedConversationActionExecution = {
  state: null;
  kind: 'conversation';
  bindingFailure: 'stale' | 'busy';
  diagnosticCode:
    | 'conversation_action_conversation_missing'
    | 'conversation_action_turn_not_persisted'
    | 'conversation_action_turn_busy';
};

export type ConversationActionExecutionPreparation =
  | (PreparedConversationActionExecution & { turnRowId?: string })
  | RejectedConversationActionExecution;

function rejectedConversationActionExecution(
  bindingFailure: RejectedConversationActionExecution['bindingFailure'],
  diagnosticCode: RejectedConversationActionExecution['diagnosticCode'],
): RejectedConversationActionExecution {
  return { state: null, kind: 'conversation', bindingFailure, diagnosticCode };
}

export function prepareConversationActionExecution(input: {
  conversationId: string;
  userId: string;
  userText: string;
  requestId: string;
  /** Exact already-persisted user transcript row owning this serial turn. */
  userMessageId: string;
  toolPolicy: ToolPolicy;
  forceResume?: boolean;
  forceNewTask?: boolean;
  forceTask?: boolean;
  /** Current-turn classification from the shared execution pipeline. */
  followupIntent?: import("../../cognition/action_continuation").RecentActionFollowupIntent;
  /** Preserve the current task while binding corrective/continuation feedback. */
  preserveExistingTask?: boolean;
}): ConversationActionExecutionPreparation {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  const conversation = (db.conversations || []).find((item: Conversation) => (
    item.id === input.conversationId && item.userId === input.userId
  ));
  if (!conversation) {
    return rejectedConversationActionExecution(
      'stale',
      'conversation_action_conversation_missing',
    );
  }
  hydrateConversationActionState(db, conversation, input.userText);
  const binding = bindConversationActionExecutionTurnInDb(db, conversation, {
    userId: input.userId,
    conversationId: input.conversationId,
    userText: input.userText,
    requestId: input.requestId,
    userMessageId: input.userMessageId,
    // A fresh executable turn still needs to see the prior unfinished state
    // long enough for prepareConversationActionTaskState to record an exact
    // supersession edge. Detachment is only for a genuinely conversational
    // turn; it must not erase the old identity before a replacement is built.
    preserveExistingTask: input.preserveExistingTask
      ?? (input.forceResume === true || input.forceTask === true),
  }, true);
  const boundTurn = binding.turn;
  // The durable transcript identity is the ownership fence for every channel.
  // A different pending request is busy; a missing/mismatched transcript is
  // stale. Neither case may fall through and mutate the prior task.
  if (!boundTurn) {
    return rejectedConversationActionExecution(
      binding.failure === 'busy' ? 'busy' : 'stale',
      binding.failure === 'busy'
        ? 'conversation_action_turn_busy'
        : 'conversation_action_turn_not_persisted',
    );
  }
  const persistedTurn = getConversationActionTurn({
    conversationId: input.conversationId,
    userId: input.userId,
    requestId: input.requestId,
  });
  const exactBoundTaskState = persistedTurn?.taskId
    ? getConversationActionStateByTaskId(db, {
        conversationId: input.conversationId,
        userId: input.userId,
        taskId: persistedTurn.taskId,
      })
    : null;
  if (exactBoundTaskState) {
    // A replay of the same immutable request must continue the task already
    // bound to that request. Reclassifying the same text as a new task causes
    // a task_conflict after TTL recovery and turns self-recovery back into a
    // permanent busy response.
    conversation.actionContinuationState = exactBoundTaskState;
  }
  const prepared = prepareConversationActionTaskState(conversation.actionContinuationState, {
    ...input,
    forceResume: input.forceResume === true || Boolean(exactBoundTaskState),
    forceNewTask: exactBoundTaskState ? false : input.forceNewTask,
  });
  if (prepared.state?.taskId) {
    const taskBinding = bindConversationActionTurnTask({
      conversationId: input.conversationId,
      userId: input.userId,
      requestId: input.requestId,
      taskId: prepared.state.taskId,
    });
    if (taskBinding.bound === false) {
      releaseManagerActionTurnLease({
        conversationId: input.conversationId,
        userId: input.userId,
        requestId: input.requestId,
        reason: `task binding failed: ${taskBinding.reason}`,
      });
      if (conversation.pendingActionContinuation?.requestId === input.requestId) {
        delete conversation.pendingActionContinuation;
      }
      commitDatabaseTables(db);
      return rejectedConversationActionExecution(
        taskBinding.reason === 'task_conflict' ? 'busy' : 'stale',
        taskBinding.reason === 'task_conflict'
          ? 'conversation_action_turn_busy'
          : 'conversation_action_turn_not_persisted',
      );
    }
  }
  if (prepared.kind === 'conversation') {
    const detached = detachUnrelatedConversationActionState(
      db,
      conversation,
      input.userText,
      new Date().toISOString(),
    );
    if (detached || boundTurn) {
      delete conversation.pendingActionContinuation;
      if (boundTurn && !detached) {
        // Keep the exact pending row until its assistant terminal arrives.
        conversation.pendingActionContinuation = {
          userText: input.userText,
          messageId: boundTurn.messageId,
          requestId: input.requestId,
          updatedAt: boundTurn.updatedAt,
        };
      }
      conversation.lastActiveAt = new Date().toISOString();
      commitDatabaseTables(db);
    }
    // The ledger may retain the previous task for status/history, but a plain
    // turn never receives that task id for plan/receipt binding.
    return { state: null, kind: 'conversation', turnRowId: persistedTurn?.id };
  }
  if (prepared.state !== conversation.actionContinuationState) {
    if (prepared.state) conversation.actionContinuationState = prepared.state;
    else delete conversation.actionContinuationState;
    conversation.lastActiveAt = new Date().toISOString();
    if (prepared.state) {
      const pending = conversation.pendingActionContinuation;
      const rootUserMessageId = pending
        && (!pending.requestId || pending.requestId === input.requestId)
        && pending.userText === input.userText
        ? pending.messageId
        : undefined;
      syncConversationActionTaskLedger(db, {
        conversation,
        state: prepared.state,
        userText: input.userText,
        rootUserMessageId,
        currentUserMessageId: rootUserMessageId,
        now: conversation.lastActiveAt,
      });
    }
    commitDatabaseTables(db);
  }
  return { ...prepared, turnRowId: persistedTurn?.id };
}

export function persistConversationExecutionPlan(input: {
  conversationId: string;
  userId: string;
  plan: CapabilityExecutionPlan;
}): boolean {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  const task = attachConversationExecutionPlan(db, input);
  if (!task) return false;
  commitDatabaseTables(db);
  return true;
}
