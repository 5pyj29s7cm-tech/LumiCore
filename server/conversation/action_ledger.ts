import crypto from 'node:crypto';
import {
  formatConversationActionTaskStatus,
  normalizeConversationActionState,
  RECONFIRMATION_REQUIRED_BLOCKER,
  type ConversationActionContinuationState,
} from '../cognition/action_continuation';
import { normalizeActionIntent, type NormalizedActionIntent } from '../cognition/normalized_action_intent';
import {
  mergeTaskReceipts,
  taskCompletionFromReceipts,
  taskReceiptsToRecords,
  toolRecordSucceeded,
  conversationTaskStatusOwnsExecutionLease,
  canTransitionConversationTaskStatus,
  isTerminalConversationTaskStatus,
  type ConversationTaskStatus,
} from '../cognition/task_execution_ledger';
import { buildToolExecutionEnvelope, toolRecordIdempotencyKey } from '../tools/execution_envelope';
import { inspectPersistedToolExecutionReceipt } from '../tools/persisted_execution_receipt';
import { isConfirmationBlockedToolRecord } from '../tools/confirmation_block';
import type { ToolExecutionRecord } from '../tools/types';
import type { CapabilityExecutionPlan } from '../cognition/capability_execution_plan';
import { CN_ACTION_LEDGER_MESSAGES } from '../regions/packs/cn/action_ledger_messages';
import { detectLanguage } from '../utils/language';
import type {
  ModelExecutionGraph,
  ModelGraphArbitrationReceipt,
  ModelGraphNodeReceipt,
} from '../agents/model_execution_graph';
import { reconcileConversationFocusThread } from './focus_threads';

export interface ConversationActionTaskRow {
  id: string;
  conversationId: string;
  userId: string;
  domain: string;
  orgId: string;
  parentTaskId: string;
  rootUserMessageId: string;
  intentKind: string;
  operation: string;
  goal: string;
  target: string;
  status: ConversationTaskStatus;
  blocker: string;
  activeRequestId: string;
  completionSource: string;
  context: string | Record<string, unknown>;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string;
}

export interface ConversationActionReceiptRow {
  id: string;
  taskId: string;
  conversationId: string;
  turnId: string;
  requestId: string;
  modelRoutingReceiptId?: string;
  executionOrigin?: ToolExecutionRecord['executionOrigin'];
  idempotencyKey: string;
  toolName: string;
  targetIdentity: string;
  inputDigest: string;
  envelope: string;
  outcome: string;
  createdAt: string;
}

export interface PersistedCapabilityExecutionPlan {
  schemaVersion: 1;
  planId: string;
  taskId: string;
  intent: Omit<NormalizedActionIntent, 'payload'> & {
    payload: '';
    payloadDigest: string;
  };
  nodes: Array<{
    nodeId: string;
    type: string;
    capabilityId: string;
    toolName?: string;
    lane: string;
    operation: string;
    risk: string;
    requiresConfirmation: boolean;
    verificationStrategy: string;
    executionRole: 'planner' | 'adapter' | 'verifier' | 'join';
    selectionGroup?: string;
    selectionRank?: number;
  }>;
  edges: CapabilityExecutionPlan['edges'];
  expectedEvidence: CapabilityExecutionPlan['expectedEvidence'];
  risk: CapabilityExecutionPlan['risk'];
  fallbackPolicy: CapabilityExecutionPlan['fallbackPolicy'];
  contextRefs: CapabilityExecutionPlan['contextRefs'];
  decisionAuthority: 'semantic_planner';
  scriptAuthority: 'adapter_only';
  persistedAt: string;
}

export interface ConversationModelExecutionRecovery {
  graph: ModelExecutionGraph;
  receipts: ModelGraphNodeReceipt[];
}

function stableValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 50).map(item => stableValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [
    key,
    stableValue((value as Record<string, unknown>)[key], depth + 1),
  ]));
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function parseObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

function taskPersistenceUnknownMarker(
  task: ConversationActionTaskRow | null | undefined,
): ConversationActionContinuationState['terminalPersistence'] | undefined {
  if (!task) return undefined;
  const context = parseObject(task.context);
  const taskMarker = context.terminalPersistence;
  const stateMarker = parseObject(context.actionState).terminalPersistence;
  const marker = taskMarker?.status === 'persistence_unknown' ? taskMarker : stateMarker;
  if (marker?.status !== 'persistence_unknown') return undefined;
  return {
    status: 'persistence_unknown',
    requestId: String(marker.requestId || '').trim().slice(0, 180),
    quarantinedAt: String(marker.quarantinedAt || '').trim().slice(0, 80),
  };
}

function formatEnglishPreviousActionLedgerStatus(
  task: ConversationActionTaskRow,
  state: ConversationActionContinuationState,
  taskReceipts: ConversationActionReceiptRow[],
): string {
  const receipt = [...taskReceipts].sort((left, right) => (
    right.createdAt.localeCompare(left.createdAt)
  ))[0];
  const envelope = parseObject(receipt?.envelope);
  const result = parseObject(envelope.result);
  const expectation = parseObject(result.expectation);
  const verification = parseObject(result.verification);
  const envelopeVerification = parseObject(envelope.verification);
  const action = String(
    result.action
    || expectation.action
    || receipt?.toolName
    || task.operation
    || task.intentKind
    || '',
  ).trim();
  const target = String(
    result.target
    || expectation.target
    || receipt?.targetIdentity
    || task.target
    || state.appTarget
    || '',
  ).trim();
  const section = String(result.section || expectation.section || '').trim();
  const verificationStatus = String(
    verification.status
    || envelopeVerification.status
    || (receipt?.outcome === 'verified_success' ? 'verified' : receipt?.outcome || ''),
  ).trim();
  const matchedEvidence = Array.isArray(verification.matched)
    ? verification.matched
      .map(value => String(value || '').replace(/\s+/gu, ' ').trim().slice(0, 240))
      .filter(Boolean)
      .slice(0, 8)
    : [];
  const verificationReason = String(envelopeVerification.reason || '').replace(/\s+/gu, ' ').trim().slice(0, 500);
  const blocker = String(task.blocker || state.latestBlocker || '')
    .replace(/^[A-Za-z0-9_.:-]+:\s*/, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500);
  const durableVerified = receipt?.outcome === 'verified_success' && verificationStatus === 'verified';
  const finalStatus = task.status === 'completed'
    ? durableVerified
      ? 'completed (durable receipt verified)'
      : state.completionSource === 'user_observation'
        ? 'completed (confirmed by user observation)'
        : 'completed (no verified terminal receipt recorded)'
    : task.status === 'waiting_confirmation'
      ? 'waiting for confirmation'
      : task.status === 'blocked'
        ? `blocked${blocker ? ` — ${blocker}` : ''}`
        : task.status === 'cancelled'
          ? `cancelled${blocker ? ` — ${blocker}` : ''}`
          : `${task.status} (no verified terminal receipt yet)`;

  return [
    `Executed action: ${action || 'not recorded'}`,
    target ? `Target: ${target}` : '',
    section ? `Target section: ${section}` : '',
    `Verification status: ${verificationStatus || 'not recorded'}`,
    matchedEvidence.length
      ? `Verification evidence: ${matchedEvidence.join('; ')}`
      : verificationReason
        ? `Verification evidence: ${verificationReason}`
        : '',
    receipt ? '' : 'Durable receipt: none recorded',
    `Final status: ${finalStatus}`,
  ].filter(Boolean).join('\n');
}

function redactArguments(args: Record<string, any>): Record<string, any> {
  const sensitive = /^(?:message|text|content|body|payload|draft|password|secret|token|api.?key)$/i;
  return Object.fromEntries(Object.entries(args || {}).map(([key, value]) => (
    sensitive.test(key)
      ? [key, { digest: digest(value), length: typeof value === 'string' ? value.length : undefined }]
      : [key, stableValue(value)]
  )));
}

function redactGoal(goal: string, intent: NormalizedActionIntent): string {
  if (intent.sideEffectClass !== 'external_commit' || !intent.payload) return String(goal || '').slice(0, 700);
  return `${intent.kind}:${intent.target || '(unresolved target)'} payload_sha256=${digest(intent.payload)}`;
}

function sanitizeState(state: ConversationActionContinuationState): ConversationActionContinuationState {
  return {
    ...state,
    receipts: (state.receipts || []).map(receipt => ({
      ...receipt,
      arguments: redactArguments(receipt.arguments || {}),
    })),
  };
}

export function sanitizeCapabilityExecutionPlan(
  plan: CapabilityExecutionPlan,
  persistedAt: string,
): PersistedCapabilityExecutionPlan {
  return {
    schemaVersion: 1,
    planId: plan.planId,
    taskId: plan.taskId,
    intent: {
      ...plan.intent,
      payload: '',
      payloadDigest: digest(plan.intent.payload),
    },
    nodes: plan.nodes.map(node => ({
      nodeId: node.nodeId,
      type: node.type,
      capabilityId: node.capabilityId,
      ...(node.toolName ? { toolName: node.toolName } : {}),
      lane: node.lane,
      operation: node.operation,
      risk: node.risk,
      requiresConfirmation: node.requiresConfirmation,
      verificationStrategy: node.verification.strategy,
      executionRole: node.executionRole,
      ...(node.selectionGroup ? { selectionGroup: node.selectionGroup } : {}),
      ...(node.selectionRank !== undefined ? { selectionRank: node.selectionRank } : {}),
    })),
    edges: plan.edges.map(edge => ({ ...edge })),
    expectedEvidence: plan.expectedEvidence.map(requirement => ({
      ...requirement,
      requiredFields: [...requirement.requiredFields],
      ...(requirement.requiredValues ? { requiredValues: { ...requirement.requiredValues } } : {}),
      requiredArtifacts: [...requirement.requiredArtifacts],
      successStatuses: [...requirement.successStatuses],
    })),
    risk: {
      ...plan.risk,
      reasons: [...plan.risk.reasons],
      ...(plan.risk.confirmationBinding
        ? { confirmationBinding: { ...plan.risk.confirmationBinding } }
        : {}),
    },
    fallbackPolicy: { ...plan.fallbackPolicy },
    contextRefs: plan.contextRefs.map(ref => ({ ...ref })),
    decisionAuthority: plan.decisionAuthority,
    scriptAuthority: plan.scriptAuthority,
    persistedAt,
  };
}

function ensureTables(db: any): void {
  if (!Array.isArray(db.conversationActionTasks)) db.conversationActionTasks = [];
  if (!Array.isArray(db.conversationActionReceipts)) db.conversationActionReceipts = [];
}

function scopedUserMessage(
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

function resolveTaskRootUserMessageId(
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

function latestParentTask(
  tasks: ConversationActionTaskRow[],
  conversationId: string,
  currentTaskId: string,
): ConversationActionTaskRow | undefined {
  return tasks
    .filter(task => task.conversationId === conversationId && task.id !== currentTaskId)
    .filter(task => task.intentKind === 'cad_drafting' || /(?:Auto\s*CAD|\bCAD\b|图纸|平面图)/iu.test(`${task.goal} ${task.target}`)) // i18n-allow: Chinese CAD task matching; not user-visible copy.
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
}

function markSupersededTask(
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
  const intent = normalizeActionIntent(input.userText || state.latestInstruction || state.goal);
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
  context.focusThread = reconcileConversationFocusThread(currentContext.focusThread, {
    id: state.taskId,
    goal: redactGoal(state.goal, intent),
    status: taskStatus,
    blocker: state.latestBlocker || '',
    updatedAt: now,
  }, now);
  const values: ConversationActionTaskRow = {
    id: state.taskId,
    conversationId: input.conversation.id,
    userId: input.conversation.userId,
    domain: input.conversation.domain || 'personal',
    orgId: input.conversation.orgId || '',
    parentTaskId: parent?.id || task?.parentTaskId || '',
    rootUserMessageId,
    intentKind: intent.kind === 'none' ? task?.intentKind || 'desktop_operation' : intent.kind,
    operation: intent.kind === 'none' ? task?.operation || 'mutate' : intent.operation,
    goal: redactGoal(state.goal, intent),
    target: intent.target || state.appTarget || task?.target || '',
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

export type ConversationActionTaskFinalizationOutcome =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked'
  | 'persistence_unknown';

/**
 * Request-scoped terminal adjudication supplied by a foreground transport.
 *
 * This is deliberately narrower than task finalization: a blocked request
 * leaves the durable task resumable, while preventing a successful receipt
 * from an earlier step in the same request from being mistaken for completion.
 */
export interface ConversationActionTerminalDisposition {
  outcome: 'blocked';
  taskId: string;
  requestId: string;
  reason: string;
}

export interface ConversationActionLiveProjection {
  id: string;
  userId: string;
  domain?: string;
  orgId?: string;
  actionContinuationState?: ConversationActionContinuationState;
  pendingActionContinuation?: {
    userText: string;
    messageId: string;
    requestId?: string;
    updatedAt: string;
  };
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
    &&
    input.conversation.pendingActionContinuation
    && (!requestId || input.conversation.pendingActionContinuation.requestId === requestId)
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

/**
 * Persist terminal records that arrive after their request was replaced.
 *
 * Every task-bound receipt remains append-only audit evidence. Recomputing the
 * task projection is a stronger operation: the receipt request must still be
 * the exact active owner in the task context, task row, and action-turn ledger.
 * A historical receipt from an older request on the same task is therefore
 * archived without being allowed to settle a successor's live projection.
 */
export function archiveBoundConversationActionReceipts(
  db: any,
  input: {
    conversationId: string;
    userId: string;
    records: ToolExecutionRecord[];
    turnId?: string;
    now?: string;
    /** @internal Exact, manager-fenced terminal adjudication for this request. */
    terminalDisposition?: ConversationActionTerminalDisposition;
    /**
     * @internal Legacy requestless compatibility. Only the manager's current
     * user/assistant pairing may use this; stale/replay archive calls omit it.
     */
    currentPairingAuthority?: {
      userMessageId: string;
      assistantMessageId: string;
    };
  },
): {
  archived: number;
  taskIds: string[];
  adjudicatedTaskIds: string[];
  terminalDispositionApplied: boolean;
} {
  ensureTables(db);
  const now = input.now || new Date().toISOString();
  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  const grouped = new Map<string, ToolExecutionRecord[]>();
  for (const record of input.records || []) {
    const taskId = String(record.taskId || '').trim();
    if (!taskId) continue;
    const task = tasks.find(candidate => (
      candidate.id === taskId
      && candidate.conversationId === input.conversationId
      && candidate.userId === input.userId
    ));
    if (!task) continue;
    const records = grouped.get(taskId) || [];
    records.push(record);
    grouped.set(taskId, records);
  }

  let archived = 0;
  const taskIds: string[] = [];
  const adjudicatedTaskIds: string[] = [];
  let terminalDispositionApplied = false;
  for (const [taskId, records] of grouped) {
    const task = tasks.find(candidate => candidate.id === taskId)!;
    archived += appendConversationActionReceipts(db, {
      task,
      records,
      turnId: input.turnId,
      requestId: records.find(record => record.requestId)?.requestId,
      now,
    }).length;
    const context = parseObject(task.context);
    const state = normalizeConversationActionState(context.actionState);
    if (state) {
      const requestIds = [...new Set(
        records.map(record => String(record.requestId || '').trim()).filter(Boolean),
      )];
      const receiptRequestId = requestIds.length === 1
        && records.every(record => String(record.requestId || '').trim() === requestIds[0])
        ? requestIds[0]
        : '';
      const activeTurn = receiptRequestId
        ? (db.conversationActionTurns || []).find((candidate: any) => (
            candidate.conversationId === input.conversationId
            && candidate.userId === input.userId
            && candidate.requestId === receiptRequestId
            && candidate.taskId === taskId
            && (candidate.status === 'accepted' || candidate.status === 'leased')
          ))
        : null;
      const exactRequestOwnsActiveTask = Boolean(
        receiptRequestId
        && state.activeRequestId === receiptRequestId
        && task.activeRequestId === receiptRequestId
        && activeTurn,
      );
      const authority = input.currentPairingAuthority;
      const conversation = (db.conversations || []).find((candidate: any) => (
        candidate.id === input.conversationId && candidate.userId === input.userId
      ));
      const pending = conversation?.pendingActionContinuation;
      const exactUser = authority?.userMessageId
        ? (db.interactions || []).find((candidate: any) => (
            candidate.id === authority.userMessageId
            && candidate.conversationId === input.conversationId
            && candidate.userId === input.userId
            && candidate.role === 'user'
          ))
        : null;
      const exactAssistant = authority?.assistantMessageId
        ? (db.interactions || []).find((candidate: any) => (
            candidate.id === authority.assistantMessageId
            && candidate.conversationId === input.conversationId
            && candidate.userId === input.userId
            && candidate.role === 'assistant'
            && candidate.mode !== 'proactive'
          ))
        : null;
      const competingActiveTurn = (db.conversationActionTurns || []).some((candidate: any) => (
        candidate.conversationId === input.conversationId
        && candidate.userId === input.userId
        && candidate.taskId === taskId
        && (candidate.status === 'accepted' || candidate.status === 'leased')
      ));
      const currentRequestlessPairingOwnsTask = Boolean(
        !receiptRequestId
        && records.every(record => !String(record.requestId || '').trim())
        && !state.activeRequestId
        && !task.activeRequestId
        && authority?.userMessageId
        && authority?.assistantMessageId
        && pending?.messageId === authority.userMessageId
        && !pending?.requestId
        && exactUser
        && exactAssistant
        && !String(exactAssistant.requestId || '').trim()
        && !competingActiveTurn,
      );
      const requestOwnsActiveTask = exactRequestOwnsActiveTask
        || currentRequestlessPairingOwnsTask;
      if (!requestOwnsActiveTask) {
        // Audit-only path. In particular, never merge an R1 receipt into the
        // R2 state merely because both requests are bound to the same task id.
        taskIds.push(taskId);
        continue;
      }
      adjudicatedTaskIds.push(taskId);
      const disposition = input.terminalDisposition;
      const dispositionRequestId = String(disposition?.requestId || '').trim().slice(0, 180);
      const dispositionReason = String(disposition?.reason || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 380);
      const boundTurn = dispositionRequestId
        ? (db.conversationActionTurns || []).find((candidate: any) => (
            candidate.conversationId === input.conversationId
            && candidate.userId === input.userId
            && candidate.requestId === dispositionRequestId
            && candidate.taskId === taskId
            && (candidate.status === 'accepted' || candidate.status === 'leased')
          ))
        : null;
      const authoritativeBlocked = Boolean(
        disposition?.outcome === 'blocked'
        && disposition.taskId === taskId
        && dispositionRequestId
        && dispositionReason
        && !isTerminalConversationTaskStatus(task.status)
        && boundTurn
        && requestOwnsActiveTask
        && records.every(record => (
          String(record.taskId || '').trim() === taskId
          && String(record.requestId || '').trim() === dispositionRequestId
        )),
      );
      const receipts = mergeTaskReceipts(state.receipts || [], records, now);
      const completion = taskCompletionFromReceipts(
        state.goal || task.goal,
        receipts,
        state.taskCapsule,
      );
      const waitingForConfirmation = records.some(isConfirmationBlockedToolRecord);
      const hasFailure = records.some(record => !toolRecordSucceeded(record));
      const status: ConversationTaskStatus = authoritativeBlocked
        ? 'blocked'
        : isTerminalConversationTaskStatus(task.status)
        ? task.status
        : completion.complete
          ? 'completed'
          : waitingForConfirmation
            ? 'waiting_confirmation'
            : hasFailure
              ? 'blocked'
              : task.status;
      const requestLeaseActive = Boolean(state.unfinished)
        && conversationTaskStatusOwnsExecutionLease(status);
      const nextState = normalizeConversationActionState({
        ...state,
        receipts,
        status,
        unfinished: !isTerminalConversationTaskStatus(status),
        latestBlocker: status === 'blocked'
          ? authoritativeBlocked
            ? dispositionReason
            : completion.blocker || task.blocker
          : status === 'failed' || status === 'cancelled'
            ? task.blocker
            : '',
        activeRequestId: !authoritativeBlocked && requestLeaseActive
          && !records.some(record => record.requestId === state.activeRequestId)
          ? state.activeRequestId
          : undefined,
        completionSource: !authoritativeBlocked && status === 'completed' && completion.complete
          ? 'tool_receipt'
          : authoritativeBlocked
            ? undefined
            : state.completionSource,
        revision: Math.max(state.revision || 0, task.revision || 0) + 1,
        updatedAt: now,
      });
      if (nextState && (status === 'blocked' || isTerminalConversationTaskStatus(status))) {
        finalizeConversationActionTask(db, {
          conversation: conversation || {
            id: task.conversationId,
            userId: task.userId,
            domain: task.domain,
            orgId: task.orgId,
          },
          state: nextState,
          outcome: status as 'blocked' | 'completed' | 'failed' | 'cancelled',
          requestId: authoritativeBlocked
            ? dispositionRequestId
            : records.find(record => record.requestId)?.requestId,
          blocker: nextState.latestBlocker,
          assistantState: nextState.assistantState,
          completionSource: nextState.completionSource,
          now,
          updateLivePointer: Boolean(conversation),
        });
        if (authoritativeBlocked) terminalDispositionApplied = true;
      } else {
        if (nextState) context.actionState = sanitizeState(nextState);
        task.context = JSON.stringify(context);
        task.status = status;
        task.blocker = status === 'cancelled' ? task.blocker : '';
        task.activeRequestId = nextState?.activeRequestId || '';
        task.completionSource = nextState?.completionSource || task.completionSource;
        task.updatedAt = now;
        task.revision = nextState?.revision || task.revision;
      }
    }
    taskIds.push(taskId);
  }
  return { archived, taskIds, adjudicatedTaskIds, terminalDispositionApplied };
}

export function appendConversationActionReceipts(
  db: any,
  input: {
    task: ConversationActionTaskRow;
    records: ToolExecutionRecord[];
    turnId?: string;
    requestId?: string;
    now?: string;
  },
): ConversationActionReceiptRow[] {
  ensureTables(db);
  const now = input.now || new Date().toISOString();
  const receipts = db.conversationActionReceipts as ConversationActionReceiptRow[];
  const appended: ConversationActionReceiptRow[] = [];
  input.records.forEach((rawRecord, index) => {
    const record: ToolExecutionRecord = {
      ...rawRecord,
      taskId: rawRecord.taskId || input.task.id,
      turnId: rawRecord.turnId || input.turnId,
      requestId: rawRecord.requestId || input.requestId,
      idempotencyKey: rawRecord.idempotencyKey || toolRecordIdempotencyKey(rawRecord),
    };
    const envelope = buildToolExecutionEnvelope(record, {
      taskId: input.task.id,
      turnId: input.turnId,
      requestId: input.requestId,
      completedAt: now,
    });
    const duplicate = receipts.some(candidate => (
      candidate.taskId === input.task.id
      && candidate.idempotencyKey === envelope.idempotencyKey
      && candidate.toolName === record.name
      && candidate.outcome === envelope.status
    ));
    if (duplicate) return;
    const requestedReceiptId = String(record.id || `receipt_${crypto.randomUUID()}_${index}`);
    const receiptId = receipts.some(candidate => candidate.id === requestedReceiptId)
      ? `receipt_${crypto.randomUUID()}_${index}`
      : requestedReceiptId;
    const row: ConversationActionReceiptRow = {
      id: receiptId,
      taskId: input.task.id,
      conversationId: input.task.conversationId,
      turnId: envelope.turnId,
      requestId: envelope.requestId,
      ...(record.modelRoutingReceiptId
        ? { modelRoutingReceiptId: String(record.modelRoutingReceiptId).trim().slice(0, 180) }
        : {}),
      ...(record.executionOrigin ? { executionOrigin: record.executionOrigin } : {}),
      idempotencyKey: envelope.idempotencyKey,
      toolName: envelope.toolName,
      targetIdentity: envelope.targetIdentity,
      inputDigest: digest(record.arguments || {}),
      envelope: JSON.stringify(envelope),
      outcome: envelope.status,
      createdAt: now,
    };
    receipts.push(row);
    appended.push(row);
  });
  return appended;
}

/**
 * Create the durable action row owned by a scheduled/background plan before
 * it enters the runtime queue. The deterministic task id is also the restart
 * and idempotency boundary for the downstream orchestration.
 */
export function ensureBackgroundConversationActionTask(
  db: any,
  input: {
    taskId: string;
    conversationId: string;
    userId: string;
    domain: string;
    orgId: string;
    goal: string;
    target: string;
    requestId: string;
    source: string;
    context?: Record<string, unknown>;
    now?: string;
  },
): ConversationActionTaskRow {
  ensureTables(db);
  const existing = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === input.taskId
    && candidate.userId === input.userId
  ));
  if (existing) return existing;
  const now = input.now || new Date().toISOString();
  const intent = normalizeActionIntent(input.goal);
  const actionState = normalizeConversationActionState({
    version: 2,
    taskId: input.taskId,
    goal: input.goal,
    latestInstruction: input.goal,
    latestInstructionRef: input.requestId,
    status: 'executing',
    unfinished: true,
    latestBlocker: '',
    appTarget: input.target,
    activeRequestId: input.requestId,
    sourcePaths: [],
    evidenceTools: [],
    assistantState: '',
    toolSummaries: [],
    receipts: [],
    revision: 1,
    updatedAt: now,
  });
  const task: ConversationActionTaskRow = {
    id: input.taskId,
    conversationId: input.conversationId,
    userId: input.userId,
    domain: input.domain || 'personal',
    orgId: input.orgId || '',
    parentTaskId: '',
    rootUserMessageId: '',
    intentKind: intent.kind === 'none' ? 'background_work' : intent.kind,
    operation: intent.kind === 'none' ? 'mutate' : intent.operation,
    goal: input.goal,
    target: input.target,
    status: 'executing',
    blocker: '',
    activeRequestId: input.requestId,
    completionSource: '',
    context: JSON.stringify({
      ...(input.context || {}),
      source: input.source,
      actionState,
    }),
    revision: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: '',
  };
  (db.conversationActionTasks as ConversationActionTaskRow[]).push(task);
  return task;
}

/** Settle a background-owned action only from terminal records/finalization. */
export function settleBackgroundConversationActionTask(
  db: any,
  input: {
    taskId: string;
    userId: string;
    records: ToolExecutionRecord[];
    status: 'completed' | 'blocked' | 'cancelled';
    blocker?: string;
    requestId?: string;
    now?: string;
  },
): ConversationActionTaskRow | null {
  ensureTables(db);
  const task = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === input.taskId && candidate.userId === input.userId
  ));
  if (!task) return null;
  const now = input.now || new Date().toISOString();
  appendConversationActionReceipts(db, {
    task,
    records: input.records,
    requestId: input.requestId,
    now,
  });
  const previous = normalizeConversationActionState(parseObject(task.context).actionState);
  const baseState: ConversationActionContinuationState = previous || {
    version: 2,
    taskId: task.id,
    goal: task.goal,
    appTarget: task.target,
    latestInstruction: task.goal,
    latestInstructionRef: task.activeRequestId || undefined,
    unfinished: true,
    latestBlocker: '',
    sourcePaths: [],
    evidenceTools: [],
    assistantState: '',
    toolSummaries: [],
    receipts: [],
    revision: task.revision,
    updatedAt: task.updatedAt,
  };
  const conversation = (db.conversations || []).find((candidate: any) => (
    candidate.id === task.conversationId && candidate.userId === task.userId
  ));
  const finalized = finalizeConversationActionTask(db, {
    conversation: conversation || {
      id: task.conversationId,
      userId: task.userId,
      domain: task.domain,
      orgId: task.orgId,
    },
    state: baseState,
    outcome: input.status,
    requestId: input.requestId || task.activeRequestId,
    blocker: input.status === 'blocked'
      ? String(input.blocker || 'Background execution did not reach verified completion.')
      : '',
    completionSource: input.status === 'completed' ? 'tool_receipt' : undefined,
    now,
    updateLivePointer: false,
  });
  return finalized?.task || task;
}

type SchedulerAuditOutcome = 'executing' | 'verified' | 'blocked' | 'failed' | 'unknown';

function compactSchedulerAuditTaskId(scheduledTaskId: string): string {
  return `scheduler_audit_${digest(scheduledTaskId).slice(0, 24)}`;
}

function schedulerRecordOutcome(
  status: 'executing' | 'blocked' | 'completed',
  records: ToolExecutionRecord[],
): SchedulerAuditOutcome {
  const declared = records
    .map(record => String((record.receipt as any)?.status || ''))
    .find(Boolean);
  if (declared === 'failed' || declared === 'unknown' || declared === 'blocked') return declared;
  if (status === 'completed') return 'verified';
  return status;
}

function parseSchedulerAudit(task: ConversationActionTaskRow | undefined): Record<string, any> {
  const context = parseObject(task?.context);
  const audit = parseObject(context.schedulerAudit);
  return {
    schemaVersion: 1,
    totalExecutions: 0,
    completedCount: 0,
    blockedCount: 0,
    failedCount: 0,
    unknownCount: 0,
    compactedReceiptCount: 0,
    receiptOutcomeCounts: {},
    recentExecutions: [],
    ...audit,
  };
}

/** Returns the durable state for one compact scheduler slot, if it is still in the replay window. */
export function getScheduledCapabilityExecutionStatus(
  db: any,
  input: { scheduledTaskId: string; executionId: string },
): SchedulerAuditOutcome | null {
  ensureTables(db);
  const task = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === compactSchedulerAuditTaskId(input.scheduledTaskId)
  ));
  if (!task) return null;
  const audit = parseSchedulerAudit(task);
  if (audit.currentExecution?.executionId === input.executionId) {
    return audit.currentExecution.status || null;
  }
  const recent = (Array.isArray(audit.recentExecutions) ? audit.recentExecutions : [])
    .find((candidate: any) => candidate?.executionId === input.executionId);
  return recent?.status || null;
}

function persistCompactScheduledCapabilityExecution(
  db: any,
  input: {
    scheduledTaskId: string;
    plan: CapabilityExecutionPlan;
    status: Extract<ConversationTaskStatus, 'executing' | 'blocked' | 'completed'>;
    records?: ToolExecutionRecord[];
    blocker?: string;
    now?: string;
  },
): ConversationActionTaskRow {
  const now = input.now || new Date().toISOString();
  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  const taskId = compactSchedulerAuditTaskId(input.scheduledTaskId);
  let task = tasks.find(candidate => candidate.id === taskId);
  const context = parseObject(task?.context);
  const audit = parseSchedulerAudit(task);
  const records = input.records || [];
  const outcome = schedulerRecordOutcome(input.status, records);
  const existing = audit.currentExecution?.executionId === input.plan.taskId
    ? audit.currentExecution
    : (Array.isArray(audit.recentExecutions) ? audit.recentExecutions : [])
      .find((candidate: any) => candidate?.executionId === input.plan.taskId);

  if (input.status === 'executing' && existing?.status && existing.status !== 'executing') {
    return task!;
  }

  const isNewExecution = input.status === 'executing' && !existing;
  if (isNewExecution) audit.totalExecutions = Number(audit.totalExecutions || 0) + 1;
  const priorOutcome = existing?.status && existing.status !== 'executing'
    ? existing.status
    : String(audit.lastOutcome || '');
  const entry = {
    executionId: input.plan.taskId,
    status: outcome,
    startedAt: existing?.startedAt || now,
    ...(outcome === 'executing' ? {} : { completedAt: now }),
  };
  const recent = (Array.isArray(audit.recentExecutions) ? audit.recentExecutions : [])
    .filter((candidate: any) => candidate?.executionId !== input.plan.taskId);
  recent.push(entry);
  audit.recentExecutions = recent.slice(-36);
  audit.currentExecution = entry;
  audit.firstExecutionAt = audit.firstExecutionAt || now;
  audit.lastExecutionAt = now;
  if (outcome !== 'executing' && existing?.status !== outcome) {
    if (outcome === 'verified') audit.completedCount = Number(audit.completedCount || 0) + 1;
    if (outcome === 'blocked') audit.blockedCount = Number(audit.blockedCount || 0) + 1;
    if (outcome === 'failed') audit.failedCount = Number(audit.failedCount || 0) + 1;
    if (outcome === 'unknown') audit.unknownCount = Number(audit.unknownCount || 0) + 1;
    audit.lastOutcome = outcome;
  }

  const persistedPlan = sanitizeCapabilityExecutionPlan(input.plan, now);
  const values: ConversationActionTaskRow = {
    id: taskId,
    conversationId: `scheduler:${input.scheduledTaskId}`,
    userId: 'system',
    domain: 'personal',
    orgId: '',
    parentTaskId: '',
    rootUserMessageId: '',
    intentKind: input.plan.intent.kind,
    operation: input.plan.intent.operation,
    goal: `Audit declared scheduled task ${input.scheduledTaskId}`,
    target: input.scheduledTaskId,
    status: input.status,
    blocker: String(input.blocker || '').slice(0, 500),
    activeRequestId: input.status === 'executing' ? input.plan.taskId : '',
    completionSource: input.status === 'completed' ? 'tool_receipt' : '',
    context: JSON.stringify({
      ...context,
      source: 'scheduler',
      scheduledTaskId: input.scheduledTaskId,
      compactAudit: true,
      executionPlan: persistedPlan,
      schedulerAudit: audit,
    }),
    revision: Math.max(1, Number(task?.revision || 0) + (task ? 1 : 0)),
    createdAt: task?.createdAt || now,
    updatedAt: now,
    completedAt: input.status === 'completed' ? now : '',
  };
  if (task) Object.assign(task, values);
  else {
    task = values;
    tasks.push(task);
  }

  const lastReceiptAt = Date.parse(String(audit.lastReceiptAt || '')) || 0;
  const abnormal = outcome !== 'verified' && outcome !== 'executing';
  // The summary row itself keeps exact counters and the most recent 36 slot
  // identities. A successful receipt every six hours is enough to prove the
  // heartbeat while avoiding thousands of identical scheduler receipts.
  // Abnormal outcomes are still appended immediately.
  const checkpointDue = Date.parse(now) - lastReceiptAt >= 6 * 60 * 60 * 1000;
  if (records.length > 0 && (abnormal || priorOutcome !== outcome || checkpointDue)) {
    appendConversationActionReceipts(db, {
      task,
      records,
      turnId: input.plan.taskId,
      requestId: input.plan.taskId,
      now,
    });
    audit.lastReceiptAt = now;
    task.context = JSON.stringify({
      ...parseObject(task.context),
      schedulerAudit: audit,
    });
  }
  return task;
}

/**
 * One-version migration for the old 10-second/1-minute probe ledger. Only
 * verified completed rows are folded; failures, unknown outcomes and their
 * receipts remain append-only evidence.
 */
export function compactLegacyScheduledCapabilityExecutions(db: any): {
  tasksRemoved: number;
  receiptsRemoved: number;
  summariesUpdated: number;
} {
  ensureTables(db);
  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  const receipts = db.conversationActionReceipts as ConversationActionReceiptRow[];
  const receiptsByTask = new Map<string, ConversationActionReceiptRow[]>();
  for (const receipt of receipts) {
    const related = receiptsByTask.get(receipt.taskId) || [];
    related.push(receipt);
    receiptsByTask.set(receipt.taskId, related);
  }
  let tasksRemoved = 0;
  let receiptsRemoved = 0;
  let summariesUpdated = 0;

  const scheduledTaskIds = new Set(tasks
    .filter(candidate => (
      candidate.intentKind === 'scheduled_task'
      && candidate.conversationId.startsWith('scheduler:')
      && candidate.target
    ))
    .map(candidate => candidate.target));

  for (const scheduledTaskId of scheduledTaskIds) {
    const summaryId = compactSchedulerAuditTaskId(scheduledTaskId);
    const candidates = tasks.filter(candidate => (
      candidate.id !== summaryId
      && candidate.conversationId === `scheduler:${scheduledTaskId}`
      && candidate.status === 'completed'
    ));
    const verified = candidates.filter(candidate => {
      const related = receiptsByTask.get(candidate.id) || [];
      return related.length > 0 && related.every(receipt => receipt.outcome === 'verified_success');
    });
    if (verified.length === 0) continue;

    verified.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
    const removedIds = new Set(verified.map(candidate => candidate.id));
    const removedReceipts = verified.flatMap(candidate => receiptsByTask.get(candidate.id) || []);
    const summary = tasks.find(candidate => candidate.id === summaryId);
    const audit = parseSchedulerAudit(summary);
    const last = verified[verified.length - 1];
    const lastContext = parseObject(last.context);
    const migratedRecent = verified.slice(-36).map(candidate => ({
      executionId: candidate.id,
      status: 'verified',
      startedAt: candidate.createdAt,
      completedAt: candidate.completedAt || candidate.updatedAt,
    }));
    audit.totalExecutions = Number(audit.totalExecutions || 0) + verified.length;
    audit.completedCount = Number(audit.completedCount || 0) + verified.length;
    audit.compactedReceiptCount = Number(audit.compactedReceiptCount || 0) + removedReceipts.length;
    audit.receiptOutcomeCounts = {
      ...parseObject(audit.receiptOutcomeCounts),
      verified_success: Number(parseObject(audit.receiptOutcomeCounts).verified_success || 0) + removedReceipts.length,
    };
    audit.firstExecutionAt = audit.firstExecutionAt || verified[0].createdAt;
    audit.lastExecutionAt = last.updatedAt;
    audit.lastOutcome = 'verified';
    audit.currentExecution = migratedRecent[migratedRecent.length - 1];
    audit.recentExecutions = [
      ...(Array.isArray(audit.recentExecutions) ? audit.recentExecutions : []),
      ...migratedRecent,
    ].slice(-36);

    const values: ConversationActionTaskRow = {
      id: summaryId,
      conversationId: `scheduler:${scheduledTaskId}`,
      userId: 'system',
      domain: 'personal',
      orgId: '',
      parentTaskId: '',
      rootUserMessageId: '',
      intentKind: last.intentKind,
      operation: last.operation,
      goal: `Audit declared scheduled task ${scheduledTaskId}`,
      target: scheduledTaskId,
      status: 'completed',
      blocker: '',
      activeRequestId: '',
      completionSource: 'tool_receipt',
      context: JSON.stringify({
        ...parseObject(summary?.context),
        source: 'scheduler',
        scheduledTaskId,
        compactAudit: true,
        ...(lastContext.executionPlan ? { executionPlan: lastContext.executionPlan } : {}),
        schedulerAudit: audit,
      }),
      revision: Math.max(1, Number(summary?.revision || 0) + 1),
      createdAt: summary?.createdAt || verified[0].createdAt,
      updatedAt: last.updatedAt,
      completedAt: last.completedAt || last.updatedAt,
    };
    db.conversationActionTasks = tasks.filter(candidate => !removedIds.has(candidate.id));
    const refreshedTasks = db.conversationActionTasks as ConversationActionTaskRow[];
    const refreshedSummary = refreshedTasks.find(candidate => candidate.id === summaryId);
    if (refreshedSummary) Object.assign(refreshedSummary, values);
    else refreshedTasks.push(values);
    db.conversationActionReceipts = receipts.filter(receipt => !removedIds.has(receipt.taskId));
    tasks.splice(0, tasks.length, ...refreshedTasks);
    receipts.splice(0, receipts.length, ...(db.conversationActionReceipts as ConversationActionReceiptRow[]));
    tasksRemoved += verified.length;
    receiptsRemoved += removedReceipts.length;
    summariesUpdated += 1;
  }
  return { tasksRemoved, receiptsRemoved, summariesUpdated };
}

/**
 * Stores a scheduler execution in the shared action ledger. The scheduler has
 * no chat conversation, so it uses a namespaced conversation identity while
 * retaining the same append-only task/receipt schema and sanitization rules.
 */
export function persistScheduledCapabilityExecution(
  db: any,
  input: {
    scheduledTaskId: string;
    plan: CapabilityExecutionPlan;
    status: Extract<ConversationTaskStatus, 'executing' | 'blocked' | 'completed'>;
    records?: ToolExecutionRecord[];
    blocker?: string;
    now?: string;
    compactAudit?: boolean;
  },
): ConversationActionTaskRow {
  ensureTables(db);
  if (input.compactAudit) return persistCompactScheduledCapabilityExecution(db, input);
  const now = input.now || new Date().toISOString();
  const conversationId = `scheduler:${input.scheduledTaskId}`;
  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  let task = tasks.find(candidate => (
    candidate.id === input.plan.taskId
    && candidate.conversationId === conversationId
    && candidate.userId === 'system'
  ));
  const existingCompleted = task?.status === 'completed';
  const persistedPlan = sanitizeCapabilityExecutionPlan(input.plan, now);
  const existingContext = parseObject(task?.context);
  const context = {
    ...existingContext,
    source: 'scheduler',
    scheduledTaskId: input.scheduledTaskId,
    executionPlan: persistedPlan,
    executionPlans: [
      ...(Array.isArray(existingContext.executionPlans)
        ? existingContext.executionPlans.filter((candidate: any) => candidate?.planId !== persistedPlan.planId)
        : []),
      persistedPlan,
    ].slice(-12),
  };
  const status = existingCompleted ? 'completed' : input.status;
  const values: ConversationActionTaskRow = {
    id: input.plan.taskId,
    conversationId,
    userId: 'system',
    domain: 'personal',
    orgId: '',
    parentTaskId: '',
    rootUserMessageId: '',
    intentKind: input.plan.intent.kind,
    operation: input.plan.intent.operation,
    goal: `Execute declared scheduled task ${input.scheduledTaskId}`,
    target: input.scheduledTaskId,
    status,
    blocker: existingCompleted ? '' : String(input.blocker || '').slice(0, 500),
    activeRequestId: input.plan.taskId,
    completionSource: status === 'completed' ? 'tool_receipt' : '',
    context: JSON.stringify(context),
    revision: Math.max(1, Number(task?.revision || 0) + (task ? 1 : 0)),
    createdAt: task?.createdAt || now,
    updatedAt: existingCompleted ? task?.updatedAt || now : now,
    completedAt: status === 'completed' ? task?.completedAt || now : '',
  };
  if (task) Object.assign(task, values);
  else {
    task = values;
    tasks.push(task);
  }
  appendConversationActionReceipts(db, {
    task,
    records: input.records || [],
    turnId: input.plan.taskId,
    requestId: input.plan.taskId,
    now,
  });
  return task;
}

/**
 * Persists the semantic plan in the existing append-compatible task context.
 * Raw message payloads are never stored; confirmation uses the digest already
 * bound to the durable task identity.
 */
export function attachConversationExecutionPlan(
  db: any,
  input: {
    conversationId: string;
    userId: string;
    plan: CapabilityExecutionPlan;
    now?: string;
  },
): ConversationActionTaskRow | null {
  ensureTables(db);
  const task = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === input.plan.taskId
    && candidate.conversationId === input.conversationId
    && candidate.userId === input.userId
  ));
  if (!task) return null;
  const now = input.now || new Date().toISOString();
  const context = parseObject(task.context);
  const persisted = sanitizeCapabilityExecutionPlan(input.plan, now);
  const history = (Array.isArray(context.executionPlans) ? context.executionPlans : [])
    .filter((candidate: any) => candidate?.planId !== persisted.planId)
    .slice(-11);
  history.push(persisted);
  task.context = JSON.stringify({
    ...context,
    executionPlan: persisted,
    executionPlans: history,
  });
  task.updatedAt = now;
  return task;
}

/** Stores the compiled graph and digest-only node receipts for restart recovery. */
export function attachConversationModelExecutionGraph(
  db: any,
  input: {
    conversationId: string;
    userId: string;
    taskId: string;
    graph: ModelExecutionGraph;
    receipts: ModelGraphNodeReceipt[];
    arbitrationReceipt?: ModelGraphArbitrationReceipt;
    now?: string;
  },
): ConversationActionTaskRow | null {
  ensureTables(db);
  const task = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === input.taskId
    && candidate.conversationId === input.conversationId
    && candidate.userId === input.userId
  ));
  if (!task || input.graph.taskId !== task.id) return null;
  const now = input.now || new Date().toISOString();
  const context = parseObject(task.context);
  const persistedGraph = {
    ...input.graph,
    nodes: input.graph.nodes.map(node => ({
      ...node,
      candidates: node.candidates.map(candidate => ({ ...candidate })),
      dependsOn: [...node.dependsOn],
      inputRefs: [...node.inputRefs],
      outputSchema: { ...node.outputSchema },
    })),
    edges: input.graph.edges.map(edge => ({ ...edge })),
    budgets: { ...input.graph.budgets },
    persistedAt: now,
  };
  const graphHistory = (Array.isArray(context.modelExecutionGraphs) ? context.modelExecutionGraphs : [])
    .filter((candidate: any) => candidate?.graphId !== persistedGraph.graphId)
    .slice(-7);
  graphHistory.push(persistedGraph);
  const priorReceipts = Array.isArray(context.modelNodeReceipts) ? context.modelNodeReceipts : [];
  const receiptKeys = new Set(input.receipts.map(receipt => `${receipt.graphId}:${receipt.nodeId}`));
  const modelNodeReceipts = [
    ...priorReceipts.filter((receipt: any) => !receiptKeys.has(`${receipt?.graphId}:${receipt?.nodeId}`)),
    ...input.receipts.map(receipt => ({
      graphId: receipt.graphId,
      taskId: receipt.taskId,
      nodeId: receipt.nodeId,
      status: receipt.status,
      ...(receipt.selectedCandidate ? { selectedCandidate: { ...receipt.selectedCandidate } } : {}),
      ...(receipt.agentId ? { agentId: receipt.agentId } : {}),
      dependencyReceiptIds: [...receipt.dependencyReceiptIds],
      startedAt: receipt.startedAt,
      completedAt: receipt.completedAt,
      durationMs: receipt.durationMs,
      nodeFingerprint: receipt.nodeFingerprint,
      outputDigest: receipt.outputDigest,
      evidenceKind: receipt.evidenceKind,
      evidenceRefs: [...receipt.evidenceRefs],
      verified: receipt.verified,
      ...(receipt.estimatedInputTokens !== undefined
        ? { estimatedInputTokens: receipt.estimatedInputTokens }
        : {}),
      ...(receipt.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: receipt.estimatedCostUsd }
        : {}),
      ...(receipt.reusedFromReceipt ? { reusedFromReceipt: receipt.reusedFromReceipt } : {}),
      // Model output and free-form errors can contain user data. Durable recovery
      // intentionally stores only digests and bounded structural metadata.
      ...(receipt.error ? { error: 'model_node_execution_failed' } : {}),
    })),
  ].slice(-120);
  task.context = JSON.stringify({
    ...context,
    modelExecutionGraph: persistedGraph,
    modelExecutionGraphs: graphHistory,
    modelNodeReceipts,
    ...(input.arbitrationReceipt ? {
      modelArbitrationReceipt: {
        ...input.arbitrationReceipt,
        selectedNodeIds: [...input.arbitrationReceipt.selectedNodeIds],
        consideredNodeIds: [...input.arbitrationReceipt.consideredNodeIds],
      },
    } : {}),
  });
  task.updatedAt = now;
  return task;
}

/**
 * Loads restart state only from the exact scoped task. Legacy receipts without
 * a semantic node fingerprint are excluded and therefore cannot be replayed.
 */
export function loadConversationModelExecutionRecovery(
  db: any,
  input: { conversationId: string; userId: string; taskId: string },
): ConversationModelExecutionRecovery | null {
  ensureTables(db);
  const task = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === input.taskId
    && candidate.conversationId === input.conversationId
    && candidate.userId === input.userId
  ));
  if (!task) return null;
  const context = parseObject(task.context);
  const graph = context.modelExecutionGraph as ModelExecutionGraph | undefined;
  if (!graph || graph.taskId !== task.id || !Array.isArray(graph.nodes)) return null;
  const receipts = (Array.isArray(context.modelNodeReceipts) ? context.modelNodeReceipts : [])
    .filter((receipt: any) => (
      receipt
      && receipt.taskId === task.id
      && receipt.graphId === graph.graphId
      && typeof receipt.nodeId === 'string'
      && /^[a-f0-9]{64}$/.test(String(receipt.nodeFingerprint || ''))
      && /^[a-f0-9]{64}$/.test(String(receipt.outputDigest || ''))
      && receipt.status === 'succeeded'
      && receipt.verified === true
      && Array.isArray(receipt.evidenceRefs)
      && receipt.evidenceRefs.length > 0
      && (
        (receipt.evidenceKind === 'tool_terminal_verification'
          && receipt.evidenceRefs.every((value: unknown) => /^tool:[A-Za-z0-9._:-]{1,240}$/.test(String(value || ''))))
        || (receipt.evidenceKind === 'validated_model_output'
          && receipt.evidenceRefs.length === 1
          && receipt.evidenceRefs[0] === `model_output:${receipt.outputDigest}`
          && /^model_output:[a-f0-9]{64}$/.test(String(receipt.evidenceRefs[0] || '')))
      )
    ))
    .map((receipt: any): ModelGraphNodeReceipt => ({
      graphId: receipt.graphId,
      taskId: receipt.taskId,
      nodeId: receipt.nodeId,
      status: 'succeeded',
      ...(receipt.selectedCandidate ? { selectedCandidate: { ...receipt.selectedCandidate } } : {}),
      ...(receipt.agentId ? { agentId: String(receipt.agentId) } : {}),
      dependencyReceiptIds: Array.isArray(receipt.dependencyReceiptIds)
        ? receipt.dependencyReceiptIds.map(String)
        : [],
      startedAt: String(receipt.startedAt || ''),
      completedAt: String(receipt.completedAt || ''),
      durationMs: Math.max(0, Number(receipt.durationMs) || 0),
      nodeFingerprint: receipt.nodeFingerprint,
      outputDigest: receipt.outputDigest,
      evidenceKind: receipt.evidenceKind,
      evidenceRefs: receipt.evidenceRefs.map(String),
      verified: true,
      ...(receipt.estimatedInputTokens !== undefined
        ? { estimatedInputTokens: Math.max(0, Number(receipt.estimatedInputTokens) || 0) }
        : {}),
      ...(receipt.estimatedCostUsd !== undefined
        ? { estimatedCostUsd: Math.max(0, Number(receipt.estimatedCostUsd) || 0) }
        : {}),
      ...(receipt.reusedFromReceipt ? { reusedFromReceipt: String(receipt.reusedFromReceipt) } : {}),
    }));
  return { graph, receipts };
}

export function findConversationActionTask(
  db: any,
  input: { conversationId: string; userId: string; query?: string },
): ConversationActionTaskRow | null {
  ensureTables(db);
  const intent = normalizeActionIntent(input.query || '');
  const query = String(input.query || '').toLowerCase();
  const queryMentionsWps = /\bwps\b/iu.test(query);
  const explicitTargets = Array.from(String(input.query || '').matchAll(
    /([^\s\\/:*?"<>|\r\n]{1,160}\.(?:txt|md|docx?|xlsx?|pptx?|pdf|csv))\b/giu,
  )).map(match => String(match[1] || '').trim().toLowerCase()).filter(Boolean);
  const scopedReceipts = (db.conversationActionReceipts as ConversationActionReceiptRow[])
    .filter(receipt => receipt.conversationId === input.conversationId);
  const scopedTasks = (db.conversationActionTasks as ConversationActionTaskRow[])
    .filter(task => task.conversationId === input.conversationId && task.userId === input.userId);
  if (intent.kind === 'status_query' && intent.target === 'previous_action') {
    const latestTaskEventAt = (task: ConversationActionTaskRow): string => (
      scopedReceipts
        .filter(receipt => receipt.taskId === task.id)
        .reduce((latest, receipt) => (
          receipt.createdAt.localeCompare(latest) > 0 ? receipt.createdAt : latest
        ), task.createdAt || task.updatedAt)
    );
    return scopedTasks
      .map((task, insertionOrder) => ({ task, insertionOrder, eventAt: latestTaskEventAt(task) }))
      .sort((left, right) => (
        right.eventAt.localeCompare(left.eventAt)
        || right.task.createdAt.localeCompare(left.task.createdAt)
        || right.insertionOrder - left.insertionOrder
      ))[0]?.task || null;
  }
  return scopedTasks
    .map(task => {
      const context = parseObject(task.context);
      const actionState = normalizeConversationActionState(context.actionState);
      const haystack = `${task.intentKind} ${task.goal} ${task.target} ${task.context}`.toLowerCase();
      // Receipt context contains before/after snapshots. Those observations
      // prove an action but do not identify its target: a command-center action
      // may legitimately contain before.activeTab=home, for example.
      const targetHaystack = [
        task.intentKind,
        task.goal,
        task.target,
        actionState?.appTarget || '',
        actionState?.latestInstruction || '',
      ].join(' ').toLowerCase();
      const taskReceipts = scopedReceipts.filter(receipt => receipt.taskId === task.id);
      let score = 0;
      if (intent.target && targetHaystack.includes(intent.target.toLowerCase())) score += 8;
      if (intent.target === 'AutoCAD' && /cad|图纸|平面图/i.test(targetHaystack)) score += 8; // i18n-allow: Chinese CAD task matching; not user-visible copy.
      if (intent.kind !== 'status_query' && intent.kind !== 'none' && task.intentKind === intent.kind) score += 6;
      if (query && haystack.includes(query)) score += 3;
      for (const target of explicitTargets) {
        if (haystack.includes(target)) score += 16;
        if (taskReceipts.some(receipt => (
          receipt.targetIdentity.toLowerCase().includes(target)
          || receipt.envelope.toLowerCase().includes(target)
        ))) score += 32;
      }
      // WPS creation receipts are stronger task identity evidence than
      // recency. A later client navigation (for example, returning to the
      // command center to inspect the result) must not steal a status query
      // that explicitly names WPS.
      if (queryMentionsWps) {
        if (/\bwps\b/iu.test(targetHaystack)) score += 12;
        if (taskReceipts.some(receipt => /^wps_/i.test(receipt.toolName))) score += 32;
      }
      if (taskReceipts.some(receipt => receipt.outcome === 'verified_success')) score += 4;
      return { task, score };
    })
    .sort((left, right) => (
      right.score - left.score
      || (query
        ? right.task.updatedAt.localeCompare(left.task.updatedAt)
        : right.task.createdAt.localeCompare(left.task.createdAt)
          || right.task.updatedAt.localeCompare(left.task.updatedAt))
    ))[0]?.task || null;
}

export function conversationActionStateFromTask(
  task: ConversationActionTaskRow | null | undefined,
): ConversationActionContinuationState | null {
  if (!task) return null;
  const context = parseObject(task.context);
  const persisted = normalizeConversationActionState(context.actionState);
  const requestLeaseActive = conversationTaskStatusOwnsExecutionLease(task.status);
  return normalizeConversationActionState({
    ...(persisted || {}),
    version: 2,
    taskId: task.id,
    goal: persisted?.goal || task.goal,
    latestInstruction: persisted?.latestInstruction || persisted?.goal || task.goal,
    status: task.status,
    latestBlocker: task.blocker,
    activeRequestId: requestLeaseActive ? task.activeRequestId || undefined : undefined,
    completionSource: task.completionSource === 'user_observation'
      ? 'user_observation'
      : task.completionSource === 'tool_receipt'
        ? 'tool_receipt'
        : undefined,
    unfinished: !isTerminalConversationTaskStatus(task.status),
    updatedAt: task.updatedAt,
    appTarget: persisted?.appTarget || task.target,
    sourcePaths: persisted?.sourcePaths || [],
    evidenceTools: persisted?.evidenceTools || [],
    assistantState: persisted?.assistantState || '',
    toolSummaries: persisted?.toolSummaries || [],
    receipts: persisted?.receipts || [],
  } as ConversationActionContinuationState);
}

export function getConversationActionStateFromLedger(
  db: any,
  input: { conversationId: string; userId: string; query?: string },
): ConversationActionContinuationState | null {
  return conversationActionStateFromTask(findConversationActionTask(db, input));
}

/**
 * Resolve the immutable task already bound to a request. Unlike the general
 * ledger selector, this cannot be displaced by a newer status/audit task.
 */
export function getConversationActionStateByTaskId(
  db: any,
  input: { conversationId: string; userId: string; taskId: string },
): ConversationActionContinuationState | null {
  ensureTables(db);
  const taskId = String(input.taskId || '').trim();
  if (!taskId) return null;
  const task = (db.conversationActionTasks as ConversationActionTaskRow[]).find(candidate => (
    candidate.id === taskId
    && candidate.conversationId === input.conversationId
    && candidate.userId === input.userId
  ));
  return conversationActionStateFromTask(task);
}

export function formatConversationActionLedgerStatus(
  db: any,
  input: { conversationId: string; userId: string; query?: string },
): string | null {
  const task = findConversationActionTask(db, input);
  const state = conversationActionStateFromTask(task);
  if (!state) return null;
  const query = String(input.query || '');
  const taskReceipts = task
    ? (db.conversationActionReceipts as ConversationActionReceiptRow[])
      .filter(receipt => receipt.taskId === task.id)
    : [];
  const normalizedQueryIntent = normalizeActionIntent(query);
  const asksForPreviousAction = normalizedQueryIntent.kind === 'status_query'
    && normalizedQueryIntent.target === 'previous_action';
  const asksForArtifactReceiptChain = /(?:\u5199\u5165|\u56de\u8bfb|\u6700\u7ec8\u72b6\u6001)|\b(?:written|read\s*back|final\s+status)\b/iu.test(query);
  if (task && asksForArtifactReceiptChain) {
    const writeIndex = taskReceipts.map(receipt => (
      receipt.outcome === 'verified_success'
      && /^(?:write_file|create_docx|create_xlsx|create_ppt|create_pdf|modify_docx|modify_xlsx)$/i.test(receipt.toolName)
      && /(?:^[A-Za-z]:[\\/]|^\/).+\.[A-Za-z0-9]{1,12}$/u.test(receipt.targetIdentity)
    )).lastIndexOf(true);
    const writeReceipt = writeIndex >= 0 ? taskReceipts[writeIndex] : undefined;
    const asksForSourceRead = /(?:\u6e90\u6587\u4ef6\u8bfb\u53d6|\u8bfb\u53d6\u6e90\u6587\u4ef6|\u4e09\u6b65|source\s+file\s+read)/iu.test(query);
    const sourceReadReceipt = writeReceipt && writeIndex > 0
      ? [...taskReceipts.slice(0, writeIndex)].reverse().find(receipt => (
          receipt.outcome === 'verified_success'
          && /^(?:read_file|read_docx|read_xlsx|read_pdf|extract_document_text)$/i.test(receipt.toolName)
          && Boolean(receipt.targetIdentity)
          && receipt.targetIdentity.toLowerCase() !== writeReceipt.targetIdentity.toLowerCase()
        ))
      : undefined;
    const readReceipt = writeReceipt
      ? taskReceipts.slice(writeIndex + 1).find(receipt => (
          receipt.outcome === 'verified_success'
          && /^(?:read_file|read_docx|read_xlsx|read_pdf|extract_document_text)$/i.test(receipt.toolName)
          && receipt.targetIdentity.toLowerCase() === writeReceipt.targetIdentity.toLowerCase()
        ))
      : undefined;
    if (writeReceipt) {
      const path = writeReceipt?.targetIdentity || state.sourcePaths?.[0] || task.target;
      const finalStatus = task.status === 'completed' && writeReceipt
        ? '\u5df2\u5b8c\u6210\uff08\u6301\u4e45\u56de\u6267\u5df2\u9a8c\u8bc1\uff09'
        : formatConversationActionTaskStatus(state);
      const readbackEnvelope = readReceipt ? parseObject(readReceipt.envelope) : {};
      const readbackText = typeof readbackEnvelope.result === 'string'
        ? readbackEnvelope.result.replace(/\r\n/g, '\n')
        : '';
      const readbackMetadata = readbackEnvelope.result && typeof readbackEnvelope.result === 'object'
        ? readbackEnvelope.result as Record<string, any>
        : {};
      const asksEncoding = /(?:\u7f16\u7801|encoding)/iu.test(query);
      const asksLineCount = /(?:\u603b\u884c\u6570|\u884c\u6570)|\bline\s*count\b/iu.test(query);
      const lineCount = Number(readbackMetadata.lineCount) > 0
        ? Number(readbackMetadata.lineCount)
        : readbackText
        ? readbackText.replace(/\n$/, '').split('\n').length
        : 0;
      return [
        `\u8def\u5f84\uff1a${path || '\u672a\u8bb0\u5f55'}`,
        asksForSourceRead
          ? `\u6e90\u6587\u4ef6\u8bfb\u53d6\uff1a${sourceReadReceipt ? `\u5df2\u9a8c\u8bc1\uff08${sourceReadReceipt.toolName}\uff0c${sourceReadReceipt.targetIdentity}\uff09` : '\u672a\u9a8c\u8bc1'}`
          : '',
        `\u5199\u5165\uff1a${writeReceipt ? `\u5df2\u9a8c\u8bc1\uff08${writeReceipt.toolName}\uff09` : '\u672a\u9a8c\u8bc1'}`,
        `\u5199\u5165\u540e\u56de\u8bfb\uff1a${readReceipt ? `\u662f\uff08${readReceipt.toolName}\uff09` : '\u5426'}`,
        asksEncoding ? `\u7f16\u7801\uff1a${writeReceipt.toolName === 'write_file' && readReceipt ? String(readbackMetadata.encoding || 'UTF-8') : '\u56de\u6267\u672a\u8bb0\u5f55'}` : '',
        asksLineCount ? `\u603b\u884c\u6570\uff1a${readReceipt && lineCount ? lineCount : '\u56de\u6267\u672a\u8bb0\u5f55'}` : '',
        `\u6700\u7ec8\u72b6\u6001\uff1a${finalStatus}`,
      ].filter(Boolean).join('\n');
    }
  }
  // A receipt question such as “what did you just open?” should answer the
  // concrete target directly. The generic ledger sentence is useful for task
  // progress, but sounds unnatural and obscures the requested fact here.
  // i18n-allow: Multilingual recent desktop-open receipt recognition.
  const asksForWpsDocumentDetails = /(?:\bWPS\b|\u6b63\u6587\u9a8c\u8bc1|\u4fdd\u5b58\u72b6\u6001|\u6587\u6863\u540d)|\b(?:wps|body\s+verification|save\s+status|document\s+name)\b/iu.test(query);
  if (task && asksForWpsDocumentDetails) {
    const wpsReceipt = [...taskReceipts].reverse().find(receipt => (
      receipt.toolName === 'wps_create_document_with_text'
      && receipt.outcome === 'verified_success'
    ));
    if (wpsReceipt) {
      const result = parseObject(parseObject(wpsReceipt.envelope).result);
      const documentName = String(result.documentName || '').trim();
      const windowTitle = String(result.windowTitle || '').trim();
      const processName = String(result.processName || '').trim();
      const processId = Number(result.processId) || 0;
      const exactTextMatch = result.exactTextMatch === true;
      const charactersRequested = Number(result.charactersRequested) || 0;
      const charactersReadBack = Number(result.charactersReadBack) || 0;
      const saved = result.saved === true;
      const savePath = String(result.savePath || '').trim();
      return [
        `\u6587\u6863\uff1a${documentName || '\u56de\u6267\u672a\u8bb0\u5f55'}`,
        `\u7a97\u53e3\uff1a${windowTitle || '\u56de\u6267\u672a\u8bb0\u5f55'}`,
        `\u8fdb\u7a0b\uff1a${processName || '\u56de\u6267\u672a\u8bb0\u5f55'}${processId ? ` (PID ${processId})` : ''}`,
        `\u6b63\u6587\u9a8c\u8bc1\uff1a${exactTextMatch ? `\u5df2\u9a8c\u8bc1\uff08\u5199\u5165 ${charactersRequested} \u5b57\u7b26\uff0c\u56de\u8bfb ${charactersReadBack} \u5b57\u7b26\uff09` : '\u672a\u9a8c\u8bc1'}`,
        `\u4fdd\u5b58\u72b6\u6001\uff1a${saved ? `\u5df2\u4fdd\u5b58${savePath ? `\uff08${savePath}\uff09` : ''}` : '\u672a\u4fdd\u5b58'}`,
        `\u6700\u7ec8\u72b6\u6001\uff1a${exactTextMatch
          ? '\u5df2\u5b8c\u6210\uff08\u6301\u4e45\u56de\u6267\u5df2\u9a8c\u8bc1\uff09'
          : formatConversationActionTaskStatus(state)}`,
      ].join('\n');
    }
  }
  const asksRecentOpenedTarget = /(?:\u521a\u624d|\u521a\u521a|\u4e0a\u4e00\u8f6e|\u4e0a\u6b21).{0,20}\u6253\u5f00(?:\u4e86)?(?:\u4ec0\u4e48|\u54ea\u4e2a|\u54ea\u4e9b)|\bwhat\s+did\s+(?:you|lumi)\s+(?:just\s+)?open\b/iu.test(query);
  if (asksRecentOpenedTarget && state.status === 'completed' && task) {
    const openReceipt = [...(db.conversationActionReceipts as ConversationActionReceiptRow[])]
      .reverse()
      .find(receipt => (
        receipt.taskId === task.id
        && receipt.toolName === 'desktop_open'
        && receipt.outcome === 'verified_success'
        && Boolean(receipt.targetIdentity)
      ));
    const target = openReceipt?.targetIdentity || state.appTarget || task.target;
    if (target) return `\u521a\u624d\u6253\u5f00\u7684\u662f${target}\uff0c\u5df2\u901a\u8fc7\u7a97\u53e3\u56de\u6267\u786e\u8ba4\u3002`;
  }
  const asksForDesktopReceiptDetails = /(?:\u5b9e\u9645\u8fdb\u7a0b|\u7a97\u53e3\u6807\u9898|\u7cbe\u786e\u5339\u914d)|\b(?:actual\s+process|window\s+title|exact\s+(?:target\s+)?match)\b/iu.test(query);
  if (asksForDesktopReceiptDetails && task) {
    const openReceipt = [...taskReceipts].reverse().find(receipt => (
      receipt.toolName === 'desktop_open'
      && receipt.outcome === 'verified_success'
    ));
    const activeWindowReceipt = [...taskReceipts].reverse().find(receipt => (
      receipt.toolName === 'desktop_active_window'
      && receipt.outcome === 'verified_success'
    ));
    if (openReceipt) {
      const openResult = parseObject(parseObject(openReceipt.envelope).result);
      const activeWindowResult = activeWindowReceipt
        ? parseObject(parseObject(activeWindowReceipt.envelope).result)
        : {};
      const actualTarget = parseObject(openResult.actualTarget);
      const processName = String(
        activeWindowResult.process_name
        || activeWindowResult.processName
        || actualTarget.processName
        || actualTarget.process_name
        || '',
      ).trim();
      const windowTitle = String(
        activeWindowResult.title
        || actualTarget.title
        || '',
      ).trim();
      const targetMatched = openResult.targetMatched === true
        && Boolean(processName)
        && Boolean(windowTitle);
      return [
        `\u51c6\u786e\u76ee\u6807\uff1a${task.target || state.appTarget || openReceipt.targetIdentity || '\u672a\u8bb0\u5f55'}`,
        `\u5b9e\u9645\u8fdb\u7a0b\uff1a${processName || '\u56de\u6267\u672a\u8bb0\u5f55'}`,
        `\u5b9e\u9645\u7a97\u53e3\u6807\u9898\uff1a${windowTitle || '\u56de\u6267\u672a\u8bb0\u5f55'}`,
        `\u7cbe\u786e\u5339\u914d\uff1a${targetMatched ? '\u662f\uff08\u6253\u5f00\u56de\u6267\u4e0e\u6d3b\u52a8\u7a97\u53e3\u56de\u6267\u4e00\u81f4\uff09' : '\u5426\u6216\u56de\u6267\u4e0d\u5b8c\u6574'}`,
        `\u6700\u7ec8\u72b6\u6001\uff1a${targetMatched && task.status === 'completed' ? '\u5df2\u5b8c\u6210\uff08\u6301\u4e45\u56de\u6267\u5df2\u9a8c\u8bc1\uff09' : formatConversationActionTaskStatus(state)}`,
      ].join('\n');
    }
  }
  if (task && asksForPreviousAction && detectLanguage(query) === 'en') {
    return formatEnglishPreviousActionLedgerStatus(task, state, taskReceipts);
  }
  const latestClientActionReceipt = [...taskReceipts].reverse().find(receipt => (
    receipt.toolName === 'client_action'
  ));
  const verifiedClientActionReceipt = latestClientActionReceipt?.outcome === 'verified_success'
    ? latestClientActionReceipt
    : undefined;
  const asksForClientNavigationDetails = /(?:\u6267\u884c\u52a8\u4f5c|\u76ee\u6807\u9875\u9762|\u9a8c\u8bc1\u72b6\u6001)|\b(?:client\s+action|target\s+(?:page|surface)|verification\s+status)\b/iu.test(query)
    || normalizedQueryIntent.kind === 'status_query'
      && normalizedQueryIntent.target === 'previous_action';
  if (asksForClientNavigationDetails && (task?.intentKind === 'client_navigation' || verifiedClientActionReceipt)) {
    const clientReceipt = verifiedClientActionReceipt;
    if (clientReceipt) {
      const envelope = parseObject(clientReceipt.envelope);
      const result = parseObject(envelope.result);
      const verification = parseObject(result.verification);
      const action = String(result.action || parseObject(result.expectation).action || '').trim();
      const target = String(result.target || parseObject(result.expectation).target || task.target || state.appTarget || '').trim();
      const section = String(result.section || parseObject(result.expectation).section || '').trim();
      const verificationStatus = String(verification.status || parseObject(envelope.verification).status || '').trim();
      const matchedEvidence = Array.isArray(verification.matched)
        ? verification.matched.map(value => String(value || '').trim()).filter(Boolean).slice(0, 8)
        : [];
      return [
        `\u6267\u884c\u52a8\u4f5c\uff1a${action || '\u56de\u6267\u672a\u8bb0\u5f55'}`,
        `\u76ee\u6807\u9875\u9762\uff1a${target || '\u56de\u6267\u672a\u8bb0\u5f55'}`,
        section ? CN_ACTION_LEDGER_MESSAGES.targetSection(section) : '',
        `\u9a8c\u8bc1\u72b6\u6001\uff1a${verificationStatus || '\u56de\u6267\u672a\u8bb0\u5f55'}`,
        matchedEvidence.length ? CN_ACTION_LEDGER_MESSAGES.verificationEvidence(matchedEvidence) : '',
        `\u6700\u7ec8\u72b6\u6001\uff1a${task.status === 'completed' && verificationStatus === 'verified'
          ? '\u5df2\u5b8c\u6210\uff08\u6301\u4e45\u56de\u6267\u5df2\u9a8c\u8bc1\uff09'
          : formatConversationActionTaskStatus(state)}`,
      ].filter(Boolean).join('\n');
    }
  }
  const status = formatConversationActionTaskStatus(state);
  const asksForArtifactPath = /(?:产物|文件).{0,10}(?:路径|位置|在哪)|(?:路径|位置|在哪).{0,10}(?:产物|文件)|\b(?:artifact|file|output)\s+(?:path|location)\b|\bwhere\s+is\s+(?:the\s+)?(?:artifact|file|output)\b/iu.test(String(input.query || ''));
  if (!asksForArtifactPath || state.status !== 'completed' || !task) return status;

  const producerReceipt = [...(db.conversationActionReceipts as ConversationActionReceiptRow[])]
    .reverse()
    .find(receipt => (
      receipt.taskId === task.id
      && receipt.outcome === 'verified_success'
      && /^(?:write_file|create_docx|create_xlsx|create_ppt|create_pdf|modify_docx|modify_xlsx|cad_generate_dxf)$/i.test(receipt.toolName)
      && /(?:^[A-Za-z]:[\\/]|^\/).+\.[A-Za-z0-9]{1,12}$/u.test(receipt.targetIdentity)
    ));
  if (!producerReceipt) return status;
  return `${status}\n产物路径：${producerReceipt.targetIdentity}`;
}

export function migrateLegacyConversationActionLedger(db: any): number {
  ensureTables(db);
  let migrated = 0;
  for (const conversation of db.conversations || []) {
    const state = normalizeConversationActionState(conversation.actionContinuationState);
    if (!state?.taskId) continue;
    if ((db.conversationActionTasks as ConversationActionTaskRow[]).some(task => task.id === state.taskId)) continue;
    if (syncConversationActionTaskLedger(db, { conversation, state, now: state.updatedAt })) migrated += 1;
  }
  return migrated;
}

/**
 * One-version repair for terminal rows created before request-lease cleanup was
 * enforced at the normalization and ledger boundaries. Keep ordering
 * timestamps intact so a repair cannot make old work look newly completed.
 */
export function repairTerminalConversationActionTaskLeases(db: any): number {
  ensureTables(db);
  let repaired = 0;
  for (const task of db.conversationActionTasks as ConversationActionTaskRow[]) {
    if (task.conversationId.startsWith('scheduler:')) continue;
    if (!isTerminalConversationTaskStatus(task.status)) continue;
    const context = parseObject(task.context);
    const rawActionState = parseObject(context.actionState);
    if (!String(task.activeRequestId || '').trim() && !String(rawActionState.activeRequestId || '').trim()) continue;
    const actionState = normalizeConversationActionState({
      ...rawActionState,
      status: task.status,
      unfinished: false,
      activeRequestId: undefined,
    });
    task.activeRequestId = '';
    task.revision = Math.max(1, Number(task.revision) || 0) + 1;
    task.context = JSON.stringify({
      ...context,
      ...(actionState ? { actionState: sanitizeState(actionState) } : {}),
    });
    repaired += 1;
  }
  return repaired;
}

/**
 * Process-local request leases cannot survive a backend restart. Recover every
 * non-scheduler ledger row, including older rows hidden by a newer task. Hidden
 * rows keep their original ordering timestamp so recovery cannot steal the
 * conversation's current task pointer; the repair time remains in context.
 */
export function recoverConversationActionTaskLeases(
  db: any,
  now = new Date().toISOString(),
  options: {
    /** True only when startup hydration restored the exact one-time envelope. */
    hasExactPendingConfirmation?: (task: ConversationActionTaskRow) => boolean;
  } = {},
): number {
  ensureTables(db);
  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  let recovered = 0;

  for (const task of tasks) {
    if (task.conversationId.startsWith('scheduler:')) continue;
    if (!['planning', 'executing', 'verifying', 'waiting_confirmation'].includes(task.status)) continue;

    const hasNewerTask = tasks.some(candidate => (
      candidate.id !== task.id
      && candidate.conversationId === task.conversationId
      && candidate.userId === task.userId
      && candidate.createdAt.localeCompare(task.createdAt) > 0
    ));
    const previousStatus = task.status;
    if (
      previousStatus === 'waiting_confirmation'
      && options.hasExactPendingConfirmation?.(task)
    ) {
      // A hydrated encrypted envelope still owns this boundary. It has no
      // process-local executor lease to recover, so leave the task untouched.
      // In particular, do not reduce Windows DPAPI-backed restart behavior.
      continue;
    }
    const blocker = previousStatus === 'waiting_confirmation'
      ? RECONFIRMATION_REQUIRED_BLOCKER
      : 'The previous runtime ended before this task reached a terminal receipt.';
    const context = parseObject(task.context);
    const actionState = normalizeConversationActionState(context.actionState);
    const orderingTimestamp = hasNewerTask ? task.updatedAt : now;

    const conversation = (db.conversations || []).find((candidate: any) => (
      candidate.id === task.conversationId && candidate.userId === task.userId
    ));
    const recoverableState = actionState || conversationActionStateFromTask(task);
    if (conversation && recoverableState) {
      const finalized = finalizeConversationActionTask(db, {
        conversation,
        state: recoverableState,
        outcome: 'blocked',
        requestId: task.activeRequestId,
        blocker,
        now: orderingTimestamp,
        retainPendingAction: true,
        updateLivePointer: !hasNewerTask,
      });
      if (finalized) {
        const refreshedContext = parseObject(task.context);
        task.context = JSON.stringify({
          ...refreshedContext,
          executionLeaseRecovery: {
            recoveredAt: now,
            priorStatus: previousStatus,
            newerTaskAlreadyExists: hasNewerTask,
          },
        });
        recovered += 1;
        continue;
      }
    }

    // Legacy/malformed rows without their owning conversation cannot pass
    // through the foreground finalizer; keep this bounded migration fallback.
    task.status = 'blocked';
    task.blocker = blocker;
    task.activeRequestId = '';
    task.revision = Math.max(1, Number(task.revision) || 0) + 1;
    task.updatedAt = orderingTimestamp;
    task.context = JSON.stringify({
      ...context,
      executionLeaseRecovery: {
        recoveredAt: now,
        priorStatus: previousStatus,
        newerTaskAlreadyExists: hasNewerTask,
      },
      ...(actionState
        ? {
            actionState: sanitizeState({
              ...actionState,
              version: 2,
              status: 'blocked',
              unfinished: true,
              latestBlocker: blocker,
              activeRequestId: undefined,
              revision: Math.max(actionState.revision || 0, task.revision),
              updatedAt: orderingTimestamp,
            }),
          }
        : {}),
    });
    recovered += 1;
  }
  return recovered;
}

/**
 * One-version repair for receipts written by the former text-scanning
 * success detector. A verified structured result containing diagnostics such
 * as `failed: 0` could be persisted as a failure. Only contradictory rows
 * that already carry an explicit verified terminal decision are repaired.
 */
export function repairContradictoryConversationActionReceipts(db: any): number {
  ensureTables(db);
  let repaired = 0;
  const repairedRecords = new Map<string, ToolExecutionRecord[]>();
  for (const row of db.conversationActionReceipts as ConversationActionReceiptRow[]) {
    if (row.outcome !== 'failed') continue;
    const inspection = inspectPersistedToolExecutionReceipt(row);
    if (!inspection.valid || !inspection.explicitlyTerminalVerified) continue;
    const envelope = inspection.envelope!;
    const result = envelope.result as Record<string, any> | undefined;
    if (!result || typeof result !== 'object') continue;
    const record: ToolExecutionRecord = {
      taskId: row.taskId,
      turnId: row.turnId,
      requestId: row.requestId,
      idempotencyKey: row.idempotencyKey,
      name: row.toolName,
      arguments: envelope.toolName === 'client_action'
        ? {
            action: String(result.action || ''),
            target: String(result.target || row.targetIdentity || ''),
            ...(typeof result?.relayResult?.enabled === 'boolean'
              ? { enabled: result.relayResult.enabled }
              : {}),
          }
        : row.targetIdentity
          ? { target: row.targetIdentity }
          : {},
      result: JSON.stringify(result),
      receipt: result,
      terminalVerification: {
        status: 'verified',
        strategy: 'terminal_receipt',
        reason: String(envelope?.verification?.reason || 'Verified terminal receipt.'),
      },
    };
    if (!toolRecordSucceeded(record)) continue;
    row.outcome = 'verified_success';
    row.envelope = JSON.stringify({
      ...envelope,
      status: 'verified_success',
      error: undefined,
    });
    const records = repairedRecords.get(row.taskId) || [];
    records.push(record);
    repairedRecords.set(row.taskId, records);
    repaired += 1;
  }

  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  for (const [taskId, records] of repairedRecords) {
    const task = tasks.find(candidate => candidate.id === taskId);
    if (!task) continue;
    const context = parseObject(task.context);
    const state = normalizeConversationActionState(context.actionState);
    if (!state) continue;
    const receipts = mergeTaskReceipts(
      state.receipts || [],
      records,
      task.updatedAt,
    );
    const completion = taskCompletionFromReceipts(
      state.goal || task.goal,
      receipts,
      state.taskCapsule,
    );
    const status = completion.complete ? 'completed' : task.status;
    const nextState = normalizeConversationActionState({
      ...state,
      receipts,
      status,
      unfinished: !isTerminalConversationTaskStatus(status),
      latestBlocker: completion.complete ? '' : state.latestBlocker,
      activeRequestId: conversationTaskStatusOwnsExecutionLease(status)
        ? state.activeRequestId
        : undefined,
      completionSource: completion.complete ? 'tool_receipt' : state.completionSource,
      revision: Math.max(state.revision || 0, task.revision || 0) + 1,
      updatedAt: task.updatedAt,
    });
    if (nextState) context.actionState = sanitizeState(nextState);
    task.context = JSON.stringify(context);
    task.status = status;
    if (completion.complete) {
      task.blocker = '';
      task.activeRequestId = '';
      task.completionSource = 'tool_receipt';
      task.completedAt = task.completedAt || task.updatedAt;
    }
    task.revision = nextState?.revision || task.revision;
  }

  // Terminal and confirmation-waiting states cannot simultaneously carry a
  // live execution blocker. Older builds could leave the confirmation-denial
  // text behind after cancellation, which made the command-center widget show
  // a contradictory cancelled+error state. Repair those rows on bootstrap.
  for (const task of tasks) {
    if (!['completed', 'failed', 'cancelled', 'waiting_confirmation'].includes(task.status)) continue;
    if (!String(task.blocker || '').trim()) continue;
    const context = parseObject(task.context);
    const state = normalizeConversationActionState(context.actionState);
    if (state) {
      const nextState = normalizeConversationActionState({
        ...state,
        status: task.status,
        latestBlocker: '',
        unfinished: !isTerminalConversationTaskStatus(task.status),
      });
      if (nextState) context.actionState = sanitizeState(nextState);
      task.context = JSON.stringify(context);
    }
    task.blocker = '';
    repaired += 1;
  }
  return repaired;
}
