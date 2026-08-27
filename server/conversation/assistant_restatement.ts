import { isGuardGeneratedConversationRecord } from './guard_history';

export interface AssistantRestatementRecord {
  role?: string;
  type?: string;
  message?: string;
  content?: string;
  text?: string;
  response?: string;
  toolCalls?: unknown;
  cognitiveIntent?: string;
}

function assistantText(record: AssistantRestatementRecord): string {
  return String(
    record.response
    || record.message
    || record.content
    || record.text
    || '',
  ).trim();
}

/**
 * Return the newest ordinary, user-visible Lumi reply before the current user
 * turn. Guard diagnostics and role/type-level tool or status rows are
 * execution evidence, not conversational answers. A final user-visible reply
 * may still carry `toolCalls` as audit metadata and remains repeatable.
 */
export function findLatestRepeatableAssistantReply(
  history: readonly AssistantRestatementRecord[] | null | undefined,
): string {
  if (!Array.isArray(history)) return '';
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const record = history[index];
    const role = String(record?.role || record?.type || '').toLowerCase();
    const recordType = String(record?.type || '').toLowerCase();
    const cognitiveIntent = String(record?.cognitiveIntent || '').toLowerCase();
    if (!record || (role !== 'assistant' && role !== 'agent')) continue;
    if (['tool', 'status', 'internal'].includes(recordType)) continue;
    if (/^(?:agent_status|internal_status|execution_status|tool_(?:call|result|status))$/u.test(cognitiveIntent)) continue;
    if (isGuardGeneratedConversationRecord(record)) continue;
    const text = assistantText(record);
    if (text) return text;
  }
  return '';
}
