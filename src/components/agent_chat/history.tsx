import { sanitizeAgentResponseTextForDisplay } from "@/lib/agentResponseDelivery";

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
