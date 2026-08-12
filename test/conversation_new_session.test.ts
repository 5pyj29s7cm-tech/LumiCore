import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import {
  addMessage,
  activateConversation,
  getUserConversations,
  getOrCreateConversationForTurn,
  startNewConversation,
  getOrCreateActiveConversation,
} from '../server/conversation/manager';

describe('explicit new conversation', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('archives the transcript while preserving its task state and starts empty', () => {
    const userId = `new-conversation-${Date.now()}-${Math.random()}`;
    const previous = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: previous.id,
      role: 'user',
      content: 'old conversation content',
    });
    previous.actionContinuationState = {
      version: 1,
      goal: 'durable old task',
      latestInstruction: 'continue in background',
      appTarget: '',
      sourcePaths: [],
      latestBlocker: '',
      unfinished: true,
      evidenceTools: [],
      assistantState: 'running',
      toolSummaries: [],
      updatedAt: new Date().toISOString(),
    };

    const next = startNewConversation(userId, 'lumi', 'personal', '');
    const db = readDB();
    const archived = db.conversations.find((item: any) => item.id === previous.id);

    expect(next).toMatchObject({ status: 'active', messageCount: 0, summary: '' });
    expect(next.id).not.toBe(previous.id);
    expect(archived).toMatchObject({ status: 'closed' });
    expect(archived?.actionContinuationState).toMatchObject({ goal: 'durable old task', unfinished: true });
  });

  it('allows an already accepted turn to finish in its archived conversation', () => {
    const userId = `new-conversation-flight-${Date.now()}-${Math.random()}`;
    const previous = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    startNewConversation(userId, 'lumi', 'personal', '');

    const acceptedTurn = getOrCreateConversationForTurn(
      userId,
      'lumi',
      'personal',
      '',
      { conversationId: previous.id, userText: 'already accepted work' },
    );

    expect(acceptedTurn).toMatchObject({ rolledOver: false });
    expect(acceptedTurn.conversation.id).toBe(previous.id);
    expect(acceptedTurn.conversation.status).toBe('closed');
  });

  it('restores an old conversation only inside the same user, agent, and workspace', () => {
    const userId = `restore-conversation-${Date.now()}-${Math.random()}`;
    const previous = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: previous.id,
      role: 'user',
      content: 'conversation to restore',
    });
    const current = startNewConversation(userId, 'lumi', 'personal', '');

    const restored = activateConversation(previous.id, userId, 'lumi', 'personal', '');
    const listed = getUserConversations(userId, 20, 0, 'personal', '', 'lumi');
    const db = readDB();

    expect(restored).toMatchObject({ id: previous.id, status: 'active' });
    expect(db.conversations.find((item: any) => item.id === current.id)?.status).toBe('closed');
    expect(listed.map(item => item.id)).toContain(previous.id);
    expect(activateConversation(previous.id, userId, 'another-agent', 'personal', '')).toBeNull();
    expect(activateConversation(previous.id, 'another-user', 'lumi', 'personal', '')).toBeNull();
    expect(activateConversation(previous.id, userId, 'lumi', 'work', 'org-elsewhere')).toBeNull();
  });
});
