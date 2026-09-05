import { executionFeedbackCopy } from '../i18n/locales/executionFeedback';
import {
  containsInternalExecutionLanguage,
  sanitizePublicExecutionText,
  type PublicExecutionLanguage,
} from '../../shared/public_execution_language';

export type AgentResponseDelivery = {
  text?: string;
  finalized?: boolean;
  blocked?: boolean;
  reason?: string;
  status?: string;
};

const FAILURE_STATUS_RE = /^(?:blocked|cancelled|canceled|error|failed|timeout|timed_out)$/i;
const WAITING_STATUS_RE = /^(?:waiting_confirmation|waiting_for_confirmation)$/i;
const CHINESE_ACTION_SUCCESS_RE = new RegExp(
  [
    '(?:\\u5df2|\\u5df2\\u7ecf|\\u6210\\u529f|\\u73b0\\u5728\\u5df2)(?:\\u6253\\u5f00|\\u542f\\u52a8|\\u65b0\\u5efa|\\u521b\\u5efa|\\u5199\\u5165|\\u5199\\u597d|\\u4fdd\\u5b58|\\u53d1\\u9001|\\u53d1\\u51fa|\\u751f\\u6210|\\u5bfc\\u51fa|\\u4e0a\\u4f20|\\u4e0b\\u8f7d|\\u5b89\\u88c5|\\u5173\\u95ed|\\u5220\\u9664|\\u4fee\\u6539|\\u7ed8\\u5236|\\u6267\\u884c|\\u5b8c\\u6210|\\u63d0\\u53d6)',
    '(?:\\u6253\\u5f00|\\u542f\\u52a8|\\u65b0\\u5efa|\\u521b\\u5efa|\\u5199\\u5165|\\u5199\\u597d|\\u4fdd\\u5b58|\\u53d1\\u9001|\\u53d1\\u51fa|\\u751f\\u6210|\\u5bfc\\u51fa|\\u4e0a\\u4f20|\\u4e0b\\u8f7d|\\u5b89\\u88c5|\\u5173\\u95ed|\\u5220\\u9664|\\u4fee\\u6539|\\u7ed8\\u5236|\\u6267\\u884c|\\u63d0\\u53d6)(?:\\u6210\\u529f|\\u5b8c\\u6210|\\u597d\\u4e86|\\u5b8c\\u6bd5|\\u4e86)',
    '(?:\\u4efb\\u52a1|\\u64cd\\u4f5c|\\u5904\\u7406|\\u5de5\\u4f5c)(?:\\u5df2|\\u5df2\\u7ecf)?(?:\\u5b8c\\u6210|\\u6210\\u529f)',
  ].join('|'),
  'u',
);

const ENGLISH_ACTION_SUCCESS_RE =
  /\b(?:i(?:'ve| have)?|we(?:'ve| have)?|it(?:'s| has)?|the (?:task|operation|file|document|app|application))\s+(?:(?:has|have|is|was)\s+)?(?:been\s+)?(?:successfully\s+)?(?:opened|launched|started|created|wrote|written|saved|sent|generated|exported|uploaded|downloaded|installed|closed|deleted|updated|modified|drew|drawn|executed|completed|finished)\b|(?:^|[\n.!?]\s*)(?:successfully\s+)?(?:opened|launched|started|created|wrote|saved|sent|generated|exported|uploaded|downloaded|installed|closed|deleted|updated|modified|drew|executed|completed|finished)\b|\b(?:all done|task complete|task completed|operation complete|operation completed)\b/i;

const NEGATED_ACTION_RE =
  /(?:\u672a|\u6ca1\u6709|\u6ca1|\u5c1a\u672a|\u65e0\u6cd5|\u4e0d\u80fd|\u5e76\u672a|\u8fd8\u6ca1)(?:.{0,4}?)(?:\u6253\u5f00|\u542f\u52a8|\u65b0\u5efa|\u521b\u5efa|\u5199\u5165|\u4fdd\u5b58|\u53d1\u9001|\u751f\u6210|\u5bfc\u51fa|\u4e0a\u4f20|\u4e0b\u8f7d|\u5b89\u88c5|\u5173\u95ed|\u5220\u9664|\u4fee\u6539|\u7ed8\u5236|\u6267\u884c|\u5b8c\u6210|\u63d0\u53d6)|\b(?:not|never|unable to|could not|couldn't|did not|didn't|has not|hasn't|have not|haven't|failed to)\b.{0,32}?\b(?:open|launch|start|create|write|save|send|generate|export|upload|download|install|close|delete|update|modify|draw|execute|complete|finish)\b/giu;

export function isActionSuccessClaim(text: string): boolean {
  const clean = String(text || '').trim();
  if (!clean) return false;
  const positiveOnly = clean.replace(NEGATED_ACTION_RE, ' ');
  return CHINESE_ACTION_SUCCESS_RE.test(positiveOnly) || ENGLISH_ACTION_SUCCESS_RE.test(positiveOnly);
}

export function isAgentResponseBlocked(data: AgentResponseDelivery): boolean {
  return data.blocked === true || FAILURE_STATUS_RE.test(String(data.status || '').trim());
}

/**
 * A terminal notice must remain visible even when it quotes the part of an
 * operation that did succeed. For example, "the file was written, but its
 * readback failed" contains a concrete success fragment while the response as
 * a whole is the only user-visible blocker receipt. Silencing that receipt
 * strands the request in a perpetual-looking busy state.
 */
export function isAgentResponseTerminalNotice(data: AgentResponseDelivery): boolean {
  const status = String(data.status || '').trim();
  const reason = String(data.reason || '').trim();
  return isAgentResponseBlocked(data)
    || WAITING_STATUS_RE.test(status)
    || WAITING_STATUS_RE.test(reason);
}

export function isUnverifiedActionClaim(data: AgentResponseDelivery): boolean {
  return isActionSuccessClaim(String(data.text || ''))
    && data.finalized !== true
    && !isAgentResponseTerminalNotice(data);
}

export function shouldDisplayAgentResponse(data: AgentResponseDelivery): boolean {
  return Boolean(String(data.text || '').trim()) && !isUnverifiedActionClaim(data);
}

export function shouldSpeakAgentResponse(data: AgentResponseDelivery): boolean {
  if (!shouldDisplayAgentResponse(data)) return false;
  if (isAgentResponseBlocked(data)) {
    const text = String(data.text || '').trim();
    return data.finalized === true
      && Boolean(text)
      && !containsInternalExecutionLanguage(text);
  }
  return !isActionSuccessClaim(String(data.text || '')) || data.finalized === true;
}

/**
 * The backend normally sends customer-ready prose. This final client boundary
 * also protects restored legacy conversations and late events from an older
 * backend process, without truncating or rewriting ordinary Markdown replies.
 */
export function sanitizeAgentResponseTextForDisplay(
  value: unknown,
  language?: PublicExecutionLanguage,
): string {
  return sanitizePublicExecutionText(value, language);
}

/**
 * Buffers the very beginning of a streamed reply until there is enough text
 * to distinguish normal prose from a leaked execution report. The terminal
 * response still replaces this preview, so short conversational replies are
 * not lost; they simply appear when finalized instead of flashing an unsafe
 * partial heading such as `Status:` or `状态：`.
 */
export function sanitizeAgentStreamingTextForDisplay(
  value: unknown,
  language?: PublicExecutionLanguage,
): string {
  const text = String(value || '');
  if (!text) return '';
  if (containsInternalExecutionLanguage(text)) {
    return sanitizePublicExecutionText(text, language);
  }
  return Array.from(text).length < 24 ? '' : text;
}

export function hasInternalAgentExecutionDetail(value: unknown): boolean {
  return containsInternalExecutionLanguage(value);
}

export function isFinalizedSuccessfulResponse(data: AgentResponseDelivery): boolean {
  return data.finalized === true && !isAgentResponseBlocked(data);
}

export function isTerminalAgentStatus(status: string): boolean {
  const normalized = String(status || '').trim().toLowerCase();
  return normalized === 'idle' || FAILURE_STATUS_RE.test(normalized);
}

/** User-facing workflow detail. Never render the backend finalizer's internal
 * diagnostic sentence directly; the response body already carries the useful
 * blocker/result, while this line explains the next actionable state. */
export function describeAgentResponseDelivery(
  data: AgentResponseDelivery,
  isZh: boolean,
): string {
  const copy = executionFeedbackCopy(isZh ? 'zh' : 'en');
  const reason = String(data.reason || '').trim().toLowerCase();
  if (WAITING_STATUS_RE.test(reason) || WAITING_STATUS_RE.test(String(data.status || ''))) {
    return copy.confirmation;
  }
  if (/^(?:cancelled|canceled|request_cancelled)$/.test(reason)) {
    return copy.cancelled;
  }
  if (reason === 'uncertain_external_outcome') {
    return copy.uncertainExternal;
  }
  if (reason === 'execution_capability_unavailable') {
    return copy.capabilityUnavailable;
  }
  if (reason === 'target_mismatch' || /\btarget_mismatch\b/i.test(String(data.text || ''))) {
    return copy.targetChanged;
  }
  const text = String(data.text || '').replace(/\s+/g, ' ').trim();
  if (text && !containsInternalExecutionLanguage(text)) return text.slice(0, 160);
  if (text) return sanitizePublicExecutionText(text, isZh ? 'zh' : 'en').slice(0, 160);
  return copy.retainedBlocker;
}
