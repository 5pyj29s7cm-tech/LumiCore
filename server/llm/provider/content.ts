import type { MessageContent, NormalizedMessage } from './contracts';

export function contentToText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (!content) return '';
  return content
    .map(part => part.type === 'text' ? part.text : '[image]')
    .join('\n')
    .trim();
}

export function hasMeaningfulContent(content: MessageContent): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  if (!content) return false;
  return content.length > 0;
}

export function isQwenVisionModel(model: string): boolean {
  return /(?:qwen.*vl|vl-|vl_|vision)/i.test(model || '');
}

export function messagesNeedVision(messages: NormalizedMessage[]): boolean {
  return messages.some(message => Array.isArray(message.content)
    && message.content.some(part => part.type === 'image_url'));
}
