import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  flushDBOrThrow,
  initDatabase,
  querySQL,
  readDB,
} from '../db_layer';
import {
  addMessage,
  addMessageIdempotent,
  getMessages,
  updateAssistantMessageTerminalPresentation,
} from '../server/conversation/manager';

describe('foreground completion feedback persistence', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `feedback-user-${suffix}`;
  const conversationId = `feedback-conversation-${suffix}`;

  beforeAll(async () => {
    await initDatabase();
    const db = readDB();
    db.conversations ||= [];
    db.conversations.push({
      id: conversationId,
      userId,
      agentId: 'lumi',
      title: 'Feedback persistence',
      status: 'active',
      summary: '',
      messageCount: 0,
      lastActiveAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      domain: 'personal',
      orgId: '',
    });
  });

  it('stores only bounded, allowlisted and secret-redacted feedback', async () => {
    const requestId = `verified-${suffix}`;
    const messageId = addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'assistant',
      content: 'The observed window is ready.',
      source: 'chat',
      channel: 'chat',
      requestId,
      completionFeedback: {
        status: 'completed',
        completed: ['Window observation completed.', { arbitrary: true }],
        evidence: [
          'Verified tool receipt: desktop_active_window',
          'authorization: Bearer definitely-secret-token-value',
          ...Array.from({ length: 12 }, (_, index) => `receipt-${index}`),
        ],
        incomplete: [],
        blockers: [],
        nextSteps: ['x'.repeat(900)],
        providerTrace: { prompt: 'must not persist' },
      },
    });
    await flushDBOrThrow();

    const rows = await querySQL<any>(
      'SELECT completionFeedback FROM interactions WHERE id = ? LIMIT 1',
      [messageId],
    );
    const stored = JSON.parse(rows[0].completionFeedback);
    expect(Object.keys(stored).sort()).toEqual([
      'blockers',
      'completed',
      'evidence',
      'incomplete',
      'nextSteps',
      'status',
    ]);
    expect(stored.status).toBe('completed');
    expect(stored.completed).toEqual(['The task is complete.']);
    expect(stored.evidence).toEqual(['The current execution result was recorded.']);
    expect(JSON.stringify(stored)).not.toContain('definitely-secret-token-value');
    expect(JSON.stringify(stored)).not.toMatch(/desktop_active_window|verified terminal evidence|tool receipt/iu);
    expect(JSON.stringify(stored)).not.toContain('providerTrace');
    expect(stored.nextSteps).toEqual(['No further action is needed.']);
  });

  it('does not invent feedback for an ordinary conversation row', async () => {
    const messageId = addMessage({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'assistant',
      content: 'Hello, how can I help?',
      source: 'chat',
      channel: 'chat',
    });
    await flushDBOrThrow();
    const rows = await querySQL<any>(
      'SELECT completionFeedback FROM interactions WHERE id = ? LIMIT 1',
      [messageId],
    );
    expect(rows[0].completionFeedback).toBe('');
    expect(getMessages(conversationId).find(message => message.id === messageId)?.completionFeedback)
      .toBeUndefined();
  });

  it('never persists internal execution-guard prose through task feedback', async () => {
    const requestId = `guard-redaction-${suffix}`;
    const messageId = addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'assistant',
      content: 'The requested action could not be verified.',
      source: 'chat',
      channel: 'chat',
      requestId,
      completionFeedback: {
        status: 'blocked',
        completed: [],
        evidence: [],
        incomplete: ['The task is not verified complete.'],
        blockers: [
          'No successful current-turn tool execution was recorded for that execution-status claim.',
          '\u8fd9\u4e00\u8f6e\u6ca1\u6709\u8bb0\u5f55\u5230\u6210\u529f\u7684\u771f\u5b9e\u5de5\u5177\u6267\u884c\u3002',
        ],
        nextSteps: ['Retry the action.'],
      },
    });
    await flushDBOrThrow();

    const rows = await querySQL<any>(
      'SELECT completionFeedback FROM interactions WHERE id = ? LIMIT 1',
      [messageId],
    );
    const serialized = String(rows[0].completionFeedback || '');
    expect(serialized).not.toMatch(/No successful current-turn|\u8fd9\u4e00\u8f6e\u6ca1\u6709\u8bb0\u5f55\u5230\u6210\u529f\u7684\u771f\u5b9e\u5de5\u5177\u6267\u884c/iu);
    expect(JSON.parse(serialized).blockers).toEqual(['当前步骤未能完成。']);
    expect(serialized).not.toMatch(/execution_|desktop_|verified terminal evidence/iu);
  });

  it('replaces a staged terminal projection with persistence-unknown and survives restart', async () => {
    const requestId = `unknown-${suffix}`;
    const messageId = addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'assistant',
      content: 'The task completed.',
      source: 'chat',
      channel: 'chat',
      requestId,
      completionFeedback: {
        status: 'completed', completed: ['Completed.'], evidence: ['receipt'], incomplete: [], blockers: [], nextSteps: [],
      },
    });
    expect(updateAssistantMessageTerminalPresentation({
      userId,
      conversationId,
      requestId,
      content: 'The terminal persistence outcome is unknown.',
      source: 'chat',
      channel: 'chat',
      completionFeedback: {
        status: 'blocked',
        completed: [],
        evidence: [],
        incomplete: ['Task is not verified complete.'],
        blockers: ['Terminal persistence outcome is unknown.'],
        nextSteps: ['Retry only after persistence health recovers.'],
      },
    })).toBe(true);
    await flushDBOrThrow();
    await closeDatabase();
    await initDatabase();

    const restored = getMessages(conversationId).find(message => message.id === messageId);
    expect(restored).toMatchObject({
      role: 'assistant',
      message: 'The terminal persistence outcome is unknown.',
      completionFeedback: {
        status: 'blocked',
        incomplete: ['The task is not complete yet.'],
        blockers: ['Terminal persistence outcome is unknown.'],
      },
    });
  });

  it('projects internal completion evidence without tool names, reason codes, or the full task label', async () => {
    const requestId = `public-projection-${suffix}`;
    const fullTask = '帮我分析一下 WPS 当前打开的文件，先告诉我它主要讲了什么。';
    const messageId = addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'assistant',
      content: '已读取当前文档。',
      source: 'chat',
      channel: 'chat',
      requestId,
      completionFeedback: {
        status: 'completed',
        completed: [`${fullTask} completed with verified terminal evidence.`],
        evidence: [
          'Verified tool receipts: desktop_running_processes, desktop_list_files, extract_document_text',
        ],
        incomplete: [],
        blockers: ['execution_recovery_incomplete'],
        nextSteps: [],
      },
    });
    await flushDBOrThrow();

    const rows = await querySQL<any>(
      'SELECT completionFeedback FROM interactions WHERE id = ? LIMIT 1',
      [messageId],
    );
    const stored = JSON.parse(rows[0].completionFeedback);
    const serialized = JSON.stringify(stored);
    expect(stored).toMatchObject({
      status: 'completed',
      completed: ['任务已完成。'],
      evidence: ['已记录当前执行结果。'],
    });
    expect(serialized).not.toContain(fullTask);
    expect(serialized).not.toMatch(/desktop_|execution_|extract_document_text|verified terminal evidence/iu);
  });
});
