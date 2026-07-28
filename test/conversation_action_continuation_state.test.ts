import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import {
  addMessage,
  getMessages,
  getOrCreateActiveConversation,
  prepareConversationActionExecution,
  recoverOrphanedConversationActionExecutions,
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
        result: JSON.stringify({
          ok: true,
          status: 'verified',
          target: 'WPS',
          targetMatched: true,
          actualTarget: { processName: 'wps.exe', title: 'WPS Writer' },
        }),
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

  it('keeps a zero-receipt action blocked instead of accepting the assistant claim as completion', () => {
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
      .toMatchObject({
        version: 2,
        status: 'blocked',
        unfinished: true,
        receipts: [],
        goal: '在桌面创建文件。',
      });
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
        result: JSON.stringify({
          ok: true,
          status: 'verified',
          target: 'WPS',
          targetMatched: true,
          actualTarget: { processName: 'wps.exe', title: 'WPS Writer' },
        }),
      }],
      domain: 'personal',
    });

    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toMatchObject({ goal: '打开 WPS。', appTarget: 'WPS' });
  });

  it('accepts a concrete user-visible correction as terminal verification', () => {
    const userId = `conversation-user-observation-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '给文件传输助手发送微信消息：测试',
      domain: 'personal',
    });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '发送结果无法确认。',
      toolCalls: [{
        name: 'wechat_send_message',
        arguments: { recipient: '文件传输助手', text: '测试' },
        result: JSON.stringify({
          sent: false,
          sendAttempted: true,
          verificationStatus: 'uncertain',
        }),
      }],
      domain: 'personal',
    });
    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toMatchObject({ status: 'blocked', unfinished: true });

    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '你已经发送出去了',
      domain: 'personal',
    });

    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toMatchObject({
        status: 'completed',
        unfinished: false,
        completionSource: 'user_observation',
        goal: '给文件传输助手发送微信消息：测试',
      });
  });

  it('turns a process-local execution lease into a resumable blocker on restart', () => {
    const userId = `conversation-orphaned-lease-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '打开 WPS 并新建 Word 文档',
      domain: 'personal',
    });
    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toMatchObject({ status: 'planning', unfinished: true });

    expect(recoverOrphanedConversationActionExecutions('2026-07-22T14:00:00.000Z')).toBeGreaterThan(0);
    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toMatchObject({
        status: 'blocked',
        unfinished: true,
        activeRequestId: undefined,
        updatedAt: '2026-07-22T14:00:00.000Z',
      });
  });

  it('persists an accepted voice instruction before routing without letting progress chat steal its task pointer', () => {
    const userId = `conversation-voice-durable-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const instruction = '读取桌面上的阿陆平面图画进 AutoCAD 里';

    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: instruction,
      mode: 'voice',
      source: 'voice',
      domain: 'personal',
      deferActionPreparation: true,
    });
    expect(getMessages(conversation.id).some(message => message.message === instruction)).toBe(true);
    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState).toBeUndefined();

    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '任务执行得怎么样？',
      mode: 'voice',
      source: 'voice_sidecar',
      domain: 'personal',
      skipActionContinuation: true,
    });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '还在继续处理，没有停。',
      mode: 'voice',
      source: 'voice_sidecar',
      domain: 'personal',
      skipActionContinuation: true,
    });

    const prepared = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: instruction,
      requestId: 'voice-request-1',
      toolPolicy: {
        allowedTools: ['floorplan_extract_geometry', 'mcp_cad-drafting_autocad_playback_file'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 12,
      },
    });
    expect(prepared.kind).toBe('new');
    expect(prepared.state).toMatchObject({
      goal: instruction,
      status: 'planning',
      activeRequestId: 'voice-request-1',
    });
  });
});
