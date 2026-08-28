import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import {
  addMessage,
  activateConversation,
  deleteConversationData,
  getUserConversations,
  getOrCreateConversationForTurn,
  startIsolatedConversation,
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

  it('runs and exactly cleans an isolated E2E conversation without changing personal active data or settings', () => {
    const userId = `isolated-conversation-${Date.now()}-${Math.random()}`;
    const active = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: active.id,
      role: 'user',
      content: 'pre-existing personal transcript',
      domain: 'personal',
    });
    const db = readDB();
    const settingKey = `isolated-e2e-setting-${userId}`;
    db.settings.push({ key: settingKey, value: 'must-remain-byte-identical' });
    writeDB(db);
    const activeBefore = structuredClone(db.conversations.find((row: any) => row.id === active.id));
    const interactionsBefore = structuredClone(
      db.interactions.filter((row: any) => row.conversationId === active.id),
    );
    const settingsBefore = structuredClone(db.settings);

    const isolated = startIsolatedConversation(userId, 'lumi', 'personal', '');
    const bound = getOrCreateConversationForTurn(userId, 'lumi', 'personal', '', {
      conversationId: isolated.id,
      userText: 'run only in the isolated E2E conversation',
    });
    expect(bound).toMatchObject({ rolledOver: false, conversation: { id: isolated.id, status: 'closed' } });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: isolated.id,
      role: 'user',
      content: 'isolated E2E turn',
      domain: 'personal',
    });

    const afterRun = readDB();
    expect(afterRun.conversations.find((row: any) => row.id === active.id)).toEqual(activeBefore);
    expect(afterRun.interactions.filter((row: any) => row.conversationId === active.id)).toEqual(interactionsBefore);
    expect(afterRun.settings).toEqual(settingsBefore);

    const now = new Date().toISOString();
    const taskId = `isolated-task-${userId}`;
    afterRun.conversationActionTasks.push({
      id: taskId,
      conversationId: isolated.id,
      userId,
      domain: 'personal',
      orgId: '',
      intentKind: 'none',
      operation: 'read',
      goal: 'isolated E2E task',
      target: '',
      status: 'completed',
      blocker: '',
      activeRequestId: '',
      completionSource: 'test',
      context: '{}',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });
    afterRun.conversationActionTurns.push({
      id: `isolated-turn-${userId}`,
      conversationId: isolated.id,
      userId,
      domain: 'personal',
      orgId: '',
      requestId: `isolated-request-${userId}`,
      userMessageId: `isolated-message-${userId}`,
      taskId,
      status: 'terminal',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      terminalAt: now,
    });
    afterRun.conversationActionReceipts.push({
      id: `isolated-receipt-${userId}`,
      taskId,
      conversationId: isolated.id,
      idempotencyKey: `isolated-key-${userId}`,
      toolName: 'runtime_work_status',
      envelope: '{}',
      outcome: 'verified_success',
      createdAt: now,
    });
    afterRun.modelRoutingReceipts.push({
      id: `isolated-routing-${userId}`,
      userId,
      domain: 'personal',
      orgId: '',
      conversationId: isolated.id,
      requestId: `isolated-request-${userId}`,
      status: 'completed',
      requestedProvider: 'test',
      requestedModel: 'test',
      selectionMode: 'pinned',
      attempts: [],
      startedAt: now,
      completedAt: now,
      durationMs: 0,
    });
    writeDB(afterRun);

    const deleted = deleteConversationData(isolated.id, userId, 'personal', '');
    const afterCleanup = readDB();
    expect(deleted).toMatchObject({
      conversationId: isolated.id,
      interactions: 1,
      actionTasks: 1,
      actionTurns: 1,
      actionReceipts: 1,
      routingReceipts: 1,
    });
    expect(afterCleanup.conversations.some((row: any) => row.id === isolated.id)).toBe(false);
    expect(afterCleanup.interactions.some((row: any) => row.conversationId === isolated.id)).toBe(false);
    expect(afterCleanup.conversations.find((row: any) => row.id === active.id)).toEqual(activeBefore);
    expect(afterCleanup.interactions.filter((row: any) => row.conversationId === active.id)).toEqual(interactionsBefore);
    expect(afterCleanup.settings).toEqual(settingsBefore);
    afterCleanup.settings = afterCleanup.settings.filter((row: any) => row.key !== settingKey);
    writeDB(afterCleanup);
  });
});
