export interface ConversationUpdatedEvent {
  conversationId?: string;
  requestId?: string;
  source?: string;
  originSocketId?: string;
  rolledOver?: boolean;
  previousConversationId?: string;
}

export interface ChatExecutionEventIdentity {
  requestId?: string;
  source?: string;
  conversationId?: string;
}

export interface ChatExecutionEventResolution {
  accepted: boolean;
  adoptedConversationId?: string;
}

export function resolveChatExecutionEvent(input: {
  event?: ChatExecutionEventIdentity;
  currentConversationId?: string | null;
  expectedRequestId?: string | null;
  expectedSource?: string | null;
  textChatActive?: boolean;
}): ChatExecutionEventResolution {
  const eventRequestId = String(input.event?.requestId || '').trim();
  const expectedRequestId = String(input.expectedRequestId || '').trim();
  const eventConversationId = String(input.event?.conversationId || '').trim();
  const currentConversationId = String(input.currentConversationId || '').trim();
  const eventSource = String(input.event?.source || '').trim();
  const expectedSource = String(input.expectedSource || '').trim();

  if (expectedRequestId) {
    if (eventRequestId !== expectedRequestId) return { accepted: false };
    if (eventSource && expectedSource && eventSource !== expectedSource) return { accepted: false };
    if (currentConversationId && eventConversationId && eventConversationId !== currentConversationId) {
      return { accepted: false };
    }
    return {
      accepted: true,
      adoptedConversationId: !currentConversationId && eventConversationId
        ? eventConversationId
        : undefined,
    };
  }

  if (eventRequestId) return { accepted: false };
  if (eventSource && expectedSource && eventSource !== expectedSource) return { accepted: false };
  if (!input.textChatActive) return { accepted: false };
  if (eventConversationId && eventConversationId !== currentConversationId) return { accepted: false };
  return { accepted: true };
}

export function shouldApplyInitialConversationMessages(input: {
  cancelled?: boolean;
  expectedScopeKey: string;
  currentScopeKey: string;
  loadedConversationId?: string | null;
  currentConversationId?: string | null;
  activeRequestId?: string | null;
  textChatActive?: boolean;
  messageCountAtStart: number;
  currentMessageCount: number;
}): boolean {
  if (input.cancelled) return false;
  if (input.expectedScopeKey !== input.currentScopeKey) return false;
  if (String(input.activeRequestId || '').trim() || input.textChatActive) return false;
  const loadedConversationId = String(input.loadedConversationId || '').trim();
  if (!loadedConversationId) return false;
  if (loadedConversationId !== String(input.currentConversationId || '').trim()) return false;
  return input.messageCountAtStart === input.currentMessageCount;
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
