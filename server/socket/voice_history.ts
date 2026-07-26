import type { NormalizedMessage } from '../llm/providers';
import {
  isGuardGeneratedAssistantText,
  isGuardGeneratedConversationRecord,
} from '../conversation/guard_history';
import { isUnverifiedExecutionAssistantRecord } from '../conversation/summary_grounding';

export function normalizeVoiceHistoryRecord(record: any): NormalizedMessage[] {
  const hasToolCalls = Array.isArray(record?.toolCalls)
    ? record.toolCalls.length > 0
    : Boolean(String(record?.toolCalls || '').trim());
  if (record?.role === 'tool' || record?.mode === 'proactive' || hasToolCalls || record?.tool_call_id) return [];
  const role = record?.role === 'assistant' ? 'assistant' : record?.role === 'user' ? 'user' : '';
  if (!role) return [];
  if (role === 'assistant' && isGuardGeneratedConversationRecord(record)) return [];
  if (role === 'assistant' && isUnverifiedExecutionAssistantRecord(record)) return [];
  const message = typeof record?.message === 'string' ? record.message.trim() : '';
  const response = typeof record?.response === 'string' ? record.response.trim() : '';
  const responseIsGuard = String(record?.cognitiveIntent || '').toLowerCase() === 'work_product_guard'
    || isGuardGeneratedAssistantText(response);
  const entries: NormalizedMessage[] = [];
  if (message) entries.push({ role, content: message });
  if (response && role === 'user' && !responseIsGuard) entries.push({ role: 'assistant', content: response });
  return entries;
}

/**
 * Build voice model history only from completed, trustworthy conversation
 * pairs. Execution receipts continue through TaskLedger instead of prose.
 */
export function normalizeVoiceHistory(records: any[]): NormalizedMessage[] {
  const output: NormalizedMessage[] = [];
  let pendingUser: any | null = null;

  for (const record of Array.isArray(records) ? records : []) {
    const role = String(record?.role || '').toLowerCase();
    if (role === 'user') {
      pendingUser = record;
      continue;
    }
    if (role !== 'assistant') continue;

    const assistant = normalizeVoiceHistoryRecord(record);
    if (pendingUser) {
      const user = normalizeVoiceHistoryRecord(pendingUser);
      if (user.length > 0 && assistant.length > 0) output.push(...user, ...assistant);
      pendingUser = null;
      continue;
    }
    if (assistant.length > 0) output.push(...assistant);
  }

  return output.slice(-20);
}
