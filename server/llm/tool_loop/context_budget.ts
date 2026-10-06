import type { NormalizedMessage } from "../providers";
import { compactStringForModel } from './receipts';

export const FULL_TOOL_RESULTS_PER_MODEL_ITERATION = 3;

export const EARLIER_TOOL_RESULT_CONTEXT_LIMIT = 1_600;

export function compactEarlierToolMessage(content: string): string {
  if (content.length <= EARLIER_TOOL_RESULT_CONTEXT_LIMIT) return content;
  const head = 1_000;
  const tail = 420;
  return [
    content.slice(0, head),
    `\n\n[Earlier tool output compacted after newer receipts arrived: ${content.length} characters total. The full receipt remains in the durable task ledger.]\n\n`,
    content.slice(-tail),
  ].join('');
}

/**
 * Bound growth inside one multi-step tool loop without losing the assistant /
 * tool-call pairing required by model APIs. The newest receipts remain full;
 * older receipts retain terminal status, reason, target-leading fields and a
 * bounded tail. Durable execution records are never modified.
 */
export function compactToolLoopMessagesForModel(
  messages: NormalizedMessage[],
): NormalizedMessage[] {
  let fullToolResultsRemaining = FULL_TOOL_RESULTS_PER_MODEL_ITERATION;
  const reversed: NormalizedMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const cloned: NormalizedMessage = {
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map(part => part.type === 'text'
          ? { ...part }
          : { ...part, image_url: { ...part.image_url } })
        : message.content,
      reasoningContent: message.reasoningContent
        ? compactStringForModel(message.reasoningContent, 2_000, 'reasoning')
        : message.reasoningContent,
    };
    if (message.role === 'tool' && typeof cloned.content === 'string') {
      if (fullToolResultsRemaining > 0) {
        fullToolResultsRemaining -= 1;
      } else {
        cloned.content = compactEarlierToolMessage(cloned.content);
      }
    }
    reversed.push(cloned);
  }
  return reversed.reverse();
}

export function compactMessagesForModel(messages: NormalizedMessage[]): NormalizedMessage[] {
  // The provider boundary still owns the shared token budget after dynamic
  // schemas are known. This pass only prevents iterative tool output and
  // repeated target state from growing without bound inside the same turn.
  return compactToolLoopMessagesForModel(messages);
}
