import { describe, expect, it } from 'vitest';
import { shouldReloadPersistedConversation } from '../src/lib/conversationSync';

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
});
