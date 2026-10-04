import { isGuardGeneratedConversationRecord, isGuardGeneratedAssistantText } from "../guard_history";
import { buildCompactToolEvidenceNote, isUnverifiedExecutionAssistantRecord } from "../summary_grounding";
import { buildHistoricalFileObservations } from "../file_observation_history";
import { listConversationReceiptHistory } from "../history_repository";
import { estimateTokenCount } from "../../llm/providers";
import { type MessageRecord } from "./contracts";
const DEFAULT_CONTEXT_TOKENS = parseInt(process.env.CONTEXT_TOKEN_BUDGET || '18000', 10);

const CONTEXT_HISTORY_LIMIT = parseInt(process.env.CONTEXT_HISTORY_LIMIT || '240', 10);

const CONTEXT_MESSAGE_CHAR_LIMIT = parseInt(process.env.CONTEXT_MESSAGE_CHAR_LIMIT || '5000', 10);

const CONTEXT_RESPONSE_CHAR_LIMIT = parseInt(process.env.CONTEXT_RESPONSE_CHAR_LIMIT || '5000', 10);


function compactPromptText(value: string, limit: number): string {
  const text = value || '';
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.75);
  const tail = Math.max(400, limit - head - 180);
  return [
    text.slice(0, head),
    `\n\n[Prompt history compacted: ${text.length} characters total. Older detail is preserved in conversation storage and searchable history.]\n\n`,
    text.slice(-tail),
  ].join('');
}


export function isPromptEligibleMessage(m: MessageRecord): boolean {
  if (!m) return false;
  if (m.role === 'tool' || m.mode === 'proactive') return false;
  if (isGuardGeneratedConversationRecord(m)) return false;
  return Boolean((m.message || '').trim() || (m.response || '').trim());
}


export function compactRecordForPrompt(m: MessageRecord): MessageRecord {
  const legacyCombinedGuardResponse = m.role === 'user'
    && Boolean(String(m.response || '').trim())
    && (
      String(m.cognitiveIntent || '').toLowerCase() === 'work_product_guard'
      || isGuardGeneratedAssistantText(m.response)
    );
  const evidenceNote = buildCompactToolEvidenceNote(m.toolCalls);
  // Removing an ungrounded assistant reply while retaining its user question
  // makes an already answered turn look pending to the next model. Preserve
  // the reply boundary without replaying its unsupported outcome claims.
  const suppressedReply = m.role === 'assistant'
    && !evidenceNote
    && isUnverifiedExecutionAssistantRecord(m);
  const compactedMessage = suppressedReply
    ? '[The historical reply is omitted because its action claims lack attached evidence. This turn already has a response and is not a pending instruction. Refer to the original action receipts only when relevant to the newest user request.]'
    : compactPromptText(m.message || '', CONTEXT_MESSAGE_CHAR_LIMIT);
  const compactedResponse = legacyCombinedGuardResponse
    ? ''
    : compactPromptText(m.response || '', CONTEXT_RESPONSE_CHAR_LIMIT);
  return {
    ...m,
    message: evidenceNote && m.role === 'assistant'
      ? `${compactedMessage}\n${evidenceNote}`.trim()
      : compactedMessage,
    // Older interaction rows stored the assistant reply in `response` while
    // keeping role=user. Preserve the user's side, but never reconstruct a
    // marked/legacy guard reply as conversational assistant truth.
    response: evidenceNote && m.role === 'user' && compactedResponse
      ? `${compactedResponse}\n${evidenceNote}`.trim()
      : compactedResponse,
    toolReceiptLedger: evidenceNote || undefined,
    toolFileObservations: buildHistoricalFileObservations(m.toolCalls) || undefined,
    toolCalls: undefined,
  };
}


export function getMessages(conversationId: string, limit = 1000): MessageRecord[] {
  return listConversationReceiptHistory(conversationId, limit);
}


/**
 * Get messages trimmed to a token budget rather than a fixed count.
 * Always keeps the last `keepRecent` messages (default 4).
 * Trims oldest messages first from the middle.
 */
export function getMessagesByTokenBudget(
  conversationId: string,
  maxTokens: number = DEFAULT_CONTEXT_TOKENS,
  keepRecent: number = 4,
  throughExternalMessageId = '',
): MessageRecord[] {
  const messages = getMessages(conversationId, CONTEXT_HISTORY_LIMIT);
  const visibleMessages = throughExternalMessageId
    ? messagesThroughExternalRequest(messages, throughExternalMessageId) : messages;
  const all = visibleMessages
    .filter(isPromptEligibleMessage)
    .map(compactRecordForPrompt);
  if (all.length <= keepRecent) return all;

  const keep = all.slice(-keepRecent); // always keep most recent
  const rest = all.slice(0, -keepRecent);

  let budget = maxTokens;
  // Count tokens for the kept portion first
  for (const m of keep) {
    budget -= estimateTokenCount(m.message + (m.response || ''));
  }

  // Walk backwards through rest, taking messages that fit
  const selected: MessageRecord[] = [];
  for (let i = rest.length - 1; i >= 0; i--) {
    const cost = estimateTokenCount(rest[i].message + (rest[i].response || ''));
    if (budget - cost > 0) {
      selected.unshift(rest[i]);
      budget -= cost;
    } else {
      break; // no more budget for older messages
    }
  }

  return [...selected, ...keep];
}


export function getMessagesThroughExternalMessage(
  conversationId: string,
  externalMessageId: string,
  limit = 1000,
): MessageRecord[] {
  const messages = getMessages(conversationId, 1000);
  return messagesThroughExternalRequest(messages, externalMessageId).slice(-limit);
}

/** A request cutoff belongs to its accepted user row, including legacy empty identities. */
function messagesThroughExternalRequest(messages: MessageRecord[], externalMessageId: string): MessageRecord[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user' && messages[index].externalMessageId === externalMessageId) {
      return messages.slice(0, index + 1);
    }
  }
  return messages;
}
