import { type Conversation, type MessageRecord } from "./manager/contracts";
import { isolateLegacyGuardSummaryState, isGuardGeneratedAssistantText, isGuardGeneratedConversationRecord } from './guard_history';
import { readDatabaseTables, commitDatabaseTables } from '../../db_layer';
import { getMessages } from "./manager/message_history";
import { sanitizeSummaryForPrompt } from './summary_grounding';

export function isolateConversationSummaryForUse(conv: Conversation): boolean {
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

export function isStandaloneGuardOutput(value: unknown): boolean {
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
  const db = readDatabaseTables(["conversations"]);
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
    if (summaryWasIsolated) commitDatabaseTables(db);
    return emptyResult(conv);
  }
  const hadPersistedMarker = Number.isFinite(Number(conv.lastSummaryMessageCount))
    && Number(conv.lastSummaryMessageCount) >= 0;
  const lastCount = normalizedLastSummaryMessageCount(conv);
  if (summaryWasIsolated || !hadPersistedMarker) commitDatabaseTables(db);
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

  const db = readDatabaseTables(["conversations"]);
  const conv = (db.conversations || []).find((item: Conversation) => item.id === conversationId);
  if (!conv || through > conv.messageCount) return false;
  const summaryWasIsolated = isolateConversationSummaryForUse(conv);
  const markerBeforeNormalization = Number(conv.lastSummaryMessageCount);
  const lastCount = normalizedLastSummaryMessageCount(conv);
  if (
    summaryWasIsolated
    || !Number.isFinite(markerBeforeNormalization)
    || markerBeforeNormalization < 0
  ) commitDatabaseTables(db);
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
  const db = readDatabaseTables(["conversations"]);
  if (!db.conversations) return false;
  const conv = db.conversations.find((c: Conversation) => c.id === conversationId);
  if (!conv) return false;
  const priorSummaryWasIsolated = isolateConversationSummaryForUse(conv);
  const cleanSummary = String(summary || '').trim();
  // The source transcript is filtered by record metadata before summarization.
  // Keep a final defense against a verbatim guard response, but do not reject a
  // legitimate mixed summary merely because it describes a historical error.
  if (!cleanSummary || isStandaloneGuardOutput(cleanSummary)) {
    if (priorSummaryWasIsolated) commitDatabaseTables(db);
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
  commitDatabaseTables(db);
  return true;
}

/**
 * Get full conversation context: recent summary + older layers.
 * Returns formatted string suitable for system prompt injection.
 */
export function getConversationSummary(conversationId: string): string | null {
  const db = readDatabaseTables(["conversations"]);
  if (!db.conversations) return null;
  const conv = db.conversations.find((c: Conversation) => c.id === conversationId);
  if (!conv) return null;
  if (isolateConversationSummaryForUse(conv)) commitDatabaseTables(db);

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
  const db = readDatabaseTables(["conversations"]);
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
  commitDatabaseTables(db);
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
  const db = readDatabaseTables(["conversations"]);
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
