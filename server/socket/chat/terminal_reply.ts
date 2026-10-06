import type { ChatMessageWriter, ChatTurnMessage } from './message_writer';

type ReplyInput = {
  text: string;
  [key: string]: unknown;
  message: () => Omit<ChatTurnMessage, 'role' | 'content' | 'conversationId'> & { conversationId?: string };
  publishAfter?: () => void;
  errorContext?: string;
};

/** Common reply fields are bound here; the durable boundary still owns all writes. */
export function createChatTerminalReply(input: {
  commit: (terminal: { payload: Record<string, any>; persistAssistantMessage: () => void;
    publishAfter?: () => void; errorContext?: string }) => Promise<boolean>;
  write: ChatMessageWriter;
  getConversationId: () => string;
}) {
  return ({ message, publishAfter, errorContext, ...payload }: ReplyInput): Promise<boolean> => input.commit({
    payload: { agentName: 'Lumi', finalized: true, blocked: false, ...payload },
    persistAssistantMessage: () => input.write({
      conversationId: input.getConversationId(), ...message(), role: 'assistant', content: payload.text,
    }),
    publishAfter,
    errorContext,
  });
}
