import { sanitizeAgentResponseTextForDisplay, hasInternalAgentExecutionDetail } from "@/lib/agentResponseDelivery";

export function makeChatMessageId(prefix = 'msg'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}


export function getDisplayText(message: any): string {
  if (typeof message?.text === 'string') return message.text;
  if (message?.text == null) return '';
  return String(message.text);
}


export function getCustomerDisplayText(message: any, isZh: boolean): string {
  const text = getDisplayText(message);
  return message?.type === 'agent'
    ? sanitizeAgentResponseTextForDisplay(text, isZh ? 'zh' : 'en')
    : text;
}


const ASSISTANT_HISTORY_NOISE_RE =
  /我还没有真正开始读取或审查|我还不能说这件事已经完成|没有记录到成功的工具执行|真正读取时|Completion claim|Maximum tool call iterations|Action Constitution|local_write action requires confirmation|已经落到(?:桌面|电脑|文件)|结果包已经|交付包已经|真实接管|WPS\s*表格|剪映已打开|微信已打开|文件生成也卡在权限确认|工具调用一直在跑/i;


function shouldOmitAssistantHistoryMessage(message: any, text: string): boolean {
  const role = String(message?.role || '').toLowerCase();
  const type = String(message?.type || '').toLowerCase();
  const isAssistantLike = role === 'assistant' || type === 'agent';
  return isAssistantLike && (
    message?.legacyExecutionReport === true
    || hasInternalAgentExecutionDetail(text)
    || ASSISTANT_HISTORY_NOISE_RE.test(text)
  );
}


export function stripStoredAttachmentSummary(value: string): string {
  return String(value || '')
    .replace(/\n{0,2}\[Attachments\][\s\S]*$/i, '')
    .trim();
}


export function buildChatHistoryPayload(messages: any[]) {
  return messages.flatMap((m) => {
    const text = getDisplayText(m).trim();
    if (!text) return [];
    if (m.type === 'tool') return [];
    if (['error', 'proactive'].includes(m.source)) return [];
    if (/^(Request failed|请求失败|出错了|Failed to route)/i.test(text)) return [];
    if (shouldOmitAssistantHistoryMessage(m, text)) return [];
    if (m.type === 'agent') return [{ role: 'assistant', content: text }];
    if (m.type === 'user' || m.type === 'file_context') return [{ role: 'user', content: text }];
    return [];
  }).slice(-80);
}
