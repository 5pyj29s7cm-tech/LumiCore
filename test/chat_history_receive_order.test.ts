import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import {
  addMessageIdempotent,
  getMessageByRequestId,
  getMessages,
  getOrCreateActiveConversation,
} from '../server/conversation/manager';

describe('native chat receive-order persistence', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('keeps an in-flight foreground turn ahead of its status sidecar', () => {
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

    addMessageIdempotent({ ...common, role: 'user', content: 'A user', requestId: 'request-A', receivedAt: '2026-08-22T00:00:00.000Z', timestamp: '2026-08-22T00:00:00.000Z', deferActionPreparation: true });
    addMessageIdempotent({ ...common, role: 'user', content: 'S user', requestId: 'request-S', receivedAt: '2026-08-22T00:00:00.000Z', timestamp: '2026-08-22T00:00:00.000Z', cognitiveIntent: 'task_status', skipActionContinuation: true });
    addMessageIdempotent({ ...common, role: 'assistant', content: 'S assistant', requestId: 'request-S', timestamp: '2026-08-22T00:00:00.000Z', cognitiveIntent: 'task_status', skipActionContinuation: true });

    const duringA = readDB().conversations.find((item: any) => item.id === conversation.id);
    expect(duringA?.pendingActionContinuation?.requestId).toBe('request-A');

    addMessageIdempotent({ ...common, role: 'assistant', content: 'A assistant', requestId: 'request-A', timestamp: '2026-08-22T00:00:00.000Z' });

    const history = getMessages(conversation.id);
    expect(history.map(item => item.message)).toEqual([
      'A user',
      'S user',
      'S assistant',
      'A assistant',
    ]);
    expect(history.map(item => item.routeSequence)).toEqual([1, 2, 3, 4]);
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
