import { resolveConversationForEntry } from '../../../conversation/entry_conversation';
import { ensurePendingConfirmationPersistenceInitialized } from '../../../tools/pending_confirmation_repository';
import { correlateMessagingReply } from './messaging_ingress_runtime';
import type { IncomingMessage } from '../../../messaging/types';
import { flushDBOrThrow, readDatabaseTables, commitDatabaseTables } from '../../../../db_layer';
import { addMessageIdempotent } from '../../../conversation/manager';
import { admitAcceptedUserTurnDurably, type AcceptedUserTurnAdmission } from '../../../socket/action_turn_durability';
import { type MessagingRouteOptions, type MessagingConversationUpdate, MessagingReplyDurabilityError } from "./messaging_finalization";
import { getDisplayText, messagingConversationAgentId } from "./remote_materials";

export function persistBoundMessagingExchange(
  message: IncomingMessage,
  reply: string,
  onConversationUpdated?: MessagingRouteOptions['onConversationUpdated'],
): MessagingConversationUpdate | null {
  if (!message.userMessagePersisted) {
    persistBoundMessagingMessage(message, 'user', getDisplayText(message));
  }
  return persistBoundMessagingMessage(message, 'assistant', reply, onConversationUpdated);
}

export function conversationForMessagingTurn(message: IncomingMessage) {
  if (!message.boundUserId) return null;
  const domain = message.boundOrgId ? 'work' as const : 'personal' as const;
  const orgId = message.boundOrgId || '';
  const requestId = `${message.platform}_bot:${message.messageId}`;
  return resolveConversationForEntry(message.boundUserId, { domain, orgId }, {
    kind: 'messaging', agentId: messagingConversationAgentId(message), requestId,
  });
}

export function persistBoundMessagingMessage(
  message: IncomingMessage,
  role: 'user' | 'assistant',
  content: string,
  onConversationUpdated?: MessagingRouteOptions['onConversationUpdated'],
  toolCalls?: any[],
  terminalTaskDisposition?: Parameters<typeof addMessageIdempotent>[0]['terminalTaskDisposition'],
): MessagingConversationUpdate | null {
  if (!message.boundUserId) return null;
  const agentId = messagingConversationAgentId(message);
  const domain = message.boundOrgId ? 'work' as const : 'personal' as const;
  const orgId = message.boundOrgId || '';
  const conversation = conversationForMessagingTurn(message);
  if (!conversation) return null;
  const source = `${message.platform}_bot`;
  const requestId = `${source}:${message.messageId}`;
  const messageId = addMessageIdempotent({
    userId: message.boundUserId,
    agentId,
    conversationId: conversation.id,
    role,
    content,
    domain,
    orgId,
    source,
    channel: message.platform,
    externalMessageId: message.messageId,
    routeSequence: message.routeSequence,
    receivedAt: message.receivedAt,
    requestId,
    toolCalls: toolCalls?.length ? toolCalls : undefined,
    terminalTaskDisposition,
    // Remote ingress persists before routing so attachment download/queueing
    // cannot lose the accepted turn. The shared executor creates the real task
    // with its final policy and request lease; never create a placeholder task
    // from this early write.
    deferActionPreparation: role === 'user',
  });
  const update: MessagingConversationUpdate = {
    userId: message.boundUserId,
    domain,
    orgId,
    conversationId: conversation.id,
    agentId,
    source,
    messageId,
  };
  onConversationUpdated?.(update);
  return update;
}

export function removeSupersededAssistantMessage(update: MessagingConversationUpdate | null): void {
  if (!update) return;
  const db = readDatabaseTables(["conversations","interactions"]);
  const index = (db.interactions || []).findIndex((row: any) => (
    row.id === update.messageId
    && row.conversationId === update.conversationId
    && row.userId === update.userId
    && row.role === 'assistant'
  ));
  if (index < 0) return;
  db.interactions.splice(index, 1);
  const conversation = (db.conversations || []).find((item: any) => (
    item.id === update.conversationId && item.userId === update.userId
  ));
  if (conversation) conversation.messageCount = Math.max(0, Number(conversation.messageCount || 0) - 1);
  commitDatabaseTables(db);
}

export function notifyMessagingConversationUpdated(
  update: MessagingConversationUpdate | null,
  callback?: MessagingRouteOptions['onConversationUpdated'],
): void {
  if (update) callback?.(update);
}

export async function admitBoundMessagingTurnDurably(
  message: IncomingMessage,
  onConversationUpdated?: MessagingRouteOptions['onConversationUpdated'],
): Promise<{ message: IncomingMessage; admission: AcceptedUserTurnAdmission<string> | null }> {
  if (!message.boundUserId) return { message, admission: null };
  const persisted = message.userMessagePersisted && message.userMessageId
    ? { messageId: message.userMessageId }
    : persistBoundMessagingMessage(message, 'user', getDisplayText(message), onConversationUpdated);
  const acceptedMessage: IncomingMessage = {
    ...message,
    userMessagePersisted: Boolean(persisted?.messageId),
    userMessageId: persisted?.messageId,
  };
  let admissionFailure: unknown;
  const admission = await admitAcceptedUserTurnDurably({
    persistAcceptedUserTurn: () => {
      if (!acceptedMessage.userMessagePersisted || !acceptedMessage.userMessageId) {
        throw new Error('Accepted remote user transcript was not persisted');
      }
      return acceptedMessage.userMessageId;
    },
    flush: flushDBOrThrow,
    onPersistenceUnknown: error => {
      admissionFailure = error;
    },
  });
  if (!admission) {
    console.error('[Messaging] Accepted remote turn is not durable:', admissionFailure);
    throw new MessagingReplyDurabilityError('accepted_turn', admissionFailure);
  }
  try {
    await ensurePendingConfirmationPersistenceInitialized();
  } catch (error) {
    console.error('[Messaging] Encrypted confirmation store is unavailable:', error);
    throw new MessagingReplyDurabilityError('accepted_turn', error);
  }
  return { message: acceptedMessage, admission };
}

/** All remote reply branches share the same durability and supersession fence. */
export function createMessagingReplyCommitter(message: IncomingMessage, input: {
  flush: () => Promise<void>;
  /** Current turn fence, including authorization, newer messages and execution ownership. */
  isCancelled: () => boolean;
  onConversationUpdated?: MessagingRouteOptions['onConversationUpdated'];
}) {
  return async (text: string, options: {
    toolCalls?: Parameters<typeof persistBoundMessagingMessage>[4];
    terminalTaskDisposition?: Parameters<typeof persistBoundMessagingMessage>[5];
    beforeFlush?: (superseded: boolean) => void;
  } = {}): Promise<string> => {
    const correlated = correlateMessagingReply(message, text);
    const superseded = correlated.superseded || input.isCancelled();
    const persisted = superseded ? null : persistBoundMessagingMessage(
      message, 'assistant', correlated.text, undefined, options.toolCalls, options.terminalTaskDisposition,
    );
    options.beforeFlush?.(superseded);
    await input.flush();
    if (superseded) return '';
    if (input.isCancelled()) {
      removeSupersededAssistantMessage(persisted);
      await input.flush();
      return '';
    }
    notifyMessagingConversationUpdated(persisted, input.onConversationUpdated);
    return correlated.text;
  };
}
