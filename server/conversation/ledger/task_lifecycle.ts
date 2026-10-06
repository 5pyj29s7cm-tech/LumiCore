import { normalizeConversationActionState, type ConversationActionContinuationState } from "../../cognition/action_continuation";
import { normalizeActionIntent } from "../../cognition/normalized_action_intent";
import { buildActionEvidenceContract } from "../../cognition/action_contract";
import { taskReceiptsToRecords, conversationTaskStatusOwnsExecutionLease, canTransitionConversationTaskStatus, isTerminalConversationTaskStatus, type ConversationTaskStatus } from "../../cognition/task_execution_ledger";
import type { ConversationActionTaskRow, ConversationActionLiveProjection, ConversationActionTaskFinalizationOutcome } from './contracts';
import { getConversationActionStateByTaskId, conversationActionStateFromTask } from './queries';
import { ensureTables, parseObject, taskPersistenceUnknownMarker, sanitizeState, redactGoal } from './serialization';
import { currentTaskCorrectionTarget, durableTaskCapsuleTarget } from './targets';
import { appendConversationActionReceipts } from './receipt_store';

export function conservativeFallbackLedgerOperation(
  state: ConversationActionContinuationState,
  cancellationContract: boolean,
): string {
  if (cancellationContract) return 'mutate';
  const operations = (state.receipts || [])
    .map(receipt => receipt.capability?.operation)
    .filter(Boolean);
  if (operations.some(operation => (
    operation === 'mutate' || operation === 'communicate'
  ))) return 'mutate';
  if (operations.some(operation => operation === 'create')) return 'create';
  if (
    operations.length > 0
    && operations.every(operation => operation === 'observe' || operation === 'test')
  ) return 'read';
  // An unclassified durable task is an audit boundary. Under-reporting an
  // unknown side effect as read-only is worse than conservatively labelling it
  // as a mutation until a capability receipt proves otherwise.
  return 'mutate';
}

export function scopedUserMessage(
  db: any,
  conversation: { id: string; userId: string },
  messageId: string | undefined,
): any | null {
  const id = String(messageId || '').trim();
  if (!id) return null;
  return (db.interactions || []).find((message: any) => (
    message.id === id
    && message.conversationId === conversation.id
    && message.userId === conversation.userId
    && message.role === 'user'
  )) || null;
}

export function resolveTaskRootUserMessageId(
  db: any,
  input: {
    conversation: { id: string; userId: string };
    state: ConversationActionContinuationState;
    existing?: string;
    candidate?: string;
  },
): string {
  const existing = scopedUserMessage(db, input.conversation, input.existing);
  if (existing) return existing.id;

  const userMessages = (db.interactions || []).filter((message: any) => (
    message.conversationId === input.conversation.id
    && message.userId === input.conversation.userId
    && message.role === 'user'
  ));
  const normalizedGoal = String(input.state.goal || '').replace(/\s+/gu, ' ').trim();
  const exactGoal = [...userMessages].reverse().find((message: any) => (
    String(message.message || '').replace(/\s+/gu, ' ').trim() === normalizedGoal
  ));
  if (exactGoal) return exactGoal.id;

  const candidate = scopedUserMessage(db, input.conversation, input.candidate);
  if (candidate) return candidate.id;

  const requestId = String(input.state.activeRequestId || '').trim();
  if (requestId) {
    const requestMessage = [...userMessages].reverse().find((message: any) => (
      String(message.requestId || '') === requestId
      || String(message.externalMessageId || '') === requestId
    ));
    if (requestMessage) return requestMessage.id;
  }
  return '';
}

export function latestParentTask(
  tasks: ConversationActionTaskRow[],
  conversationId: string,
  currentTaskId: string,
): ConversationActionTaskRow | undefined {
  return tasks
    .filter(task => task.conversationId === conversationId && task.id !== currentTaskId)
    .filter(task => task.intentKind === 'cad_drafting' || /(?:Auto\s*CAD|\bCAD\b|图纸|平面图)/iu.test(`${task.goal} ${task.target}`)) // i18n-allow: Chinese CAD task matching; not user-visible copy.
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

export function markSupersededTask(
  db: any,
  conversation: ConversationActionLiveProjection,
  supersededTaskId: string | undefined,
  replacementTaskId: string,
  now: string,
): void {
  if (!supersededTaskId || supersededTaskId === replacementTaskId) return;
  const actionState = getConversationActionStateByTaskId(db, {
    conversationId: conversation.id,
    userId: conversation.userId,
    taskId: supersededTaskId,
  });
  if (!actionState || isTerminalConversationTaskStatus(actionState.status)) return;
  const blocker = `Superseded by task ${replacementTaskId}.`;
  finalizeConversationActionTask(db, {
    conversation,
    state: { ...actionState, supersededTaskId: replacementTaskId },
    outcome: 'cancelled',
    blocker,
    assistantState: blocker,
    now,
  });
}

export function syncConversationActionTaskLedger(
  db: any,
  input: {
    conversation: { id: string; userId: string; domain?: string; orgId?: string };
    state: ConversationActionContinuationState;
    userText?: string;
    rootUserMessageId?: string;
    currentUserMessageId?: string;
    now?: string;
    /** Internal recursion guard used by the finalization boundary. */
    skipSupersession?: boolean;
  },
): ConversationActionTaskRow | null {
  ensureTables(db);
  // A request id is both historical receipt correlation and, in executing
  // phases only, a live lease. Normalization deliberately drops the lease for
  // blocked/waiting/terminal states, but must not erase the immutable request
  // identity from receipts produced by that request.
  const receiptRequestId = String(input.state?.activeRequestId || '').trim().slice(0, 180);
  const state = normalizeConversationActionState(input.state);
  if (!state?.taskId) return null;
  const now = input.now || state.updatedAt || new Date().toISOString();
  const taskText = input.userText || state.latestInstruction || state.goal;
  const intent = normalizeActionIntent(taskText);
  const evidenceContract = intent.kind === 'none'
    ? buildActionEvidenceContract(taskText)
    : null;
  const fallbackIntentKind = evidenceContract?.applies
    ? evidenceContract.kind
    : 'none';
  const fallbackOperation = conservativeFallbackLedgerOperation(
    state,
    evidenceContract?.preferredTools.includes('runtime_work_cancel') === true,
  );
  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  let task = tasks.find(candidate => candidate.id === state.taskId);
  const currentContext = parseObject(task?.context);
  const persistenceUnknownMarker = taskPersistenceUnknownMarker(task);
  if (persistenceUnknownMarker) {
    const incomingMarker = state.terminalPersistence;
    const isSameQuarantine = incomingMarker?.status === 'persistence_unknown'
      && incomingMarker.requestId === persistenceUnknownMarker.requestId
      && state.status === 'blocked'
      && state.unfinished === true
      && !state.completionSource;
    // A durability quarantine is a bottom-level fence, not merely a UI state.
    // Ordinary task syncs may neither publish a terminal nor erase the marker;
    // only a future dedicated reconciliation boundary may resolve it.
    if (!isSameQuarantine) return task || null;
  }
  if (!input.skipSupersession) {
    markSupersededTask(db, input.conversation, state.supersededTaskId, state.taskId, now);
  }
  const parent = intent.relation === 'child'
    ? latestParentTask(tasks, input.conversation.id, state.taskId)
    : undefined;
  const parentContext = parent ? parseObject(parent.context) : {};
  if (task && !canTransitionConversationTaskStatus(task.status, state.status)) {
    // Late/replayed requests may still archive their immutable receipts through
    // archiveBoundConversationActionReceipts, but they cannot reopen a durable
    // terminal task by overwriting its state projection.
    return task;
  }
  const parentState = normalizeConversationActionState(parentContext.actionState);
  const taskStatus = state.status || (state.unfinished ? 'blocked' : 'completed');
  const terminal = isTerminalConversationTaskStatus(taskStatus);
  const requestLeaseActive = Boolean(state.unfinished)
    && conversationTaskStatusOwnsExecutionLease(taskStatus);
  const persistedState = requestLeaseActive
    ? state
    : normalizeConversationActionState({
        ...state,
        activeRequestId: undefined,
        ...(terminal ? { unfinished: false } : {}),
      })!;
  const context: Record<string, any> = {
    ...parentContext,
    // Execution/model plans are attached independently from action-state
    // updates. Preserve the current task context on every later status or
    // receipt sync instead of accidentally erasing the semantic plan.
    ...currentContext,
    sourceTaskId: parent?.id || currentContext.sourceTaskId || parentContext.sourceTaskId || '',
    inheritedArtifacts: Array.from(new Set([
      ...(Array.isArray(parentContext.inheritedArtifacts) ? parentContext.inheritedArtifacts : []),
      ...(Array.isArray(currentContext.inheritedArtifacts) ? currentContext.inheritedArtifacts : []),
      ...(parentState?.sourcePaths || []),
    ])).slice(0, 20),
    inheritedReceipts: parentState?.receipts
      || currentContext.inheritedReceipts
      || parentContext.inheritedReceipts
      || [],
    actionState: sanitizeState(persistedState),
  };
  const rootUserMessageId = resolveTaskRootUserMessageId(db, {
    conversation: input.conversation,
    state,
    existing: task?.rootUserMessageId,
    candidate: input.rootUserMessageId,
  });
  const correctedTarget = currentTaskCorrectionTarget(state);
  const durableTarget = durableTaskCapsuleTarget(state);
  // Status/recheck turns may add evidence to an existing mutation task, but
  // they must not rewrite the task's semantic identity into a read-only status
  // query. The task remains the exact operation the receipts are proving.
  const preservesExistingTaskIntent = Boolean(
    task && intent.kind === 'status_query' && intent.relation === 'status'
  );
  const values: ConversationActionTaskRow = {
    id: state.taskId,
    conversationId: input.conversation.id,
    userId: input.conversation.userId,
    domain: input.conversation.domain || 'personal',
    orgId: input.conversation.orgId || '',
    parentTaskId: parent?.id || task?.parentTaskId || '',
    rootUserMessageId,
    intentKind: preservesExistingTaskIntent
      ? task!.intentKind
      : intent.kind === 'none'
        ? task?.intentKind || fallbackIntentKind
        : intent.kind,
    operation: preservesExistingTaskIntent
      ? task!.operation
      : intent.kind === 'none'
        ? task?.operation || fallbackOperation
        : intent.operation,
    goal: redactGoal(state.goal, intent),
    // The durable capsule is the evidence-derived identity. Natural-language
    // intent commonly reports only a short alias (for example `计算器` or
    // `WPS`), while the state's appTarget preserves the user-facing target
    // label and the capsule can carry an even more precise file/object path.
    // Keep that durable order so a status/retry turn cannot rewrite the row to
    // a less-specific parser alias.
    target: correctedTarget || durableTarget || state.appTarget || intent.target || task?.target || '',
    status: taskStatus,
    blocker: state.latestBlocker || '',
    activeRequestId: persistedState.activeRequestId || '',
    completionSource: state.completionSource || '',
    context: JSON.stringify(context),
    revision: Math.max(task?.revision || 0, state.revision || 0, 1),
    createdAt: task?.createdAt || now,
    updatedAt: now,
    completedAt: terminal ? task?.completedAt || now : '',
  };
  if (task) Object.assign(task, values);
  else {
    task = values;
    tasks.push(task);
  }

  const records = taskReceiptsToRecords(state.receipts || []);
  appendConversationActionReceipts(db, {
    task,
    records,
    turnId: input.currentUserMessageId || input.rootUserMessageId || state.evidenceMessageId || '',
    requestId: receiptRequestId || state.activeRequestId || '',
    now,
  });
  return task;
}

/**
 * The sole convergence boundary for a foreground conversation task that ends
 * a request or reaches a terminal outcome. Durable history is always written
 * to the task ledger; only unfinished state may remain as the conversation's
 * live pointer.
 *
 * `persistence_unknown` is the one deliberate rollback of a staged terminal
 * projection. It remains blocked and resumable, carries an explicit marker,
 * and never publishes completion.
 */
export function finalizeConversationActionTask(
  db: any,
  input: {
    conversation: ConversationActionLiveProjection;
    state?: ConversationActionContinuationState | null;
    outcome: ConversationActionTaskFinalizationOutcome;
    requestId?: string;
    blocker?: string;
    assistantState?: string;
    completionSource?: ConversationActionContinuationState['completionSource'];
    userText?: string;
    now?: string;
    /** Keep transcript pairing until its assistant row crosses durability. */
    retainPendingAction?: boolean;
    /** Hidden historical recovery must not replace a newer live task. */
    updateLivePointer?: boolean;
  },
): {
  state: ConversationActionContinuationState;
  task: ConversationActionTaskRow | null;
  livePointerRetained: boolean;
} | null {
  ensureTables(db);
  const previous = normalizeConversationActionState(
    input.state || input.conversation.actionContinuationState,
  );
  if (!previous?.taskId) return null;
  const now = input.now || new Date().toISOString();
  const requestId = String(input.requestId || previous.activeRequestId || '').trim().slice(0, 180);
  const persistenceUnknown = input.outcome === 'persistence_unknown';
  if (persistenceUnknown) {
    const boundTurn = (db.conversationActionTurns || []).find((candidate: any) => (
      candidate.conversationId === input.conversation.id
      && candidate.userId === input.conversation.userId
      && candidate.requestId === requestId
      && candidate.taskId === previous.taskId
    ));
    if (!requestId || !boundTurn) return null;
  }
  const status: ConversationTaskStatus = input.outcome === 'persistence_unknown'
    ? 'blocked'
    : input.outcome;
  const marker = persistenceUnknown
    ? {
        status: 'persistence_unknown' as const,
        requestId,
        quarantinedAt: now,
      }
    : undefined;
  const blocker = String(input.blocker || '').replace(/\s+/g, ' ').trim().slice(0, 380);
  const next = normalizeConversationActionState({
    ...previous,
    version: 2,
    status,
    unfinished: !isTerminalConversationTaskStatus(status),
    latestBlocker: status === 'blocked' || status === 'failed' ? blocker || previous.latestBlocker : '',
    assistantState: input.assistantState !== undefined
      ? String(input.assistantState || '').replace(/\s+/g, ' ').trim().slice(0, 700)
      : previous.assistantState,
    activeRequestId: undefined,
    completionSource: status === 'completed'
      ? input.completionSource || previous.completionSource
      : undefined,
    terminalPersistence: marker,
    revision: (previous.revision || 0) + 1,
    updatedAt: now,
  });
  if (!next) return null;

  const existingTask = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === previous.taskId
    && candidate.conversationId === input.conversation.id
    && candidate.userId === input.conversation.userId
  ));
  const existingPersistenceUnknown = taskPersistenceUnknownMarker(existingTask);
  if (!persistenceUnknown && existingTask && existingPersistenceUnknown) {
    const quarantinedState = conversationActionStateFromTask(existingTask)
      || normalizeConversationActionState({
        ...previous,
        status: 'blocked',
        unfinished: true,
        latestBlocker: existingTask.blocker || previous.latestBlocker,
        activeRequestId: undefined,
        completionSource: undefined,
        terminalPersistence: existingPersistenceUnknown,
      });
    if (!quarantinedState) return null;
    const live = normalizeConversationActionState(input.conversation.actionContinuationState);
    const ownsLivePointer = live?.taskId === previous.taskId;
    if (input.updateLivePointer !== false && (ownsLivePointer || !live)) {
      input.conversation.actionContinuationState = quarantinedState;
    }
    return {
      state: quarantinedState,
      task: existingTask,
      livePointerRetained: normalizeConversationActionState(
        input.conversation.actionContinuationState,
      )?.taskId === previous.taskId,
    };
  }
  if (persistenceUnknown && existingTask) {
    // A failed strict durability fence invalidates the staged terminal. Reset
    // the row before the normal monotonic sync writes the explicit quarantine.
    existingTask.status = 'blocked';
    existingTask.blocker = next.latestBlocker;
    existingTask.activeRequestId = '';
    existingTask.completionSource = '';
    existingTask.completedAt = '';
  }

  const task = syncConversationActionTaskLedger(db, {
    conversation: input.conversation,
    state: next,
    userText: input.userText,
    now,
    skipSupersession: true,
  });
  if (task) {
    if (input.outcome === 'cancelled' && blocker) task.blocker = blocker;
    if (input.outcome === 'cancelled' && previous.supersededTaskId) {
      task.completionSource = 'superseded';
    }
    const context = parseObject(task.context);
    task.context = JSON.stringify({
      ...context,
      taskFinalization: {
        outcome: input.outcome,
        requestId,
        reason: blocker,
        finalizedAt: now,
      },
      ...(marker ? { terminalPersistence: marker } : {}),
    });
  }
  const persistedState = conversationActionStateFromTask(task) || next;
  const live = normalizeConversationActionState(input.conversation.actionContinuationState);
  const ownsLivePointer = Boolean(live?.taskId === previous.taskId);
  if (input.updateLivePointer !== false) {
    if (isTerminalConversationTaskStatus(persistedState.status)) {
      if (ownsLivePointer) delete input.conversation.actionContinuationState;
    } else if (ownsLivePointer || !live) {
      input.conversation.actionContinuationState = persistedState;
    }
  }
  if (
    !input.retainPendingAction
    && requestId
    &&
    input.conversation.pendingActionContinuation
    && input.conversation.pendingActionContinuation.requestId === requestId
  ) {
    delete input.conversation.pendingActionContinuation;
  }
  return {
    state: persistedState,
    task,
    livePointerRetained: !isTerminalConversationTaskStatus(persistedState.status)
      && normalizeConversationActionState(input.conversation.actionContinuationState)?.taskId === previous.taskId,
  };
}
