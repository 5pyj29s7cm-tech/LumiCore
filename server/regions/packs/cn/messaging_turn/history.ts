import type { IncomingMessage } from "../../../../messaging/types";
import { buildPendingAssistantOfferContextFromTranscript, type PendingAssistantOfferContext } from "../../../../cognition/pending_assistant_offer";
import { getMessagesThroughExternalMessage } from "../../../../conversation/manager";
import { getDisplayText } from "../remote_materials";
import type { conversationForMessagingTurn } from "../messaging_persistence";

export function buildRemoteConversationHistory(
  priorMessages: any[],
  msg: IncomingMessage,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const stableMessageId = String(msg.messageId || '').trim();
  const stableRequestId = stableMessageId ? `${msg.platform}_bot:${stableMessageId}` : '';
  let historicalMessages = msg.userMessagePersisted && stableMessageId
    ? priorMessages.filter(item => !(
        item.role === 'user'
        && (item.externalMessageId === stableMessageId || item.requestId === stableRequestId)
      ))
    : [...priorMessages];

  // Compatibility for old rows that predate remote message IDs. When identity
  // is unavailable, remove the legacy turn as a unit so its assistant response
  // cannot be left orphaned. Modern turns are filtered only by stable identity;
  // identical text from a prior message is legitimate history.
  if (msg.userMessagePersisted && !stableMessageId) {
    const currentDisplayText = getDisplayText(msg).trim();
    for (let index = historicalMessages.length - 1; index >= 0; index -= 1) {
      const item = historicalMessages[index];
      const content = String(item.message || item.content || '').trim();
      if (item.role !== 'user' || item.externalMessageId || item.requestId || content !== currentDisplayText) continue;
      const remove = new Set([index]);
      const following = historicalMessages[index + 1];
      if (
        following?.role === 'assistant'
        && !following.externalMessageId
        && !following.requestId
      ) {
        remove.add(index + 1);
      }
      historicalMessages = historicalMessages.filter((_, itemIndex) => !remove.has(itemIndex));
      break;
    }
  }

  return historicalMessages.flatMap((item: any) => {
    const content = String(item.message || item.content || '').trim();
    const response = String(item.response || '').trim();
    if (item.role === 'assistant') return content ? [{ role: 'assistant' as const, content }] : [];
    if (item.role === 'user') {
      return [
        ...(content ? [{ role: 'user' as const, content }] : []),
        ...(response ? [{ role: 'assistant' as const, content: response }] : []),
      ];
    }
    return [];
  }).slice(-16);
}

export function messagingPendingOffer(msg: IncomingMessage, conversation: ReturnType<typeof conversationForMessagingTurn>): PendingAssistantOfferContext | undefined {
  const precedingTranscript = conversation
    ? getMessagesThroughExternalMessage(conversation.id, msg.messageId, 8).filter(item => !(
        item.role === 'user'
        && (item.externalMessageId === msg.messageId || item.requestId === `${msg.platform}_bot:${msg.messageId}`)
      ))
    : [];
  return conversation
    ? buildPendingAssistantOfferContextFromTranscript({
        messages: precedingTranscript,
        userId: msg.boundUserId,
        domain: msg.boundOrgId ? 'work' : 'personal',
        orgId: msg.boundOrgId || '',
        conversationId: conversation.id,
        taskId: conversation.actionContinuationState?.taskId,
      })
    : undefined;
}
