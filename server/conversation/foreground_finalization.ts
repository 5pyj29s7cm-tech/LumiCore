import { parseStoredObject as parsePersistedObject } from '../tools/receipt_payload';
import { getConversationActionTurn, reconcileConversationActionTurnLease, type ConversationActionTurn } from './action_turn_ledger';
import { normalizeConversationActionState, type ConversationActionContinuationState } from '../cognition/action_continuation';
import { flushDBOrThrow, readDatabaseTables, commitDatabaseTables } from '../../db_layer';
import { type Conversation } from "./manager/contracts";
import { finalizeConversationActionTask } from "./ledger/task_lifecycle";
import { getConversationActionStateByTaskId } from "./ledger/queries";
import { type ConversationActionLiveProjection } from "./ledger/contracts";
import { conversationTaskStatusOwnsExecutionLease, isTerminalConversationTaskStatus } from '../cognition/task_execution_ledger';
import { type ConvergeConversationActionRequestLeaseInput, type FinalizeForegroundRequestInput, type ForegroundRequestFinalizationOutcome, type FinalizeForegroundRequestResult, type ConvergeConversationActionRequestLeaseResult, type ForegroundRequestReleaseInput, type ForegroundRequestDurabilityDependencies, type ForegroundRequestReleaseResult } from "./foreground_request_types";
import { clearManagerActionRequestLeaseOwner } from "./action_execution_runtime";

function normalizeConversationActionRequestLeaseIdentity(
  input: ConvergeConversationActionRequestLeaseInput,
): ConvergeConversationActionRequestLeaseInput & {
  conversationId: string;
  userId: string;
  requestId: string;
  now: string;
} {
  const conversationId = String(input.conversationId || '').trim();
  const userId = String(input.userId || '').trim();
  const requestId = String(input.requestId || '').trim();
  if (!conversationId || !userId || !requestId) {
    throw new TypeError('conversationId, userId, and requestId are required');
  }
  const parsedNow = input.now instanceof Date
    ? new Date(input.now.getTime())
    : new Date(input.now ?? Date.now());
  if (!Number.isFinite(parsedNow.getTime())) throw new TypeError('now must be a valid date');
  return {
    ...input,
    conversationId,
    userId,
    requestId,
    now: parsedNow.toISOString(),
  };
}

function normalizeForegroundRequestFinalizationInput(
  input: FinalizeForegroundRequestInput,
): FinalizeForegroundRequestInput & {
  conversationId: string;
  userId: string;
  requestId: string;
  expectedTaskId: string;
  assistantMessageId: string;
  assistantState: string | undefined;
  reason: string;
  now: string;
} {
  const conversationId = String(input.conversationId || '').trim();
  const userId = String(input.userId || '').trim();
  const requestId = String(input.requestId || '').trim();
  if (!conversationId || !userId || !requestId) {
    throw new TypeError('conversationId, userId, and requestId are required');
  }
  if (!['terminal', 'cancelled', 'superseded', 'blocked', 'persistence_unknown'].includes(input.outcome)) {
    throw new TypeError('outcome must be terminal, cancelled, superseded, blocked, or persistence_unknown');
  }
  const parsedNow = input.now instanceof Date
    ? new Date(input.now.getTime())
    : new Date(input.now ?? Date.now());
  if (!Number.isFinite(parsedNow.getTime())) throw new TypeError('now must be a valid date');
  return {
    ...input,
    conversationId,
    userId,
    requestId,
    expectedTaskId: String(input.expectedTaskId || '').trim(),
    assistantMessageId: String(input.assistantMessageId || '').trim(),
    assistantState: input.assistantState === undefined
      ? undefined
      : String(input.assistantState || '').replace(/\s+/g, ' ').trim().slice(0, 700),
    reason: String(input.reason || '').replace(/\s+/g, ' ').trim().slice(0, 380),
    now: parsedNow.toISOString(),
  };
}

function foregroundTaskPersistenceRequestId(task: any): string {
  const context = parsePersistedObject(task?.context);
  const actionState = parsePersistedObject(context.actionState);
  const marker = context.terminalPersistence?.status === 'persistence_unknown'
    ? context.terminalPersistence
    : actionState.terminalPersistence?.status === 'persistence_unknown'
      ? actionState.terminalPersistence
      : null;
  return String(marker?.requestId || '').trim();
}

function foregroundTaskAlreadyConverged(
  task: any,
  outcome: ForegroundRequestFinalizationOutcome,
  requestId: string,
): boolean {
  if (!task || String(task.activeRequestId || '').trim()) return false;
  if (outcome === 'terminal' && task.status !== 'completed') return false;
  if (outcome === 'cancelled' && task.status !== 'cancelled') return false;
  if (
    (outcome === 'blocked' || outcome === 'superseded' || outcome === 'persistence_unknown')
    && task.status !== 'blocked'
  ) {
    return false;
  }
  if (outcome === 'persistence_unknown') {
    return foregroundTaskPersistenceRequestId(task) === requestId;
  }
  const finalization = parsePersistedObject(parsePersistedObject(task.context).taskFinalization);
  const persistedOutcome = outcome === 'terminal'
    ? 'completed'
    : outcome === 'superseded' ? 'blocked' : outcome;
  return String(finalization.requestId || '').trim() === requestId
    && finalization.outcome === persistedOutcome;
}

function applyForegroundActionTurnOutcomeInDb(
  turn: ConversationActionTurn,
  input: {
    status: 'terminal' | 'cancelled' | 'persistence_unknown';
    assistantMessageId: string;
    reason: string;
    now: string;
  },
): boolean {
  if (
    turn.status === input.status
    && (input.status !== 'terminal' || turn.terminalMessageId === input.assistantMessageId)
  ) return false;

  turn.status = input.status;
  turn.terminalMessageId = input.status === 'terminal' ? input.assistantMessageId : '';
  turn.terminalReason = input.reason;
  turn.terminalAt = input.now;
  turn.updatedAt = input.now;
  turn.revision = Math.max(0, Number(turn.revision) || 0) + 1;
  turn.leaseOwnerId = '';
  turn.leaseEpoch = '';
  turn.leaseAcquiredAt = '';
  turn.leaseHeartbeatAt = '';
  turn.leaseExpiresAt = '';
  if (input.status === 'persistence_unknown') {
    turn.recoveryReason = input.reason;
    turn.recoveredAt = input.now;
  }
  return true;
}

function quarantineForegroundTaskWithoutActionTurnInDb(
  task: any,
  state: ConversationActionContinuationState,
  input: {
    requestId: string;
    reason: string;
    assistantState?: string;
    now: string;
  },
): ConversationActionContinuationState | null {
  const marker = {
    status: 'persistence_unknown' as const,
    requestId: input.requestId,
    quarantinedAt: input.now,
  };
  const next = normalizeConversationActionState({
    ...state,
    version: 2,
    status: 'blocked',
    unfinished: true,
    latestBlocker: input.reason,
    assistantState: input.assistantState === undefined
      ? state.assistantState
      : input.assistantState,
    activeRequestId: undefined,
    completionSource: undefined,
    terminalPersistence: marker,
    revision: Math.max(Number(task.revision) || 0, state.revision || 0) + 1,
    updatedAt: input.now,
  });
  if (!next) return null;
  const context = parsePersistedObject(task.context);
  task.status = 'blocked';
  task.blocker = input.reason;
  task.activeRequestId = '';
  task.completionSource = '';
  task.completedAt = '';
  task.updatedAt = input.now;
  task.revision = next.revision;
  task.context = JSON.stringify({
    ...context,
    actionState: next,
    taskFinalization: {
      outcome: 'persistence_unknown',
      requestId: input.requestId,
      reason: input.reason,
      finalizedAt: input.now,
    },
    terminalPersistence: marker,
  });
  return next;
}

/**
 * Atomically converge one foreground request in the shared in-memory DB.
 *
 * The immutable action-turn binding is the authority for task ownership. The
 * task/live/pending projections are settled first, then the durable action
 * turn and finally its process-local owner. Missing or ambiguous evidence is
 * never guessed: an otherwise identifiable request is quarantined as
 * persistence_unknown instead of publishing success.
 *
 * Chat, Task, and Voice use this boundary before releasing foreground
 * resources so every entry point applies the same task/receipt ownership
 * verdict.
 */
export function finalizeForegroundRequest(
  input: FinalizeForegroundRequestInput,
): FinalizeForegroundRequestResult {
  const identity = normalizeForegroundRequestFinalizationInput(input);
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  const conversations = (Array.isArray(db.conversations) ? db.conversations : [])
    .filter((row: Conversation) => (
      row.id === identity.conversationId && row.userId === identity.userId
    ));
  const turns = (Array.isArray(db.conversationActionTurns) ? db.conversationActionTurns : [])
    .filter((row: ConversationActionTurn) => (
      row.conversationId === identity.conversationId
      && row.userId === identity.userId
      && row.requestId === identity.requestId
    ));
  const assistants = identity.assistantMessageId
    ? (Array.isArray(db.interactions) ? db.interactions : []).filter((row: any) => (
        row.id === identity.assistantMessageId
        && row.userId === identity.userId
        && row.conversationId === identity.conversationId
        && row.role === 'assistant'
        && (
          String(row.requestId || '') === identity.requestId
          || String(row.externalMessageId || '') === identity.requestId
        )
      ))
    : [];

  const evidence: FinalizeForegroundRequestResult['evidence'] = {
    conversation: conversations.length === 1
      ? 'found'
      : conversations.length === 0 ? 'missing' : 'ambiguous',
    actionTurn: turns.length === 1
      ? 'found'
      : turns.length === 0 ? 'missing' : 'ambiguous',
    task: 'unbound',
    assistant: !identity.assistantMessageId
      ? 'unbound'
      : assistants.length === 1 ? 'found' : assistants.length === 0 ? 'missing' : 'ambiguous',
  };

  const turnTaskIds: string[] = [...new Set<string>(turns.map((turn: ConversationActionTurn) => (
    String(turn.taskId || '').trim()
  )).filter(Boolean))];
  const durableTurnTaskId = turns.length === 1
    ? String(turns[0].taskId || '').trim()
    : turnTaskIds.length === 1 ? turnTaskIds[0] : '';
  // An executor can survive a damaged/missing action-turn row. The caller's
  // expectedTaskId is usable only as a fail-closed cleanup fence when the one
  // exact task row still says this request owns its active lease. It is never
  // sufficient evidence for completion.
  const durableTaskId = durableTurnTaskId || (
    turns.length === 0 ? identity.expectedTaskId : ''
  );
  const taskRows = durableTaskId
    ? (Array.isArray(db.conversationActionTasks) ? db.conversationActionTasks : [])
        .filter((row: any) => (
          row.id === durableTaskId
          && row.conversationId === identity.conversationId
          && row.userId === identity.userId
        ))
    : [];
  if (durableTaskId) {
    evidence.task = taskRows.length === 1
      ? 'found'
      : taskRows.length === 0 ? 'missing' : 'ambiguous';
  }

  let reason = identity.reason;
  let effectiveOutcome = identity.outcome;
  const exactMissingTurnTaskFence = Boolean(
    turns.length === 0
    && identity.expectedTaskId
    && durableTaskId === identity.expectedTaskId
    && taskRows.length === 1
    && String(taskRows[0].activeRequestId || '').trim() === identity.requestId
  );
  let taskCanMutate = taskRows.length === 1
    && (turns.length > 0 || exactMissingTurnTaskFence);
  const exactAssistant = evidence.assistant === 'found';
  let failedClosed = false;
  const failClosed = (nextReason: string) => {
    if (!reason || (identity.outcome === 'superseded' && !failedClosed)) reason = nextReason;
    effectiveOutcome = 'persistence_unknown';
    failedClosed = true;
  };

  if (evidence.actionTurn !== 'found') failClosed(`action_turn_${evidence.actionTurn}`);
  if (evidence.conversation !== 'found') failClosed(`conversation_${evidence.conversation}`);
  if (turns.length > 1 && turnTaskIds.length !== 1) {
    evidence.task = turnTaskIds.length === 0 ? 'unbound' : 'ambiguous';
    taskCanMutate = false;
    failClosed('action_turn_task_binding_ambiguous');
  }
  if (identity.expectedTaskId) {
    if (!durableTurnTaskId && turns.length > 0) {
      evidence.task = 'mismatch';
      taskCanMutate = false;
      failClosed('expected_task_binding_missing');
    } else if (durableTurnTaskId && durableTurnTaskId !== identity.expectedTaskId) {
      evidence.task = 'mismatch';
      taskCanMutate = false;
      failClosed('expected_task_binding_mismatch');
    }
  }
  if (durableTaskId && taskRows.length !== 1) {
    taskCanMutate = false;
    failClosed(`task_${evidence.task}`);
  }
  if (taskRows.length === 1) {
    const activeRequestId = String(taskRows[0].activeRequestId || '').trim();
    if (
      (turns.length === 0 && identity.expectedTaskId && !exactMissingTurnTaskFence)
      || (activeRequestId && activeRequestId !== identity.requestId)
    ) {
      evidence.task = 'mismatch';
      taskCanMutate = false;
      failClosed('task_active_request_mismatch');
    }
  }
  if (identity.outcome === 'terminal' && !exactAssistant) {
    failClosed(`assistant_${evidence.assistant}`);
  }
  if (identity.outcome === 'blocked' && !exactAssistant && !reason) {
    reason = 'Foreground request ended without a durable assistant transcript.';
  }
  if (
    !exactAssistant
    && taskRows.length === 1
    && ['completed', 'failed'].includes(String(taskRows[0].status || ''))
  ) {
    failClosed(`terminal_task_without_assistant:${String(taskRows[0].status || 'unknown')}`);
  }
  if (taskRows.length === 1 && foregroundTaskPersistenceRequestId(taskRows[0])) {
    failClosed('task_already_persistence_unknown');
  }

  let desiredActionStatus: 'terminal' | 'cancelled' | 'persistence_unknown' =
    effectiveOutcome === 'cancelled' || effectiveOutcome === 'superseded'
      ? 'cancelled'
      : effectiveOutcome === 'persistence_unknown'
        ? 'persistence_unknown'
        : exactAssistant ? 'terminal' : 'persistence_unknown';
  if (!reason) {
    reason = desiredActionStatus === 'terminal'
      ? 'Exact durable assistant transcript finalized the foreground request.'
      : desiredActionStatus === 'cancelled'
        ? 'Foreground request was cancelled.'
        : effectiveOutcome === 'blocked'
          ? 'Foreground request is blocked and remains resumable.'
          : 'Foreground request persistence outcome is unknown.';
  }

  // A previously quarantined request cannot be promoted by an ordinary retry.
  // Likewise, a conflicting terminal identity must not mutate its task first.
  let preserveUniqueTurn = false;
  if (turns.length === 1) {
    const current = turns[0];
    const compatibleTerminal = current.status === desiredActionStatus
      && (current.status !== 'terminal' || current.terminalMessageId === identity.assistantMessageId);
    if (
      ['terminal', 'cancelled', 'persistence_unknown'].includes(current.status)
      && !compatibleTerminal
    ) {
      taskCanMutate = false;
      preserveUniqueTurn = true;
      effectiveOutcome = current.status === 'persistence_unknown'
        ? 'persistence_unknown'
        : effectiveOutcome;
      desiredActionStatus = current.status;
      reason = `action_turn_terminal_conflict:${current.status}`;
    }
  }

  let dbChanged = false;
  let taskStatus = taskRows.length === 1 ? String(taskRows[0].status || '') : '';
  let finalizedTaskState: ConversationActionContinuationState | null = null;
  if (durableTaskId && taskCanMutate) {
    const taskOutcome = effectiveOutcome === 'terminal'
      ? 'completed'
      : effectiveOutcome === 'superseded' ? 'blocked' : effectiveOutcome;
    const taskOutcomeKey: ForegroundRequestFinalizationOutcome = effectiveOutcome;
    if (!foregroundTaskAlreadyConverged(taskRows[0], taskOutcomeKey, identity.requestId)) {
      const taskState = getConversationActionStateByTaskId(db, {
        conversationId: identity.conversationId,
        userId: identity.userId,
        taskId: durableTaskId,
      });
      const projection: ConversationActionLiveProjection = conversations.length === 1
        ? conversations[0]
        : { id: identity.conversationId, userId: identity.userId };
      const finalizedState = taskState && exactMissingTurnTaskFence
        ? quarantineForegroundTaskWithoutActionTurnInDb(taskRows[0], taskState, {
            requestId: identity.requestId,
            reason,
            assistantState: identity.assistantState,
            now: identity.now,
          })
        : taskState && finalizeConversationActionTask(db, {
            conversation: projection,
            state: taskState,
            outcome: taskOutcome,
            requestId: identity.requestId,
            blocker: effectiveOutcome === 'terminal' || effectiveOutcome === 'superseded' ? '' : reason,
            assistantState: identity.assistantState,
            completionSource: effectiveOutcome === 'terminal' ? taskState.completionSource : undefined,
            now: identity.now,
          })?.state;
      if (finalizedState) {
        finalizedTaskState = finalizedState;
        taskStatus = finalizedState.status;
        if (effectiveOutcome === 'superseded') {
          // Supersession is not a user-facing blocker, so keep latestBlocker
          // clean while retaining an explicit internal audit reason.
          const taskContext = parsePersistedObject(taskRows[0].context);
          const taskFinalization = parsePersistedObject(taskContext.taskFinalization);
          taskRows[0].context = JSON.stringify({
            ...taskContext,
            taskFinalization: {
              ...taskFinalization,
              requestDisposition: 'superseded',
              reason,
            },
          });
        }
        dbChanged = true;
      } else {
        taskCanMutate = false;
        effectiveOutcome = 'persistence_unknown';
        desiredActionStatus = 'persistence_unknown';
        reason = 'task_finalization_failed';
      }
    } else {
      finalizedTaskState = getConversationActionStateByTaskId(db, {
        conversationId: identity.conversationId,
        userId: identity.userId,
        taskId: durableTaskId,
      });
    }
  }

  // Remove only the exact request projection. A newer task/request is never
  // cleared by a delayed finalizer.
  for (const conversation of conversations) {
    if (conversation.pendingActionContinuation?.requestId === identity.requestId) {
      delete conversation.pendingActionContinuation;
      dbChanged = true;
    }
    const live = normalizeConversationActionState(conversation.actionContinuationState);
    if (
      finalizedTaskState
      && live?.taskId === durableTaskId
      && (!live.activeRequestId || live.activeRequestId === identity.requestId)
    ) {
      if (isTerminalConversationTaskStatus(finalizedTaskState.status)) {
        delete conversation.actionContinuationState;
        dbChanged = true;
      } else if (JSON.stringify(live) !== JSON.stringify(finalizedTaskState)) {
        conversation.actionContinuationState = finalizedTaskState;
        dbChanged = true;
      }
    }
  }

  if (turns.length > 0 && !(turns.length === 1 && preserveUniqueTurn)) {
    for (const turn of turns) {
      // Ambiguous duplicate rows are all quarantined. For a unique row the
      // preflight above preserves any conflicting monotonic terminal state.
      const status = turns.length > 1 ? 'persistence_unknown' : desiredActionStatus;
      dbChanged = applyForegroundActionTurnOutcomeInDb(turn, {
        status,
        assistantMessageId: status === 'terminal' ? identity.assistantMessageId : '',
        reason,
        now: identity.now,
      }) || dbChanged;
    }
  }

  if (dbChanged) commitDatabaseTables(db);
  const localOwnerCleared = identity.deferLocalOwnerClear
    ? false
    : clearManagerActionRequestLeaseOwner(
        identity,
        desiredActionStatus === 'terminal' ? '' : reason,
      );
  const finalTurnStatus = turns.length === 0
    ? 'missing'
    : turns.length > 1 ? 'ambiguous' : turns[0].status;
  const taskConverged = !durableTaskId
    ? !identity.expectedTaskId
    : taskCanMutate && !String(taskRows[0]?.activeRequestId || '').trim();
  const actionConverged = turns.length === 1
    && ['terminal', 'cancelled', 'persistence_unknown'].includes(turns[0].status);

  return {
    conversationId: identity.conversationId,
    userId: identity.userId,
    requestId: identity.requestId,
    requestedOutcome: identity.outcome,
    effectiveOutcome,
    taskId: durableTaskId,
    assistantMessageId: exactAssistant ? identity.assistantMessageId : '',
    taskStatus,
    actionTurnStatus: finalTurnStatus,
    converged: actionConverged && taskConverged,
    changed: dbChanged || localOwnerCleared,
    reason,
    evidence,
    localOwnerCleared,
  };
}

export interface SupersedeConversationActionExecutionRequestInput {
  readonly conversationId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly expectedTaskId: string;
  readonly reason?: string;
  readonly now?: Date | string | number;
  /** @internal Release-time callers retain the process owner through strict flush. */
  readonly deferLocalOwnerClear?: boolean;
}

export type SupersedeConversationActionExecutionRequestResult =
  FinalizeForegroundRequestResult & {
    requestedOutcome: 'superseded';
    superseded: boolean;
  };

/**
 * Reconcile one foreground request from durable transcript/task evidence.
 *
 * This deliberately does not depend on a live conversation projection: an
 * executor can outlive a deleted conversation or task row, and its durable
 * action-turn lease must still stop fencing the thread. A successful assistant
 * transcript is sufficient terminal evidence. Missing or ambiguous ownership
 * is quarantined instead of being guessed from the task projection.
 *
 * Every foreground transport uses this manager-level primitive before its
 * channel-specific resources are released.
 */
export function convergeConversationActionRequestLease(
  input: ConvergeConversationActionRequestLeaseInput,
): ConvergeConversationActionRequestLeaseResult {
  const identity = normalizeConversationActionRequestLeaseIdentity(input);
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  const before = getConversationActionTurn(identity);
  const conversations = (Array.isArray(db.conversations) ? db.conversations : [])
    .filter((row: Conversation) => row.id === identity.conversationId && row.userId === identity.userId);
  const assistants = (Array.isArray(db.interactions) ? db.interactions : [])
    .filter((row: any) => (
      row.userId === identity.userId
      && row.conversationId === identity.conversationId
      && row.role === 'assistant'
      && (
        String(row.requestId || '') === identity.requestId
        || String(row.externalMessageId || '') === identity.requestId
      )
    ));
  const taskId = String(before?.taskId || '').trim();
  const tasks = taskId
    ? (Array.isArray(db.conversationActionTasks) ? db.conversationActionTasks : [])
        .filter((row: any) => (
          row.id === taskId
          && row.conversationId === identity.conversationId
          && row.userId === identity.userId
        ))
    : [];
  const evidence = {
    conversation: conversations.length === 1
      ? 'found' as const
      : conversations.length === 0 ? 'missing' as const : 'ambiguous' as const,
    task: !taskId
      ? 'unbound' as const
      : tasks.length === 1 ? 'found' as const : tasks.length === 0 ? 'missing' as const : 'ambiguous' as const,
    assistant: assistants.length === 1
      ? 'found' as const
      : assistants.length === 0 ? 'missing' as const : 'ambiguous' as const,
  };

  const result = (
    action: ConvergeConversationActionRequestLeaseResult['action'],
    reason: string,
    turn: ConversationActionTurn | null,
    changed: boolean,
    localOwnerCleared: boolean,
  ): ConvergeConversationActionRequestLeaseResult => {
    const exactTask = tasks.length === 1 ? tasks[0] : null;
    const exactTaskActiveRequestId = String(exactTask?.activeRequestId || '').trim();
    const taskLeaseSettled = !exactTask || (
      exactTaskActiveRequestId
        ? exactTaskActiveRequestId !== identity.requestId
        : !conversationTaskStatusOwnsExecutionLease(String(exactTask.status || ''))
    );
    return {
      conversationId: identity.conversationId,
      userId: identity.userId,
      requestId: identity.requestId,
      taskId,
      assistantMessageId: String(turn?.terminalMessageId || '').trim(),
      beforeStatus: before?.status || 'missing',
      finalStatus: turn?.status || 'missing',
      action,
      // A terminal action-turn is only one half of foreground convergence. A
      // task owned by this exact request must still be settled. An explicit,
      // different activeRequestId proves that a successor already owns the
      // task; an old finally block must then converge request-scoped without
      // clearing or mutating that newer owner.
      converged: Boolean(
        turn
        && ['terminal', 'cancelled', 'persistence_unknown'].includes(turn.status)
        && taskLeaseSettled
      ),
      changed: changed || localOwnerCleared,
      reason,
      evidence,
      localOwnerCleared,
      turn,
    };
  };

  if (!before) {
    const localOwnerCleared = identity.deferLocalOwnerClear
      ? false
      : clearManagerActionRequestLeaseOwner(
          identity,
          'The durable conversation action turn is missing.',
        );
    return result('none', 'action_turn_missing', null, false, localOwnerCleared);
  }

  if (['terminal', 'cancelled', 'persistence_unknown'].includes(before.status)) {
    const localOwnerCleared = identity.deferLocalOwnerClear
      ? false
      : clearManagerActionRequestLeaseOwner(
          identity,
          before.status === 'terminal'
            ? ''
            : `Conversation action request is already ${before.status}.`,
        );
    return result('none', 'already_converged', before, false, localOwnerCleared);
  }

  let observedStatus: 'terminal' | 'cancelled' | 'persistence_unknown' | null = null;
  let terminalMessageId = '';
  let reason = '';

  if (evidence.assistant === 'ambiguous') {
    observedStatus = 'persistence_unknown';
    reason = 'assistant_request_binding_ambiguous';
  } else if (evidence.assistant === 'found') {
    terminalMessageId = String(assistants[0]?.id || '').trim();
    if (terminalMessageId) {
      observedStatus = 'terminal';
      reason = 'durable_assistant_transcript_found';
    } else {
      observedStatus = 'persistence_unknown';
      reason = 'assistant_message_identity_missing';
    }
  } else if (evidence.conversation !== 'found') {
    observedStatus = 'persistence_unknown';
    reason = evidence.conversation === 'missing'
      ? 'conversation_missing'
      : 'conversation_binding_ambiguous';
  } else if (evidence.task === 'missing' || evidence.task === 'ambiguous') {
    observedStatus = 'persistence_unknown';
    reason = evidence.task === 'missing' ? 'task_missing' : 'task_binding_ambiguous';
  } else if (evidence.task === 'found' && tasks[0]?.status === 'cancelled') {
    observedStatus = 'cancelled';
    reason = 'durable_task_cancelled';
  } else if (evidence.task === 'found' && isTerminalConversationTaskStatus(tasks[0]?.status)) {
    // completed/failed proves that task execution ended, but without a durable
    // assistant record it cannot prove what (if anything) the user saw.
    observedStatus = 'persistence_unknown';
    reason = `terminal_task_without_assistant:${String(tasks[0]?.status || 'unknown')}`;
  }

  if (!observedStatus) {
    return result('none', taskId ? 'nonterminal_task_still_active' : 'terminal_evidence_missing', before, false, false);
  }

  if (
    observedStatus === 'persistence_unknown'
    && evidence.task === 'found'
    && evidence.assistant !== 'found'
  ) {
    const finalized = finalizeForegroundRequest({
      conversationId: identity.conversationId,
      userId: identity.userId,
      requestId: identity.requestId,
      expectedTaskId: taskId,
      outcome: 'persistence_unknown',
      reason,
      now: identity.now,
      deferLocalOwnerClear: identity.deferLocalOwnerClear,
    });
    const finalTurn = getConversationActionTurn(identity);
    return {
      ...result(
        finalTurn?.status === 'persistence_unknown' ? 'persistence_unknown' : 'none',
        reason,
        finalTurn,
        finalized.changed,
        finalized.localOwnerCleared,
      ),
      converged: finalized.converged,
    };
  }

  const reconciled = reconcileConversationActionTurnLease({
    conversationId: identity.conversationId,
    userId: identity.userId,
    requestId: identity.requestId,
    observedStatus,
    terminalMessageId: terminalMessageId || undefined,
    reason,
    now: identity.now,
  });
  const finalTurn = reconciled.turn || getConversationActionTurn(identity);
  const localOwnerCleared = identity.deferLocalOwnerClear
    ? false
    : clearManagerActionRequestLeaseOwner(
        identity,
        observedStatus === 'terminal'
          ? ''
          : `Conversation action request converged to ${observedStatus}: ${reason}`,
      );
  return result(
    reconciled.action === 'terminal'
      || reconciled.action === 'cancelled'
      || reconciled.action === 'persistence_unknown'
      ? reconciled.action
      : 'none',
    reconciled.reconciled ? reason : reconciled.reason,
    finalTurn,
    reconciled.reconciled,
    localOwnerCleared,
  );
}

/** Converge the exact durable request before any channel releases resources. */
export async function convergeForegroundRequestBeforeRelease(input: ForegroundRequestReleaseInput & {
  readonly channel: 'Chat' | 'Task' | 'Voice';
  /** Voice can settle verified receipts that raced behind its terminal transcript. */
  readonly settlePendingTask?: () => void;
}, dependencies: ForegroundRequestDurabilityDependencies = {}): Promise<ForegroundRequestReleaseResult> {
  let convergence = convergeConversationActionRequestLease({
    ...input.identity,
    deferLocalOwnerClear: true,
  });
  if (!convergence.converged && convergence.assistantMessageId && input.identity.expectedTaskId && input.settlePendingTask) {
    input.settlePendingTask();
    convergence = convergeConversationActionRequestLease({
      ...input.identity,
      deferLocalOwnerClear: true,
    });
  }
  if (convergence.converged) {
    convergence = await convergeConversationActionRequestLeaseDurably(input.identity, dependencies);
    return { convergence, finalization: null, converged: true };
  }
  const finalization = await finalizeForegroundRequestDurably({
    ...input.identity,
    outcome: input.aborted ? 'cancelled' : 'blocked',
    assistantMessageId: convergence.assistantMessageId || undefined,
    reason: input.reason || (input.aborted
      ? `${input.channel} foreground request was aborted before release.`
      : `${input.channel} foreground executor exited without a fully converged terminal.`),
    assistantState: input.assistantState,
  }, dependencies);
  return { convergence, finalization, converged: finalization.converged };
}

function clearDurableForegroundRequestOwner(
  identity: Pick<ConvergeConversationActionRequestLeaseInput, 'conversationId' | 'userId' | 'requestId'>,
  terminal: boolean,
  reason: string,
): boolean {
  return clearManagerActionRequestLeaseOwner(
    identity,
    terminal ? '' : reason || 'Foreground request reached a durable fail-closed terminal.',
  );
}

/**
 * Strict release-time reconciliation. `commitDatabaseTables()` stages an in-memory
 * snapshot; this wrapper always executes the strict barrier, including on an
 * idempotent retry after an earlier flush failed. The process owner is cleared
 * only after both convergence and that barrier succeed.
 */
export async function convergeConversationActionRequestLeaseDurably(
  input: ConvergeConversationActionRequestLeaseInput,
  dependencies: ForegroundRequestDurabilityDependencies = {},
): Promise<ConvergeConversationActionRequestLeaseResult> {
  const identity = normalizeConversationActionRequestLeaseIdentity(input);
  const result = convergeConversationActionRequestLease({
    ...identity,
    deferLocalOwnerClear: true,
  });
  await (dependencies.flush || flushDBOrThrow)();
  if (!result.converged) return result;
  const localOwnerCleared = clearDurableForegroundRequestOwner(
    identity,
    result.finalStatus === 'terminal',
    result.reason,
  );
  return {
    ...result,
    changed: result.changed || localOwnerCleared,
    localOwnerCleared,
  };
}

/** Strictly persist a fail-closed foreground terminal before releasing owner. */
export async function finalizeForegroundRequestDurably(
  input: FinalizeForegroundRequestInput,
  dependencies: ForegroundRequestDurabilityDependencies = {},
): Promise<FinalizeForegroundRequestResult> {
  const identity = normalizeForegroundRequestFinalizationInput(input);
  const result = finalizeForegroundRequest({
    ...identity,
    deferLocalOwnerClear: true,
  });
  // Always flush: an idempotent in-memory retry may be carrying the dirty
  // snapshot left behind by the previous strict-barrier failure.
  await (dependencies.flush || flushDBOrThrow)();
  if (!result.converged) return result;
  const localOwnerCleared = clearDurableForegroundRequestOwner(
    identity,
    result.actionTurnStatus === 'terminal',
    result.reason,
  );
  return {
    ...result,
    changed: result.changed || localOwnerCleared,
    localOwnerCleared,
  };
}
