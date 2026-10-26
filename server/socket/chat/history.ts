import type { NormalizedMessage } from "../../llm/providers";
import { buildHistoricalFileObservations } from "../../conversation/file_observation_history";
import { buildCompactToolEvidenceNote, readCompactToolEvidenceNote } from "../../conversation/summary_grounding";

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

  const primaryText = typeof m?.message === 'string' && m.message ? m.message : typeof m?.content === 'string' ? m.content : '';
  const response = typeof m?.response === 'string' ? m.response : '';
  if (role === 'system') return primaryText ? [{ role, content: primaryText }] : [];

  // Only server-persisted records may contribute historical tool evidence.
  // Keep their dialogue as dialogue; never reconstruct provider tool-call protocol.
  const receiptNote = options.serverOwned
    ? buildCompactToolEvidenceNote(m?.toolCalls) || readCompactToolEvidenceNote(m)
    : '';
  const fileObservations = options.serverOwned
    ? buildHistoricalFileObservations(m?.toolCalls) || (typeof m?.toolFileObservations === 'string' ? m.toolFileObservations : '')
    : '';
  const entries: NormalizedMessage[] = [];
  const dialogue = primaryText;
  if (role === 'user' && dialogue) entries.push({ role, content: dialogue });
  const assistantText = role === 'assistant' ? dialogue : response;
  const assistantContent = [assistantText, ...[receiptNote, fileObservations].filter(value => value && !assistantText.includes(value))].filter(Boolean).join('\n');
  if (assistantContent) entries.push({ role: 'assistant', content: assistantContent });
  return entries;
}
