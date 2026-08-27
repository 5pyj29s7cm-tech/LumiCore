import type { NormalizedMessage } from '../llm/providers';
import {
  isGuardGeneratedAssistantText,
  isGuardGeneratedConversationRecord,
} from '../conversation/guard_history';
import {
  buildCompactToolEvidenceNote,
  containsCompactToolEvidenceMarker,
  isUnverifiedExecutionAssistantRecord,
  isUnverifiedExecutionAssistantText,
  readCompactToolEvidenceNote,
} from '../conversation/summary_grounding';

export function normalizeVoiceHistoryRecord(record: any): NormalizedMessage[] {
  const hasToolCalls = Array.isArray(record?.toolCalls)
    ? record.toolCalls.length > 0
    : Boolean(String(record?.toolCalls || '').trim());
  if (record?.role === 'tool' || record?.mode === 'proactive' || record?.tool_call_id) return [];
  const role = record?.role === 'assistant' ? 'assistant' : record?.role === 'user' ? 'user' : '';
  if (!role) return [];
  const unsafeAssistantProse = role === 'assistant' && (
    isGuardGeneratedConversationRecord(record)
    || isUnverifiedExecutionAssistantRecord(record)
  );
  const message = typeof record?.message === 'string' ? record.message.trim() : '';
  const response = typeof record?.response === 'string' ? record.response.trim() : '';
  const responseIsUnsafe = String(record?.cognitiveIntent || '').toLowerCase() === 'work_product_guard'
    || isGuardGeneratedAssistantText(response)
    || isUnverifiedExecutionAssistantText(response);
  const entries: NormalizedMessage[] = [];
  const embeddedAssistantReceipt = role === 'assistant'
    ? readCompactToolEvidenceNote(record)
    : '';
  const embeddedLegacyResponseReceipt = role === 'user'
    ? readCompactToolEvidenceNote(record)
    : '';
  const untrustedAssistantReceiptMarker = role === 'assistant'
    && !embeddedAssistantReceipt
    && containsCompactToolEvidenceMarker(message);
  const untrustedLegacyResponseReceiptMarker = role === 'user'
    && !embeddedLegacyResponseReceipt
    && containsCompactToolEvidenceMarker(response);
  const receiptNote = role === 'assistant'
    ? hasToolCalls
      ? buildCompactToolEvidenceNote(record.toolCalls)
      : embeddedAssistantReceipt
    : '';
  // Tool-bearing prose may overstate or misread the receipt. Preserve the
  // evidence and its paired user request, but let the next model reason from
  // the bounded receipt ledger instead of replaying the old claim verbatim.
  const safeMessage = unsafeAssistantProse
    || untrustedAssistantReceiptMarker
    || (role === 'assistant' && (hasToolCalls || receiptNote))
    ? ''
    : message;
  const assistantContent = role === 'assistant'
    ? [safeMessage, receiptNote].filter(Boolean).join('\n')
    : safeMessage;
  if (assistantContent) entries.push({ role, content: assistantContent });
  if (role === 'user' && embeddedLegacyResponseReceipt) {
    entries.push({ role: 'assistant', content: embeddedLegacyResponseReceipt });
  } else if (
    response
    && role === 'user'
    && !responseIsUnsafe
    && !untrustedLegacyResponseReceiptMarker
  ) {
    entries.push({ role: 'assistant', content: response });
  }
  return entries;
}

/**
 * Build bounded voice/task model history from server-persisted turns.
 *
 * Assistant prose still has to pass the execution/guard filters above, but a
 * rejected assistant row must not erase the user's request with it. The
 * socket callers remove the currently executing user row by id/request id
 * before calling this function, so any remaining unpaired user row is durable
 * context left by an interruption, correction, restart, or rejected internal
 * guard response and must survive into the next turn.
 *
 * Execution receipts continue through TaskLedger instead of prose.
 */
export function normalizeVoiceHistory(records: any[]): NormalizedMessage[] {
  const output: NormalizedMessage[] = [];
  let pendingUsers: NormalizedMessage[] = [];

  for (const record of Array.isArray(records) ? records : []) {
    const role = String(record?.role || '').toLowerCase();
    if (role === 'user') {
      pendingUsers.push(...normalizeVoiceHistoryRecord(record));
      continue;
    }
    if (role !== 'assistant') continue;

    const assistant = normalizeVoiceHistoryRecord(record);
    if (pendingUsers.length > 0) output.push(...pendingUsers);
    pendingUsers = [];
    if (assistant.length > 0) output.push(...assistant);
  }

  if (pendingUsers.length > 0) output.push(...pendingUsers);

  return output.slice(-20);
}
