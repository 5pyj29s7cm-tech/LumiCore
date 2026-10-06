import { acceptConversationActionTurn, bindConversationActionTurnTask, finalizeConversationActionTurn, getConversationActionTurn, listConversationActionTurns, quarantineConversationActionTurnPersistenceInDb, reconcileConversationActionTurnLease, reconcileConversationActionTurnLeases } from './action_turn_ledger';
import { normalizeCompletionFeedbackForPersistence } from './completion_feedback';
import { readDatabaseTables, commitDatabaseTables } from '../../db_layer';
import { type Conversation, type MessageRecord } from "./manager/contracts";
import { buildConversationActionContinuationState, classifyToolRecordTaskDurability, classifyRecentActionFollowupIntent, isUserObservedTaskCompletion, needsRecentActionContinuationContext, normalizeConversationActionState, prepareConversationActionTaskState, RECONFIRMATION_REQUIRED_BLOCKER, type ConversationActionContinuationState } from '../cognition/action_continuation';
import { parseStoredObject as parsePersistedObject } from '../tools/receipt_payload';
import { attachConversationExecutionPlan } from "./ledger/plans";
import { migrateLegacyConversationActionLedger, recoverConversationActionTaskLeases, repairTerminalConversationActionPointers, repairTerminalConversationActionTaskLeases, repairContradictoryConversationActionReceipts } from "./ledger/recovery";
import { compactLegacyScheduledCapabilityExecutions } from "./ledger/scheduler";
import { archiveBoundConversationActionReceipts } from "./ledger/receipt_archive";
import { finalizeConversationActionTask, syncConversationActionTaskLedger } from "./ledger/task_lifecycle";
import { getConversationActionStateByTaskId } from "./ledger/queries";
import { type ConversationActionTerminalDisposition } from "./ledger/contracts";
import type { ToolPolicy } from '../personality/types';
import type { CapabilityExecutionPlan } from '../cognition/capability_execution_plan';
import { conversationTaskStatusOwnsExecutionLease, isTerminalConversationTaskStatus } from '../cognition/task_execution_ledger';
import { normalizeNativeRequestBinding } from '../devices/native_identity';
import { normalizeVoiceTurnProvenance } from '../socket/voice_provenance';
import { partitionConversationReceiptsByOwnership } from './receipt_ownership';
import { buildActionContract } from '../cognition/action_contract';
import { normalizeActionIntent } from '../cognition/normalized_action_intent';
import { sanitizeToolRecordsForPersistence } from '../cognition/user_output_protection';
import { type ConversationTerminalDurabilityStage, stopManagerActionTurnHeartbeat, managerActionTurnLeases, managerActionTurnKey, finalizeManagerActionTurnFromAssistantImmediately, type ConversationTerminalPersistenceUnknownProjection, finalizeConversationActionRequestInDb, finalizeManagerActionTurnFromAssistant, acquireManagerActionTurnLease, releaseManagerActionTurnLease, cancelManagerActionTurns, managerActionTurnHeartbeatStops } from "./action_execution_runtime";
import { type BoundConversationActionExecutionTurn, type BindConversationActionExecutionTurnInput, conversationMatchesScope } from "./conversation_lifecycle";
import { detachUnrelatedConversationActionState, hydrateConversationActionState, hasExactPendingConfirmationForTask, compactRolloverText } from "./action_state_hydration";
import { type SupersedeConversationActionExecutionRequestInput, type SupersedeConversationActionExecutionRequestResult, finalizeForegroundRequest } from "./foreground_finalization";

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

function finalizePersistedAssistantActionTurnInDb(
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

function bindConversationActionExecutionTurnInDb(
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
  followupIntent?: import('../cognition/action_continuation').RecentActionFollowupIntent;
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

/**
 * Foreground request leases are process-local. After a backend restart there
 * is no executor that can still own a persisted planning/executing state, and
 * a waiting confirmation is valid only when startup hydration restored its
 * exact one-time envelope. Convert true orphans to resumable blockers instead
 * of telling the next turn that old work is still running.
 */
export function recoverOrphanedConversationActionExecutions(
  now = new Date().toISOString(),
): number {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  const migrated = migrateLegacyConversationActionLedger(db);
  const repairedTerminalPointers = repairTerminalConversationActionPointers(db);
  const repairedTerminalLeases = repairTerminalConversationActionTaskLeases(db);
  const recoveredLedgerLeases = recoverConversationActionTaskLeases(db, now, {
    hasExactPendingConfirmation: hasExactPendingConfirmationForTask,
  });
  const repairedReceipts = repairContradictoryConversationActionReceipts(db);
  const schedulerCompaction = compactLegacyScheduledCapabilityExecutions(db);
  for (const stopHeartbeat of [...managerActionTurnHeartbeatStops.values()]) {
    stopHeartbeat();
  }
  managerActionTurnLeases.clear();
  let reconciledActionTurns = 0;
  for (const turn of listConversationActionTurns()) {
    const assistant = (db.interactions || []).find((row: any) => (
      row.userId === turn.userId
      && row.conversationId === turn.conversationId
      && row.role === 'assistant'
      && (
        String(row.requestId || '') === turn.requestId
        || String(row.externalMessageId || '') === turn.requestId
      )
    ));
    const conversation = (db.conversations || []).find((row: Conversation) => (
      row.id === turn.conversationId && row.userId === turn.userId
    ));
    const result = assistant
      ? reconcileConversationActionTurnLease({
          conversationId: turn.conversationId,
          userId: turn.userId,
          requestId: turn.requestId,
          observedStatus: 'terminal',
          terminalMessageId: assistant.id,
          reason: 'assistant transcript found during restart reconciliation',
          now,
        })
      : conversation?.status === 'closed'
        ? reconcileConversationActionTurnLease({
            conversationId: turn.conversationId,
            userId: turn.userId,
            requestId: turn.requestId,
            observedStatus: 'cancelled',
            reason: 'conversation was already closed during restart reconciliation',
            now,
          })
        : null;
    if (result?.reconciled) reconciledActionTurns += 1;
  }
  const recoveredActionTurnLeases = reconcileConversationActionTurnLeases({
    // This function is a startup hook. A synthetic epoch also makes its
    // restart behavior deterministic in same-process integration tests.
    processEpoch: `manager-restart:${crypto.randomUUID()}`,
    now,
  }).released;
  let recovered = 0;
  let recoveredPendingTurns = 0;
  for (const conversation of db.conversations || []) {
    hydrateConversationActionState(db, conversation);
    // Foreground request ownership is process-local. After restart every
    // transcript pairing slot is orphaned, including terminal/no-task states
    // that the older recovery filter skipped entirely.
    if (conversation.pendingActionContinuation) {
      delete conversation.pendingActionContinuation;
      recoveredPendingTurns += 1;
    }
    const previous = normalizeConversationActionState(conversation.actionContinuationState);
    if (
      !previous?.unfinished
      || (!conversationTaskStatusOwnsExecutionLease(previous.status)
        && previous.status !== 'waiting_confirmation')
    ) continue;
    const waitingForConfirmation = previous.status === 'waiting_confirmation';
    if (waitingForConfirmation && previous.taskId && hasExactPendingConfirmationForTask({
      id: previous.taskId,
      conversationId: conversation.id,
      userId: conversation.userId,
      domain: conversation.domain,
      orgId: conversation.orgId,
    })) {
      // The exact encrypted envelope was hydrated before this startup hook.
      // Keep the task waiting; its one-time grant is still safe to consume.
      continue;
    }
    const finalized = finalizeConversationActionTask(db, {
      conversation,
      state: previous,
      outcome: 'blocked',
      requestId: previous.activeRequestId,
      blocker: waitingForConfirmation
        ? RECONFIRMATION_REQUIRED_BLOCKER
        : 'The previous runtime ended before this task reached a terminal receipt.',
      now,
    });
    if (finalized) recovered += 1;
  }
  if (
    migrated > 0
    || repairedTerminalPointers > 0
    || repairedTerminalLeases > 0
    || recoveredLedgerLeases > 0
    || repairedReceipts > 0
    || schedulerCompaction.tasksRemoved > 0
    || reconciledActionTurns > 0
    || recoveredActionTurnLeases > 0
    || recoveredPendingTurns > 0
    || recovered > 0
  ) commitDatabaseTables(db);
  return repairedTerminalPointers
    + repairedTerminalLeases
    + recoveredLedgerLeases
    + reconciledActionTurns
    + recoveredActionTurnLeases
    + recovered
    + recoveredPendingTurns;
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
function resolveConversationActionTerminalDisposition(input: {
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

export function addMessage(msg: {
  userId: string;
  agentId?: string;
  conversationId?: string;
  role: string;
  content: string;
  response?: string;
  personality?: string;
  mode?: string;
  toolCalls?: any;
  domain?: string;
  orgId?: string;
  source?: string;
  channel?: string;
  cognitiveIntent?: string;
  llmWasCalled?: boolean;
  externalMessageId?: string;
  routeSequence?: number;
  receivedAt?: string;
  timestamp?: string;
  /** Immutable foreground request identity used to reject late replies. */
  requestId?: string;
  /** Proof-bound native request provenance; absent on web/remote/harness turns. */
  nativeDeviceId?: string;
  executionSessionId?: string;
  nativeClientIdentitySha256?: string;
  audioInputKind?: 'physical_microphone' | 'synthetic_accepted_transcript';
  syntheticAudio?: boolean;
  captureSessionId?: string;
  sttReceiptId?: string;
  contextChainId?: string;
  previousRequestId?: string;
  /** Explicit structured intent emitted by the model/runtime for this reply. */
  taskIntent?: 'task' | 'conversation';
  /** User-visible structured outcome; normalized before it reaches memory/SQLite. */
  completionFeedback?: unknown;
  /** @internal Request/task-fenced semantic result from a foreground transport. */
  terminalTaskDisposition?: ConversationActionTerminalDisposition;
  /**
   * Persist the accepted instruction before routing/tool selection finishes,
   * while leaving creation of the real task state to the foreground executor.
   */
  deferActionPreparation?: boolean;
  /**
   * Side-channel progress/chat records must not replace the pending action
   * pointer owned by the foreground task.
   */
  skipActionContinuation?: boolean;
}): string {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  // Conversation IDs are parent identities, not optional labels. A delayed
  // model/voice/tool reply must never recreate content after that parent was
  // deleted. Unbound legacy interactions remain supported without an ID.
  if (msg.conversationId && !(db.conversations || []).some((conversation: Conversation) => (
    conversation.id === msg.conversationId
    && conversation.userId === msg.userId
    && (!msg.agentId || conversation.agentId === msg.agentId)
    && conversationMatchesScope(conversation, msg.domain, msg.orgId)
  ))) return '';
  const id = 'msg_' + crypto.randomUUID();
  const now = msg.timestamp || new Date().toISOString();
  const normalizedToolCalls = normalizeToolCalls(msg.toolCalls);
  const completionFeedback = normalizeCompletionFeedbackForPersistence(msg.completionFeedback);
  const nativeRequestBinding = normalizeNativeRequestBinding(msg);
  const voiceTurnProvenance = normalizeVoiceTurnProvenance(msg);

  const interaction: any = {
    id,
    userId: msg.userId,
    agentId: msg.agentId || '',
    conversationId: msg.conversationId || '',
    module: msg.personality || '',
    message: msg.content,
    response: msg.response || '',
    role: msg.role,
    personality: msg.personality || '',
    mode: msg.mode || '',
    toolCalls: normalizedToolCalls,
    domain: msg.domain || 'personal',
    orgId: msg.orgId || '',
    source: msg.source || '',
    channel: msg.channel || '',
    cognitiveIntent: msg.cognitiveIntent || '',
    llmWasCalled: msg.llmWasCalled === true,
    externalMessageId: msg.externalMessageId || '',
    routeSequence: Number.isFinite(msg.routeSequence) ? msg.routeSequence : undefined,
    receivedAt: msg.receivedAt || '',
    requestId: msg.requestId || '',
    nativeDeviceId: nativeRequestBinding?.nativeDeviceId || '',
    executionSessionId: nativeRequestBinding?.executionSessionId || '',
    nativeClientIdentitySha256: nativeRequestBinding?.nativeClientIdentitySha256 || '',
    audioInputKind: voiceTurnProvenance?.audioInputKind || '',
    syntheticAudio: voiceTurnProvenance?.syntheticAudio,
    captureSessionId: voiceTurnProvenance?.captureSessionId || '',
    sttReceiptId: voiceTurnProvenance?.sttReceiptId || '',
    contextChainId: voiceTurnProvenance?.contextChainId || '',
    previousRequestId: voiceTurnProvenance?.previousRequestId || '',
    taskIntent: msg.taskIntent || '',
    ...(completionFeedback ? { completionFeedback } : {}),
    timestamp: now,
  };

  if (!db.interactions) db.interactions = [];
  db.interactions.push(interaction);

  // The transcript row and accepted turn enter the same in-memory persistence
  // snapshot. Callers must flush this snapshot before any side-effecting tool
  // execution; the ledger then becomes the sole durable request authority.
  if (msg.role === 'user' && msg.conversationId && msg.requestId) {
    const accepted = acceptConversationActionTurn({
      conversationId: msg.conversationId,
      userId: msg.userId,
      requestId: msg.requestId,
      userMessageId: id,
      domain: msg.domain,
      orgId: msg.orgId,
      channel: msg.channel,
      source: msg.source,
      now,
    });
    if (!accepted.accepted) {
      const insertedIndex = db.interactions.findIndex((row: any) => row.id === id);
      if (insertedIndex >= 0) db.interactions.splice(insertedIndex, 1);
      return accepted.turn.userMessageId;
    }
  }
  const terminalArchiveId = updateConversationForMessage(db, msg, id, now, normalizedToolCalls);
  if (terminalArchiveId !== undefined) return terminalArchiveId;


  if (
    msg.role === 'assistant'
    && msg.mode !== 'proactive'
    && msg.conversationId
    && msg.requestId
  ) {
    finalizePersistedAssistantActionTurnInDb(db, {
      conversationId: msg.conversationId,
      userId: msg.userId,
      requestId: msg.requestId,
      assistantMessageId: id,
      assistantText: msg.content,
      now,
    });
  }

  commitDatabaseTables(db);
  return id;
}

export type IdempotentConversationMessage = Parameters<typeof addMessage>[0] & {
  conversationId: string;
  requestId: string;
};

/**
 * Find the durable transcript row for one accepted socket request. Native chat
 * mirrors the request id into externalMessageId because that column survives a
 * database restart; older in-memory rows can still be found through requestId.
 */
export function getMessageByRequestId(input: {
  userId: string;
  agentId?: string;
  conversationId?: string;
  requestId: string;
  role: string;
  source?: string;
  channel?: string;
}): MessageRecord | null {
  const requestId = String(input.requestId || '').trim();
  if (!requestId) return null;
  const source = String(input.source || '');
  const channel = String(input.channel || '');
  const row = (readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]).interactions || []).find((item: any) => (
    item.userId === input.userId
    && (!input.agentId || item.agentId === input.agentId)
    && (!input.conversationId || item.conversationId === input.conversationId)
    && item.role === input.role
    && (!source || item.source === source)
    && (!channel || item.channel === channel)
    && (
      String(item.requestId || '') === requestId
      || String(item.externalMessageId || '') === requestId
    )
  ));
  return row || null;
}

/**
 * Persist one role exactly once for a received socket request. The monotonic
 * routeSequence is used as a durable receive/commit order for native chat;
 * user rows are written when accepted, while assistant rows take their order
 * only when the terminal result is committed.
 */
export function addMessageIdempotent(msg: IdempotentConversationMessage): string {
  const requestId = String(msg.requestId || '').trim();
  if (!requestId) return addMessage(msg);
  const existing = getMessageByRequestId({
    userId: msg.userId,
    agentId: msg.agentId,
    conversationId: msg.conversationId,
    requestId,
    role: msg.role,
    source: msg.source,
    channel: msg.channel,
  });
  if (existing) {
    if (msg.role === 'user') {
      acceptConversationActionTurn({
        conversationId: msg.conversationId,
        userId: msg.userId,
        requestId,
        userMessageId: existing.id,
        domain: msg.domain,
        orgId: msg.orgId,
        channel: msg.channel,
        source: msg.source,
        now: existing.receivedAt || existing.timestamp,
      });
    } else if (msg.role === 'assistant') {
      const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
      const conversation = (db.conversations || []).find((item: Conversation) => (
        item.id === msg.conversationId && item.userId === msg.userId
      ));
      if (conversation) {
        const replayRecords = normalizeToolCalls(msg.toolCalls) || [];
        const receiptOwnership = partitionConversationReceiptsByOwnership(replayRecords, {
          taskId: conversation.actionContinuationState?.taskId,
          requestId: conversation.actionContinuationState?.activeRequestId
            || conversation.pendingActionContinuation?.requestId,
        });
        if (receiptOwnership.staleRecords.length > 0) {
          // The transcript row is immutable and already user-visible. A late
          // transport replay may contribute only archive-bound receipts; it
          // must never append or rewrite the assistant projection.
          archiveBoundConversationActionReceipts(db, {
            conversationId: conversation.id,
            userId: conversation.userId,
            records: receiptOwnership.staleRecords,
            turnId: requestId,
          });
        }
        finalizeConversationActionRequestInDb(db, conversation, requestId, {
          assistantState: existing.message,
          fallbackBlocker: 'The terminal assistant record was replayed without a verified task outcome.',
        });
      }
      finalizeManagerActionTurnFromAssistant({
        conversationId: msg.conversationId,
        userId: msg.userId,
        requestId,
        assistantMessageId: existing.id,
        reason: 'idempotent assistant transcript replay',
        now: existing.receivedAt || existing.timestamp,
      });
      commitDatabaseTables(db);
    }
    return existing.id;
  }

  const rows = (readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]).interactions || []).filter((item: any) => (
    item.conversationId === msg.conversationId
  ));
  const nextRouteSequence = rows.reduce((largest: number, item: any) => (
    Number.isFinite(Number(item.routeSequence))
      ? Math.max(largest, Math.floor(Number(item.routeSequence)))
      : largest
  ), 0) + 1;

  return addMessage({
    ...msg,
    requestId,
    externalMessageId: msg.externalMessageId || requestId,
    routeSequence: Number.isFinite(msg.routeSequence) ? msg.routeSequence : nextRouteSequence,
  });
}

/**
 * Replace only the user-visible terminal projection of an already accepted
 * assistant turn. This is used when cancellation or a failed durability fence
 * supersedes a response that was staged in memory before the strict flush.
 */
export function updateAssistantMessageTerminalPresentation(input: {
  userId: string;
  conversationId: string;
  requestId: string;
  content: string;
  completionFeedback: unknown;
  source?: string;
  channel?: string;
}): boolean {
  const completionFeedback = normalizeCompletionFeedbackForPersistence(input.completionFeedback);
  if (!completionFeedback) return false;
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  const requestId = String(input.requestId || '').trim();
  const row = (db.interactions || []).find((item: any) => (
    item.userId === input.userId
    && item.conversationId === input.conversationId
    && item.role === 'assistant'
    && (!input.source || item.source === input.source)
    && (!input.channel || item.channel === input.channel)
    && (
      String(item.requestId || '') === requestId
      || String(item.externalMessageId || '') === requestId
    )
  ));
  if (!row) return false;
  const content = String(input.content || '').replace(/\0/g, '').trim().slice(0, 8_000);
  row.message = content;
  row.content = content;
  row.response = '';
  row.completionFeedback = completionFeedback;
  commitDatabaseTables(db);
  return true;
}

function normalizeToolCalls(value: unknown): any[] | undefined {
  return sanitizeToolRecordsForPersistence(value);
}
export { type Conversation, type MessageRecord, type ConversationTurnOptions, type ConversationTurnResult } from "./manager/contracts";
export { compactRecordForPrompt, getMessages, getMessagesByTokenBudget, getMessagesThroughExternalMessage } from "./manager/message_history";
export { type DurableForegroundReleaseGateSnapshot, type DurableForegroundReleaseGate, type CreateDurableForegroundReleaseGateInput, createDurableForegroundReleaseGate } from "./manager/foreground_release_gate";
export { type AutoSummaryCheckResult, checkAutoSummary, beginConversationSummary, cancelConversationSummary, setConversationSummary, getConversationSummary, trackTopic, extractTopics, getTopicContext } from "./summary_state";
export { CONVERSATION_ACTION_EXECUTION_LEASE_TTL_MS, CONVERSATION_ACTION_EXECUTION_HEARTBEAT_INTERVAL_MS, type ConversationTerminalPersistenceUnknownProjection, type ConversationTerminalDurabilityStage, runWithConversationTerminalDurabilityStage, renewConversationActionExecutionLease, type ConversationActionExecutionLeaseLoss, type ConversationActionExecutionHeartbeat, startConversationActionExecutionHeartbeat } from "./action_execution_runtime";
export { finalizeForegroundRequest, type SupersedeConversationActionExecutionRequestInput, type SupersedeConversationActionExecutionRequestResult, convergeConversationActionRequestLease, convergeForegroundRequestBeforeRelease, convergeConversationActionRequestLeaseDurably, finalizeForegroundRequestDurably } from "./foreground_finalization";
export { type ConvergeConversationActionRequestLeaseInput, type ConversationActionRequestLeaseEvidence, type ConvergeConversationActionRequestLeaseResult, type ForegroundRequestFinalizationOutcome, type FinalizeForegroundRequestInput, type ForegroundRequestFinalizationEvidence, type FinalizeForegroundRequestResult, type ForegroundRequestDurabilityDependencies, type ForegroundRequestIdentity, type ForegroundRequestReleaseInput, type ForegroundRequestReleaseResult } from "./foreground_request_types";
export { getConversationFocusThreads, updateConversationActionFocus, getConversationActionStatus, getConversationForScope, getOrCreateActiveConversation, startNewConversation, startIsolatedConversation, type DeletedConversationData, deleteConversationData, shouldRolloverConversationForTurn, getOrCreateConversationForTurn, closeConversation, getActiveConversation, setConversationMode, getUserConversations, activateConversation, type BindConversationActionExecutionTurnInput, type BoundConversationActionExecutionTurn, getMessagesForAgent } from "./conversation_lifecycle";

function updateConversationForMessage(
  db: Pick<ReturnType<typeof readDatabaseTables>, "conversationActionReceipts" | "conversationActionTasks" | "conversationActionTurns" | "conversations" | "interactions" | "modelRoutingReceipts">,
  msg: Parameters<typeof addMessage>[0],
  id: string,
  now: string,
  normalizedToolCalls: ReturnType<typeof normalizeToolCalls>,
): string | undefined {
  let currentUserMessageIdForLedger = "";


  // Update conversation messageCount and lastActiveAt
  if (msg.conversationId && db.conversations) {
    const conv = db.conversations.find((c: Conversation) => c.id === msg.conversationId);
    if (conv) {
      hydrateConversationActionState(db, conv);
      conv.messageCount = (conv.messageCount || 0) + 1;
      conv.lastActiveAt = now;
      // Auto-title from first user message
      if (!conv.title && msg.role === 'user' && msg.content?.trim()) {
        conv.title = msg.content.trim().slice(0, 80);
      }

      const records = normalizedToolCalls || [];
      const receiptOwnership = !msg.skipActionContinuation
        && msg.role === 'assistant'
        && msg.mode !== 'proactive'
        ? partitionConversationReceiptsByOwnership(records, {
          taskId: conv.actionContinuationState?.taskId,
          requestId: conv.actionContinuationState?.activeRequestId
            || conv.pendingActionContinuation?.requestId,
        })
        : { currentRecords: records, staleRecords: [] };
      // A transport's semantic terminal result is fenced by the exact live
      // task/request/turn in resolveConversationActionTerminalDisposition.
      // Late receipts have their own immutable ownership fence below; their
      // presence in the same persistence batch must not suppress the current
      // request's otherwise-valid terminal disposition.
      const terminalTaskDisposition = resolveConversationActionTerminalDisposition({
        db,
        conversation: conv,
        role: msg.role,
        requestId: msg.requestId,
        skipActionContinuation: msg.skipActionContinuation,
        terminalDisposition: msg.terminalTaskDisposition,
      });
      if (receiptOwnership.staleRecords.length > 0) {
        // Receipt ownership is independent from the transient user/assistant
        // pairing pointer. A late terminal may arrive after that pointer was
        // cleared, but it must still be archived against its immutable task.
        archiveBoundConversationActionReceipts(db, {
          conversationId: conv.id,
          userId: conv.userId,
          records: receiptOwnership.staleRecords,
          turnId: msg.requestId,
          now,
        });
      }
      if (
        msg.role === 'assistant'
        && !conv.pendingActionContinuation
        && receiptOwnership.staleRecords.length > 0
        && receiptOwnership.currentRecords.length === 0
      ) {
        // The foreground pairing slot has already closed. Persist the delayed
        // transcript/archive, fence its historical turn, and return without a
        // generic task sync that would rewrite audit fields on the newer owner.
        if (msg.requestId) {
          finalizePersistedAssistantActionTurnInDb(db, {
            conversationId: conv.id,
            userId: conv.userId,
            requestId: msg.requestId,
            assistantMessageId: id,
            assistantText: msg.content,
            now,
          });
        }
        commitDatabaseTables(db);
        return id;
      }

      if (!msg.skipActionContinuation && msg.role === 'user' && !msg.deferActionPreparation) {
        const userText = String(msg.content || '').trim();
        if (userText) {
          currentUserMessageIdForLedger = id;
          const userObservedCompletion = isUserObservedTaskCompletion(
            userText,
            conv.actionContinuationState,
          );
          const continuationTurn = needsRecentActionContinuationContext(userText);
          const contract = buildActionContract(userText);
          const actionTurn = contract.applies && contract.kind !== 'none';
          if (!userObservedCompletion) {
            detachUnrelatedConversationActionState(db, conv, userText, now);
          }
          const preparedSameTurn = Boolean(
            conv.actionContinuationState
            && conv.actionContinuationState.latestInstruction === userText
            && (
              conversationTaskStatusOwnsExecutionLease(conv.actionContinuationState.status)
              || conv.actionContinuationState.status === 'waiting_confirmation'
            ),
          );
          if (userObservedCompletion && conv.actionContinuationState) {
            finalizeConversationActionTask(db, {
              conversation: conv,
              state: conv.actionContinuationState,
              outcome: 'completed',
              requestId: msg.requestId,
              assistantState: userText,
              completionSource: 'user_observation',
              userText,
              now,
            });
          } else {
            // A user-message wording heuristic may stage pending turn context,
            // but it never creates a durable task. The canonical capability
            // selection path, an explicit model taskIntent, or a durable tool
            // receipt owns task creation.
            if (!actionTurn && !continuationTurn && !preparedSameTurn) {
              // A finished pointer is useful for an immediate “打开它/结果呢”,
              // but must not survive an unrelated topic indefinitely. Unfinished
              // work remains resumable while ordinary conversation continues.
              if (conv.actionContinuationState && !conv.actionContinuationState.unfinished) {
                delete conv.actionContinuationState;
              }
            }
            // This protects the integrity of every user/assistant turn at the
            // rollover boundary. Action-state advancement below is still gated
            // by the actual action contract and terminal receipts.
            conv.pendingActionContinuation = {
              userText,
              messageId: id,
              requestId: msg.requestId,
              updatedAt: now,
            };
          }
        }
      } else if (
        !msg.skipActionContinuation
        &&
        msg.role === 'assistant'
        && msg.mode !== 'proactive'
        && conv.pendingActionContinuation
      ) {
        const pending = conv.pendingActionContinuation;
        currentUserMessageIdForLedger = pending.messageId;
        const activeTaskId = String(conv.actionContinuationState?.taskId || '');
        const currentToolRecords = receiptOwnership.currentRecords;
        const requestMismatch = Boolean(
          pending.requestId
          && msg.requestId
          && pending.requestId !== msg.requestId,
        );
        // A superseded pipeline may still finish and persist its terminal
        // reply. Archive its bound receipts above, but leave the newer turn's
        // pending pointer and state untouched.
        if (requestMismatch) {
          if (conv.actionContinuationState) {
            syncConversationActionTaskLedger(db, {
              conversation: conv,
              state: conv.actionContinuationState,
              now,
            });
          }
          if (msg.requestId) {
            finalizePersistedAssistantActionTurnInDb(db, {
              conversationId: conv.id,
              userId: conv.userId,
              requestId: msg.requestId,
              assistantMessageId: id,
              assistantText: msg.content,
              now,
            });
          }
          commitDatabaseTables(db);
          return id;
        }
        if (records.length > 0 && currentToolRecords.length === 0) {
          // The assistant terminal is already durable and visible. Stale
          // receipts remain quarantined above, but they must never keep this
          // request's transcript pointer or execution lease alive forever.
          finalizeConversationActionRequestInDb(
            db,
            conv,
            msg.requestId || pending.requestId || '',
            {
              assistantState: msg.content,
              fallbackBlocker: 'The terminal tool receipts could not be bound to the active task identity.',
              now,
            },
          );
          if (msg.requestId) {
            finalizePersistedAssistantActionTurnInDb(db, {
              conversationId: conv.id,
              userId: conv.userId,
              requestId: msg.requestId,
              assistantMessageId: id,
              assistantText: msg.content,
              now,
            });
          }
          commitDatabaseTables(db);
          return id;
        }
        const pendingFollowupIntent = classifyRecentActionFollowupIntent(pending.userText);
        const pendingContract = buildActionContract(pending.userText);
        const pendingNormalizedIntent = normalizeActionIntent(pending.userText);
        const toolRecordsBelongToActiveTask = Boolean(
          conv.actionContinuationState?.taskId
          && currentToolRecords.some((record: any) => (
            record?.taskId === conv.actionContinuationState?.taskId
            || (
              conv.actionContinuationState?.activeRequestId
              && record?.requestId === conv.actionContinuationState.activeRequestId
            )
          )),
        );
        const taskDurability = currentToolRecords.map(record => (
          classifyToolRecordTaskDurability(record)
        ));
        const hasDurableCapabilityReceipt = taskDurability.includes('durable');
        const hasLegacyUnknownReceipt = taskDurability.includes('unknown');
        // Legacy persisted rows predate capability snapshots. Preserve their
        // old action migration path, while never using that wording heuristic
        // to turn a canonical observe/read receipt into a durable task.
        const legacyUnknownExecutionIntent = hasLegacyUnknownReceipt && (
          (pendingContract.applies && pendingContract.kind !== 'none')
          || ['client_navigation', 'external_ai_history'].includes(pendingNormalizedIntent.kind)
        );
        const pendingExpectsExecution = msg.taskIntent === 'task'
          || pendingFollowupIntent === 'execute'
          || toolRecordsBelongToActiveTask
          || hasDurableCapabilityReceipt
          || legacyUnknownExecutionIntent;
        const pendingAgeMs = Date.now() - new Date(pending.updatedAt).getTime();
        if (
          pendingExpectsExecution
          && currentToolRecords.length
          && Number.isFinite(pendingAgeMs)
          && pendingAgeMs >= 0
          && pendingAgeMs <= 30 * 60 * 1000
        ) {
          // The task state intentionally coalesces a failed attempt followed by
          // a successful retry into one authoritative logical step. The
          // append-only receipt table must still retain both attempts so later
          // diagnosis can explain latency and recovery instead of presenting a
          // falsely clean history.
          const nextState = buildConversationActionContinuationState({
            previous: conv.actionContinuationState,
            userText: pending.userText,
            assistantText: msg.content,
            toolCalls: currentToolRecords,
            updatedAt: now,
            evidenceMessageId: id,
            userMessageId: pending.messageId,
            requestId: conv.actionContinuationState?.activeRequestId || pending.requestId || msg.requestId,
            toolPolicy: conv.actionContinuationState?.policySnapshot,
          });
          if (nextState) {
            const receiptTaskId = activeTaskId || nextState.taskId;
            const receiptRequestId = String(msg.requestId || pending.requestId || '').trim();
            const attemptRecords = currentToolRecords.map((record: any) => ({
              ...record,
              taskId: receiptTaskId,
              turnId: record.turnId || currentUserMessageIdForLedger || msg.requestId || pending.requestId,
              requestId: record.requestId || msg.requestId || pending.requestId,
            }));
            if (!activeTaskId) {
              // A durable tool receipt may be the first canonical signal that
              // this turn owns a task. Create the row without its coalesced
              // receipts first, so the raw failed attempt can be archived
              // before the successful retry and remains chronologically true.
              syncConversationActionTaskLedger(db, {
                conversation: conv,
                state: {
                  ...nextState,
                  status: 'executing',
                  receipts: [],
                  unfinished: true,
                  latestBlocker: '',
                  completionSource: undefined,
                  activeRequestId: receiptRequestId || undefined,
                },
                userText: pending.userText,
                rootUserMessageId: currentUserMessageIdForLedger || undefined,
                currentUserMessageId: currentUserMessageIdForLedger || undefined,
                now,
              });
            }
            if (receiptRequestId && receiptTaskId) {
              bindConversationActionTurnTask({
                conversationId: conv.id,
                userId: conv.userId,
                requestId: receiptRequestId,
                taskId: receiptTaskId,
                now,
              });
            }
            const receiptArchive = archiveBoundConversationActionReceipts(db, {
              conversationId: conv.id,
              userId: conv.userId,
              records: attemptRecords,
              turnId: currentUserMessageIdForLedger || msg.requestId || pending.requestId,
              now,
              terminalDisposition: terminalTaskDisposition || undefined,
              assistantState: msg.content,
              currentPairingAuthority: {
                userMessageId: pending.messageId,
                assistantMessageId: id,
              },
            });
            const receiptAdjudicated = receiptArchive.adjudicatedTaskIds.includes(receiptTaskId);
            if (!receiptAdjudicated) {
              // Historical/unbound records remain append-only evidence. They
              // cannot update the current live projection in this fallback.
            } else if (receiptArchive.terminalDispositionApplied) {
              // The append-only receipts and authoritative request outcome were
              // committed together. Never recompute completion from a successful
              // earlier step later in this assistant persistence boundary.
            } else if (isTerminalConversationTaskStatus(nextState.status)) {
              finalizeConversationActionTask(db, {
                conversation: conv,
                state: nextState,
                outcome: nextState.status as 'completed' | 'failed' | 'cancelled',
                requestId: receiptRequestId,
                blocker: nextState.latestBlocker,
                assistantState: nextState.assistantState,
                completionSource: nextState.completionSource,
                userText: pending.userText,
                now,
                retainPendingAction: true,
              });
            } else if (nextState.status === 'blocked') {
              finalizeConversationActionTask(db, {
                conversation: conv,
                state: nextState,
                outcome: 'blocked',
                requestId: msg.requestId || pending.requestId,
                blocker: nextState.latestBlocker,
                assistantState: nextState.assistantState,
                userText: pending.userText,
                now,
                retainPendingAction: true,
              });
            } else {
              conv.actionContinuationState = nextState;
            }
          }
        } else if (
          msg.taskIntent === 'task'
          && !conv.actionContinuationState?.unfinished
        ) {
          // A model may explicitly classify a turn as durable work before it
          // has a terminal receipt. Preserve that task as blocked/resumable,
          // rather than silently losing it or inferring durability from prose.
          const prepared = prepareConversationActionTaskState(undefined, {
            userText: pending.userText,
            requestId: pending.requestId || msg.requestId || id,
            toolPolicy: {
              allowedTools: [],
              requireConfirmation: [],
              forbiddenTools: [],
              maxIterations: 5,
            },
            forceTask: true,
            now,
          });
          if (prepared.state) {
            finalizeConversationActionTask(db, {
              conversation: conv,
              state: prepared.state,
              outcome: terminalTaskDisposition?.outcome || 'blocked',
              requestId: pending.requestId || msg.requestId || id,
              blocker: terminalTaskDisposition?.reason
                || 'No terminal tool receipt was recorded for the requested step.',
              assistantState: compactRolloverText(msg.content, 700),
              userText: pending.userText,
              now,
              retainPendingAction: true,
            });
          }
        } else if (
          conv.actionContinuationState?.unfinished
          && pendingExpectsExecution
        ) {
          finalizeConversationActionTask(db, {
            conversation: conv,
            state: conv.actionContinuationState,
            outcome: terminalTaskDisposition?.outcome || 'blocked',
            requestId: msg.requestId || pending.requestId,
            blocker: terminalTaskDisposition?.reason
              || 'No terminal tool receipt was recorded for the requested step.',
            assistantState: msg.content,
            userText: pending.userText,
            now,
            retainPendingAction: true,
          });
        }
        const terminalRequestId = String(msg.requestId || pending.requestId || '').trim();
        if (terminalRequestId && conv.actionContinuationState?.taskId) {
          bindConversationActionTurnTask({
            conversationId: conv.id,
            userId: conv.userId,
            requestId: terminalRequestId,
            taskId: conv.actionContinuationState.taskId,
            now,
          });
        }
        finalizeConversationActionRequestInDb(
          db,
          conv,
          terminalRequestId,
          {
            assistantState: msg.content,
            fallbackBlocker: 'The execution request ended without a terminal tool receipt.',
            now,
            terminalDisposition: terminalTaskDisposition || undefined,
          },
        );
      }

      if (conv.actionContinuationState && !msg.skipActionContinuation) {
        syncConversationActionTaskLedger(db, {
          conversation: conv,
          state: conv.actionContinuationState,
          userText: msg.role === 'user'
            ? String(msg.content || '')
            : conv.actionContinuationState.latestInstruction,
          ...(msg.role === 'assistant' && currentUserMessageIdForLedger
            ? { rootUserMessageId: currentUserMessageIdForLedger }
            : {}),
          ...(currentUserMessageIdForLedger
            ? { currentUserMessageId: currentUserMessageIdForLedger }
            : {}),
          now,
        });
      }
    }
  }
}
