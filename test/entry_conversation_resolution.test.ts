import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import { addMessageIdempotent, getOrCreateActiveConversation, startNewConversation } from '../server/conversation/manager';
import { resolveConversationForEntry } from '../server/conversation/entry_conversation';

const personal = { domain: 'personal', orgId: '' };
const uid = () => crypto.randomUUID();
const chat = (requestId: string) => ({ kind: 'chat' as const, phase: 'select' as const, agentId: 'lumi', requestId, source: 'chat' });
describe('conversation identity shared by transport entries', () => {
  beforeAll(async () => { await initDatabase(); });

  it('chat and voice use the same active owner and explicit archived transcripts', () => {
    const userId = uid();
    const first = resolveConversationForEntry(userId, personal, chat('first'))!;
    expect(resolveConversationForEntry(userId, personal, { kind: 'voice', phase: 'select', agentId: 'lumi' })?.id).toBe(first.id);
    const next = startNewConversation(userId, 'lumi', 'personal', '');
    expect(resolveConversationForEntry(userId, personal, chat('second'), first.id)?.id).toBe(first.id);
    expect(resolveConversationForEntry(userId, personal, { kind: 'voice', phase: 'select', agentId: 'lumi' })?.id).toBe(next.id);
  });

  it.each(['chat', 'messaging'] as const)('%s retries retain an accepted archived conversation after a new chat starts', kind => {
    const userId = uid(), requestId = uid();
    const previous = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    addMessageIdempotent({ userId, agentId: 'lumi', conversationId: previous.id, role: 'user', content: 'accepted work', requestId, source: kind === 'chat' ? 'chat' : 'wecom_bot', channel: kind === 'chat' ? 'chat' : 'wecom', ...personal, deferActionPreparation: true });
    const next = startNewConversation(userId, 'lumi', 'personal', '');
    const entry = kind === 'chat' ? chat(requestId) : { kind: 'messaging' as const, agentId: 'lumi', requestId };
    expect(resolveConversationForEntry(userId, personal, entry, next.id)?.id).toBe(previous.id);
  });

  it.each(['chat', 'messaging'] as const)('%s never redirects a deleted accepted binding into a new conversation', kind => {
    const userId = uid(), requestId = uid();
    const previous = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    addMessageIdempotent({ userId, agentId: 'lumi', conversationId: previous.id, role: 'user', content: 'accepted work', requestId, source: kind === 'chat' ? 'chat' : 'wecom_bot', channel: kind === 'chat' ? 'chat' : 'wecom', ...personal, deferActionPreparation: true });
    const next = startNewConversation(userId, 'lumi', 'personal', '');
    const db = readDB();
    db.conversations = db.conversations.filter((row: any) => row.id !== previous.id);
    writeDB(db);
    const entry = kind === 'chat' ? chat(requestId) : { kind: 'messaging' as const, agentId: 'lumi', requestId };
    expect(resolveConversationForEntry(userId, personal, entry)).toBeNull();
    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id).toBe(next.id);
  });

  it('recognizes the durable external message identity after a messaging restart', () => {
    const userId = uid(), requestId = uid();
    const previous = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const messageId = addMessageIdempotent({ userId, agentId: 'lumi', conversationId: previous.id, role: 'user', content: 'accepted remote work', requestId, source: 'wecom_bot', channel: 'wecom', ...personal, deferActionPreparation: true });
    const db = readDB(), row = db.interactions.find((item: any) => item.id === messageId);
    delete row.requestId; row.externalMessageId = requestId; writeDB(db);
    startNewConversation(userId, 'lumi', 'personal', '');
    expect(resolveConversationForEntry(userId, personal, { kind: 'messaging', agentId: 'lumi', requestId })?.id).toBe(previous.id);
  });

  it.each(['chat', 'voice', 'mcp'] as const)('%s rejects an explicit foreign user, agent or workspace', kind => {
    const userId = uid(), otherUser = uid();
    const otherOwner = getOrCreateActiveConversation(otherUser, 'lumi', 'personal', '');
    const otherAgent = getOrCreateActiveConversation(userId, 'memory_avatar_other', 'personal', '');
    const work = getOrCreateActiveConversation(userId, 'lumi', 'work', 'org-a');
    const entry = kind === 'chat' ? chat(uid()) : kind === 'voice' ? { kind: 'voice' as const, phase: 'select' as const, agentId: 'lumi' } : { kind: 'mcp' as const, agentId: 'lumi' };
    for (const id of [otherOwner.id, otherAgent.id, work.id, 'missing']) {
      expect(resolveConversationForEntry(userId, personal, entry, id)).toBeNull();
    }
    expect(resolveConversationForEntry(userId, { domain: 'work', orgId: 'org-b' }, entry, work.id)).toBeNull();
  });

  it('chat retries cannot carry a personal accepted binding into a work scope', () => {
    const userId = uid(), requestId = uid(), previous = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    addMessageIdempotent({ userId, agentId: 'lumi', conversationId: previous.id, role: 'user', content: 'accepted', requestId, source: 'chat', channel: 'chat', ...personal, deferActionPreparation: true });
    const work = getOrCreateActiveConversation(userId, 'lumi', 'work', 'org-a');
    expect(resolveConversationForEntry(userId, { domain: 'work', orgId: 'org-a' }, chat(requestId))).toBeNull();
    expect(getOrCreateActiveConversation(userId, 'lumi', 'work', 'org-a').id).toBe(work.id);
  });

  it('selection leaves an oversized conversation intact; admission owns rollover', () => {
    const userId = uid(), previous = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const db = readDB(); db.conversations.find((row: any) => row.id === previous.id).messageCount = 1000; writeDB(db);
    expect(resolveConversationForEntry(userId, personal, chat(uid()))?.id).toBe(previous.id);
    const admitted = resolveConversationForEntry(userId, personal, { kind: 'chat', phase: 'admit', agentId: 'lumi', userText: 'start unrelated work' }, previous.id);
    expect(admitted.rolledOver).toBe(true);
    expect(admitted.previousConversationId).toBe(previous.id);
    expect(admitted.conversation.id).not.toBe(previous.id);
  });

  it('admitted voice finishes in an explicitly bound archived conversation without rollover', () => {
    const userId = uid(), previous = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    startNewConversation(userId, 'lumi', 'personal', '');
    expect(resolveConversationForEntry(userId, personal, { kind: 'voice', phase: 'admit', agentId: 'lumi', userText: 'accepted continuation' }, previous.id))
      .toMatchObject({ rolledOver: false, conversation: { id: previous.id, status: 'closed' } });
  });

  it('MCP resumes its isolated closed transcript without changing the active native conversation', () => {
    const userId = uid(), active = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const isolated = resolveConversationForEntry(userId, personal, { kind: 'mcp', agentId: 'lumi' })!;
    expect(isolated.status).toBe('closed');
    expect(resolveConversationForEntry(userId, personal, { kind: 'mcp', agentId: 'lumi', resumeConversationId: isolated.id })?.id).toBe(isolated.id);
    expect(resolveConversationForEntry(userId, personal, { kind: 'mcp', agentId: 'lumi' }, isolated.id)?.id).toBe(isolated.id);
    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id).toBe(active.id);
  });

  it('MCP replaces an unavailable cached resume id but rejects an unavailable explicit id', () => {
    const userId = uid();
    expect(resolveConversationForEntry(userId, personal, { kind: 'mcp', agentId: 'lumi', resumeConversationId: 'missing' })?.status).toBe('closed');
    expect(resolveConversationForEntry(userId, personal, { kind: 'mcp', agentId: 'lumi' }, 'missing')).toBeNull();
    expect(resolveConversationForEntry(userId, personal, { kind: 'mcp', agentId: 'lumi' }, '   ')).toBeNull();
  });
});
