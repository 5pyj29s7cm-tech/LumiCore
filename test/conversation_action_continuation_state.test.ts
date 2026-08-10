import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
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

  it('recovers an older hidden execution lease without replacing the newer current task', () => {
    const userId = `conversation-hidden-lease-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const staleTaskId = `task-stale-${Date.now()}-${Math.random()}`;
    const newerTaskId = `task-newer-${Date.now()}-${Math.random()}`;
    const db = readDB();
    db.conversationActionTasks.push({
      id: staleTaskId,
      conversationId: conversation.id,
      userId,
      domain: 'personal',
      orgId: '',
      parentTaskId: '',
      rootUserMessageId: '',
      intentKind: 'desktop_operation',
      operation: 'mutate',
      goal: 'Open the earlier document',
      target: 'document',
      status: 'executing',
      blocker: '',
      activeRequestId: 'request-stale',
      completionSource: '',
      context: JSON.stringify({
        actionState: {
          version: 2,
          taskId: staleTaskId,
          goal: 'Open the earlier document',
          status: 'executing',
          unfinished: true,
          activeRequestId: 'request-stale',
          revision: 1,
          updatedAt: '2026-07-22T12:00:00.000Z',
        },
      }),
      revision: 1,
      createdAt: '2026-07-22T12:00:00.000Z',
      updatedAt: '2026-07-22T12:01:00.000Z',
      completedAt: '',
    });
    db.conversationActionTasks.push({
      id: newerTaskId,
      conversationId: conversation.id,
      userId,
      domain: 'personal',
      orgId: '',
      parentTaskId: '',
      rootUserMessageId: '',
      intentKind: 'status_query',
      operation: 'status',
      goal: 'Report the newer task',
      target: 'task',
      status: 'completed',
      blocker: '',
      activeRequestId: '',
      completionSource: 'tool_receipt',
      context: JSON.stringify({
        actionState: {
          version: 2,
          taskId: newerTaskId,
          goal: 'Report the newer task',
          status: 'completed',
          unfinished: false,
          revision: 1,
          updatedAt: '2026-07-22T13:00:00.000Z',
        },
      }),
      revision: 1,
      createdAt: '2026-07-22T13:00:00.000Z',
      updatedAt: '2026-07-22T13:00:00.000Z',
      completedAt: '2026-07-22T13:00:00.000Z',
    });

    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toBeUndefined();
    expect(recoverOrphanedConversationActionExecutions('2026-07-22T14:00:00.000Z')).toBeGreaterThan(0);

    const staleTask = db.conversationActionTasks.find((task: any) => task.id === staleTaskId);
    expect(staleTask).toMatchObject({
      status: 'blocked',
      activeRequestId: '',
      updatedAt: '2026-07-22T12:01:00.000Z',
    });
    expect(JSON.parse(staleTask.context)).toMatchObject({
      executionLeaseRecovery: {
        recoveredAt: '2026-07-22T14:00:00.000Z',
        priorStatus: 'executing',
        newerTaskAlreadyExists: true,
      },
      actionState: {
        status: 'blocked',
        unfinished: true,
      },
    });
    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toBeUndefined();
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

  it('supersedes the previous foreground task without leaving its lease executing', () => {
    const userId = `conversation-action-supersede-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const first = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: '进入壁纸模式。',
      requestId: 'request-wallpaper',
      toolPolicy: { allowedTools: ['client_action'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 },
      forceTask: true,
    });
    const second = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: '打开网易云音乐，放首歌给我听吧。',
      requestId: 'request-music',
      toolPolicy: { allowedTools: ['desktop_open'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 },
      forceTask: true,
    });

    expect(second.kind).toBe('new');
    expect(second.state?.taskId).not.toBe(first.state?.taskId);
    expect(second.state).toMatchObject({
      goal: '打开网易云音乐，放首歌给我听吧。',
      activeRequestId: 'request-music',
    });
    const oldTask = (readDB().conversationActionTasks || []).find((task: any) => task.id === first.state?.taskId);
    expect(oldTask).toMatchObject({
      status: 'cancelled',
      activeRequestId: '',
    });
    expect(oldTask.blocker).toContain(second.state?.taskId);
  });

  it('archives a late receipt on its bound task without mutating the newer turn', () => {
    const userId = `conversation-action-late-receipt-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '打开 WPS。',
      domain: 'personal',
      deferActionPreparation: true,
      requestId: 'request-old',
    } as any);
    const oldTask = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: '打开 WPS。',
      requestId: 'request-old',
      toolPolicy: { allowedTools: ['desktop_open'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 },
      forceTask: true,
    });

    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '进入壁纸模式。',
      domain: 'personal',
      deferActionPreparation: true,
      requestId: 'request-new',
    } as any);
    const newTask = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: '进入壁纸模式。',
      requestId: 'request-new',
      toolPolicy: { allowedTools: ['client_action'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 },
      forceTask: true,
    });

    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: 'WPS 已打开。',
      domain: 'personal',
      requestId: 'request-old',
      toolCalls: [{
        taskId: oldTask.state?.taskId,
        requestId: 'request-old',
        name: 'desktop_open',
        arguments: { target: 'WPS' },
        result: JSON.stringify({ ok: true, status: 'verified', target: 'WPS', targetMatched: true }),
      }],
    } as any);

    const current = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState;
    expect(current).toMatchObject({
      taskId: newTask.state?.taskId,
      goal: '进入壁纸模式。',
      activeRequestId: 'request-new',
      receipts: [],
    });
    const archived = (readDB().conversationActionReceipts || []).filter((receipt: any) => (
      receipt.taskId === oldTask.state?.taskId && receipt.requestId === 'request-old'
    ));
    expect(archived).toHaveLength(1);
    expect(archived[0].toolName).toBe('desktop_open');
  });
});
