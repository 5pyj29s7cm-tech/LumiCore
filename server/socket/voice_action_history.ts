import { CN_VOICE_ACTION_HISTORY_MESSAGES as M } from '../regions/packs/cn/voice_action_history_messages';

function parseMaybeJson(value: unknown): any {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function normalizeToolCalls(value: unknown): any[] {
  const parsed = parseMaybeJson(value);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') return [parsed];
  return [];
}

export function isRecentActionExplanationQuestion(text: string): boolean {
  const normalized = String(text || '').trim();
  // i18n-allow: Chinese input-recognition patterns; not user-visible copy.
  return /(?:\u6211\u95ee\u4f60)?(?:\u521a\u521a|\u521a\u624d|\u4e4b\u524d|\u4e0a\u4e00\u8f6e|\u4e0a\u4e00\u6b21).{0,100}(?:\u5e72\u4e86\u4ec0\u4e48|\u505a\u4e86\u4ec0\u4e48|\u64cd\u4f5c\u4e86\u4ec0\u4e48|\u6253\u5f00.{0,32}\u5e72\u4e86\u4ec0\u4e48|\u4e3a\u4ec0\u4e48.{0,48}(?:\u6253\u5f00|\u64cd\u4f5c|\u6267\u884c)|(?:\u753b|\u505a).{0,32}(?:\u662f\u4ec0\u4e48|\u4ec0\u4e48\u4e1c\u897f))/u.test(normalized)
    || /(?:\u4f60\u786e\u5b9a|\u4f60\u80fd\u786e\u5b9a).{0,64}(?:\u56fe|\u56fe\u7eb8|\u6237\u578b|\u5e73\u9762\u56fe|\u5ba4\u4e00\u5385|CAD)/iu.test(normalized);
}

function describeWeChatCall(call: any): string {
  const args = parseMaybeJson(call?.arguments ?? call?.args) || {};
  const result = parseMaybeJson(call?.result) || {};
  const contact = String(args.contact || '').trim();
  const message = String(args.message || args.draft || '').trim();
  const recipient = contact ? `\u201c${contact}\u201d` : M.currentConversation;
  if (call?.error) {
    if (/conversation was not verified|conversation-selection/i.test(String(call.error))) {
      return M.wechatStoppedBeforeSend(recipient);
    }
    return M.wechatToolFailed(recipient);
  }
  if (result.sent === true) return M.wechatVerified(recipient, message);
  if (result.sendAttempted === true) {
    return M.wechatAttempted(recipient, message);
  }
  return M.wechatLocatedOnly(recipient);
}

export function describeRecentActionsFromHistory(text: string, history: any[]): string | null {
  if (!isRecentActionExplanationQuestion(text)) return null;
  const recentAssistant = (Array.isArray(history) ? history.slice(-30).reverse() : [])
    .find(record => String(record?.role || '') === 'assistant' && normalizeToolCalls(record?.toolCalls ?? record?.tool_calls).length > 0);
  if (!recentAssistant) return M.noRecentToolEvidence;
  const calls = normalizeToolCalls(recentAssistant?.toolCalls ?? recentAssistant?.tool_calls);
  const wechat = [...calls].reverse().find(call => String(call?.name || call?.toolName || '') === 'wechat_send_message');
  if (wechat) return describeWeChatCall(wechat);
  const opened = [...calls].reverse().find(call => String(call?.name || call?.toolName || '') === 'desktop_open');
  if (opened) {
    const args = parseMaybeJson(opened?.arguments ?? opened?.args) || {};
    const target = String(args.target || '').trim() || M.targetFallback;
    return opened?.error
      ? M.openFailed(target)
      : M.openSucceeded(target);
  }
  const cadCalls = calls.filter(call => /(?:cad|autocad|dxf|dwg)/i.test(String(call?.name || call?.toolName || '')));
  if (cadCalls.length > 0) {
    const visiblePlayback = cadCalls.some(call => (
      /autocad_playback/i.test(String(call?.name || call?.toolName || ''))
      && !call?.error
      && String(call?.result || '').trim()
    ));
    if (!visiblePlayback) {
      return M.cadNotVerified;
    }
    return M.cadPlaybackNeedsInspection;
  }
  const names = calls.map(call => String(call?.name || call?.toolName || '')).filter(Boolean);
  return names.length
    ? M.toolList(names)
    : M.noRecentToolRecords;
}
