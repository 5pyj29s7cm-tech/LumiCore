import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveChatExecutionEvent,
  shouldApplyInitialConversationMessages,
  shouldReloadPersistedConversation,
} from '../src/lib/conversationSync';

describe('persisted conversation cross-client synchronization', () => {
  it('reloads a persisted turn produced by another client in the same conversation', () => {
    expect(shouldReloadPersistedConversation({
      event: {
        conversationId: 'conv_1',
        requestId: 'diagnostic_request',
        originSocketId: 'socket_diagnostic',
      },
      currentConversationId: 'conv_1',
      currentSocketId: 'socket_ui',
      activeRequestId: null,
    })).toBe(true);
  });

  it('does not remount messages for the originating UI request', () => {
    expect(shouldReloadPersistedConversation({
      event: {
        conversationId: 'conv_1',
        requestId: 'ui_request',
        originSocketId: 'socket_ui',
      },
      currentConversationId: 'conv_1',
      currentSocketId: 'socket_ui',
      activeRequestId: 'ui_request',
    })).toBe(false);
  });

  it('reloads a rollover produced by another client', () => {
    expect(shouldReloadPersistedConversation({
      event: {
        conversationId: 'conv_2',
        requestId: 'remote_request',
        originSocketId: 'socket_remote',
        rolledOver: true,
        previousConversationId: 'conv_1',
      },
      currentConversationId: 'conv_1',
      currentSocketId: 'socket_ui',
    })).toBe(true);
  });

  it('reloads a persisted autonomous result even while an unrelated foreground request exists', () => {
    expect(shouldReloadPersistedConversation({
      event: {
        conversationId: 'conv_1',
        requestId: 'autonomous_task_1',
        source: 'autonomy',
      },
      currentConversationId: 'conv_1',
      currentSocketId: 'socket_ui',
      activeRequestId: 'foreground_request_1',
    })).toBe(true);
  });

  it('keeps the native chat listener wired to persisted message replacement', () => {
    const chat = fs.readFileSync(path.join(process.cwd(), 'src/components/AgentChatPage.tsx'), 'utf8');
    const start = chat.indexOf('const onConversationUpdated =');
    const end = chat.indexOf('const normalizeBackgroundTask =', start);
    const handler = chat.slice(start, end);

    expect(handler).toContain('shouldReloadPersistedConversation({');
    expect(handler).toContain('/messages?limit=${CHAT_HISTORY_LIMIT}');
    expect(handler).toContain('setMessages(normalizePersistedMessages(result.messages))');
    expect(chat).toContain('socket.on("chat:conversation_updated", onConversationUpdated)');
  });
});

describe('native chat execution conversation binding', () => {
  it('adopts the server conversation for the exact active request', () => {
    expect(resolveChatExecutionEvent({
      event: { requestId: 'request_1', source: 'chat', conversationId: 'conversation_1' },
      currentConversationId: '',
      expectedRequestId: 'request_1',
      expectedSource: 'chat',
      textChatActive: true,
    })).toEqual({ accepted: true, adoptedConversationId: 'conversation_1' });
  });

  it('does not let another request or conversation take over the visible transcript', () => {
    expect(resolveChatExecutionEvent({
      event: { requestId: 'request_other', source: 'chat', conversationId: 'conversation_1' },
      currentConversationId: '',
      expectedRequestId: 'request_1',
      expectedSource: 'chat',
      textChatActive: true,
    }).accepted).toBe(false);
    expect(resolveChatExecutionEvent({
      event: { requestId: 'request_1', source: 'chat', conversationId: 'conversation_other' },
      currentConversationId: 'conversation_1',
      expectedRequestId: 'request_1',
      expectedSource: 'chat',
      textChatActive: true,
    }).accepted).toBe(false);
  });
});

describe('initial native conversation history guard', () => {
  const validLoad = {
    expectedScopeKey: 'user:lumi:personal',
    currentScopeKey: 'user:lumi:personal',
    loadedConversationId: 'conversation_1',
    currentConversationId: 'conversation_1',
    activeRequestId: null,
    textChatActive: false,
    messageCountAtStart: 0,
    currentMessageCount: 0,
  };

  it('applies an unchanged snapshot for the same scope and conversation', () => {
    expect(shouldApplyInitialConversationMessages(validLoad)).toBe(true);
  });

  it('does not overwrite a live turn, changed transcript, or switched conversation', () => {
    expect(shouldApplyInitialConversationMessages({ ...validLoad, activeRequestId: 'request_1' })).toBe(false);
    expect(shouldApplyInitialConversationMessages({ ...validLoad, currentMessageCount: 1 })).toBe(false);
    expect(shouldApplyInitialConversationMessages({ ...validLoad, currentConversationId: 'conversation_2' })).toBe(false);
    expect(shouldApplyInitialConversationMessages({ ...validLoad, cancelled: true })).toBe(false);
  });
});
