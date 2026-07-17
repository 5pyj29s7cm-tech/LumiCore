import { CN_VOICE_ACTION_HISTORY_MESSAGES as M } from '../regions/packs/cn/voice_action_history_messages';
import type { ToolExecutionRecord } from '../tools/types';

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

function hasSuccessfulReceipt(call: any): boolean {
  if (call?.error) return false;
  const raw = String(call?.result || '').trim();
  if (!raw) return false;
  const result = parseMaybeJson(call?.result);
  if (result && typeof result === 'object') {
    if (result.ok === false || result.success === false || result.opened === false) return false;
    const status = String(result.status || result.verification?.status || '').trim().toLowerCase();
    if (/^(?:failed|error|blocked|denied|forbidden|timeout|timed_out|cancelled|canceled|pending|partial)$/.test(status)) {
      return false;
    }
  }
  return !/(?:^|\b)(?:failed|error|blocked|not found|timed out|permission denied|requires confirmation)(?:\b|:)/i.test(raw);
}

export function collectRecentActionToolRecords(history: any[]): ToolExecutionRecord[] {
  const records: ToolExecutionRecord[] = [];
  for (const item of Array.isArray(history) ? history.slice(-30) : []) {
    if (String(item?.role || '') !== 'assistant') continue;
    for (const call of normalizeToolCalls(item?.toolCalls ?? item?.tool_calls)) {
      const name = String(call?.name || call?.toolName || '').trim();
      if (!name) continue;
      records.push({
        id: call?.id,
        name,
        arguments: parseMaybeJson(call?.arguments ?? call?.args) || {},
        result: String(call?.result || ''),
        error: call?.error ? String(call.error) : undefined,
      });
    }
  }
  return records;
}

export function isRecentActionExplanationQuestion(text: string): boolean {
  const normalized = String(text || '').trim();
  // i18n-allow: Chinese input-recognition patterns; not user-visible copy.
  return /(?:\u6211\u95ee\u4f60)?(?:\u521a\u521a|\u521a\u624d|\u4e4b\u524d|\u4e0a\u4e00\u8f6e|\u4e0a\u4e00\u6b21).{0,100}(?:\u5e72\u4e86\u4ec0\u4e48|\u505a\u4e86\u4ec0\u4e48|\u64cd\u4f5c\u4e86\u4ec0\u4e48|\u6253\u5f00.{0,32}\u5e72\u4e86\u4ec0\u4e48|\u4e3a\u4ec0\u4e48.{0,48}(?:\u6253\u5f00|\u64cd\u4f5c|\u6267\u884c)|(?:\u753b|\u505a).{0,32}(?:\u662f\u4ec0\u4e48|\u4ec0\u4e48\u4e1c\u897f)|(?:\u4efb\u52a1)?.{0,24}(?:\u505a\u5230|\u6267\u884c\u5230).{0,16}(?:\u54ea\u4e00\u6b65|\u4ec0\u4e48\u5730\u6b65)|(?:\u4efb\u52a1)?.{0,24}(?:\u6267\u884c|\u8fdb\u5c55|\u5904\u7406).{0,16}(?:\u600e\u4e48\u6837|\u5982\u4f55|\u4ec0\u4e48\u60c5\u51b5))/u.test(normalized)
    || /(?:Auto\s*CAD|CAD).{0,48}(?:\u4efb\u52a1)?.{0,24}(?:\u6267\u884c|\u8fdb\u5c55|\u505a\u5230|\u5904\u7406).{0,20}(?:\u600e\u4e48\u6837|\u5982\u4f55|\u54ea\u4e00\u6b65|\u4ec0\u4e48\u5730\u6b65)/iu.test(normalized)
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
  if (
    result.sent === true
    && String(result.verificationStatus || result.verification?.status || '').toLowerCase() === 'verified'
  ) return M.wechatVerified(recipient, message);
  if (result.sendAttempted === true || result.sent === true) {
    return M.wechatAttempted(recipient, message);
  }
  return M.wechatLocatedOnly(recipient);
}

export function describeRecentActionsFromHistory(text: string, history: any[]): string | null {
  if (!isRecentActionExplanationQuestion(text)) return null;
  const assistants = (Array.isArray(history) ? history.slice(-30).reverse() : [])
    .filter(record => String(record?.role || '') === 'assistant' && normalizeToolCalls(record?.toolCalls ?? record?.tool_calls).length > 0);
  const wantsCad = /(?:Auto\s*CAD|CAD|DXF|DWG)/iu.test(text);
  const wantsWeChat = /(?:\u5fae\u4fe1|WeChat|Weixin)/iu.test(text);
  const recentAssistant = assistants.find(record => {
    const calls = normalizeToolCalls(record?.toolCalls ?? record?.tool_calls);
    if (wantsCad) return calls.some(call => /(?:cad|autocad|dxf|dwg)/i.test(JSON.stringify({
      name: call?.name || call?.toolName || '',
      arguments: call?.arguments ?? call?.args,
      result: call?.result,
    })));
    if (wantsWeChat) return calls.some(call => /(?:wechat|desktop_open)/i.test(String(call?.name || call?.toolName || '')));
    return true;
  });
  if (!recentAssistant) return M.noRecentToolEvidence;
  const calls = normalizeToolCalls(recentAssistant?.toolCalls ?? recentAssistant?.tool_calls);
  const cadCalls = calls.filter(call => /(?:cad|autocad|dxf|dwg)/i.test(String(call?.name || call?.toolName || '')));
  if (wantsCad && cadCalls.length > 0) {
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
  const wechat = [...calls].reverse().find(call => String(call?.name || call?.toolName || '') === 'wechat_send_message');
  if (wechat) return describeWeChatCall(wechat);
  const opened = [...calls].reverse().find(call => String(call?.name || call?.toolName || '') === 'desktop_open');
  if (opened) {
    const args = parseMaybeJson(opened?.arguments ?? opened?.args) || {};
    const target = String(args.target || '').trim() || M.targetFallback;
    return hasSuccessfulReceipt(opened)
      ? M.openSucceeded(target)
      : M.openFailed(target);
  }
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
