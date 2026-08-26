import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import {
  addMessageIdempotent,
  bindConversationActionExecutionTurn,
  getMessageByRequestId,
  getMessages,
  getOrCreateActiveConversation,
} from '../server/conversation/manager';

describe('native chat receive-order persistence', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('persists queued A/B/C transcripts without letting them overwrite the active pending turn', () => {
    const userId = `chat-order-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const common = {
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      domain: 'personal',
      orgId: '',
      source: 'chat',
      channel: 'chat',
    } as const;

    const aId = addMessageIdempotent({ ...common, role: 'user', content: 'A user', requestId: 'request-A', receivedAt: '2026-08-22T00:00:00.000Z', timestamp: '2026-08-22T00:00:00.000Z', deferActionPreparation: true });
    const bId = addMessageIdempotent({ ...common, role: 'user', content: 'B user', requestId: 'request-B', receivedAt: '2026-08-22T00:00:01.000Z', timestamp: '2026-08-22T00:00:01.000Z', deferActionPreparation: true });
    const cId = addMessageIdempotent({ ...common, role: 'user', content: 'C user', requestId: 'request-C', receivedAt: '2026-08-22T00:00:02.000Z', timestamp: '2026-08-22T00:00:02.000Z', deferActionPreparation: true });

    let persisted = readDB().conversations.find((item: any) => item.id === conversation.id);
    expect(persisted?.pendingActionContinuation).toBeUndefined();

    expect(bindConversationActionExecutionTurn({ conversationId: conversation.id, userId, userText: 'A user', requestId: 'request-A', userMessageId: aId })).toMatchObject({ messageId: aId, requestId: 'request-A' });
    expect(bindConversationActionExecutionTurn({ conversationId: conversation.id, userId, userText: 'B user', requestId: 'request-B', userMessageId: bId })).toBeNull();
    persisted = readDB().conversations.find((item: any) => item.id === conversation.id);
    expect(persisted?.pendingActionContinuation).toMatchObject({ messageId: aId, requestId: 'request-A' });

    addMessageIdempotent({ ...common, role: 'assistant', content: 'A assistant', requestId: 'request-A', timestamp: '2026-08-22T00:00:03.000Z' });
    expect(bindConversationActionExecutionTurn({ conversationId: conversation.id, userId, userText: 'B user', requestId: 'request-B', userMessageId: bId })).toMatchObject({ messageId: bId, requestId: 'request-B' });
    expect(bindConversationActionExecutionTurn({ conversationId: conversation.id, userId, userText: 'C user', requestId: 'request-C', userMessageId: cId })).toBeNull();
    addMessageIdempotent({ ...common, role: 'assistant', content: 'B assistant', requestId: 'request-B', timestamp: '2026-08-22T00:00:04.000Z' });
    expect(bindConversationActionExecutionTurn({ conversationId: conversation.id, userId, userText: 'C user', requestId: 'request-C', userMessageId: cId })).toMatchObject({ messageId: cId, requestId: 'request-C' });
    addMessageIdempotent({ ...common, role: 'assistant', content: 'C assistant', requestId: 'request-C', timestamp: '2026-08-22T00:00:05.000Z' });

    persisted = readDB().conversations.find((item: any) => item.id === conversation.id);
    expect(persisted?.pendingActionContinuation).toBeUndefined();

    const history = getMessages(conversation.id);
    expect(history.map(item => item.message)).toEqual([
      'A user',
      'B user',
      'C user',
      'A assistant',
      'B assistant',
      'C assistant',
    ]);
    expect(history.map(item => item.routeSequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(history[0].receivedAt).toBe('2026-08-22T00:00:00.000Z');
  });

  it('has the accepted user row before terminal completion', () => {
    const userId = `chat-restart-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const input = {
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: 'accepted before crash',
      domain: 'personal',
      orgId: '',
      source: 'chat',
      channel: 'chat',
      requestId: 'request-restart',
      receivedAt: '2026-08-22T00:01:00.000Z',
      timestamp: '2026-08-22T00:01:00.000Z',
      deferActionPreparation: true,
    } as const;

    const firstId = addMessageIdempotent(input);
    expect(getMessages(conversation.id).map(item => item.message)).toEqual(['accepted before crash']);
    expect(getMessageByRequestId({ ...input })).toMatchObject({ id: firstId });
  });

  it('deduplicates a same-request retry after durable fields are rehydrated', () => {
    const userId = `chat-retry-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const input = {
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: 'retry only once',
      domain: 'personal',
      orgId: '',
      source: 'chat',
      channel: 'chat',
      requestId: 'request-retry',
      receivedAt: '2026-08-22T00:02:00.000Z',
      timestamp: '2026-08-22T00:02:00.000Z',
      deferActionPreparation: true,
    } as const;

    const firstId = addMessageIdempotent(input);

    // Database hydration preserves externalMessageId but legacy schemas may not
    // expose the transient requestId property. Exercise that restart shape.
    const stored = readDB().interactions.find((item: any) => item.id === firstId);
    delete stored.requestId;
    expect(stored.externalMessageId).toBe('request-retry');

    const retryId = addMessageIdempotent(input);
    expect(retryId).toBe(firstId);
    expect(getMessages(conversation.id).filter(item => item.role === 'user')).toHaveLength(1);
  });
});
