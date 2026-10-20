import type { NormalizedMessage } from './providers';
export interface PromptBlock {
    id: string;
    kind: 'authorization' | 'task_state' | 'receipt' | 'background' | 'style';
    authority: 'server' | 'tool' | 'untrusted';
    content: string;
    required?: boolean;
    fields?: Record<string, unknown>;
    requiredFields?: readonly string[];
    minBudget?: number;
}
/** Metadata stays on the server; provider formatters only receive content. */
export function promptBlockMessage(block: PromptBlock, role: 'system' | 'user' = 'system'): NormalizedMessage {
    if (block.required && block.authority === 'untrusted')
        throw new Error('Untrusted prompt data cannot reserve authoritative budget');
    if (!block.id || !Number.isSafeInteger(block.minBudget ?? 0) || (block.minBudget ?? 0) < 0)
        throw new Error('Invalid prompt block');
    for (const field of block.requiredFields || []) {
        if (!block.fields || !Object.prototype.hasOwnProperty.call(block.fields, field) || block.fields[field] === undefined) {
            throw new Error('Missing required prompt field: ' + block.id + '/' + field);
        }
    }
    return { role, content: block.content + (block.fields ? '\n' + JSON.stringify(block.fields) : ''), promptBlock: block };
}

/** Replace an obsolete projection from the same server-owned slot. */
export function replacePromptBlock(messages: NormalizedMessage[], block: PromptBlock): void {
    const message = promptBlockMessage(block);
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].promptBlock?.id === block.id) messages.splice(index, 1);
    }
    messages.push(message);
}

/** Keep one projection per slot; data from another authority cannot replace it. */
export function normalizePromptBlockMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
  const latest = new Map<string, { index: number; authority: PromptBlock['authority']; kind: PromptBlock['kind']; role: 'system' | 'user' }>();
  const normalized = messages.map((message, index) => {
    const block = message.promptBlock;
    if (!block) return { ...message };
    if (message.role !== 'system' && message.role !== 'user') throw new Error('Prompt block metadata requires a system or user message');
    const previous = latest.get(block.id);
    if (previous && (previous.authority !== block.authority || previous.kind !== block.kind || previous.role !== message.role)) {
      throw new Error('Conflicting prompt block authority, kind or role: ' + block.id);
    }
    const canonical = promptBlockMessage(block, message.role);
    latest.set(block.id, { index, authority: block.authority, kind: block.kind, role: message.role });
    return canonical;
  });
  return normalized.filter((message, index) => !message.promptBlock
    || latest.get(message.promptBlock.id)?.index === index);
}
