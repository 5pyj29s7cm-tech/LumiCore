import { flushDBOrThrow, readDB, writeDB } from '../../db_layer';
import { AsyncLocalStorage } from 'node:async_hooks';
import { estimateTokenCount } from '../llm/providers';
import {
  buildConversationActionContinuationState,
  classifyToolRecordTaskDurability,
  classifyConversationActionFollowupIntent,
  classifyRecentActionFollowupIntent,
  formatConversationActionTaskStatus,
  isUserObservedTaskCompletion,
  needsRecentActionContinuationContext,
  normalizeConversationActionState,
  prepareConversationActionTaskState,
  RECONFIRMATION_REQUIRED_BLOCKER,
  type ConversationActionContinuationState,
} from '../cognition/action_continuation';
import {
  conversationTaskStatusOwnsExecutionLease,
  isTerminalConversationTaskStatus,
  taskCompletionFromReceipts,
} from '../cognition/task_execution_ledger';
import { buildActionContract } from '../cognition/action_contract';
import { normalizeActionIntent } from '../cognition/normalized_action_intent';
import type { ToolPolicy } from '../personality/types';
import {
  isolateLegacyGuardSummaryState,
  isGuardGeneratedAssistantText,
  isGuardGeneratedConversationRecord,
} from './guard_history';
import {
  buildCompactToolEvidenceNote,
  isUnverifiedExecutionAssistantRecord,
  isUnverifiedExecutionAssistantText,
  sanitizeSummaryForPrompt,
} from './summary_grounding';
import { sanitizeToolRecordsForPersistence } from '../cognition/user_output_protection';
import { normalizeNativeRequestBinding } from '../devices/native_identity';
import { normalizeVoiceTurnProvenance } from '../socket/voice_provenance';
import {
  normalizeCompletionFeedbackForPersistence,
  type TaskCompletionFeedback,
} from './completion_feedback';
import {
  formatConversationActionLedgerStatus,
  attachConversationExecutionPlan,
  attachConversationModelExecutionGraph,
  loadConversationModelExecutionRecovery,
  migrateLegacyConversationActionLedger,
  recoverConversationActionTaskLeases,
  repairTerminalConversationActionTaskLeases,
  repairContradictoryConversationActionReceipts,
  compactLegacyScheduledCapabilityExecutions,
  archiveBoundConversationActionReceipts,
  finalizeConversationActionTask,
  getConversationActionStateByTaskId,
  getConversationActionStateFromLedger,
  syncConversationActionTaskLedger,
  type ConversationActionTerminalDisposition,
  type ConversationActionLiveProjection,
} from './action_ledger';
import type { CapabilityExecutionPlan } from '../cognition/capability_execution_plan';
import type { OrchestrationPrivateNodeHandoff, WorkflowResult } from '../agents/orchestrator';
import {
  hasVerifiedModelGraphNodeEvidence,
  reuseVerifiedModelGraphNodeReceipt,
  type ModelGraphNodeEvidenceKind,
} from '../agents/model_execution_graph';
import type {
  ModelExecutionGraph,
  ModelGraphArbitrationReceipt,
  ModelGraphNodeReceipt,
} from '../agents/model_execution_graph';
import {
  loadPrivateModelHandoff,
  persistPrivateModelHandoffs,
  PRIVATE_MODEL_HANDOFF_MAX_BATCH,
  PRIVATE_MODEL_HANDOFF_MAX_CHARS,
  type PrivateModelHandoffInput,
} from './private_model_handoff_store';
import {
  listConversationFocusThreads,
  updateConversationFocusThread,
  type ConversationFocusThread,
} from './focus_threads';
import {
  acceptConversationActionTurn,
  acquireConversationActionTurnLease,
  bindConversationActionTurnTask,
  finalizeConversationActionTurn,
  getConversationActionTurn,
  listConversationActionTurns,
  quarantineConversationActionTurnPersistenceInDb,
  reconcileConversationActionTurnLease,
  reconcileConversationActionTurnLeases,
  releaseConversationActionTurnLease,
  type ConversationActionTurn,
} from './action_turn_ledger';
import {
  buildTransportNeutralConfirmationScope,
  getPendingConfirmation,
} from '../tools/pending_confirmation';
import { partitionConversationReceiptsByOwnership } from './receipt_ownership';

function hasExactPendingConfirmationForTask(input: {
  id: string;
  conversationId: string;
  userId: string;
  domain?: string;
  orgId?: string;
}): boolean {
  if (!input.id || !input.conversationId || !input.userId) return false;
  return Boolean(getPendingConfirmation(
    input.userId,
    buildTransportNeutralConfirmationScope({
      domain: input.domain,
      orgId: input.orgId,
      conversationId: input.conversationId,
      taskId: input.id,
    }),
  ));
}

export function getConversationFocusThreads(input: {
  userId: string;
  domain?: string;
  orgId?: string;
  includeTerminal?: boolean;
}): ConversationFocusThread[] {
  return listConversationFocusThreads(readDB(), input);
}

export function updateConversationActionFocus(input: {
  taskId: string;
  userId: string;
  domain?: string;
  orgId?: string;
  commitment?: string;
  nextAction?: string;
  waitingFor?: string;
  interruption?: string;
  resumePoint?: string;
  dueAt?: string;
}): ConversationFocusThread | null {
  const db = readDB();
  const focus = updateConversationFocusThread(db, input);
  if (focus) writeDB(db);
  return focus;
}

export function getConversationActionStatus(
  conversationId: string,
  userId: string,
  query = '',
  fallbackState?: ConversationActionContinuationState | null,
): string {
  const db = readDB();
  return formatConversationActionLedgerStatus(db, { conversationId, userId, query })
    || formatConversationActionTaskStatus(fallbackState);
}

function hydrateConversationActionState(
  db: any,
  conversation: Conversation,
  query = '',
): ConversationActionContinuationState | null {
  const existing = normalizeConversationActionState(conversation.actionContinuationState);
  const resolveHistoricalTask = Boolean(
    query.trim() && needsRecentActionContinuationContext(query),
  );
  const ledgerState = getConversationActionStateFromLedger(db, {
    conversationId: conversation.id,
    userId: conversation.userId,
    query: resolveHistoricalTask ? query : '',
  });
  const exactExistingLedgerState = existing?.taskId
    ? getConversationActionStateByTaskId(db, {
        conversationId: conversation.id,
        userId: conversation.userId,
        taskId: existing.taskId,
      })
    : null;
  const exactLedgerUpdatedAt = exactExistingLedgerState
    ? Date.parse(exactExistingLedgerState.updatedAt)
    : Number.NaN;
  const rawExistingUpdatedAt = existing ? Date.parse(existing.updatedAt) : Number.NaN;
  const authoritativeExisting = exactExistingLedgerState
    && Number.isFinite(exactLedgerUpdatedAt)
    && (!Number.isFinite(rawExistingUpdatedAt) || exactLedgerUpdatedAt >= rawExistingUpdatedAt)
    ? exactExistingLedgerState
    : existing;
  const existingLive = authoritativeExisting?.unfinished ? authoritativeExisting : null;
  const ledgerLive = ledgerState?.unfinished ? ledgerState : null;
  const existingUpdatedAt = existingLive ? Date.parse(existingLive.updatedAt) : Number.NaN;
  const ledgerUpdatedAt = ledgerLive ? Date.parse(ledgerLive.updatedAt) : Number.NaN;
  const state = existingLive && ledgerLive
    ? existingLive.taskId === ledgerLive.taskId
      && Number.isFinite(ledgerUpdatedAt)
      && (!Number.isFinite(existingUpdatedAt) || ledgerUpdatedAt > existingUpdatedAt)
        ? ledgerLive
        : existingLive
    : existingLive || ledgerLive;
  // Historical and terminal projections live only in the durable ledger.
  // A query may influence which unfinished ledger row is selected, but it may
  // never repopulate the conversation's live pointer with completed work.
  if (state) conversation.actionContinuationState = state;
  else delete conversation.actionContinuationState;
  return state;
}

function shouldDetachUnrelatedActionState(
  state: ConversationActionContinuationState | null | undefined,
  userText: string,
): boolean {
  const current = normalizeConversationActionState(state);
  if (
    !current?.unfinished
    || !['blocked', 'waiting_confirmation'].includes(current.status || '')
  ) return false;
  return classifyConversationActionFollowupIntent(userText, current) === 'none';
}

/**
 * A blocked/confirmation-waiting task stays in the durable ledger for audit,
 * but must stop being the conversation's live pointer once the user clearly
 * starts an unrelated turn. Keeping that pointer live caused later model,
 * screen and biometric questions to inherit the older task id.
 */
function detachUnrelatedConversationActionState(
  db: any,
  conversation: Conversation,
  userText: string,
  now: string,
): boolean {
  const previous = normalizeConversationActionState(conversation.actionContinuationState);
  if (!previous || !shouldDetachUnrelatedActionState(previous, userText)) return false;
  return Boolean(finalizeConversationActionTask(db, {
    conversation,
    state: previous,
    outcome: 'cancelled',
    assistantState: 'Detached because the user started an unrelated turn.',
    now,
  }));
}

export interface Conversation {
  id: string;
  userId: string;
  agentId: string;
  title: string;
  status: 'active' | 'paused' | 'closed';
  mode?: string;  // Conversation mode: casual, teaching, brainstorm, executive
  summary: string;
  /** Multi-level summary chain: [oldest, middle, newest]. Max 3 entries. */
  summaryChain?: string[];
  /** Number of stored messages covered by the newest successfully persisted summary. */
  lastSummaryMessageCount?: number;
  messageCount: number;
  lastActiveAt: string;
  createdAt: string;
  /** Recent topic tags — tracked for cross-session continuity */
  recentTopics?: string[];
  /** ISO timestamp of the last topic change */
  lastTopicChangeAt?: string;
  /** Domain: personal or work */
  domain?: string;
  /** orgId when in work domain */
  orgId?: string;
  /** Runtime compatibility projection; durable state lives in conversation_action_tasks/receipts. */
  actionContinuationState?: ConversationActionContinuationState;
  /** Latest user turn waiting for its terminal assistant/tool record. */
  pendingActionContinuation?: {
    userText: string;
    messageId: string;
    requestId?: string;
    updatedAt: string;
  };
}

export interface MessageRecord {
  id: string;
  userId: string;
  agentId?: string;
  conversationId?: string;
  module?: string;
  message: string;
  response?: string;
  role: string;
  personality?: string;
  mode?: string;
  toolCalls?: any[];
  /** Server-derived receipt evidence retained after prompt compaction removes raw tool calls. */
  toolReceiptLedger?: string;
  domain?: string;
  orgId?: string;
  source?: string;
  channel?: string;
  cognitiveIntent?: string;
  llmWasCalled?: boolean;
  /** Provider message identity used to keep asynchronous remote turns ordered. */
  externalMessageId?: string;
  /** Monotonic sequence within one external conversation. */
  routeSequence?: number;
  /** Time the remote transport received the message. */
  receivedAt?: string;
  /** Stable request identity for one local/socket turn. */
  requestId?: string;
  /** Proof-bound native request provenance; absent on web/remote/harness turns. */
  nativeDeviceId?: string;
  executionSessionId?: string;
  nativeClientIdentitySha256?: string;
  audioInputKind?: 'physical_microphone' | 'synthetic_accepted_transcript' | '';
  syntheticAudio?: boolean;
  captureSessionId?: string;
  sttReceiptId?: string;
  contextChainId?: string;
  previousRequestId?: string;
  /** Structured model/runtime classification for durable task ownership. */
  taskIntent?: 'task' | 'conversation' | '';
  /** Bounded, allowlisted task outcome summary shown after history reload. */
  completionFeedback?: TaskCompletionFeedback;
  timestamp: string;
}

function isolateConversationSummaryForUse(conv: Conversation): boolean {
  const isolated = isolateLegacyGuardSummaryState({
    summary: conv.summary,
    summaryChain: conv.summaryChain,
    lastSummaryMessageCount: conv.lastSummaryMessageCount,
  });
  if (!isolated.changed) return false;
  conv.summary = isolated.summary;
  conv.summaryChain = isolated.summaryChain;
  conv.lastSummaryMessageCount = isolated.lastSummaryMessageCount;
  return true;
}

function resolveConversationScope(domainOrOrgId?: string, orgIdMaybe?: string): { domain: string; orgId: string } {
  if (domainOrOrgId === 'personal') return { domain: 'personal', orgId: '' };
  if (domainOrOrgId === 'work') return { domain: 'work', orgId: orgIdMaybe || '' };
  return {
    domain: domainOrOrgId ? 'work' : 'personal',
    orgId: domainOrOrgId || '',
  };
}

export interface ConversationTurnOptions {
  /** Current user text, used to avoid a soft rollover during a referential follow-up. */
  userText?: string;
  /** Test/diagnostic override. Production defaults to CONVERSATION_ROLLOVER_MESSAGE_LIMIT or 240. */
  messageLimit?: number;
  /** Bind this turn to the conversation selected by the client. */
  conversationId?: string;
}

export interface ConversationTurnResult {
  conversation: Conversation;
  rolledOver: boolean;
  previousConversationId?: string;
}

function conversationMatchesScope(c: Conversation, domainOrOrgId?: string, orgIdMaybe?: string): boolean {
  const scope = resolveConversationScope(domainOrOrgId, orgIdMaybe);
  if (scope.domain === 'work') {
    return !!scope.orgId && c.orgId === scope.orgId;
  }
  return !c.orgId || c.orgId === '';
}

export function getConversationForScope(
  conversationId: string,
  userId: string,
  domain?: string,
  orgId?: string,
): Conversation | null {
  const db = readDB();
  const conversation = (db.conversations || []).find((item: Conversation) => item.id === conversationId);
  if (!conversation || conversation.userId !== userId) return null;
  if (!conversationMatchesScope(conversation, domain, orgId)) return null;
  hydrateConversationActionState(db, conversation);
  if (isolateConversationSummaryForUse(conversation)) writeDB(db);
  return conversation;
}

export function getOrCreateActiveConversation(userId: string, agentId?: string, domain?: string, orgId?: string): Conversation {
  const db = readDB();
  if (!db.conversations) db.conversations = [];
  const scope = resolveConversationScope(domain, orgId);

  const active = db.conversations
    .filter((c: Conversation) =>
      c.userId === userId &&
      c.agentId === (agentId || '') &&
      c.status === 'active' &&
      conversationMatchesScope(c, scope.domain, scope.orgId)
    )
    .sort((a: Conversation, b: Conversation) =>
      new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
    )[0];
  if (active) {
    hydrateConversationActionState(db, active);
    if (isolateConversationSummaryForUse(active)) writeDB(db);
    return active;
  }

  const id = 'conv_' + crypto.randomUUID();
  const now = new Date().toISOString();
  const conv: Conversation = {
    id,
    userId,
    agentId: agentId || '',
    title: '',
    status: 'active',
    summary: '',
    summaryChain: [],
    lastSummaryMessageCount: 0,
    messageCount: 0,
    lastActiveAt: now,
    createdAt: now,
    domain: scope.domain,
    orgId: scope.orgId,
  };
  db.conversations.push(conv);
  writeDB(db);
  return conv;
}

/**
 * Start an empty active conversation without deleting the archived transcript or
 * its durable task ledger. In-flight work may finish against the archived
 * conversation while later chat turns are isolated in the new conversation.
 */
export function startNewConversation(userId: string, agentId?: string, domain?: string, orgId?: string): Conversation {
  const db = readDB();
  if (!db.conversations) db.conversations = [];
  const scope = resolveConversationScope(domain, orgId);
  const now = new Date().toISOString();

  for (const conversation of db.conversations as Conversation[]) {
    if (
      conversation.userId === userId
      && conversation.agentId === (agentId || '')
      && conversation.status === 'active'
      && conversationMatchesScope(conversation, scope.domain, scope.orgId)
          ) {
      conversation.status = 'closed';
      conversation.lastActiveAt = now;
    }
  }

  const conversation: Conversation = {
    id: 'conv_' + crypto.randomUUID(),
    userId,
    agentId: agentId || '',
    title: '',
    status: 'active',
    summary: '',
    summaryChain: [],
    lastSummaryMessageCount: 0,
    messageCount: 0,
    lastActiveAt: now,
    createdAt: now,
    domain: scope.domain,
    orgId: scope.orgId,
  };
  db.conversations.push(conversation);
  writeDB(db);
  return conversation;
}

/**
 * Create an explicitly-bound conversation without changing the user's active
 * conversation. Formal E2E and other diagnostic callers must always send the
 * returned conversationId; the closed status keeps it out of normal active
 * conversation selection while still allowing bound turns to run.
 */
export function startIsolatedConversation(userId: string, agentId?: string, domain?: string, orgId?: string): Conversation {
  const db = readDB();
  if (!db.conversations) db.conversations = [];
  const scope = resolveConversationScope(domain, orgId);
  const now = new Date().toISOString();
  const conversation: Conversation = {
    id: 'conv_' + crypto.randomUUID(),
    userId,
    agentId: agentId || '',
    title: '',
    status: 'closed',
    summary: '',
    summaryChain: [],
    lastSummaryMessageCount: 0,
    messageCount: 0,
    lastActiveAt: now,
    createdAt: now,
    domain: scope.domain,
    orgId: scope.orgId,
  };
  db.conversations.push(conversation);
  writeDB(db);
  return conversation;
}

export interface DeletedConversationData {
  conversationId: string;
  interactions: number;
  actionTasks: number;
  actionTurns: number;
  actionReceipts: number;
  routingReceipts: number;
  backgroundTasks: number;
}

/** Delete only records carrying the exact, already-authorized conversation id. */
export function deleteConversationData(
  conversationId: string,
  userId: string,
  domain?: string,
  orgId?: string,
): DeletedConversationData | null {
  const db = readDB();
  const conversation = (db.conversations || []).find((candidate: Conversation) => (
    candidate.id === conversationId
    && candidate.userId === userId
    && conversationMatchesScope(candidate, domain, orgId)
  ));
  if (!conversation) return null;

  const before = {
    interactions: (db.interactions || []).length,
    actionTasks: (db.conversationActionTasks || []).length,
    actionTurns: (db.conversationActionTurns || []).length,
    actionReceipts: (db.conversationActionReceipts || []).length,
    routingReceipts: (db.modelRoutingReceipts || []).length,
    backgroundTasks: (db.backgroundDelegationTasks || []).length,
  };
  const ownedTaskIds = new Set(
    (db.conversationActionTasks || [])
      .filter((row: any) => row.conversationId === conversationId)
      .map((row: any) => String(row.id || ''))
      .filter(Boolean),
  );

  db.conversations = (db.conversations || []).filter((row: Conversation) => row.id !== conversationId);
  db.interactions = (db.interactions || []).filter((row: any) => row.conversationId !== conversationId);
  db.conversationActionTasks = (db.conversationActionTasks || [])
    .filter((row: any) => row.conversationId !== conversationId);
  db.conversationActionTurns = (db.conversationActionTurns || [])
    .filter((row: any) => row.conversationId !== conversationId);
  db.conversationActionReceipts = (db.conversationActionReceipts || [])
    .filter((row: any) => row.conversationId !== conversationId && !ownedTaskIds.has(String(row.taskId || '')));
  db.modelRoutingReceipts = (db.modelRoutingReceipts || [])
    .filter((row: any) => row.conversationId !== conversationId);
  db.backgroundDelegationTasks = (db.backgroundDelegationTasks || [])
    .filter((row: any) => row.conversationId !== conversationId && row.context?.conversationId !== conversationId);
  writeDB(db);

  return {
    conversationId,
    interactions: before.interactions - db.interactions.length,
    actionTasks: before.actionTasks - db.conversationActionTasks.length,
    actionTurns: before.actionTurns - db.conversationActionTurns.length,
    actionReceipts: before.actionReceipts - db.conversationActionReceipts.length,
    routingReceipts: before.routingReceipts - db.modelRoutingReceipts.length,
    backgroundTasks: before.backgroundTasks - db.backgroundDelegationTasks.length,
  };
}

const DEFAULT_CONVERSATION_ROLLOVER_MESSAGE_LIMIT = 240;

function resolveConversationRolloverMessageLimit(override?: number): number {
  const configured = override ?? Number.parseInt(
    process.env.CONVERSATION_ROLLOVER_MESSAGE_LIMIT || '',
    10,
  );
  if (!Number.isFinite(configured)) return DEFAULT_CONVERSATION_ROLLOVER_MESSAGE_LIMIT;
  return Math.max(4, Math.floor(configured));
}

/**
 * Decide whether a completed conversation segment should be archived before
 * accepting a new user turn. Referential follow-ups get one extra segment so
 * a natural "continue" is not separated from the action it refers to. The hard
 * limit still prevents an indefinitely reused thread.
 */
export function shouldRolloverConversationForTurn(
  conversation: Conversation,
  userText = '',
  messageLimit?: number,
): boolean {
  const limit = resolveConversationRolloverMessageLimit(messageLimit);
  const count = Math.max(0, Math.floor(Number(conversation.messageCount) || 0));
  if (count < limit) return false;

  // A user turn without a terminal assistant record is still in flight. Never
  // split that turn merely because it crossed the message threshold.
  if (conversation.pendingActionContinuation) return false;

  const hardLimit = Math.max(limit + 1, limit * 2);
  if (count >= hardLimit) return true;

  return !needsRecentActionContinuationContext(String(userText || '').trim());
}

function compactRolloverText(value: unknown, limit: number): string {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return clean.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
}

function buildRolloverTranscriptTail(conversationId: string): string[] {
  const lines: string[] = [];
  const recent = getMessages(conversationId, 18)
    .filter(isPromptEligibleMessage)
    .filter(record => !isUnverifiedExecutionAssistantRecord(record))
    .slice(-10);

  for (const record of recent) {
    const message = compactRolloverText(record.message, 360);
    const response = compactRolloverText(record.response, 360);
    if (record.role === 'user') {
      if (message) lines.push(`User: ${message}`);
      // Legacy rows sometimes stored both sides of a turn in one user record.
      if (response && !isGuardGeneratedAssistantText(response) && !isUnverifiedExecutionAssistantText(response)) lines.push(`Lumi: ${response}`);
    } else if (record.role === 'assistant' && message) {
      lines.push(`Lumi: ${message}`);
    }
  }

  return lines.slice(-10);
}

function buildConversationRolloverSummary(conversation: Conversation): string {
  const priorParts: string[] = [];
  if (conversation.summary && !isStandaloneGuardOutput(conversation.summary)) {
    const safe = sanitizeSummaryForPrompt(conversation.summary);
    if (safe) priorParts.push(compactRolloverText(safe, 1800));
  }
  if (conversation.summaryChain?.length) {
    const older = conversation.summaryChain
      .filter(summary => !isStandaloneGuardOutput(summary))
      .map(summary => compactRolloverText(sanitizeSummaryForPrompt(summary), 700))
      .filter(Boolean)
      .join(' | ');
    if (older) priorParts.push(`Earlier context: ${compactRolloverText(older, 1200)}`);
  }

  const recentLines = buildRolloverTranscriptTail(conversation.id);
  return [
    `Conversation continuity snapshot from an archived segment (${conversation.messageCount || 0} stored messages).`,
    priorParts.length ? `Durable summary:\n${priorParts.join('\n')}` : '',
    recentLines.length ? `Recent conversational context:\n${recentLines.join('\n')}` : '',
    'Continuity boundary: treat this only as conversational background. Do not infer or claim that any prior tool run, pending confirmation, background job, or unfinished action remains active. Resume prior work only when the current user explicitly asks.',
  ].filter(Boolean).join('\n\n');
}

/**
 * Acquire the conversation for one new user turn, rolling over an oversized
 * segment when safe. The compact continuity snapshot is stored as the new
 * segment's summary, so chat and voice share the same restart-safe context.
 */
export function getOrCreateConversationForTurn(
  userId: string,
  agentId?: string,
  domain?: string,
  orgId?: string,
  options: ConversationTurnOptions = {},
): ConversationTurnResult {
  const requestedConversationId = String(options.conversationId || '').trim();
  const requestedConversation = requestedConversationId
    ? getConversationForScope(requestedConversationId, userId, domain, orgId)
    : null;
  if (requestedConversationId && (!requestedConversation || requestedConversation.agentId !== (agentId || ''))) {
    throw new Error('Conversation is unavailable for this user, agent, or workspace');
  }
  const current = requestedConversation || getOrCreateActiveConversation(userId, agentId, domain, orgId);
  // An explicitly bound in-flight turn is allowed to finish after the user has
  // opened a new conversation. Never roll that archived transcript into the new one.
  if (requestedConversation && requestedConversation.status !== 'active') {
    return { conversation: requestedConversation, rolledOver: false };
  }
  if (!shouldRolloverConversationForTurn(current, options.userText, options.messageLimit)) {
    return { conversation: current, rolledOver: false };
  }

  const db = readDB();
  if (!db.conversations) return { conversation: current, rolledOver: false };
  const active = db.conversations.find((conversation: Conversation) =>
    conversation.id === current.id
    && conversation.userId === userId
    && conversation.status === 'active'
  );
  if (
    !active
    || !conversationMatchesScope(active, domain, orgId)
    || !shouldRolloverConversationForTurn(active, options.userText, options.messageLimit)
  ) {
    const selected = active || current;
    hydrateConversationActionState(db, selected);
    return { conversation: selected, rolledOver: false };
  }

  const now = new Date().toISOString();
  const continuitySummary = buildConversationRolloverSummary(active);
  active.status = 'closed';
  active.summary = continuitySummary;
  active.lastSummaryMessageCount = Math.max(0, active.messageCount || 0);
  active.lastActiveAt = now;
  delete active.pendingActionContinuation;

  const next: Conversation = {
    id: 'conv_' + crypto.randomUUID(),
    userId,
    agentId: agentId || '',
    title: '',
    status: 'active',
    mode: active.mode,
    summary: continuitySummary,
    summaryChain: [],
    lastSummaryMessageCount: 0,
    messageCount: 0,
    lastActiveAt: now,
    createdAt: now,
    recentTopics: active.recentTopics ? [...active.recentTopics] : undefined,
    lastTopicChangeAt: active.lastTopicChangeAt,
    domain: resolveConversationScope(domain, orgId).domain,
    orgId: resolveConversationScope(domain, orgId).orgId,
  };
  db.conversations.push(next);
  writeDB(db);

  return {
    conversation: next,
    rolledOver: true,
    previousConversationId: active.id,
  };
}

export function closeConversation(conversationId: string, summary?: string, userId?: string): Conversation | null {
  const db = readDB();
  if (!db.conversations) return null;
  const conv = db.conversations.find((c: Conversation) => c.id === conversationId);
  if (!conv) return null;
  if (userId && conv.userId !== userId) return null;
  const closingRequestId = String(
    conv.actionContinuationState?.activeRequestId
    || conv.pendingActionContinuation?.requestId
    || '',
  );
  const now = new Date().toISOString();
  cancelManagerActionTurns({
    conversationId: conv.id,
    userId: conv.userId,
    reason: 'Conversation closed before the request reached a terminal result.',
    now,
  });
  const previous = normalizeConversationActionState(conv.actionContinuationState);
  if (previous?.unfinished) {
    finalizeConversationActionTask(db, {
      conversation: conv,
      state: previous,
      outcome: 'cancelled',
      requestId: closingRequestId,
      assistantState: 'Conversation closed by the user.',
      now,
    });
  } else if (closingRequestId) {
    finalizeConversationActionRequestInDb(db, conv, closingRequestId, {
      fallbackBlocker: 'The conversation was closed before the request reached a verified terminal result.',
      now,
    });
  }
  delete conv.pendingActionContinuation;
  conv.status = 'closed';
  conv.summary = summary || '';
  conv.lastActiveAt = now;
  writeDB(db);
  return conv;
}

export function getActiveConversation(userId: string, agentId?: string, domainOrOrgId?: string, orgIdMaybe?: string): Conversation | null {
  const db = readDB();
  if (!db.conversations) return null;
  const active = db.conversations
    .filter((c: Conversation) => {
      if (c.userId !== userId) return false;
      if (agentId && c.agentId !== agentId) return false;
      if (c.status !== 'active') return false;
      return conversationMatchesScope(c, domainOrOrgId, orgIdMaybe);
    })
    .sort((a: Conversation, b: Conversation) =>
      new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
    )[0] || null;
  if (active) hydrateConversationActionState(db, active);
  if (active && isolateConversationSummaryForUse(active)) writeDB(db);
  return active;
}

export function setConversationMode(conversationId: string, mode: string): void {
  const db = readDB();
  if (!db.conversations) return;
  const conv = db.conversations.find((c: Conversation) => c.id === conversationId);
  if (!conv) return;
  conv.mode = mode;
  conv.lastActiveAt = new Date().toISOString();
  writeDB(db);
}

export function getUserConversations(
  userId: string,
  limit = 20,
  offset = 0,
  domainOrOrgId?: string,
  orgIdMaybe?: string,
  agentId?: string,
): Conversation[] {
  const db = readDB();
  if (!db.conversations) return [];
  const conversations = db.conversations
    .filter((c: Conversation) => {
      if (c.userId !== userId) return false;
      if (agentId && c.agentId !== agentId) return false;
      return conversationMatchesScope(c, domainOrOrgId, orgIdMaybe);
    })
    .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
    .slice(offset, offset + limit);
  let summaryWasIsolated = false;
  for (const conversation of conversations) {
    hydrateConversationActionState(db, conversation);
    if (isolateConversationSummaryForUse(conversation)) summaryWasIsolated = true;
  }
  if (summaryWasIsolated) writeDB(db);
  return conversations;
}

export function activateConversation(
  conversationId: string,
  userId: string,
  agentId: string,
  domainOrOrgId?: string,
  orgIdMaybe?: string,
): Conversation | null {
  const db = readDB();
  if (!db.conversations) return null;
  const target = db.conversations.find((conversation: Conversation) => (
    conversation.id === conversationId
    && conversation.userId === userId
    && conversation.agentId === agentId
    && conversationMatchesScope(conversation, domainOrOrgId, orgIdMaybe)
  ));
  if (!target) return null;

  const now = new Date().toISOString();
  for (const conversation of db.conversations as Conversation[]) {
    if (
      conversation.id !== target.id
      && conversation.userId === userId
      && conversation.agentId === agentId
      && conversation.status === 'active'
      && conversationMatchesScope(conversation, domainOrOrgId, orgIdMaybe)
    ) {
      conversation.status = 'closed';
      conversation.lastActiveAt = now;
    }
  }
  target.status = 'active';
  target.lastActiveAt = now;
  hydrateConversationActionState(db, target);
  writeDB(db);
  return target;
}

export interface BindConversationActionExecutionTurnInput {
  conversationId: string;
  userId: string;
  userText: string;
  requestId: string;
  /** Exact persisted user transcript row that owns this request. */
  userMessageId: string;
  preserveExistingTask?: boolean;
}

export interface BoundConversationActionExecutionTurn {
  conversationId: string;
  messageId: string;
  requestId: string;
  leaseOwnerId: string;
  updatedAt: string;
}

export const CONVERSATION_ACTION_EXECUTION_LEASE_TTL_MS = 5 * 60 * 1_000;
export const CONVERSATION_ACTION_EXECUTION_HEARTBEAT_INTERVAL_MS = Math.floor(
  CONVERSATION_ACTION_EXECUTION_LEASE_TTL_MS / 3,
);

interface ManagerActionTurnLease {
  ownerId: string;
  prepared: boolean;
  /** Executor fenced by this lease, aborted if an expired owner is recovered. */
  abortController?: AbortController;
}

const managerActionTurnLeases = new Map<string, ManagerActionTurnLease>();
const managerActionTurnHeartbeatStops = new Map<string, () => void>();

export interface ConversationTerminalPersistenceUnknownProjection {
  text: string;
  completionFeedback?: unknown;
  reason?: string;
}

interface StagedConversationTerminalTurn {
  conversationId: string;
  userId: string;
  requestId: string;
  assistantMessageId: string;
  desiredStatus: 'terminal' | 'cancelled';
  reason: string;
  now?: string;
}

export interface ConversationTerminalDurabilityStage {
  turns: Map<string, StagedConversationTerminalTurn>;
  settled: boolean;
}

const conversationTerminalDurabilityStorage = new AsyncLocalStorage<ConversationTerminalDurabilityStage>();

export function runWithConversationTerminalDurabilityStage<T>(
  operation: (stage: ConversationTerminalDurabilityStage) => Promise<T>,
): Promise<T> {
  const stage: ConversationTerminalDurabilityStage = {
    turns: new Map(),
    settled: false,
  };
  return conversationTerminalDurabilityStorage.run(stage, () => operation(stage));
}

function stageConversationTerminalTurn(input: StagedConversationTerminalTurn): boolean {
  const stage = conversationTerminalDurabilityStorage.getStore();
  if (!stage || stage.settled) return false;
  const key = managerActionTurnKey(input);
  const previous = stage.turns.get(key);
  stage.turns.set(key, {
    ...previous,
    ...input,
    assistantMessageId: input.assistantMessageId || previous?.assistantMessageId || '',
    desiredStatus: input.desiredStatus === 'cancelled' || previous?.desiredStatus === 'cancelled'
      ? 'cancelled'
      : 'terminal',
    reason: input.reason || previous?.reason || '',
    now: input.now || previous?.now,
  });
  return true;
}

function stopManagerActionTurnHeartbeat(input: {
  conversationId: string;
  userId: string;
  requestId: string;
}): void {
  managerActionTurnHeartbeatStops.get(managerActionTurnKey(input))?.();
}

function managerActionTurnKey(input: {
  conversationId: string;
  userId: string;
  requestId: string;
}): string {
  return JSON.stringify([input.conversationId, input.userId, input.requestId]);
}

/**
 * Drop a process-local owner only after the durable lease no longer proves
 * that it owns this request. Keeping an expired map entry made an idempotent
 * retry return `busy` forever even though the durable TTL had recovered.
 */
function reconcileManagerActionTurnLeaseOwner(input: {
  conversationId: string;
  userId: string;
  requestId: string;
}): ManagerActionTurnLease | undefined {
  const key = managerActionTurnKey(input);
  const managerLease = managerActionTurnLeases.get(key);
  if (!managerLease) return undefined;
  const durableTurn = getConversationActionTurn(input);
  if (
    durableTurn?.status === 'leased'
    && durableTurn.leaseOwnerId === managerLease.ownerId
  ) return managerLease;

  if (managerLease.abortController && !managerLease.abortController.signal.aborted) {
    managerLease.abortController.abort(new Error(
      'Conversation action execution lease expired or lost ownership',
    ));
  }
  stopManagerActionTurnHeartbeat(input);
  managerActionTurnLeases.delete(key);
  return undefined;
}

function acquireManagerActionTurnLease(input: {
  conversationId: string;
  userId: string;
  requestId: string;
  reuseExistingLease: boolean;
}): { acquired: true; ownerId: string } | { acquired: false; reason: 'busy' | 'stale' } {
  const key = managerActionTurnKey(input);
  // Recover the durable TTL first, then discard only a map owner that no
  // longer matches it. The inverse order lets an expired in-memory entry act
  // as an unbounded busy lock.
  const recoveredDurableLeases = reconcileConversationActionTurnLeases();
  for (const recovered of recoveredDurableLeases.turns) {
    reconcileManagerActionTurnLeaseOwner(recovered);
  }
  const existingManagerLease = reconcileManagerActionTurnLeaseOwner(input);
  if (!input.reuseExistingLease && existingManagerLease) {
    return { acquired: false, reason: 'busy' };
  }
  if (input.reuseExistingLease && existingManagerLease?.prepared) {
    return { acquired: false, reason: 'busy' };
  }

  // The database is process-exclusive. Durable recovery above runs
  // synchronously before enforcing one live request per thread.
  const competing = listConversationActionTurns({
    conversationId: input.conversationId,
    userId: input.userId,
    statuses: ['leased'],
  }).find(turn => turn.requestId !== input.requestId);
  if (competing) return { acquired: false, reason: 'busy' };

  const turn = getConversationActionTurn(input);
  if (!turn) return { acquired: false, reason: 'stale' };
  if (!input.reuseExistingLease && turn.status === 'leased') {
    return { acquired: false, reason: 'busy' };
  }

  const ownerId = existingManagerLease?.ownerId || `manager:${crypto.randomUUID()}`;
  const acquired = acquireConversationActionTurnLease({
    ...input,
    leaseOwnerId: ownerId,
    ttlMs: CONVERSATION_ACTION_EXECUTION_LEASE_TTL_MS,
  });
  if (acquired.acquired === false) {
    return {
      acquired: false,
      reason: acquired.reason === 'not_found' || acquired.reason === 'terminal' ? 'stale' : 'busy',
    };
  }
  managerActionTurnLeases.set(key, {
    ownerId,
    prepared: input.reuseExistingLease,
  });
  return { acquired: true, ownerId };
}

function releaseManagerActionTurnLease(input: {
  conversationId: string;
  userId: string;
  requestId: string;
  reason: string;
}): void {
  const key = managerActionTurnKey(input);
  stopManagerActionTurnHeartbeat(input);
  const managerLease = managerActionTurnLeases.get(key);
  const turn = getConversationActionTurn(input);
  if (managerLease && turn?.status === 'leased') {
    releaseConversationActionTurnLease({
      ...input,
      leaseOwnerId: managerLease.ownerId,
    });
  } else if (turn?.status === 'leased') {
    // The executor is exiting but its in-process owner token is unavailable.
    // Fence replay until durable transcript/task reconciliation proves safety.
    reconcileConversationActionTurnLease({
      ...input,
      observedStatus: 'persistence_unknown',
      reason: input.reason,
    });
  }
  managerActionTurnLeases.delete(key);
}

function finalizeManagerActionTurnFromAssistant(input: {
  conversationId: string;
  userId: string;
  requestId: string;
  assistantMessageId: string;
  reason?: string;
  now?: string;
}): void {
  if (stageConversationTerminalTurn({
    ...input,
    desiredStatus: 'terminal',
    reason: input.reason || 'assistant transcript staged behind strict durability fence',
  })) return;
  finalizeManagerActionTurnFromAssistantImmediately(input);
}

function finalizeManagerActionTurnFromAssistantImmediately(input: {
  conversationId: string;
  userId: string;
  requestId: string;
  assistantMessageId: string;
  reason?: string;
  now?: string;
}): void {
  stopManagerActionTurnHeartbeat(input);
  finalizeConversationActionTurn({
    conversationId: input.conversationId,
    userId: input.userId,
    requestId: input.requestId,
    status: 'terminal',
    terminalMessageId: input.assistantMessageId,
    reason: input.reason || 'assistant transcript persisted',
    force: true,
    now: input.now,
  });
  managerActionTurnLeases.delete(managerActionTurnKey(input));
}

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

function parsePersistedObject(value: unknown): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : {};
  } catch {
    return {};
  }
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
  const db = readDB();
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
  if (quarantined > 0) writeDB(db);
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
  finalizeManagerActionTurnFromAssistant({
    conversationId: input.conversationId,
    userId: input.userId,
    requestId: input.requestId,
    assistantMessageId: input.assistantMessageId,
    reason: taskOutcome ? `task_outcome:${taskOutcome}` : undefined,
    now: input.now,
  });
}

function cancelManagerActionTurns(input: {
  conversationId: string;
  userId: string;
  requestId?: string;
  reason: string;
  now?: string;
}): number {
  const candidates = listConversationActionTurns({
    conversationId: input.conversationId,
    userId: input.userId,
    statuses: ['accepted', 'leased', 'persistence_unknown'],
  }).filter(turn => !input.requestId || turn.requestId === input.requestId);
  let cancelled = 0;
  for (const turn of candidates) {
    if (stageConversationTerminalTurn({
      conversationId: turn.conversationId,
      userId: turn.userId,
      requestId: turn.requestId,
      assistantMessageId: '',
      desiredStatus: 'cancelled',
      reason: input.reason,
      now: input.now,
    })) {
      cancelled += 1;
      continue;
    }
    stopManagerActionTurnHeartbeat(turn);
    const result = finalizeConversationActionTurn({
      conversationId: turn.conversationId,
      userId: turn.userId,
      requestId: turn.requestId,
      status: 'cancelled',
      reason: input.reason,
      force: true,
      now: input.now,
    });
    managerActionTurnLeases.delete(managerActionTurnKey(turn));
    if (result.finalized && result.changed) cancelled += 1;
  }
  return cancelled;
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
  | PreparedConversationActionExecution
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
  const db = readDB();
  const conversation = (db.conversations || []).find((item: Conversation) => (
    item.id === input.conversationId && item.userId === input.userId
  ));
  if (!conversation) return null;
  hydrateConversationActionState(db, conversation, input.userText);
  const binding = bindConversationActionExecutionTurnInDb(db, conversation, input, false);
  if (!binding.turn) return null;
  conversation.lastActiveAt = new Date().toISOString();
  writeDB(db);
  return binding.turn;
}

/** Refresh the foreground fencing lease from any foreground channel heartbeat. */
export function renewConversationActionExecutionLease(
  conversationId: string,
  userId: string,
  requestId: string,
): boolean {
  const key = managerActionTurnKey({ conversationId, userId, requestId });
  const lease = managerActionTurnLeases.get(key);
  if (!lease) return false;
  const renewed = acquireConversationActionTurnLease({
    conversationId,
    userId,
    requestId,
    leaseOwnerId: lease.ownerId,
    ttlMs: CONVERSATION_ACTION_EXECUTION_LEASE_TTL_MS,
  });
  // Re-acquiring an already expired/released lease is not a renewal. There was
  // an ownership gap, so the executor must fail closed instead of continuing
  // side effects under a newly created lease that only happens to share its id.
  return renewed.acquired && renewed.renewed && !renewed.recovered;
}

export interface ConversationActionExecutionLeaseLoss {
  conversationId: string;
  userId: string;
  requestId: string;
  status: 'persistence_unknown';
  reason: string;
  persisted: boolean;
  occurredAt: string;
}

export interface ConversationActionExecutionHeartbeat {
  stop(): void;
  isRunning(): boolean;
  isLeaseLost(): boolean;
  /** Resolves after the durable quarantine and optional entrypoint receipt finish. */
  leaseLoss: Promise<ConversationActionExecutionLeaseLoss>;
}

function persistConversationActionLeaseLoss(input: {
  conversationId: string;
  userId: string;
  requestId: string;
  reason: string;
  occurredAt: string;
}): boolean {
  const reconciled = reconcileConversationActionTurnLease({
    conversationId: input.conversationId,
    userId: input.userId,
    requestId: input.requestId,
    observedStatus: 'persistence_unknown',
    reason: input.reason,
    now: input.occurredAt,
  });
  managerActionTurnLeases.delete(managerActionTurnKey(input));

  const db = readDB();
  const conversation = (db.conversations || []).find((item: Conversation) => (
    item.id === input.conversationId && item.userId === input.userId
  ));
  if (conversation) {
    hydrateConversationActionState(db, conversation);
    const previous = normalizeConversationActionState(conversation.actionContinuationState);
    if (previous) {
      finalizeConversationActionTask(db, {
        conversation,
        state: previous,
        outcome: 'persistence_unknown',
        requestId: input.requestId,
        blocker: `persistence_unknown: ${input.reason}`,
        assistantState: input.reason,
        now: input.occurredAt,
      });
    }
    writeDB(db);
  }
  return reconciled.turn?.status === 'persistence_unknown';
}

/**
 * Keep one prepared foreground action turn fenced for the full executor
 * lifetime. A lost renewal is a hard execution boundary: quarantine the
 * durable turn first, abort the entrypoint controller, then persist its
 * channel-specific unknown receipt.
 */
export function startConversationActionExecutionHeartbeat(input: {
  conversationId: string;
  userId: string;
  requestId: string;
  abortController: AbortController;
  onPersistenceUnknown?: (
    loss: ConversationActionExecutionLeaseLoss,
  ) => void | Promise<void>;
}): ConversationActionExecutionHeartbeat {
  const identity = {
    conversationId: String(input.conversationId || '').trim(),
    userId: String(input.userId || '').trim(),
    requestId: String(input.requestId || '').trim(),
  };
  if (!identity.conversationId || !identity.userId || !identity.requestId) {
    throw new TypeError('conversationId, userId, and requestId are required');
  }

  const key = managerActionTurnKey(identity);
  stopManagerActionTurnHeartbeat(identity);
  const managerLease = managerActionTurnLeases.get(key);
  if (managerLease) managerLease.abortController = input.abortController;
  let running = true;
  let leaseLost = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let resolveLeaseLoss!: (loss: ConversationActionExecutionLeaseLoss) => void;
  const leaseLoss = new Promise<ConversationActionExecutionLeaseLoss>(resolve => {
    resolveLeaseLoss = resolve;
  });

  const stop = () => {
    if (!running && !timer) return;
    running = false;
    if (timer) clearInterval(timer);
    timer = null;
    input.abortController.signal.removeEventListener('abort', stop);
    if (managerActionTurnHeartbeatStops.get(key) === stop) {
      managerActionTurnHeartbeatStops.delete(key);
    }
  };

  const loseLease = () => {
    if (!running || leaseLost) return;
    leaseLost = true;
    const occurredAt = new Date().toISOString();
    const reason = 'The execution lease heartbeat could not be renewed; the outcome is unknown.';
    const persisted = persistConversationActionLeaseLoss({
      ...identity,
      reason,
      occurredAt,
    });
    stop();
    if (!input.abortController.signal.aborted) {
      input.abortController.abort(new Error('Conversation action execution lease was lost'));
    }
    const loss: ConversationActionExecutionLeaseLoss = {
      ...identity,
      status: 'persistence_unknown',
      reason,
      persisted,
      occurredAt,
    };
    Promise.resolve(input.onPersistenceUnknown?.(loss))
      .catch(error => {
        console.error('[ConversationActionHeartbeat] Failed to persist entrypoint receipt:', error);
      })
      .finally(() => resolveLeaseLoss(loss));
  };

  const tick = () => {
    if (!running) return;
    if (input.abortController.signal.aborted) {
      stop();
      return;
    }
    if (renewConversationActionExecutionLease(
      identity.conversationId,
      identity.userId,
      identity.requestId,
    )) return;

    const turn = getConversationActionTurn(identity);
    if (turn?.status === 'terminal') {
      stop();
      return;
    }
    if (turn?.status === 'cancelled') {
      stop();
      if (!input.abortController.signal.aborted) {
        input.abortController.abort(new Error('Conversation action execution was cancelled'));
      }
      return;
    }
    // An independently installed quarantine is also an execution stop, and its
    // channel callback still needs a chance to write the public-safe receipt.
    loseLease();
  };

  managerActionTurnHeartbeatStops.set(key, stop);
  input.abortController.signal.addEventListener('abort', stop, { once: true });
  timer = setInterval(tick, CONVERSATION_ACTION_EXECUTION_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  if (input.abortController.signal.aborted) stop();

  return {
    stop,
    isRunning: () => running,
    isLeaseLost: () => leaseLost,
    leaseLoss,
  };
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
  /** Preserve the current task while binding corrective/continuation feedback. */
  preserveExistingTask?: boolean;
}): ConversationActionExecutionPreparation {
  const db = readDB();
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
    preserveExistingTask: input.preserveExistingTask ?? input.forceResume === true,
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
      writeDB(db);
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
      writeDB(db);
    }
    // The ledger may retain the previous task for status/history, but a plain
    // turn never receives that task id for plan/receipt binding.
    return { state: null, kind: 'conversation' };
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
    writeDB(db);
  }
  return prepared;
}

export function persistConversationExecutionPlan(input: {
  conversationId: string;
  userId: string;
  plan: CapabilityExecutionPlan;
}): boolean {
  const db = readDB();
  const task = attachConversationExecutionPlan(db, input);
  if (!task) return false;
  writeDB(db);
  return true;
}

export function persistConversationModelExecutionResult(input: {
  conversationId: string;
  userId: string;
  taskId: string;
  workflowResult: WorkflowResult;
}): boolean {
  if (!input.workflowResult.executionGraph) return false;
  return persistConversationModelExecutionCheckpoint({
    conversationId: input.conversationId,
    userId: input.userId,
    taskId: input.taskId,
    executionGraph: input.workflowResult.executionGraph,
    nodeReceipts: input.workflowResult.nodeReceipts || [],
    privateNodeHandoffs: input.workflowResult.privateNodeHandoffs,
    arbitrationReceipt: input.workflowResult.arbitrationReceipt,
  });
}

function compactPrivateModelHandoff(value: unknown): string {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, PRIVATE_MODEL_HANDOFF_MAX_CHARS);
}

function collectPrivateModelHandoffs(input: {
  conversationId: string;
  userId: string;
  taskId: string;
  executionGraph: ModelExecutionGraph;
  nodeReceipts: ModelGraphNodeReceipt[];
  privateNodeHandoffs?: OrchestrationPrivateNodeHandoff[];
}): PrivateModelHandoffInput[] | null {
  const graphNodeIds = new Set(input.executionGraph.nodes.map(node => node.nodeId));
  if ((input.privateNodeHandoffs?.length || 0) > PRIVATE_MODEL_HANDOFF_MAX_BATCH) return null;
  const supplied = input.privateNodeHandoffs === undefined
    ? null
    : new Map(input.privateNodeHandoffs.map(handoff => [
        `${handoff.graphId}:${handoff.taskId}:${handoff.nodeId}`,
        handoff,
      ]));
  if (supplied && supplied.size !== input.privateNodeHandoffs!.length) return null;
  const consumedSupplied = new Set<string>();
  const handoffs = new Map<string, PrivateModelHandoffInput>();
  for (const receipt of input.nodeReceipts) {
    const graphNode = input.executionGraph.nodes.find(node => node.nodeId === receipt.nodeId);
    if (
      receipt.graphId !== input.executionGraph.graphId
      || receipt.taskId !== input.taskId
      || input.executionGraph.taskId !== input.taskId
      || !graphNodeIds.has(receipt.nodeId)
      || !graphNode
      || !hasVerifiedModelGraphNodeEvidence(receipt)
      || (receipt.evidenceKind !== 'tool_terminal_verification'
        && receipt.evidenceKind !== 'validated_model_output')
    ) continue;
    if (!reuseVerifiedModelGraphNodeReceipt({
      graph: input.executionGraph,
      node: graphNode,
      prior: receipt,
      recoveredAt: receipt.completedAt,
    })) continue;
    const key = `${receipt.graphId}:${receipt.taskId}:${receipt.nodeId}`;
    const suppliedHandoff = supplied?.get(key);
    const receiptSummary = compactPrivateModelHandoff(receipt.outputSummary);
    if (!receiptSummary) {
      if (suppliedHandoff) return null;
      continue;
    }
    if (supplied && !suppliedHandoff) return null;
    if (suppliedHandoff && (
      suppliedHandoff.outputDigest !== receipt.outputDigest
      || suppliedHandoff.evidenceKind !== receipt.evidenceKind
    )) return null;
    const outputSummary = compactPrivateModelHandoff(
      suppliedHandoff?.outputSummary ?? receipt.outputSummary,
    );
    // The private copy must be the same bounded value that produced the verified
    // in-memory receipt. A caller cannot attach unrelated plaintext to a digest.
    if (!outputSummary || receiptSummary !== outputSummary) return null;
    const handoff: PrivateModelHandoffInput = {
      userId: input.userId,
      conversationId: input.conversationId,
      taskId: input.taskId,
      graphId: receipt.graphId,
      nodeId: receipt.nodeId,
      outputDigest: receipt.outputDigest,
      outputSummary,
      evidenceKind: receipt.evidenceKind as ModelGraphNodeEvidenceKind,
    };
    handoffs.delete(key);
    handoffs.set(key, handoff);
    if (suppliedHandoff) consumedSupplied.add(key);
  }
  if (supplied && consumedSupplied.size !== supplied.size) return null;
  return [...handoffs.values()].slice(-PRIVATE_MODEL_HANDOFF_MAX_BATCH);
}

export function persistConversationModelExecutionCheckpoint(input: {
  conversationId: string;
  userId: string;
  taskId: string;
  executionGraph: ModelExecutionGraph;
  nodeReceipts: ModelGraphNodeReceipt[];
  privateNodeHandoffs?: OrchestrationPrivateNodeHandoff[];
  arbitrationReceipt?: ModelGraphArbitrationReceipt;
}): boolean {
  const db = readDB();
  const ownsTask = (Array.isArray(db.conversationActionTasks) ? db.conversationActionTasks : [])
    .some((candidate: any) => (
      candidate?.id === input.taskId
      && candidate?.conversationId === input.conversationId
      && candidate?.userId === input.userId
    ));
  if (!ownsTask || input.executionGraph.taskId !== input.taskId) return false;
  const privateHandoffs = collectPrivateModelHandoffs(input);
  if (!privateHandoffs) return false;
  if (privateHandoffs.length > 0 && !persistPrivateModelHandoffs(privateHandoffs)) return false;
  const task = attachConversationModelExecutionGraph(db, {
    conversationId: input.conversationId,
    userId: input.userId,
    taskId: input.taskId,
    graph: input.executionGraph,
    receipts: input.nodeReceipts,
    arbitrationReceipt: input.arbitrationReceipt,
  });
  if (!task) return false;
  writeDB(db);
  return true;
}

export function getConversationModelExecutionRecovery(input: {
  conversationId: string;
  userId: string;
  taskId?: string;
}) {
  if (!input.taskId) return null;
  const recovery = loadConversationModelExecutionRecovery(readDB(), {
    conversationId: input.conversationId,
    userId: input.userId,
    taskId: input.taskId,
  });
  if (!recovery) return null;
  return {
    ...recovery,
    receipts: recovery.receipts.map(receipt => {
      const outputSummary = loadPrivateModelHandoff({
        userId: input.userId,
        conversationId: input.conversationId,
        taskId: input.taskId!,
        graphId: receipt.graphId,
        nodeId: receipt.nodeId,
        outputDigest: receipt.outputDigest,
        evidenceKind: receipt.evidenceKind,
      });
      return outputSummary ? { ...receipt, outputSummary } : receipt;
    }),
  };
}

interface FinalizeConversationActionRequestOptions {
  assistantState?: string;
  fallbackBlocker?: string;
  now?: string;
  terminalDisposition?: ConversationActionTerminalDisposition;
}

/**
 * End one foreground request without conflating that request lease with the
 * durable task. A blocked or confirmation-waiting task remains resumable, but
 * the process-local request that produced this terminal assistant record no
 * longer owns it.
 */
function finalizeConversationActionRequestInDb(
  db: any,
  conversation: Conversation,
  requestId: string,
  options: FinalizeConversationActionRequestOptions = {},
): ConversationActionContinuationState | null {
  const normalizedRequestId = String(requestId || '').trim();
  const previous = normalizeConversationActionState(conversation.actionContinuationState);
  const pendingOwnsRequest = Boolean(
    conversation.pendingActionContinuation
    && (normalizedRequestId
      ? conversation.pendingActionContinuation.requestId === normalizedRequestId
      : !conversation.pendingActionContinuation.requestId),
  );
  const stateOwnsRequest = Boolean(
    previous
    && normalizedRequestId
    && previous.activeRequestId === normalizedRequestId,
  );
  const now = options.now || new Date().toISOString();

  if (previous && stateOwnsRequest) {
    const completion = taskCompletionFromReceipts(
      previous.goal,
      previous.receipts || [],
      previous.taskCapsule,
    );
    const requestWasRunning = conversationTaskStatusOwnsExecutionLease(previous.status);
    const authoritativeBlocked = Boolean(
      options.terminalDisposition?.outcome === 'blocked'
      && options.terminalDisposition.requestId === normalizedRequestId
      && options.terminalDisposition.taskId === previous.taskId,
    );
    const status = authoritativeBlocked
      ? 'blocked'
      : completion.complete
      ? 'completed'
      : requestWasRunning
        ? 'blocked'
        : previous.status;
    const finalized = finalizeConversationActionTask(db, {
      conversation,
      state: previous,
      outcome: status === 'completed' ? 'completed' : 'blocked',
      requestId: normalizedRequestId,
      blocker: status === 'blocked'
        ? (authoritativeBlocked ? options.terminalDisposition?.reason : '')
          || previous.latestBlocker
          || completion.blocker
          || options.fallbackBlocker
          || 'The execution request ended without a verified terminal result.'
        : '',
      assistantState: options.assistantState !== undefined
        ? compactRolloverText(options.assistantState, 700)
        : previous.assistantState,
      completionSource: authoritativeBlocked
        ? undefined
        : completion.complete
          ? 'tool_receipt'
          : previous.completionSource,
      now,
    });
    if (finalized) return finalized.state;
  }

  if (pendingOwnsRequest) delete conversation.pendingActionContinuation;
  return normalizeConversationActionState(conversation.actionContinuationState);
}

export function cancelConversationActionExecution(
  conversationId: string,
  userId: string,
  reason = 'Cancelled by the user.',
  expectedRequestId?: string,
): ConversationActionContinuationState | null {
  const db = readDB();
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
  writeDB(db);
  return finalized?.state || previous;
}

export function completeConversationActionFromUserObservation(
  conversationId: string,
  userId: string,
  userText: string,
): ConversationActionContinuationState | null {
  const db = readDB();
  const conversation = (db.conversations || []).find((item: Conversation) => (
    item.id === conversationId && item.userId === userId
  ));
  if (conversation) hydrateConversationActionState(db, conversation);
  const previous = normalizeConversationActionState(conversation?.actionContinuationState);
  if (!conversation || !previous || !isUserObservedTaskCompletion(userText, previous)) return null;
  const finalized = finalizeConversationActionTask(db, {
    conversation,
    state: previous,
    outcome: 'completed',
    requestId: previous.activeRequestId,
    assistantState: userText,
    completionSource: 'user_observation',
    userText,
  });
  writeDB(db);
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
  const db = readDB();
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
  writeDB(db);
  return settled;
}

export interface ConvergeConversationActionRequestLeaseInput {
  conversationId: string;
  userId: string;
  requestId: string;
  now?: Date | string | number;
  /** @internal Keep the process owner until the staged mutation is strictly flushed. */
  deferLocalOwnerClear?: boolean;
}

export type ConversationActionRequestLeaseEvidence =
  | 'found'
  | 'missing'
  | 'ambiguous'
  | 'unbound';

export interface ConvergeConversationActionRequestLeaseResult {
  conversationId: string;
  userId: string;
  requestId: string;
  taskId: string;
  assistantMessageId: string;
  beforeStatus: ConversationActionTurn['status'] | 'missing';
  finalStatus: ConversationActionTurn['status'] | 'missing';
  action: 'none' | 'terminal' | 'cancelled' | 'persistence_unknown';
  converged: boolean;
  changed: boolean;
  reason: string;
  evidence: {
    conversation: ConversationActionRequestLeaseEvidence;
    task: ConversationActionRequestLeaseEvidence;
    assistant: ConversationActionRequestLeaseEvidence;
  };
  localOwnerCleared: boolean;
  turn: ConversationActionTurn | null;
}

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

function clearManagerActionRequestLeaseOwner(
  identity: Pick<ConvergeConversationActionRequestLeaseInput, 'conversationId' | 'userId' | 'requestId'>,
  abortReason = '',
): boolean {
  const key = managerActionTurnKey(identity);
  const owner = managerActionTurnLeases.get(key);
  stopManagerActionTurnHeartbeat(identity);
  const cleared = managerActionTurnLeases.delete(key);
  if (abortReason && owner?.abortController && !owner.abortController.signal.aborted) {
    owner.abortController.abort(new Error(abortReason));
  }
  return cleared;
}

export type ForegroundRequestFinalizationOutcome =
  | 'terminal'
  | 'cancelled'
  | 'superseded'
  | 'blocked'
  | 'persistence_unknown';

export interface FinalizeForegroundRequestInput {
  /** Immutable identity of the already accepted foreground request. */
  readonly conversationId: string;
  readonly userId: string;
  readonly requestId: string;
  /** Optional caller assertion. It must agree with the durable turn binding. */
  readonly expectedTaskId?: string;
  readonly outcome: ForegroundRequestFinalizationOutcome;
  /** Exact durable assistant row. Text alone is never terminal evidence. */
  readonly assistantMessageId?: string;
  /** Bounded user-visible state copied into a task projection when one exists. */
  readonly assistantState?: string;
  readonly reason?: string;
  readonly now?: Date | string | number;
  /** @internal Keep the process owner until the staged mutation is strictly flushed. */
  readonly deferLocalOwnerClear?: boolean;
}

export type ForegroundRequestFinalizationEvidence =
  | 'found'
  | 'missing'
  | 'ambiguous'
  | 'unbound'
  | 'mismatch';

export interface FinalizeForegroundRequestResult {
  conversationId: string;
  userId: string;
  requestId: string;
  requestedOutcome: ForegroundRequestFinalizationOutcome;
  effectiveOutcome: ForegroundRequestFinalizationOutcome;
  taskId: string;
  assistantMessageId: string;
  taskStatus: string;
  actionTurnStatus: ConversationActionTurn['status'] | 'missing' | 'ambiguous';
  converged: boolean;
  changed: boolean;
  reason: string;
  evidence: {
    conversation: ForegroundRequestFinalizationEvidence;
    actionTurn: ForegroundRequestFinalizationEvidence;
    task: ForegroundRequestFinalizationEvidence;
    assistant: ForegroundRequestFinalizationEvidence;
  };
  localOwnerCleared: boolean;
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
 * Chat and Task now use this boundary before releasing foreground resources.
 * Voice is intentionally not integrated in this slice.
 */
export function finalizeForegroundRequest(
  input: FinalizeForegroundRequestInput,
): FinalizeForegroundRequestResult {
  const identity = normalizeForegroundRequestFinalizationInput(input);
  const db = readDB();
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

  if (dbChanged) writeDB(db);
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
  const db = readDB();
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

export interface ForegroundRequestDurabilityDependencies {
  /** Strict persistence barrier. Tests may inject a deterministic failure. */
  flush?: () => Promise<void>;
}

export interface DurableForegroundReleaseGateSnapshot {
  attempts: number;
  resourcesReleased: boolean;
  recoveryOwned: boolean;
  retryScheduled: boolean;
}

export interface DurableForegroundReleaseGate {
  release(reason?: string): Promise<boolean>;
  snapshot(): DurableForegroundReleaseGateSnapshot;
  /** Cancel the unref'd recovery worker during test/server teardown. */
  dispose(): void;
}

export interface CreateDurableForegroundReleaseGateInput {
  /** Returns true only after the exact request is strictly durable/release-safe. */
  converge(reason: string): Promise<boolean>;
  /** Idempotent heartbeat/desktop/serial cleanup. */
  releaseResources(): void;
  onFailure?(input: { reason: string; error: unknown; attempts: number }): void;
  onRecoveryTakeover?(input: { reason: string; error: unknown; attempts: number }): void;
  retryDelaysMs?: readonly number[];
  recoveryTakeoverAfterAttempts?: number;
}

/**
 * Gate transport cleanup behind strict durable convergence.
 *
 * Transient failures retain every foreground resource. A structurally broken
 * request cannot hold the desktop/serial lane forever, however: after bounded
 * exponential attempts this gate becomes the explicit fail-closed recovery
 * owner, releases transport resources, and continues low-frequency persistence
 * retries without reporting convergence. The manager request owner remains
 * intact until a later strict barrier succeeds.
 */
export function createDurableForegroundReleaseGate(
  input: CreateDurableForegroundReleaseGateInput,
): DurableForegroundReleaseGate {
  const retryDelaysMs = (input.retryDelaysMs?.length
    ? input.retryDelaysMs
    : [250, 500, 1_000, 2_000, 4_000, 10_000, 30_000])
    .map(value => Math.max(1, Math.floor(Number(value) || 0)));
  const recoveryTakeoverAfterAttempts = Math.max(
    1,
    Math.floor(Number(input.recoveryTakeoverAfterAttempts ?? 6) || 1),
  );
  let attempts = 0;
  let resourcesReleased = false;
  let recoveryOwned = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<boolean> | null = null;
  let latestReason = 'Foreground request reached its release boundary.';
  let disposed = false;

  const releaseResourcesOnce = (): void => {
    if (resourcesReleased) return;
    input.releaseResources();
    resourcesReleased = true;
  };
  const scheduleRetry = (): void => {
    if (disposed || retryTimer) return;
    const delay = retryDelaysMs[Math.min(Math.max(0, attempts - 1), retryDelaysMs.length - 1)];
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void release(latestReason);
    }, delay);
    retryTimer.unref?.();
  };
  const release = async (reason = latestReason): Promise<boolean> => {
    latestReason = String(reason || latestReason);
    if (disposed) return false;
    if (resourcesReleased && !recoveryOwned) return true;
    if (inFlight) return inFlight;
    // A finally block and a fast-path boundary may both call release. Once a
    // retry worker is scheduled, those duplicate calls must not accelerate the
    // takeover threshold or create a second worker.
    if (retryTimer) return false;
    const attempt = (async (): Promise<boolean> => {
      attempts += 1;
      let failure: unknown = null;
      try {
        if (await input.converge(latestReason)) {
          releaseResourcesOnce();
          recoveryOwned = false;
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = null;
          return true;
        }
        failure = new Error('foreground_request_not_durably_converged');
      } catch (error) {
        failure = error;
      }

      input.onFailure?.({ reason: latestReason, error: failure, attempts });
      if (!recoveryOwned && attempts >= recoveryTakeoverAfterAttempts) {
        recoveryOwned = true;
        input.onRecoveryTakeover?.({ reason: latestReason, error: failure, attempts });
        // The gate, rather than the channel executor, now owns retry/recovery.
        // This releases scarce transport resources but deliberately returns
        // false so no caller can mistake takeover for durable convergence.
        releaseResourcesOnce();
      }
      scheduleRetry();
      return false;
    })();
    inFlight = attempt;
    try {
      return await attempt;
    } finally {
      if (inFlight === attempt) inFlight = null;
    }
  };

  return {
    release,
    dispose: () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    },
    snapshot: () => ({
      attempts,
      resourcesReleased,
      recoveryOwned,
      retryScheduled: Boolean(retryTimer),
    }),
  };
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
 * Strict release-time reconciliation. `writeDB()` stages an in-memory
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
  const db = readDB();
  const migrated = migrateLegacyConversationActionLedger(db);
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
    || repairedTerminalLeases > 0
    || recoveredLedgerLeases > 0
    || repairedReceipts > 0
    || schedulerCompaction.tasksRemoved > 0
    || reconciledActionTurns > 0
    || recoveredActionTurnLeases > 0
    || recoveredPendingTurns > 0
    || recovered > 0
  ) writeDB(db);
  return repairedTerminalLeases
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
  const db = readDB();
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
    writeDB(db);
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
  writeDB(db);
  return conversation.actionContinuationState;
}

function normalizeConversationActionTerminalDisposition(
  value: unknown,
): ConversationActionTerminalDisposition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.outcome !== 'blocked') return null;
  const taskId = String(candidate.taskId || '').trim().slice(0, 180);
  const requestId = String(candidate.requestId || '').trim().slice(0, 180);
  const reason = String(
    candidate.reason || 'The foreground request ended without a verified complete result.',
  ).replace(/\s+/g, ' ').trim().slice(0, 380);
  if (!taskId || !requestId || !reason) return null;
  return { outcome: 'blocked', taskId, requestId, reason };
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
  const db = readDB();
  const id = 'msg_' + crypto.randomUUID();
  const now = msg.timestamp || new Date().toISOString();
  const normalizedToolCalls = normalizeToolCalls(msg.toolCalls);
  const completionFeedback = normalizeCompletionFeedbackForPersistence(msg.completionFeedback);
  const nativeRequestBinding = normalizeNativeRequestBinding(msg);
  const voiceTurnProvenance = normalizeVoiceTurnProvenance(msg);
  let currentUserMessageIdForLedger = '';

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
      const terminalTaskDisposition = receiptOwnership.staleRecords.length === 0
        ? resolveConversationActionTerminalDisposition({
            db,
            conversation: conv,
            role: msg.role,
            requestId: msg.requestId,
            skipActionContinuation: msg.skipActionContinuation,
            terminalDisposition: msg.terminalTaskDisposition,
          })
        : null;
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
        writeDB(db);
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
          writeDB(db);
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
          writeDB(db);
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
              outcome: 'blocked',
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
            outcome: 'blocked',
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

      if (conv.actionContinuationState) {
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

  writeDB(db);
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
  const row = (readDB().interactions || []).find((item: any) => (
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
      const db = readDB();
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
      writeDB(db);
    }
    return existing.id;
  }

  const rows = (readDB().interactions || []).filter((item: any) => (
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
  const db = readDB();
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
  writeDB(db);
  return true;
}

const DEFAULT_CONTEXT_TOKENS = parseInt(process.env.CONTEXT_TOKEN_BUDGET || '18000', 10);
const CONTEXT_HISTORY_LIMIT = parseInt(process.env.CONTEXT_HISTORY_LIMIT || '240', 10);
const CONTEXT_MESSAGE_CHAR_LIMIT = parseInt(process.env.CONTEXT_MESSAGE_CHAR_LIMIT || '5000', 10);
const CONTEXT_RESPONSE_CHAR_LIMIT = parseInt(process.env.CONTEXT_RESPONSE_CHAR_LIMIT || '5000', 10);

function compactPromptText(value: string, limit: number): string {
  const text = value || '';
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.75);
  const tail = Math.max(400, limit - head - 180);
  return [
    text.slice(0, head),
    `\n\n[Prompt history compacted: ${text.length} characters total. Older detail is preserved in conversation storage and searchable history.]\n\n`,
    text.slice(-tail),
  ].join('');
}

function normalizeToolCalls(value: unknown): any[] | undefined {
  return sanitizeToolRecordsForPersistence(value);
}

function isPromptEligibleMessage(m: MessageRecord): boolean {
  if (!m) return false;
  if (m.role === 'tool' || m.mode === 'proactive') return false;
  if (isGuardGeneratedConversationRecord(m)) return false;
  return Boolean((m.message || '').trim() || (m.response || '').trim());
}

export function compactRecordForPrompt(m: MessageRecord): MessageRecord {
  const legacyCombinedGuardResponse = m.role === 'user'
    && Boolean(String(m.response || '').trim())
    && (
      String(m.cognitiveIntent || '').toLowerCase() === 'work_product_guard'
      || isGuardGeneratedAssistantText(m.response)
    );
  const evidenceNote = buildCompactToolEvidenceNote(m.toolCalls);
  const compactedMessage = compactPromptText(m.message || '', CONTEXT_MESSAGE_CHAR_LIMIT);
  const compactedResponse = legacyCombinedGuardResponse
    ? ''
    : compactPromptText(m.response || '', CONTEXT_RESPONSE_CHAR_LIMIT);
  return {
    ...m,
    message: evidenceNote && m.role === 'assistant'
      ? `${compactedMessage}\n${evidenceNote}`.trim()
      : compactedMessage,
    // Older interaction rows stored the assistant reply in `response` while
    // keeping role=user. Preserve the user's side, but never reconstruct a
    // marked/legacy guard reply as conversational assistant truth.
    response: evidenceNote && m.role === 'user' && compactedResponse
      ? `${compactedResponse}\n${evidenceNote}`.trim()
      : compactedResponse,
    toolReceiptLedger: evidenceNote || undefined,
    toolCalls: undefined,
  };
}

export function getMessages(conversationId: string, limit = 1000): MessageRecord[] {
  const db = readDB();
  if (!db.interactions) return [];
  const rows = db.interactions
    .map((row: any, insertionOrder: number) => ({ row, insertionOrder }))
    .filter(({ row }: any) => row.conversationId === conversationId)
    .sort((a: any, b: any) => {
      const timestampDelta = new Date(a.row.timestamp).getTime() - new Date(b.row.timestamp).getTime();
      if (timestampDelta) return timestampDelta;
      const aSequence = Number(a.row.routeSequence);
      const bSequence = Number(b.row.routeSequence);
      if (Number.isFinite(aSequence) && Number.isFinite(bSequence) && aSequence !== bSequence) {
        return aSequence - bSequence;
      }
      return a.insertionOrder - b.insertionOrder;
    })
    .map(({ row }: any) => row);

  return rows
    .filter((row: any) => {
      const response = String(row.response || '').trim();
      if (row.role !== 'user' || !response) return true;
      const message = String(row.message || row.content || '').trim();
      const ts = new Date(row.timestamp).getTime();
      const hasSplitUser = rows.some((other: any) =>
        other !== row &&
        other.role === 'user' &&
        !String(other.response || '').trim() &&
        String(other.message || other.content || '').trim() === message &&
        Math.abs(new Date(other.timestamp).getTime() - ts) < 2000
      );
      const hasSplitAssistant = rows.some((other: any) =>
        other !== row &&
        other.role === 'assistant' &&
        String(other.message || other.content || '').trim() === response &&
        Math.abs(new Date(other.timestamp).getTime() - ts) < 2000
      );
      return !(hasSplitUser || hasSplitAssistant);
    })
    .slice(-limit);
}

/**
 * Get messages trimmed to a token budget rather than a fixed count.
 * Always keeps the last `keepRecent` messages (default 4).
 * Trims oldest messages first from the middle.
 */
export function getMessagesByTokenBudget(
  conversationId: string,
  maxTokens: number = DEFAULT_CONTEXT_TOKENS,
  keepRecent: number = 4,
  throughExternalMessageId = '',
): MessageRecord[] {
  const messages = getMessages(conversationId, CONTEXT_HISTORY_LIMIT);
  let cutoffIndex = -1;
  if (throughExternalMessageId) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role !== 'user') continue;
      if (messages[index].externalMessageId !== throughExternalMessageId) continue;
      cutoffIndex = index;
      break;
    }
  }
  const visibleMessages = cutoffIndex >= 0 ? messages.slice(0, cutoffIndex + 1) : messages;
  const all = visibleMessages
    .filter(isPromptEligibleMessage)
    .map(compactRecordForPrompt);
  if (all.length <= keepRecent) return all;

  const keep = all.slice(-keepRecent); // always keep most recent
  const rest = all.slice(0, -keepRecent);

  let budget = maxTokens;
  // Count tokens for the kept portion first
  for (const m of keep) {
    budget -= estimateTokenCount(m.message + (m.response || ''));
  }

  // Walk backwards through rest, taking messages that fit
  const selected: MessageRecord[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = estimateTokenCount(rest[i].message + (rest[i].response || ''));
    if (budget - cost > 0) {
      selected.unshift(rest[i]);
      budget -= cost;
    } else {
      break; // no more budget for older messages
    }
  }

  return [...selected, ...keep];
}

export function getMessagesThroughExternalMessage(
  conversationId: string,
  externalMessageId: string,
  limit = 1000,
): MessageRecord[] {
  const messages = getMessages(conversationId, 1000);
  let cutoffIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== 'user') continue;
    if (messages[index].externalMessageId !== externalMessageId) continue;
    cutoffIndex = index;
    break;
  }
  const visibleMessages = cutoffIndex >= 0 ? messages.slice(0, cutoffIndex + 1) : messages;
  return visibleMessages.slice(-limit);
}

export function getMessagesForAgent(userId: string, agentId: string, limit = 500): MessageRecord[] {
  const conv = getActiveConversation(userId, agentId);
  if (!conv) return [];
  return getMessages(conv.id, limit);
}

/** Messages threshold for auto-summarization */
const AUTO_SUMMARY_THRESHOLD = 20;
const AUTO_SUMMARY_RESERVATION_TTL_MS = 5 * 60 * 1000;

interface AutoSummaryReservation {
  summarizedThroughMessageCount: number;
  startedAt: number;
}

const autoSummaryReservations = new Map<string, AutoSummaryReservation>();

export interface AutoSummaryCheckResult {
  needed: boolean;
  conversation: Conversation | null;
  recentMessages: MessageRecord[];
  summarizedThroughMessageCount: number;
}

function isStandaloneGuardOutput(value: unknown): boolean {
  const text = String(value || '').trim();
  return isGuardGeneratedAssistantText(text)
    && /^(?:我|I\b|Completion claim blocked)/i.test(text); // i18n-allow: guard-output prefix, not user-visible copy.
}

function normalizedLastSummaryMessageCount(conv: Conversation): number {
  const stored = Number(conv.lastSummaryMessageCount);
  if (Number.isFinite(stored) && stored >= 0) return Math.floor(stored);

  // Existing databases predate this marker. A stored summary is the durable
  // baseline; without one, the whole conversation is eligible for its first
  // summary. Persist the inferred value so restarts preserve the cadence.
  const storedSummary = String(conv.summary || '').trim();
  const inferred = storedSummary
    ? Math.max(0, conv.messageCount || 0)
    : 0;
  conv.lastSummaryMessageCount = inferred;
  return inferred;
}

function activeAutoSummaryReservation(conversationId: string): AutoSummaryReservation | null {
  const reservation = autoSummaryReservations.get(conversationId);
  if (!reservation) return null;
  if (Date.now() - reservation.startedAt <= AUTO_SUMMARY_RESERVATION_TTL_MS) return reservation;
  autoSummaryReservations.delete(conversationId);
  return null;
}

/**
 * Check if a conversation needs auto-summarization.
 * Returns the conversation and older messages if threshold exceeded.
 */
export function checkAutoSummary(
  conversationId: string,
): AutoSummaryCheckResult {
  const db = readDB();
  const emptyResult = (conversation: Conversation | null = null): AutoSummaryCheckResult => ({
    needed: false,
    conversation,
    recentMessages: [],
    summarizedThroughMessageCount: 0,
  });
  if (!db.conversations) return emptyResult();
  const conv = db.conversations.find((c: Conversation) => c.id === conversationId);
  if (!conv) return emptyResult();

  const summaryWasIsolated = isolateConversationSummaryForUse(conv);
  if (conv.messageCount < AUTO_SUMMARY_THRESHOLD) {
    if (summaryWasIsolated) writeDB(db);
    return emptyResult(conv);
  }
  const hadPersistedMarker = Number.isFinite(Number(conv.lastSummaryMessageCount))
    && Number(conv.lastSummaryMessageCount) >= 0;
  const lastCount = normalizedLastSummaryMessageCount(conv);
  if (summaryWasIsolated || !hadPersistedMarker) writeDB(db);
  if (conv.messageCount - lastCount < AUTO_SUMMARY_THRESHOLD) {
    return emptyResult(conv);
  }

  const summarizedThroughMessageCount = Math.max(0, Math.floor(conv.messageCount));
  const recentMessages = getMessages(conversationId, 40)
    .filter(message => !isGuardGeneratedConversationRecord(message));
  return {
    needed: recentMessages.length > 0,
    conversation: conv,
    recentMessages,
    summarizedThroughMessageCount,
  };
}

/**
 * Atomically reserve one eligible summary interval before starting async LLM
 * work. `checkAutoSummary` deliberately stays side-effect free for callers
 * such as idle diagnostics that only inspect eligibility.
 */
export function beginConversationSummary(
  conversationId: string,
  summarizedThroughMessageCount: number,
): boolean {
  const through = Math.max(0, Math.floor(Number(summarizedThroughMessageCount)));
  if (!Number.isFinite(through) || through < AUTO_SUMMARY_THRESHOLD) return false;
  if (activeAutoSummaryReservation(conversationId)) return false;

  const db = readDB();
  const conv = (db.conversations || []).find((item: Conversation) => item.id === conversationId);
  if (!conv || through > conv.messageCount) return false;
  const summaryWasIsolated = isolateConversationSummaryForUse(conv);
  const markerBeforeNormalization = Number(conv.lastSummaryMessageCount);
  const lastCount = normalizedLastSummaryMessageCount(conv);
  if (
    summaryWasIsolated
    || !Number.isFinite(markerBeforeNormalization)
    || markerBeforeNormalization < 0
  ) writeDB(db);
  if (through - lastCount < AUTO_SUMMARY_THRESHOLD) return false;

  autoSummaryReservations.set(conversationId, {
    summarizedThroughMessageCount: through,
    startedAt: Date.now(),
  });
  return true;
}

/** Release a failed/empty async summary so the same interval can retry. */
export function cancelConversationSummary(
  conversationId: string,
  summarizedThroughMessageCount?: number,
): void {
  const reservation = autoSummaryReservations.get(conversationId);
  if (!reservation) return;
  if (
    summarizedThroughMessageCount !== undefined
    && reservation.summarizedThroughMessageCount !== Math.floor(Number(summarizedThroughMessageCount))
  ) return;
  autoSummaryReservations.delete(conversationId);
}

/**
 * Store a conversation summary. Maintains a multi-level chain (max 3).
 * Newest summary becomes conv.summary; older ones move into summaryChain.
 */
export function setConversationSummary(
  conversationId: string,
  summary: string,
  summarizedThroughMessageCount?: number,
): boolean {
  const db = readDB();
  if (!db.conversations) return false;
  const conv = db.conversations.find((c: Conversation) => c.id === conversationId);
  if (!conv) return false;
  const priorSummaryWasIsolated = isolateConversationSummaryForUse(conv);
  const cleanSummary = String(summary || '').trim();
  // The source transcript is filtered by record metadata before summarization.
  // Keep a final defense against a verbatim guard response, but do not reject a
  // legitimate mixed summary merely because it describes a historical error.
  if (!cleanSummary || isStandaloneGuardOutput(cleanSummary)) {
    if (priorSummaryWasIsolated) writeDB(db);
    cancelConversationSummary(conversationId, summarizedThroughMessageCount);
    return false;
  }

  let summarizedThrough = Math.max(0, Math.floor(conv.messageCount || 0));
  if (summarizedThroughMessageCount !== undefined) {
    summarizedThrough = Math.max(0, Math.floor(Number(summarizedThroughMessageCount)));
    const reservation = activeAutoSummaryReservation(conversationId);
    if (!reservation || reservation.summarizedThroughMessageCount !== summarizedThrough) return false;
    if (summarizedThrough > conv.messageCount) {
      cancelConversationSummary(conversationId, summarizedThrough);
      return false;
    }
  }

  // Push the current clean summary into the chain before overwriting. Legacy
  // guard contamination has already been isolated above.
  if (
    conv.summary
    && conv.summary !== cleanSummary
    && !isStandaloneGuardOutput(conv.summary)
  ) {
    if (!conv.summaryChain) conv.summaryChain = [];
    conv.summaryChain.push(conv.summary);
    // Keep max 2 in chain (plus current summary = 3 total layers)
    if (conv.summaryChain.length > 2) {
      const newestPriorSummary = conv.summaryChain[conv.summaryChain.length - 1];
      conv.summaryChain = [
        conv.summaryChain.slice(0, -1).join(' | '),
        newestPriorSummary,
      ];
    }
  }

  conv.summary = cleanSummary;
  conv.lastSummaryMessageCount = Math.max(
    normalizedLastSummaryMessageCount(conv),
    summarizedThrough,
  );
  cancelConversationSummary(conversationId, summarizedThroughMessageCount);
  writeDB(db);
  return true;
}

/**
 * Get full conversation context: recent summary + older layers.
 * Returns formatted string suitable for system prompt injection.
 */
export function getConversationSummary(conversationId: string): string | null {
  const db = readDB();
  if (!db.conversations) return null;
  const conv = db.conversations.find((c: Conversation) => c.id === conversationId);
  if (!conv) return null;
  if (isolateConversationSummaryForUse(conv)) writeDB(db);

  const parts: string[] = [];
  if (conv.summary && !isStandaloneGuardOutput(conv.summary)) {
    const safe = sanitizeSummaryForPrompt(conv.summary);
    if (safe) parts.push(safe);
  }
  if (conv.summaryChain && conv.summaryChain.length > 0) {
    const cleanChain = conv.summaryChain
      .filter(summary => !isStandaloneGuardOutput(summary))
      .map(summary => sanitizeSummaryForPrompt(summary))
      .filter(Boolean);
    if (cleanChain.length) parts.push('Earlier: ' + cleanChain.join(' | '));
  }
  return parts.length ? parts.join('\n') : null;
}

/**
 * Track a topic for a conversation. Appends to recentTopics, keeping max 8 entries.
 * If the same topic was already recent, it moves to the end (most recent).
 */
export function trackTopic(conversationId: string, topic: string): void {
  const db = readDB();
  if (!db.conversations) return;
  const conv = db.conversations.find((c: Conversation) => c.id === conversationId);
  if (!conv) return;

  if (!conv.recentTopics) conv.recentTopics = [];
  // Remove if already exists — re-insert at end so it's "most recent"
  const idx = conv.recentTopics.indexOf(topic);
  if (idx >= 0) conv.recentTopics.splice(idx, 1);
  conv.recentTopics.push(topic);
  // Keep max 8
  if (conv.recentTopics.length > 8) conv.recentTopics.shift();
  conv.lastTopicChangeAt = new Date().toISOString();
  writeDB(db);
}

/**
 * Extract likely topics from a user message using simple keyword extraction.
 * Returns 1-3 topic strings, or empty array if nothing discernible.
 */
export function extractTopics(text: string): string[] {
  const topics: string[] = [];
  const lower = text.toLowerCase();

  // Programming-related topics
  const techPatterns: [RegExp, string][] = [
    [/\b(rust|rustlang|cargo|borrow\s*checker|ownership|lifetime)\b/i, 'Rust'],
    [/\b(python|py|pip|django|flask|fastapi|pytorch|numpy)\b/i, 'Python'],
    [/\b(javascript|js|typescript|ts|react|vue|angular|node\.js|nodejs|npm)\b/i, 'JS/TS开发'],
    [/\b(go|golang|goroutine)\b/i, 'Go'],
    [/\b(java|spring|maven|gradle|kotlin)\b/i, 'Java'],
    [/\b(c\+\+|cpp|cmake|unreal|ue5|ue4)\b/i, 'C++'],
    [/\b(docker|kubernetes|k8s|container|pod)\b/i, '容器/Docker'],
    [/\b(git|github|pr|pull\s*request|commit|branch|merge)\b/i, 'Git'],
    [/\b(database|sql|mysql|postgres|mongodb|redis|db)\b/i, '数据库'],
    [/\b(api|rest|graphql|grpc|endpoint|http)\b/i, 'API开发'],
    [/\b(ai|llm|gpt|model|training|inference|embedding|transformer|deepseek|qwen)\b/i, 'AI/LLM'],
    [/\b(debug|bug|error|crash|fix|修复|调试)\b/i, '调试/Debug'],
    [/\b(test|testing|unit\s*test|测试|coverage)\b/i, '测试'],
    [/\b(deploy|deployment|ci|cd|pipeline|release)\b/i, '部署'],
  ];

  for (const [pattern, label] of techPatterns) {
    if (pattern.test(lower)) {
      topics.push(label);
    }
  }

  // Non-tech topics
  if (/(天气|weather|温度|temperature|下雨|晴天)/i.test(lower)) topics.push('天气');
  if (/(新闻|news|发生|最新)/i.test(lower)) topics.push('时事');
  if (/(音乐|music|song|歌|播放|听)/i.test(lower)) topics.push('音乐');
  if (/(游戏|game|玩|gaming|steam)/i.test(lower)) topics.push('游戏');
  if (/(电影|movie|film|视频|video|看片)/i.test(lower)) topics.push('影视');
  if (/(文件|file|folder|目录|路径|打开|保存)/i.test(lower)) topics.push('文件操作');
  if (/(设置|setting|配置|config|开关|toggle)/i.test(lower)) topics.push('系统设置');
  if (/(桌面|desktop|app|application|应用|程序|软件)/i.test(lower)) topics.push('桌面应用');
  if (/(邮件|email|mail|消息|message)/i.test(lower)) topics.push('通讯');
  if (/(文档|document|doc|ppt|excel|word|写作|write|笔记|note)/i.test(lower)) topics.push('文档/写作');

  // Deduplicate and limit
  return [...new Set(topics)].slice(0, 3);
}

/**
 * Build a topic continuity block for the system prompt.
 * Returns null if no recent topics exist.
 */
export function getTopicContext(conversationId: string): string | null {
  const db = readDB();
  if (!db.conversations) return null;
  const conv = db.conversations.find((c: Conversation) => c.id === conversationId);
  if (!conv?.recentTopics || conv.recentTopics.length === 0) return null;

  const topics = conv.recentTopics.slice(-5);
  const lastChange = conv.lastTopicChangeAt
    ? Math.round((Date.now() - new Date(conv.lastTopicChangeAt).getTime()) / (1000 * 60))
    : null;

  const lines: string[] = [];
  lines.push('\n## Conversation Topics');
  lines.push(`Recent topics discussed: ${topics.join(' → ')}.`);
  if (lastChange !== null && lastChange > 0) {
    lines.push(`Last topic change was ${lastChange} minutes ago.`);
  }
  lines.push('If the user references "that thing we discussed" or returns to a prior topic, check these recent topics for context.');

  return lines.join('\n');
}

export function getUnclosedConversation(userId: string, orgId?: string): Conversation | null {
  const db = readDB();
  if (!db.conversations) return null;
  const convs = db.conversations.filter(
    (c: Conversation) => {
      if (c.userId !== userId || c.status !== 'active') return false;
      if (orgId) return c.orgId === orgId;
      return (!c.orgId || c.orgId === '');
    }
  );
  if (convs.length === 0) return null;
  const conversation = convs.reduce((a: Conversation, b: Conversation) =>
    new Date(a.lastActiveAt).getTime() > new Date(b.lastActiveAt).getTime() ? a : b
  );
  if (isolateConversationSummaryForUse(conversation)) writeDB(db);
  return conversation;
}
