import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import {
  addMessage,
  getOrCreateActiveConversation,
} from '../server/conversation/manager';

describe('conversation action continuation state', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('persists terminal tool evidence across turns and clears it when a concrete new topic supersedes the task', () => {
    const userId = `conversation-action-state-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');

    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '打开 WPS。',
      domain: 'personal',
    });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '已打开 WPS。',
      toolCalls: [{
        name: 'desktop_open',
        arguments: { target: 'WPS' },
        result: JSON.stringify({ ok: true, status: 'opened', target: 'WPS' }),
      }],
      domain: 'personal',
    });

    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toMatchObject({ goal: '打开 WPS。', appTarget: 'WPS', evidenceTools: ['desktop_open'] });

    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '完成了吗？',
      domain: 'personal',
    });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '刚才已成功打开，当前没有新的执行。',
      domain: 'personal',
    });

    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toMatchObject({ goal: '打开 WPS。', appTarget: 'WPS' });

    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '我们聊聊明天的天气。',
      domain: 'personal',
    });

    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toBeUndefined();
  });

  it('does not create durable task state from an assistant claim without tool evidence', () => {
    const userId = `conversation-action-no-evidence-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '在桌面创建文件。',
      domain: 'personal',
    });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '已经创建好了。',
      domain: 'personal',
    });

    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toBeUndefined();
  });

  it('does not let an unrelated proactive message consume an in-flight task pointer', () => {
    const userId = `conversation-action-proactive-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '打开 WPS。',
      domain: 'personal',
    });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '有一条新的提醒。',
      mode: 'proactive',
      domain: 'personal',
    });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '已打开 WPS。',
      toolCalls: [{
        name: 'desktop_open',
        arguments: { target: 'WPS' },
        result: JSON.stringify({ ok: true, status: 'opened', target: 'WPS' }),
      }],
      domain: 'personal',
    });

    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toMatchObject({ goal: '打开 WPS。', appTarget: 'WPS' });
  });
});
