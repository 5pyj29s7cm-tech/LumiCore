import { addMessageIdempotent } from '../../conversation/manager';
import type { SocketNativeRequestBinding } from '../native_request_binding';

type Message = Parameters<typeof addMessageIdempotent>[0];
type RequestIdentityKey = 'userId' | 'agentId' | 'domain' | 'orgId' | 'channel' | 'requestId';
export type ChatTurnMessage = Omit<Message, RequestIdentityKey>;
export type ChatMessageWriter = (message: ChatTurnMessage) => string;

/** Bind authenticated request identity once; individual branches only supply message data. */
export function createChatMessageWriter(input: {
  userId: Message['userId'];
  agentId: Message['agentId'];
  domain: Message['domain'];
  orgId: Message['orgId'];
  requestId: string;
  source: string;
  getNativeBinding: () => SocketNativeRequestBinding | null;
}): ChatMessageWriter {
  return message => addMessageIdempotent({
    source: input.source,
    ...message,
    userId: input.userId,
    agentId: input.agentId,
    domain: input.domain,
    orgId: input.orgId,
    channel: 'chat',
    requestId: input.requestId,
    ...(input.getNativeBinding() || {}),
  });
}
