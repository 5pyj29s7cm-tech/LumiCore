export type AgentResponseDelivery = {
  text?: string;
  finalized?: boolean;
  blocked?: boolean;
  reason?: string;
  status?: string;
};

const FAILURE_STATUS_RE = /^(?:blocked|cancelled|canceled|error|failed|timeout|timed_out)$/i;

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

export function isUnverifiedActionClaim(data: AgentResponseDelivery): boolean {
  return isActionSuccessClaim(String(data.text || ''))
    && (data.finalized !== true || isAgentResponseBlocked(data));
}

export function shouldDisplayAgentResponse(data: AgentResponseDelivery): boolean {
  return Boolean(String(data.text || '').trim()) && !isUnverifiedActionClaim(data);
}

export function shouldSpeakAgentResponse(data: AgentResponseDelivery): boolean {
  if (!shouldDisplayAgentResponse(data) || isAgentResponseBlocked(data)) return false;
  return !isActionSuccessClaim(String(data.text || '')) || data.finalized === true;
}

export function isFinalizedSuccessfulResponse(data: AgentResponseDelivery): boolean {
  return data.finalized === true && !isAgentResponseBlocked(data);
}

export function isTerminalAgentStatus(status: string): boolean {
  const normalized = String(status || '').trim().toLowerCase();
  return normalized === 'idle' || FAILURE_STATUS_RE.test(normalized);
}
