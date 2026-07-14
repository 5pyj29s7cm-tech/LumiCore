import { readDB, writeDB } from '../../db_layer';
import { estimateTokenCount } from '../llm/providers';

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
  /** Provider message identity used to keep asynchronous remote turns ordered. */
  externalMessageId?: string;
  /** Monotonic sequence within one external conversation. */
  routeSequence?: number;
  /** Time the remote transport received the message. */
  receivedAt?: string;
  timestamp: string;
}

function resolveConversationScope(domainOrOrgId?: string, orgIdMaybe?: string): { domain: string; orgId: string } {
  if (domainOrOrgId === 'personal') return { domain: 'personal', orgId: '' };
  if (domainOrOrgId === 'work') return { domain: 'work', orgId: orgIdMaybe || '' };
  return {
    domain: domainOrOrgId ? 'work' : 'personal',
    orgId: domainOrOrgId || '',
  };
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
  return conversationMatchesScope(conversation, domain, orgId) ? conversation : null;
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
  if (active) return active;

  const id = 'conv_' + crypto.randomUUID();
  const now = new Date().toISOString();
  const conv: Conversation = {
    id,
    userId,
    agentId: agentId || '',
    title: '',
    status: 'active',
    summary: '',
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
  return db.conversations
    .filter((c: Conversation) => {
      if (c.userId !== userId) return false;
      if (agentId && c.agentId !== agentId) return false;
      if (c.status !== 'active') return false;
      return conversationMatchesScope(c, domainOrOrgId, orgIdMaybe);
    })
    .sort((a: Conversation, b: Conversation) =>
      new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime()
    )[0] || null;
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

export function getUserConversations(userId: string, limit = 20, offset = 0, domainOrOrgId?: string, orgIdMaybe?: string): Conversation[] {
  const db = readDB();
  if (!db.conversations) return [];
  return db.conversations
    .filter((c: Conversation) => {
      if (c.userId !== userId) return false;
      return conversationMatchesScope(c, domainOrOrgId, orgIdMaybe);
    })
    .sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime())
    .slice(offset, offset + limit);
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
  externalMessageId?: string;
  routeSequence?: number;
  receivedAt?: string;
}): string {
  const db = readDB();
  const id = 'msg_' + crypto.randomUUID();
  const now = new Date().toISOString();

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
    toolCalls: normalizeToolCalls(msg.toolCalls),
    domain: msg.domain || 'personal',
    orgId: msg.orgId || '',
    source: msg.source || '',
    channel: msg.channel || '',
    externalMessageId: msg.externalMessageId || '',
    routeSequence: Number.isFinite(msg.routeSequence) ? msg.routeSequence : undefined,
    receivedAt: msg.receivedAt || '',
    timestamp: now,
  };

  if (!db.interactions) db.interactions = [];
  db.interactions.push(interaction);

  // Update conversation messageCount and lastActiveAt
  if (msg.conversationId && db.conversations) {
    const conv = db.conversations.find((c: Conversation) => c.id === msg.conversationId);
    if (conv) {
      conv.messageCount = (conv.messageCount || 0) + 1;
      conv.lastActiveAt = now;
      // Auto-title from first user message
      if (!conv.title && msg.role === 'user' && msg.content?.trim()) {
        conv.title = msg.content.trim().slice(0, 80);
      }
    }
  }

  writeDB(db);
  return id;
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
  return Boolean((m.message || '').trim() || (m.response || '').trim());
}

function compactRecordForPrompt(m: MessageRecord): MessageRecord {
  return {
    ...m,
    message: compactPromptText(m.message || '', CONTEXT_MESSAGE_CHAR_LIMIT),
    response: compactPromptText(m.response || '', CONTEXT_RESPONSE_CHAR_LIMIT),
    toolCalls: undefined,
  };
}

export function getMessages(conversationId: string, limit = 1000): MessageRecord[] {
  const db = readDB();
  if (!db.interactions) return [];
  const rows = db.interactions
    .filter((i: any) => i.conversationId === conversationId)
    .sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

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

/**
 * Check if a conversation needs auto-summarization.
 * Returns the conversation and older messages if threshold exceeded.
 */
export function checkAutoSummary(
  conversationId: string,
): { needed: boolean; conversation: Conversation | null; recentMessages: MessageRecord[] } {
  const db = readDB();
  if (!db.conversations) return { needed: false, conversation: null, recentMessages: [] };
  const conv = db.conversations.find((c: Conversation) => c.id === conversationId);
  if (!conv || conv.messageCount < AUTO_SUMMARY_THRESHOLD) {
    return { needed: false, conversation: conv || null, recentMessages: [] };
  }
  // Only summarize if last summary was more than 20 messages ago (avoid re-summarizing every message)
  const recentMessages = getMessages(conversationId, 40);
  return { needed: true, conversation: conv, recentMessages };
}

/**
 * Store a conversation summary. Maintains a multi-level chain (max 3).
 * Newest summary becomes conv.summary; older ones move into summaryChain.
 */
export function setConversationSummary(conversationId: string, summary: string): void {
  const db = readDB();
  if (!db.conversations) return;
  const conv = db.conversations.find((c: Conversation) => c.id === conversationId);
  if (!conv) return;

  // Push current summary into chain before overwriting
  if (conv.summary && conv.summary !== summary) {
    if (!conv.summaryChain) conv.summaryChain = [];
    conv.summaryChain.push(conv.summary);
    // Keep max 2 in chain (plus current summary = 3 total layers)
    if (conv.summaryChain.length > 2) {
      // Merge oldest two into one to keep chain bounded
      conv.summaryChain = [conv.summaryChain.slice(0, 2).join(' | ')];
    }
  }

  conv.summary = summary;
  writeDB(db);
}

/**
 * Get full conversation context: recent summary + older layers.
 * Returns formatted string suitable for system prompt injection.
 */
export function getConversationSummary(conversationId: string): string | null {
  const db = readDB();
  if (!db.conversations) return null;
  const conv = db.conversations.find((c: Conversation) => c.id === conversationId);
  if (!conv || !conv.summary) return null;

  const parts: string[] = [conv.summary];
  if (conv.summaryChain && conv.summaryChain.length > 0) {
    parts.push('Earlier: ' + conv.summaryChain.join(' | '));
  }
  return parts.join('\n');
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
  return convs.reduce((a: Conversation, b: Conversation) =>
    new Date(a.lastActiveAt).getTime() > new Date(b.lastActiveAt).getTime() ? a : b
  );
}
