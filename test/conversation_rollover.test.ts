import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import {
  addMessage,
  getConversationSummary,
  getOrCreateActiveConversation,
  getOrCreateConversationForTurn,
  prepareConversationActionExecution,
  setConversationSummary,
} from '../server/conversation/manager';

describe('conversation rollover', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('archives an oversized segment and gives the next segment safe conversational continuity', () => {
    const userId = `rollover-${Date.now()}-${Math.random()}`;
    const previous = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const guardText = '我还没有真正操作客户端，这一轮没有记录到成功的工具执行。';
    const hiddenToolText = 'internal-tool-result-that-must-not-cross-the-boundary';

    addMessage({ userId, agentId: 'lumi', conversationId: previous.id, role: 'user', content: '我们在讨论桌面端稳定性。' });
    addMessage({ userId, agentId: 'lumi', conversationId: previous.id, role: 'assistant', content: '先检查会话调度。' });
    expect(setConversationSummary(previous.id, '长期有效信息：用户正在检查 Lumi 桌面端。')).toBe(true);
    addMessage({ userId, agentId: 'lumi', conversationId: previous.id, role: 'tool', content: hiddenToolText });
    addMessage({ userId, agentId: 'lumi', conversationId: previous.id, role: 'user', content: '语音也要保持自然。' });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: previous.id,
      role: 'assistant',
      content: guardText,
      cognitiveIntent: 'work_product_guard',
    });
    addMessage({ userId, agentId: 'lumi', conversationId: previous.id, role: 'assistant', content: '下一步检查长会话换段。' });

    previous.actionContinuationState = {
      version: 1,
      goal: '旧任务',
      latestInstruction: '继续旧任务',
      appTarget: '',
      sourcePaths: [],
      latestBlocker: '',
      unfinished: true,
      evidenceTools: ['desktop_open'],
      assistantState: '旧任务仍在执行',
      toolSummaries: ['旧工具结果'],
      updatedAt: new Date().toISOString(),
    };

    const result = getOrCreateConversationForTurn(
      userId,
      'lumi',
      'personal',
      '',
      { userText: '现在检查一个新问题', messageLimit: 6 },
    );

    expect(result.rolledOver).toBe(true);
    expect(result.previousConversationId).toBe(previous.id);
    expect(result.conversation.id).not.toBe(previous.id);
    expect(result.conversation).toMatchObject({
      status: 'active',
      messageCount: 0,
      lastSummaryMessageCount: 0,
    });
    expect(result.conversation.actionContinuationState).toBeUndefined();
    expect(result.conversation.pendingActionContinuation).toBeUndefined();

    const storedPrevious = readDB().conversations.find((item: any) => item.id === previous.id);
    expect(storedPrevious).toMatchObject({ status: 'closed', lastSummaryMessageCount: 6 });

    const continuity = getConversationSummary(result.conversation.id) || '';
    expect(continuity).toContain('长期有效信息：用户正在检查 Lumi 桌面端。');
    expect(continuity).toContain('语音也要保持自然。');
    expect(continuity).toContain('下一步检查长会话换段。');
    expect(continuity).toContain('Do not infer or claim that any prior tool run, pending confirmation, background job, or unfinished action remains active.');
    expect(continuity).not.toContain(hiddenToolText);
    expect(continuity).not.toContain(guardText);
  });

  it('keeps a referential follow-up at the soft limit but enforces the hard limit', () => {
    const userId = `rollover-followup-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');

    for (let index = 0; index < 4; index += 1) {
      addMessage({
        userId,
        agentId: 'lumi',
        conversationId: conversation.id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `soft-${index}`,
      });
    }

    const soft = getOrCreateConversationForTurn(
      userId,
      'lumi',
      'personal',
      '',
      { userText: '继续', messageLimit: 4 },
    );
    expect(soft).toMatchObject({ rolledOver: false });
    expect(soft.conversation.id).toBe(conversation.id);

    for (let index = 0; index < 4; index += 1) {
      addMessage({
        userId,
        agentId: 'lumi',
        conversationId: conversation.id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `hard-${index}`,
      });
    }

    const hard = getOrCreateConversationForTurn(
      userId,
      'lumi',
      'personal',
      '',
      { userText: '继续', messageLimit: 4 },
    );
    expect(hard.rolledOver).toBe(true);
    expect(hard.previousConversationId).toBe(conversation.id);
  });

  it('does not split a user turn that is still awaiting its terminal response', () => {
    const userId = `rollover-pending-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    for (let index = 0; index < 4; index += 1) {
      addMessage({
        userId,
        agentId: 'lumi',
        conversationId: conversation.id,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `complete-${index}`,
      });
    }
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '这个回合还没有结束',
    });

    const result = getOrCreateConversationForTurn(
      userId,
      'lumi',
      'personal',
      '',
      { userText: '开始另一个任务', messageLimit: 4 },
    );
    expect(result.rolledOver).toBe(false);
    expect(result.conversation.id).toBe(conversation.id);
  });

  it('keeps a newer task pointer when an older request persists a late terminal reply', () => {
    const userId = `request-isolation-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const toolPolicy = {
      allowedTools: ['desktop_open'],
      requireConfirmation: [],
      forbiddenTools: [],
      maxIterations: 5,
    };
    const older = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: '\u6253\u5f00\u8bb0\u4e8b\u672c',
      requestId: 'request-older',
      toolPolicy,
      forceTask: true,
    });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '\u6253\u5f00\u8bb0\u4e8b\u672c',
      requestId: 'request-older',
    });

    const newer = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: '\u6253\u5f00\u8ba1\u7b97\u5668',
      requestId: 'request-newer',
      toolPolicy,
      forceTask: true,
      forceNewTask: true,
    });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '\u6253\u5f00\u8ba1\u7b97\u5668',
      requestId: 'request-newer',
    });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '\u65e7\u8bf7\u6c42\u7684\u8fdf\u5230\u56de\u590d',
      requestId: 'request-older',
      toolCalls: [{
        name: 'desktop_open',
        arguments: { target: '\u8bb0\u4e8b\u672c' },
        result: JSON.stringify({ ok: true, status: 'verified', targetMatched: true }),
        taskId: older.state?.taskId,
        requestId: 'request-older',
      }],
    });

    const stored = readDB().conversations.find((item: any) => item.id === conversation.id);
    expect(stored?.actionContinuationState?.taskId).toBe(newer.state?.taskId);
    expect(stored?.actionContinuationState?.activeRequestId).toBe('request-newer');
    expect(stored?.pendingActionContinuation?.requestId).toBe('request-newer');
  });
});
