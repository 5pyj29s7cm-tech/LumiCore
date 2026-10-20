import { isGuardGeneratedAssistantText } from "../../conversation/guard_history";
import { NormalizedMessage } from "../../llm/providers";
import { normalizeVoiceHistoryRecord } from "../voice_history";
import { buildActionContract, summarizeActionContractBlocker } from "../../cognition/action_contract";
import { CN_MESSAGING_MESSAGES } from "../../regions/messages/messaging_messages";

function stripHistoricalAttachmentBlocks(value: string): string {
  const text = String(value || '').trim();
  if (!text) return '';
  return text
    .replace(/\n{0,2}\[Attachments\][\s\S]*$/i, '')
    .trim();
}


const ASSISTANT_HISTORY_NOISE_RE =
  /我还没有真正开始读取或审查|我还没有真正操作客户端|我还不能说这件事已经完成|没有记录到成功的工具执行|真正读取时|I have not actually started|Completion claim|Maximum tool call iterations|Action Constitution|local_write action requires confirmation|已经落到(?:桌面|电脑|文件)|结果包已经|交付包已经|真实接管|WPS\s*表格|剪映已打开|微信已打开|文件生成也卡在权限确认|工具调用一直在跑/i;


function isNoisyAssistantHistory(value: string): boolean {
  return isGuardGeneratedAssistantText(value) || ASSISTANT_HISTORY_NOISE_RE.test(String(value || ''));
}


export function normalizeChatHistoryRecord(
  m: any,
  options: { serverOwned?: boolean } = {},
): NormalizedMessage[] {
  const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'system' ? 'system' : m?.role === 'user' ? 'user' : '';
  const source = typeof m?.source === 'string' ? m.source : '';
  const uiOnlySources = new Set(['error', 'proactive']);
  if (
    !role ||
    m?.role === 'tool' ||
    m?.type === 'tool' ||
    m?.mode === 'proactive' ||
    uiOnlySources.has(source) ||
    m?.tool_call_id
  ) return [];

  const message = typeof m?.message === 'string' ? stripHistoricalAttachmentBlocks(m.message) : '';
  const content = typeof m?.content === 'string' ? stripHistoricalAttachmentBlocks(m.content) : '';
  const response = typeof m?.response === 'string' ? m.response.trim() : '';
  const primaryText = message || content;
  const isUiErrorText = /^(Request failed|请求失败|出错了|Failed to route)/i.test(primaryText);
  if (role === 'system') {
    return primaryText && !isUiErrorText ? [{ role, content: primaryText }] : [];
  }

  // Only records loaded by the server from conversation persistence may carry
  // provider tool calls or the server-owned compaction ledger. Client-supplied
  // history cannot mint either evidence channel.
  const trustedRecord = {
    ...m,
    role,
    cognitiveIntent: options.serverOwned ? m?.cognitiveIntent : undefined,
    message: isUiErrorText ? '' : primaryText,
    content: undefined,
    response,
    toolCalls: options.serverOwned ? m?.toolCalls : undefined,
    toolReceiptLedger: options.serverOwned ? m?.toolReceiptLedger : undefined,
    toolFileObservations: options.serverOwned ? m?.toolFileObservations : undefined,
  };
  return normalizeVoiceHistoryRecord(trustedRecord).filter(entry => !(
    entry.role === 'assistant'
    && (
      (role === 'assistant' && entry.content === primaryText && isNoisyAssistantHistory(primaryText))
      || (role === 'user' && entry.content === response && isNoisyAssistantHistory(response))
    )
  ));
}


export function getRecentHistoryText(history: any[] | undefined, maxLength = 6000): string {
  if (!Array.isArray(history) || history.length === 0) return '';
  const lines = history
    .slice(-8)
    .map((item: any) => {
      const role = String(item?.role || item?.type || '').slice(0, 20);
      const content = stripHistoricalAttachmentBlocks(String(item?.message || item?.content || item?.text || item?.response || '').trim());
      let toolCalls: any = item?.toolCalls;
      for (let depth = 0; depth < 2 && typeof toolCalls === 'string' && toolCalls.trim(); depth += 1) {
        try { toolCalls = JSON.parse(toolCalls); } catch { toolCalls = []; }
      }
      const runtimeEvidence = Array.isArray(toolCalls)
        ? toolCalls.slice(-6).map((record: any) => {
            const name = String(record?.name || '').trim();
            const result = String(record?.result || '').slice(0, 500);
            return name ? `${name}: ${record?.error ? 'failed' : result || 'completed'}` : '';
          }).filter(Boolean).join('\n')
        : '';
      return [content ? `${role}: ${content}` : '', runtimeEvidence ? `runtime evidence:\n${runtimeEvidence}` : '']
        .filter(Boolean)
        .join('\n');
    })
    .filter(Boolean);
  return lines.join('\n').slice(-maxLength);
}


const RECENT_FAILURE_EXPLANATION_RE =
  /(?:\u4e3a\u4ec0\u4e48|\u600e\u4e48\u56de\u4e8b|\u548b\u56de\u4e8b).*(?:\u6700\u540e\u4e00\u6b65|\u6ca1\u5b8c\u6210|\u6ca1\u53d1\u51fa\u53bb|\u6ca1\u53d1|\u5931\u8d25|\u5361\u4f4f)|(?:\u6700\u540e\u4e00\u6b65).*(?:\u4e3a\u4ec0\u4e48|\u6ca1\u5b8c\u6210|\u5361\u4f4f)/u;


export function buildRecentFailureExplanation(userText: string, history: any[] | undefined): string {
  const clean = String(userText || '').trim();
  if (!RECENT_FAILURE_EXPLANATION_RE.test(clean)) return '';
  const recent = getRecentHistoryText(history, 9000);
  const incompleteContext = /\u4e0d\u80fd\u786e\u8ba4\u5b8c\u6210|\u8fd8\u6ca1\u5b8c\u6210|\u6ca1\u5b8c\u6210|\u672a\u5b8c\u6210|\u56de\u590d\u58f0\u79f0|desktop_open|computer_use|keyboard_type|keyboard_press|wechat_send_message|wechat_send_file|work_product_guard|timed out|failed/i.test(recent);
  const contract = buildActionContract(recent);
  if (!incompleteContext || !contract.applies) return '';

  const hasDedicatedSend = /wechat_send_message/i.test(recent);
  const hasDedicatedFileSend = /wechat_send_file/i.test(recent);
  const hasVerifiedFileSend = /wechat_send_file:[\s\S]{0,700}(?:"sent"\s*:\s*true|sent:\s*true)/i.test(recent);
  const hasKeyboardOnly = /keyboard_type|keyboard_press/i.test(recent);
  const hasCompletionNoise = /\u8bfb\u53d6|\u5ba1\u67e5|\u53ef\u8bfb\u53d6\u7684\u6587\u4ef6|\u56de\u590d\u58f0\u79f0/i.test(recent);
  if (contract.kind === 'messaging_send' && hasVerifiedFileSend) {
    return CN_MESSAGING_MESSAGES.priorFileDeliveryWasMisclassified;
  }
  const contractBlocker = summarizeActionContractBlocker(contract);
  return [
    `\u6700\u540e\u4e00\u6b65\u6ca1\u5b8c\u6210\uff0c\u662f\u56e0\u4e3a\u4e0a\u4e00\u8f6e\u6ca1\u6709\u62ff\u5230\u201c${contract.label}\u201d\u7684\u6838\u5fc3\u52a8\u4f5c\u8bc1\u636e\u3002`,
    contractBlocker,
    contract.kind === 'messaging_send' && !hasDedicatedSend && !hasDedicatedFileSend
      ? CN_MESSAGING_MESSAGES.noDeliveryToolEvidence
      : '',
    contract.kind === 'messaging_send' && hasDedicatedSend
      ? '\u8bb0\u5f55\u91cc\u51fa\u73b0\u4e86\u5fae\u4fe1\u53d1\u9001\u5de5\u5177\uff0c\u4f46\u6ca1\u6709\u62ff\u5230\u53ef\u9a8c\u8bc1\u7684 sent=true \u7ed3\u679c\u3002'
      : '',
    contract.kind === 'messaging_send' && hasDedicatedFileSend && !hasVerifiedFileSend
      ? CN_MESSAGING_MESSAGES.unverifiedFileDelivery
      : '',
    contract.kind === 'messaging_send' && hasKeyboardOnly
      ? '\u6240\u4ee5\u5b83\u6700\u591a\u5230\u4e86\u201c\u5b9a\u4f4d\u6216\u641c\u7d22\u8054\u7cfb\u4eba\u201d\uff0c\u6ca1\u6709\u5b8c\u6210\u201c\u7c98\u8d34\u665a\u5b89\u5e76\u6309\u53d1\u9001\u201d\u3002'
      : '',
    hasCompletionNoise
      ? '\u521a\u624d\u90a3\u53e5\u201c\u8bfb\u53d6\u6216\u5ba1\u67e5\u201d\u662f\u9519\u8bef\u7684\u901a\u7528\u515c\u5e95\u6587\u6848\uff0c\u548c\u5fae\u4fe1\u4efb\u52a1\u4e0d\u5339\u914d\u3002'
      : '',
    contract.nextStep ? `\u6b63\u786e\u7684\u4e0b\u4e00\u6b65\uff1a${contract.nextStep}` : '',
  ].filter(Boolean).join('\n');
}
