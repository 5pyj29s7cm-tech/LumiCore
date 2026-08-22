import { readDB, writeDB } from '../../db_layer';
import { estimateTokenCount } from '../llm/providers';
import {
  buildConversationActionContinuationState,
  classifyToolRecordTaskDurability,
  classifyRecentActionFollowupIntent,
  formatConversationActionTaskStatus,
  isUserObservedTaskCompletion,
  needsRecentActionContinuationContext,
  normalizeConversationActionState,
  prepareConversationActionTaskState,
  type ConversationActionContinuationState,
} from '../cognition/action_continuation';
import { taskCompletionFromReceipts } from '../cognition/task_execution_ledger';
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
import {
  formatConversationActionLedgerStatus,
  attachConversationExecutionPlan,
  attachConversationModelExecutionGraph,
  loadConversationModelExecutionRecovery,
  migrateLegacyConversationActionLedger,
  recoverConversationActionTaskLeases,
  repairContradictoryConversationActionReceipts,
  compactLegacyScheduledCapabilityExecutions,
  archiveBoundConversationActionReceipts,
  getConversationActionStateFromLedger,
  syncConversationActionTaskLedger,
} from './action_ledger';
import type { CapabilityExecutionPlan } from '../cognition/capability_execution_plan';
import type { WorkflowResult } from '../agents/orchestrator';
import {
  listConversationFocusThreads,
  updateConversationFocusThread,
  type ConversationFocusThread,
} from './focus_threads';

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
  const existingUpdatedAt = existing ? Date.parse(existing.updatedAt) : Number.NaN;
  const ledgerUpdatedAt = ledgerState ? Date.parse(ledgerState.updatedAt) : Number.NaN;
  const newestRuntimeState = existing && ledgerState
    ? (existing.taskId === ledgerState.taskId
      && Number.isFinite(ledgerUpdatedAt)
      && (!Number.isFinite(existingUpdatedAt) || ledgerUpdatedAt > existingUpdatedAt)
        ? ledgerState
        : existing)
    : existing || (ledgerState?.unfinished ? ledgerState : null);
  const state = resolveHistoricalTask
    ? ledgerState || existing
    : newestRuntimeState;
  if (state) conversation.actionContinuationState = state;
  else delete conversation.actionContinuationState;
  return state;
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
  /** Structured model/runtime classification for durable task ownership. */
  taskIntent?: 'task' | 'conversation' | '';
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
  conv.status = 'closed';
  conv.summary = summary || '';
  conv.lastActiveAt = new Date().toISOString();
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

export function prepareConversationActionExecution(input: {
  conversationId: string;
  userId: string;
  userText: string;
  requestId: string;
  toolPolicy: ToolPolicy;
  forceResume?: boolean;
  forceNewTask?: boolean;
  forceTask?: boolean;
}): ReturnType<typeof prepareConversationActionTaskState> {
  const db = readDB();
  const conversation = (db.conversations || []).find((item: Conversation) => (
    item.id === input.conversationId && item.userId === input.userId
  ));
  if (!conversation) return { state: null, kind: 'conversation' };
  hydrateConversationActionState(db, conversation, input.userText);
  const prepared = prepareConversationActionTaskState(conversation.actionContinuationState, input);
  if (prepared.state !== conversation.actionContinuationState) {
    if (prepared.state) conversation.actionContinuationState = prepared.state;
    else delete conversation.actionContinuationState;
    conversation.lastActiveAt = new Date().toISOString();
    if (prepared.state) {
      syncConversationActionTaskLedger(db, {
        conversation,
        state: prepared.state,
        userText: input.userText,
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
  const db = readDB();
  const task = attachConversationModelExecutionGraph(db, {
    conversationId: input.conversationId,
    userId: input.userId,
    taskId: input.taskId,
    graph: input.workflowResult.executionGraph,
    receipts: input.workflowResult.nodeReceipts || [],
    arbitrationReceipt: input.workflowResult.arbitrationReceipt,
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
  return loadConversationModelExecutionRecovery(readDB(), {
    conversationId: input.conversationId,
    userId: input.userId,
    taskId: input.taskId,
  });
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
  conversation.actionContinuationState = {
    ...previous,
    version: 2,
    status: 'cancelled',
    unfinished: false,
    latestBlocker: '',
    assistantState: reason,
    activeRequestId: undefined,
    revision: (previous.revision || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  delete conversation.pendingActionContinuation;
  syncConversationActionTaskLedger(db, {
    conversation,
    state: conversation.actionContinuationState,
  });
  writeDB(db);
  return conversation.actionContinuationState;
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
  conversation.actionContinuationState = {
    ...previous,
    version: 2,
    status: 'completed',
    unfinished: false,
    latestBlocker: '',
    assistantState: userText.replace(/\s+/g, ' ').trim().slice(0, 700),
    activeRequestId: undefined,
    completionSource: 'user_observation',
    revision: (previous.revision || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  syncConversationActionTaskLedger(db, {
    conversation,
    state: conversation.actionContinuationState,
    userText,
  });
  writeDB(db);
  return conversation.actionContinuationState;
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
  if (!conversation || !previous || previous.activeRequestId !== requestId) return previous;

  const completion = taskCompletionFromReceipts(previous.goal, previous.receipts || []);
  const stillRunning = previous.status === 'planning' || previous.status === 'executing';
  const status = completion.complete
    ? 'completed'
    : stillRunning
      ? 'blocked'
      : previous.status;
  conversation.actionContinuationState = {
    ...previous,
    status,
    unfinished: status !== 'completed' && status !== 'cancelled',
    latestBlocker: status === 'blocked'
      ? previous.latestBlocker || completion.blocker || fallbackBlocker
      : '',
    completionSource: completion.complete ? 'tool_receipt' : previous.completionSource,
    activeRequestId: undefined,
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

/**
 * Foreground request leases are process-local. After a backend restart there
 * is no executor that can still own a persisted planning/executing state, and
 * one-time confirmations have also expired from memory. Convert those states
 * to resumable blockers instead of telling the next turn that old work is
 * still running.
 */
export function recoverOrphanedConversationActionExecutions(
  now = new Date().toISOString(),
): number {
  const db = readDB();
  const migrated = migrateLegacyConversationActionLedger(db);
  const recoveredLedgerLeases = recoverConversationActionTaskLeases(db, now);
  const repairedReceipts = repairContradictoryConversationActionReceipts(db);
  const schedulerCompaction = compactLegacyScheduledCapabilityExecutions(db);
  let recovered = 0;
  for (const conversation of db.conversations || []) {
    hydrateConversationActionState(db, conversation);
    const previous = normalizeConversationActionState(conversation.actionContinuationState);
    if (
      !previous?.unfinished
      || !['planning', 'executing', 'waiting_confirmation'].includes(previous.status || '')
    ) continue;
    const waitingForExpiredConfirmation = previous.status === 'waiting_confirmation';
    conversation.actionContinuationState = {
      ...previous,
      version: 2,
      status: 'blocked',
      unfinished: true,
      latestBlocker: waitingForExpiredConfirmation
        ? 'The pending confirmation expired when the previous runtime ended.'
        : 'The previous runtime ended before this task reached a terminal receipt.',
      activeRequestId: undefined,
      revision: (previous.revision || 0) + 1,
      updatedAt: now,
    };
    delete conversation.pendingActionContinuation;
    syncConversationActionTaskLedger(db, {
      conversation,
      state: conversation.actionContinuationState,
      now,
    });
    recovered += 1;
  }
  if (
    migrated > 0
    || recoveredLedgerLeases > 0
    || repairedReceipts > 0
    || schedulerCompaction.tasksRemoved > 0
    || recovered > 0
  ) writeDB(db);
  return recoveredLedgerLeases + recovered;
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
  conversation.actionContinuationState = {
    ...previous,
    version: 2,
    status,
    unfinished: status !== 'completed' && status !== 'cancelled',
    latestBlocker: options.blocker !== undefined ? options.blocker : previous.latestBlocker,
    assistantState: options.assistantState !== undefined
      ? options.assistantState
      : previous.assistantState,
    activeRequestId: options.requestId !== undefined
      ? options.requestId || undefined
      : previous.activeRequestId,
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
  /** Explicit structured intent emitted by the model/runtime for this reply. */
  taskIntent?: 'task' | 'conversation';
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
    taskIntent: msg.taskIntent || '',
    timestamp: now,
  };

  if (!db.interactions) db.interactions = [];
  db.interactions.push(interaction);

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

      if (!msg.skipActionContinuation && msg.role === 'user') {
        const userText = String(msg.content || '').trim();
        if (userText) {
          const userObservedCompletion = isUserObservedTaskCompletion(
            userText,
            conv.actionContinuationState,
          );
          const continuationTurn = needsRecentActionContinuationContext(userText);
          const contract = buildActionContract(userText);
          const actionTurn = contract.applies && contract.kind !== 'none';
          const preparedSameTurn = Boolean(
            conv.actionContinuationState
            && conv.actionContinuationState.latestInstruction === userText
            && ['planning', 'executing', 'waiting_confirmation'].includes(
              conv.actionContinuationState.status || '',
            ),
          );
          if (userObservedCompletion && conv.actionContinuationState) {
            conv.actionContinuationState = {
              ...conv.actionContinuationState,
              version: 2,
              status: 'completed',
              unfinished: false,
              latestBlocker: '',
              assistantState: userText.replace(/\s+/g, ' ').trim().slice(0, 700),
              activeRequestId: undefined,
              completionSource: 'user_observation',
              revision: (conv.actionContinuationState.revision || 0) + 1,
              updatedAt: now,
            };
            delete conv.pendingActionContinuation;
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
        const activeTaskId = String(conv.actionContinuationState?.taskId || '');
        const activeRequestId = String(conv.actionContinuationState?.activeRequestId || pending.requestId || '');
        const records = normalizedToolCalls || [];
        const staleRecords = records.filter((record: any) => (
          (record?.taskId && activeTaskId && record.taskId !== activeTaskId)
          || (record?.requestId && activeRequestId && record.requestId !== activeRequestId)
        ));
        if (staleRecords.length) {
          archiveBoundConversationActionReceipts(db, {
            conversationId: conv.id,
            userId: conv.userId,
            records: staleRecords,
            turnId: msg.requestId,
            now,
          });
        }
        const currentToolRecords = records.filter(record => !staleRecords.includes(record));
        const requestMismatch = Boolean(
          pending.requestId
          && msg.requestId
          && pending.requestId !== msg.requestId,
        );
        // A superseded pipeline may still finish and persist its terminal
        // reply. Archive its bound receipts above, but leave the newer turn's
        // pending pointer and state untouched.
        if (requestMismatch || (records.length > 0 && currentToolRecords.length === 0)) {
          if (conv.actionContinuationState) {
            syncConversationActionTaskLedger(db, {
              conversation: conv,
              state: conv.actionContinuationState,
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
          const nextState = buildConversationActionContinuationState({
            previous: conv.actionContinuationState,
            userText: pending.userText,
            assistantText: msg.content,
            toolCalls: currentToolRecords,
            updatedAt: now,
            evidenceMessageId: id,
            requestId: conv.actionContinuationState?.activeRequestId,
            toolPolicy: conv.actionContinuationState?.policySnapshot,
          });
          if (nextState) conv.actionContinuationState = nextState;
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
            conv.actionContinuationState = {
              ...prepared.state,
              status: 'blocked',
              latestBlocker: 'No terminal tool receipt was recorded for the requested step.',
              assistantState: compactRolloverText(msg.content, 700),
              revision: (prepared.state.revision || 0) + 1,
              updatedAt: now,
            };
          }
        } else if (
          conv.actionContinuationState?.unfinished
          && pendingExpectsExecution
        ) {
          conv.actionContinuationState = {
            ...conv.actionContinuationState,
            version: 2,
            status: 'blocked',
            latestBlocker: 'No terminal tool receipt was recorded for the requested step.',
            assistantState: String(msg.content || '').replace(/\s+/g, ' ').trim().slice(0, 700),
            revision: (conv.actionContinuationState.revision || 0) + 1,
            updatedAt: now,
          };
        }
        delete conv.pendingActionContinuation;
      }

      if (conv.actionContinuationState) {
        syncConversationActionTaskLedger(db, {
          conversation: conv,
          state: conv.actionContinuationState,
          userText: msg.role === 'user'
            ? String(msg.content || '')
            : conv.actionContinuationState.latestInstruction,
          rootUserMessageId: msg.role === 'user'
            ? id
            : conv.actionContinuationState.evidenceMessageId,
          now,
        });
      }
    }
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
  if (existing) return existing.id;

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
  let current = value;
  for (let depth = 0; depth < 2 && typeof current === 'string' && current.trim(); depth += 1) {
    try {
      current = JSON.parse(current);
    } catch {
      return undefined;
    }
  }
  return Array.isArray(current) && current.length > 0 ? current : undefined;
}

function isPromptEligibleMessage(m: MessageRecord): boolean {
  if (!m) return false;
  if (m.role === 'tool' || m.mode === 'proactive') return false;
  if (isGuardGeneratedConversationRecord(m)) return false;
  return Boolean((m.message || '').trim() || (m.response || '').trim());
}

function compactRecordForPrompt(m: MessageRecord): MessageRecord {
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
