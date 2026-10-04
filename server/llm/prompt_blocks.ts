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
export function promptBlockMessage(block: PromptBlock): NormalizedMessage {
    if (block.required && block.authority === 'untrusted')
        throw new Error('Untrusted prompt data cannot reserve authoritative budget');
    if (!block.id || !Number.isSafeInteger(block.minBudget ?? 0) || (block.minBudget ?? 0) < 0)
        throw new Error('Invalid prompt block');
    for (const field of block.requiredFields || []) {
        if (!block.fields || !Object.prototype.hasOwnProperty.call(block.fields, field) || block.fields[field] === undefined) {
            throw new Error('Missing required prompt field: ' + block.id + '/' + field);
        }
    }
    return { role: 'system', content: block.content + (block.fields ? '\n' + JSON.stringify(block.fields) : ''), promptBlock: block };
}

/** Replace an obsolete projection from the same server-owned slot. */
export function replacePromptBlock(messages: NormalizedMessage[], block: PromptBlock): void {
    const message = promptBlockMessage(block);
    for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].promptBlock?.id === block.id) messages.splice(index, 1);
    }
    messages.push(message);
}
