import { listConversationFocusThreads, updateConversationFocusThread, type ConversationFocusThread } from './focus_threads';
import { readDatabaseTables, commitDatabaseTables } from '../../db_layer';
import { formatConversationActionTaskStatus, needsRecentActionContinuationContext, normalizeConversationActionState, type ConversationActionContinuationState } from '../cognition/action_continuation';
import { formatConversationActionLedgerStatus } from "./ledger/status";
import { finalizeConversationActionTask } from "./ledger/task_lifecycle";
import { type Conversation, type ConversationTurnOptions, type ConversationTurnResult, type MessageRecord } from "./manager/contracts";
import { getMessages, isPromptEligibleMessage } from "./manager/message_history";
import { isUnverifiedExecutionAssistantRecord, isUnverifiedExecutionAssistantText, sanitizeSummaryForPrompt } from './summary_grounding';
import { isGuardGeneratedAssistantText } from './guard_history';
import { hydrateConversationActionState, compactRolloverText } from "./action_state_hydration";
import { isolateConversationSummaryForUse, isStandaloneGuardOutput } from "./summary_state";
import { cancelManagerActionTurns, finalizeConversationActionRequestInDb } from "./action_execution_runtime";

/** Exact read-only completion inputs; this never hydrates, admits or replays a task. */
export function getConversationCompletionSnapshot(input: { userId?: string; conversationId?: string; taskId?: string; requestId?: string; domain?: string; orgId?: string }) {
  if (!input.userId || !input.conversationId || !input.taskId || !input.requestId) return null;
  const db = readDatabaseTables(["conversationActionTasks","interactions","conversationActionReceipts","conversationActionTurns"]);
  const task = (db.conversationActionTasks || []).find(row => row.id === input.taskId && row.userId === input.userId
    && row.conversationId === input.conversationId && (row.domain || 'personal') === (input.domain || 'personal') && (row.orgId || '') === (input.orgId || ''));
  if (!task) return null;
  const root = (db.interactions || []).find(row => row.id === task.rootUserMessageId && row.userId === task.userId && row.conversationId === task.conversationId && row.role === 'user');
  const turns = (db.conversationActionTurns || []).filter(row => row.taskId === task.id && row.userId === task.userId && row.conversationId === task.conversationId
    && (row.domain || 'personal') === (task.domain || 'personal') && (row.orgId || '') === (task.orgId || ''));
  const currentTurn = turns.find(row => row.requestId === input.requestId && ['accepted','leased'].includes(row.status));
  const receipts = (db.conversationActionReceipts || []).filter(row => row.taskId === task.id && row.conversationId === task.conversationId
    && turns.some(turn => turn.id === row.turnRowId && turn.requestId === row.requestId));
  return { task, root, currentTurn, turns, receipts };
}

export function getConversationFocusThreads(input: {
  userId: string;
  domain?: string;
  orgId?: string;
  includeTerminal?: boolean;
}): ConversationFocusThread[] {
  return listConversationFocusThreads(readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]), input);
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
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  const focus = updateConversationFocusThread(db, input);
  if (focus) commitDatabaseTables(db);
  return focus;
}

export function getConversationActionStatus(
  conversationId: string,
  userId: string,
  query = '',
  fallbackState?: ConversationActionContinuationState | null,
  taskId = '',
): string {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  return formatConversationActionLedgerStatus(db, { conversationId, userId, query, taskId })
    || formatConversationActionTaskStatus(fallbackState);
}

function resolveConversationScope(domainOrOrgId?: string, orgIdMaybe?: string): { domain: 'personal' | 'work'; orgId: string } {
  if (domainOrOrgId === 'personal') return { domain: 'personal', orgId: '' };
  if (domainOrOrgId === 'work') return { domain: 'work', orgId: orgIdMaybe || '' };
  return {
    domain: domainOrOrgId ? 'work' : 'personal',
    orgId: domainOrOrgId || '',
  };
}

export function conversationMatchesScope(c: Conversation, domainOrOrgId?: string, orgIdMaybe?: string): boolean {
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
  query = '',
): Conversation | null {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  const conversation = (db.conversations || []).find((item: Conversation) => item.id === conversationId);
  if (!conversation || conversation.userId !== userId) return null;
  if (!conversationMatchesScope(conversation, domain, orgId)) return null;
  hydrateConversationActionState(db, conversation, query);
  isolateConversationSummaryForUse(conversation);
  commitDatabaseTables(db);
  return conversation;
}

/** All entry points share the same empty transcript defaults and storage identity. */
function newConversationRecord(
  userId: string, agentId: string | undefined, scope: { domain: 'personal' | 'work'; orgId: string },
  status: Conversation['status'], now: string,
  continuity: Partial<Pick<Conversation, 'mode' | 'summary' | 'recentTopics' | 'lastTopicChangeAt'>> = {},
): Conversation {
  return {
    id: 'conv_' + crypto.randomUUID(), userId, agentId: agentId || '', title: '', status,
    summary: '', summaryChain: [], lastSummaryMessageCount: 0, messageCount: 0,
    lastActiveAt: now, createdAt: now, ...continuity, domain: scope.domain, orgId: scope.orgId,
  };
}

export function getOrCreateActiveConversation(userId: string, agentId?: string, domain?: string, orgId?: string): Conversation {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
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
    isolateConversationSummaryForUse(active);
    commitDatabaseTables(db);
    return active;
  }

  const now = new Date().toISOString();
  const conv: Conversation = newConversationRecord(userId, agentId, scope, 'active', now);
  db.conversations.push(conv);
  commitDatabaseTables(db);
  return conv;
}

/**
 * Start an empty active conversation without deleting the archived transcript or
 * its durable task ledger. In-flight work may finish against the archived
 * conversation while later chat turns are isolated in the new conversation.
 */
export function startNewConversation(userId: string, agentId?: string, domain?: string, orgId?: string): Conversation {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
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

  const conversation: Conversation = newConversationRecord(userId, agentId, scope, 'active', now);
  db.conversations.push(conversation);
  commitDatabaseTables(db);
  return conversation;
}

/**
 * Create an explicitly-bound conversation without changing the user's active
 * conversation. Formal E2E and other diagnostic callers must always send the
 * returned conversationId; the closed status keeps it out of normal active
 * conversation selection while still allowing bound turns to run.
 */
export function startIsolatedConversation(userId: string, agentId?: string, domain?: string, orgId?: string, surface?: 'creation'): Conversation {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  if (!db.conversations) db.conversations = [];
  const scope = resolveConversationScope(domain, orgId);
  const now = new Date().toISOString();
  const conversation: Conversation = newConversationRecord(userId, agentId, scope, 'closed', now);
  if (surface) conversation.surface = surface;
  db.conversations.push(conversation);
  commitDatabaseTables(db);
  return conversation;
}

export interface DeletedConversationData {
  conversationId: string;
  interactions: number;
  actionTasks: number;
  actionTurns: number;
  actionReceipts: number;
  routingReceipts: number;
}

/** Delete only records carrying the exact, already-authorized conversation id. */
export function deleteConversationData(
  conversationId: string,
  userId: string,
  domain?: string,
  orgId?: string,
): DeletedConversationData | null {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
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
  commitDatabaseTables(db);

  return {
    conversationId,
    interactions: before.interactions - db.interactions.length,
    actionTasks: before.actionTasks - db.conversationActionTasks.length,
    actionTurns: before.actionTurns - db.conversationActionTurns.length,
    actionReceipts: before.actionReceipts - db.conversationActionReceipts.length,
    routingReceipts: before.routingReceipts - db.modelRoutingReceipts.length,
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

  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
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

  const next = newConversationRecord(userId, agentId, resolveConversationScope(domain, orgId), 'active', now, {
    mode: active.mode, summary: continuitySummary,
    recentTopics: active.recentTopics ? [...active.recentTopics] : undefined,
    lastTopicChangeAt: active.lastTopicChangeAt,
  });
  db.conversations.push(next);
  commitDatabaseTables(db);

  return {
    conversation: next,
    rolledOver: true,
    previousConversationId: active.id,
  };
}

export function closeConversation(conversationId: string, summary?: string, userId?: string): Conversation | null {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
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
  commitDatabaseTables(db);
  return conv;
}

export function getActiveConversation(userId: string, agentId?: string, domainOrOrgId?: string, orgIdMaybe?: string): Conversation | null {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  if (!db.conversations) return null;
  const active = db.conversations
    .filter((c: Conversation) => {
      if (c.userId !== userId) return false;
      if (c.surface === 'creation') return false;
      if (agentId && c.agentId !== agentId) return false;
      if (c.status !== 'active') return false;
      return conversationMatchesScope(c, domainOrOrgId, orgIdMaybe);
    })
    .sort((a: Conversation, b: Conversation) =>
      new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
    )[0] || null;
  if (active) hydrateConversationActionState(db, active);
  if (active) { isolateConversationSummaryForUse(active); commitDatabaseTables(db); }
  return active;
}

export function setConversationMode(conversationId: string, mode: string): void {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  if (!db.conversations) return;
  const conv = db.conversations.find((c: Conversation) => c.id === conversationId);
  if (!conv) return;
  conv.mode = mode;
  conv.lastActiveAt = new Date().toISOString();
  commitDatabaseTables(db);
}

export function getUserConversations(
  userId: string,
  limit = 20,
  offset = 0,
  domainOrOrgId?: string,
  orgIdMaybe?: string,
  agentId?: string,
  surface: 'chat' | 'creation' = 'chat',
): Conversation[] {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  if (!db.conversations) return [];
  const conversations = db.conversations
    .filter((c: Conversation) => {
      if (c.userId !== userId) return false;
      if ((c.surface || 'chat') !== surface) return false;
      if (agentId && c.agentId !== agentId) return false;
      return conversationMatchesScope(c, domainOrOrgId, orgIdMaybe);
    })
    .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
    .slice(offset, offset + limit);
  for (const conversation of conversations) {
    hydrateConversationActionState(db, conversation);
    isolateConversationSummaryForUse(conversation);
  }
  commitDatabaseTables(db);
  return conversations;
}

export function activateConversation(
  conversationId: string,
  userId: string,
  agentId: string,
  domainOrOrgId?: string,
  orgIdMaybe?: string,
): Conversation | null {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  if (!db.conversations) return null;
  const target = db.conversations.find((conversation: Conversation) => (
    conversation.id === conversationId
    && conversation.userId === userId
    && conversation.agentId === agentId
    && conversation.surface !== 'creation'
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
  commitDatabaseTables(db);
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

export function getMessagesForAgent(userId: string, agentId: string, limit = 500): MessageRecord[] {
  const conv = getActiveConversation(userId, agentId);
  if (!conv) return [];
  return getMessages(conv.id, limit);
}
