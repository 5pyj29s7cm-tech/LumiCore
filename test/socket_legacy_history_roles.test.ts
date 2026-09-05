import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import { addMessage, getOrCreateActiveConversation } from '../server/conversation/manager';
import { registerConversationHandlers } from '../server/socket/conversations';

describe('legacy Socket history role compatibility', () => {
  beforeAll(async () => { await initDatabase(); });

  it('maps new user/assistant rows and old combined rows without duplicating assistant text', async () => {
    const userId = 'legacy-role-fixture';
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const common = { userId, agentId: 'lumi', conversationId: conversation.id, domain: 'personal' as const };
    addMessage({ ...common, role: 'user', content: 'New user row', timestamp: '2026-09-05T00:00:01Z' });
    addMessage({ ...common, role: 'assistant', content: 'New assistant row', timestamp: '2026-09-05T00:00:02Z' });
    const db = readDB();
    db.interactions.push({ ...common, id: 'legacy-combined', content: 'Old user row', response: 'Old assistant row', timestamp: '2026-09-05T00:00:03Z' });
    db.interactions.push({ ...common, id: 'assistant-fallback', role: 'assistant', message: '', response: 'Assistant response fallback', timestamp: '2026-09-05T00:00:04Z' });
    writeDB(db);
    const handlers = new Map<string, Function>();
    const socket = { handshake: {}, data: {}, on: (event: string, handler: Function) => handlers.set(event, handler), emit: vi.fn() };
    registerConversationHandlers(socket as any, () => userId);
    await handlers.get('chat:messages')!({ conversationId: conversation.id });
    const messages = socket.emit.mock.calls.at(-1)![1].messages;
    expect(messages.map(({ type, content }: any) => ({ type, content }))).toEqual([
      { type: 'user-text', content: 'New user row' },
      { type: 'lumi', content: 'New assistant row' },
      { type: 'user-text', content: 'Old user row' },
      { type: 'lumi', content: 'Old assistant row' },
      { type: 'lumi', content: 'Assistant response fallback' },
    ]);
  });
});
