import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { readDB } from '../db_layer';
import {
  addMessage,
  addMessageIdempotent,
  getOrCreateActiveConversation,
  prepareConversationActionExecution,
  setConversationActionExecutionStatus,
} from '../server/conversation/manager';
import { classifyConversationActionFollowupIntent } from '../server/cognition/action_continuation';
import { normalizeVoiceHistory } from '../server/socket/voice_history';

const POLICY = {
  allowedTools: ['desktop_open', 'desktop_list_files', 'runtime_work_cancel'],
  requireConfirmation: [],
  forbiddenTools: [],
  maxIterations: 6,
};

function persistDeferredTurn(input: {
  userId: string;
  conversationId: string;
  text: string;
  requestId: string;
}): string {
  return addMessageIdempotent({
    userId: input.userId,
    agentId: 'lumi',
    conversationId: input.conversationId,
    role: 'user',
    content: input.text,
    requestId: input.requestId,
    deferActionPreparation: true,
    domain: 'personal',
    source: 'voice',
    channel: 'voice',
  });
}

describe('real multi-turn task runtime regression sequence', () => {
  beforeAll(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('releases a displayed turn whose receipts were all archived as stale so correction is never locked out', () => {
    const userId = `stale-terminal-release-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');

    const initialRequestId = 'request-initial-completed';
    const initialText = '打开 WPS。';
    const initialMessageId = persistDeferredTurn({
      userId,
      conversationId: conversation.id,
      text: initialText,
      requestId: initialRequestId,
    });
    const initial = (prepareConversationActionExecution as any)({
      conversationId: conversation.id,
      userId,
      userText: initialText,
      requestId: initialRequestId,
      userMessageId: initialMessageId,
      toolPolicy: POLICY,
      forceTask: true,
    });
    setConversationActionExecutionStatus(
      conversation.id,
      userId,
      'completed',
      { requestId: '' },
    );
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '已打开 WPS。',
      requestId: initialRequestId,
      taskIntent: 'task',
      toolCalls: [{
        name: 'desktop_open',
        taskId: initial.state?.taskId,
        requestId: initialRequestId,
        arguments: { target: 'WPS' },
        result: JSON.stringify({ ok: true, status: 'verified', target: 'WPS' }),
      }],
      domain: 'personal',
    });

    const materialRequestId = 'voice-material-request';
    const materialText = '我重新整理了一下资料，这个资料你帮我看一下。';
    const materialMessageId = persistDeferredTurn({
      userId,
      conversationId: conversation.id,
      text: materialText,
      requestId: materialRequestId,
    });
    const material = (prepareConversationActionExecution as any)({
      conversationId: conversation.id,
      userId,
      userText: materialText,
      requestId: materialRequestId,
      userMessageId: materialMessageId,
      toolPolicy: POLICY,
      forceTask: true,
    });
    expect(material.state?.taskId).toBeTruthy();

    // Replay the production incident: every tool result carried the request id
    // in the task-id slot, so the assistant record was visible but every
    // receipt was archived as stale.
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '我看到 entry.cjs、node.exe 和 node_modules。',
      requestId: materialRequestId,
      taskIntent: 'task',
      toolCalls: [{
        name: 'desktop_list_files',
        taskId: materialRequestId,
        requestId: materialRequestId,
        arguments: { path: 'D:\\lumiOS\\dist-server' },
        result: JSON.stringify(['entry.cjs', 'node.exe', 'node_modules']),
      }],
      domain: 'personal',
      source: 'voice',
      channel: 'voice',
    });

    const correctionRequestId = 'voice-material-correction';
    const correctionText = '不是这个资料，先停下，我说的是 WPS 当前文件。';
    const correctionMessageId = persistDeferredTurn({
      userId,
      conversationId: conversation.id,
      text: correctionText,
      requestId: correctionRequestId,
    });
    const correction = (prepareConversationActionExecution as any)({
      conversationId: conversation.id,
      userId,
      userText: correctionText,
      requestId: correctionRequestId,
      userMessageId: correctionMessageId,
      toolPolicy: POLICY,
      forceTask: true,
    });

    expect(correction).not.toHaveProperty('bindingFailure');
    const afterCorrection = readDB().conversations.find((item: any) => item.id === conversation.id);
    expect(afterCorrection?.pendingActionContinuation?.requestId).toBe(correctionRequestId);
  });

  it('keeps tool-bearing WPS turns as compact evidence instead of erasing the paired user context', () => {
    const normalized = normalizeVoiceHistory([
      { role: 'user', message: '分析一下 WPS 里面这份文件。' },
      {
        role: 'assistant',
        message: '我还没有锁定当前文件。',
        toolCalls: [{
          name: 'desktop_active_window',
          arguments: {},
          result: JSON.stringify({ ok: true, processName: 'wps.exe', windowTitle: '路演资料.ppt - WPS' }),
        }],
      },
      { role: 'user', message: '不是刚才那份 PPT，是当前打开的。' },
      {
        role: 'assistant',
        message: '我重新检查当前窗口。',
        toolCalls: [{
          name: 'desktop_ui_snapshot',
          arguments: { root: 'active' },
          error: 'document path unavailable',
        }],
      },
      { role: 'user', message: '文件在桌面，叫 Lumia_路演资料.ppt。' },
      { role: 'assistant', message: '收到，我继续锁定这份文件。', toolCalls: [] },
    ]);

    const contents = normalized.map(message => (
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content)
    ));
    expect(contents).toContain('分析一下 WPS 里面这份文件。');
    expect(contents).toContain('不是刚才那份 PPT，是当前打开的。');
    expect(contents).toContain('文件在桌面，叫 Lumia_路演资料.ppt。');
    expect(contents.some(content => content.includes('desktop_active_window'))).toBe(true);
    expect(contents.some(content => content.includes('desktop_ui_snapshot'))).toBe(true);
    expect(contents.join('\n')).not.toContain('node_modules');
  });

  it('treats terse target corrections as continuation of an unfinished task', () => {
    const state = {
      version: 2 as const,
      taskId: 'task-wps-analysis',
      status: 'executing' as const,
      goal: '分析 WPS 当前打开的演示文稿。',
      latestInstruction: '分析 WPS 当前打开的演示文稿。',
      appTarget: 'WPS',
      sourcePaths: [],
      latestBlocker: '',
      unfinished: true,
      evidenceTools: ['desktop_active_window'],
      receipts: [],
      assistantState: '错误地选中了另一份 PPT。',
      toolSummaries: [],
      updatedAt: new Date().toISOString(),
    };

    expect(classifyConversationActionFollowupIntent('不是这份 PPT。', state)).toBe('execute');
    expect(classifyConversationActionFollowupIntent('文件在桌面，叫 Lumia_路演资料.ppt。', state)).toBe('execute');
  });
});
