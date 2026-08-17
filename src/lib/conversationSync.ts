export interface ConversationUpdatedEvent {
  conversationId?: string;
  requestId?: string;
  originSocketId?: string;
  rolledOver?: boolean;
  previousConversationId?: string;
}

export function shouldReloadPersistedConversation(input: {
  event: ConversationUpdatedEvent;
  currentConversationId?: string | null;
  currentSocketId?: string | null;
  activeRequestId?: string | null;
}): boolean {
  const eventConversationId = String(input.event.conversationId || '').trim();
  if (!eventConversationId) return false;
  if (
    input.event.originSocketId
    && input.currentSocketId
    && input.event.originSocketId === input.currentSocketId
  ) return false;
  if (
    input.event.requestId
    && input.activeRequestId
    && input.event.requestId === input.activeRequestId
  ) return false;

  const currentConversationId = String(input.currentConversationId || '').trim();
  if (!currentConversationId) return true;
  if (eventConversationId === currentConversationId) return true;
  return input.event.rolledOver === true
    && input.event.previousConversationId === currentConversationId;
}
