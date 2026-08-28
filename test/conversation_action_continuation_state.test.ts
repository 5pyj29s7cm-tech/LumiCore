import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import {
  addMessage,
  addMessageIdempotent,
  bindConversationActionExecutionTurn,
  getMessages,
  getOrCreateActiveConversation,
  prepareConversationActionExecution,
  recoverOrphanedConversationActionExecutions,
  settleConversationActionExecutionRequest,
  setConversationActionExecutionStatus,
} from '../server/conversation/manager';
import { getConversationActionStateFromLedger } from '../server/conversation/action_ledger';

function durableActionState(conversationId: string, userId: string) {
  return getConversationActionStateFromLedger(readDB(), { conversationId, userId });
}

function persistActionTurn(input: {
  conversationId: string;
  userId: string;
  userText: string;
  requestId: string;
}): string {
  return addMessageIdempotent({
    userId: input.userId,
    agentId: 'lumi',
    conversationId: input.conversationId,
    role: 'user',
    content: input.userText,
    requestId: input.requestId,
    deferActionPreparation: true,
    domain: 'personal',
  });
}

describe('conversation action continuation state', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('keeps terminal evidence in durable history without occupying the live pointer', () => {
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
      .toBeUndefined();
    expect(durableActionState(conversation.id, userId))
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
      .toBeUndefined();
    expect(durableActionState(conversation.id, userId))
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
    expect(durableActionState(conversation.id, userId))
      .toMatchObject({ goal: '打开 WPS。', status: 'completed' });
  });

  it('keeps a zero-receipt action blocked instead of accepting the assistant claim as completion', () => {
    const userId = `conversation-action-no-evidence-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const requestId = `request-no-evidence-${Date.now()}`;
    const userMessageId = addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '在桌面创建文件。',
      requestId,
      deferActionPreparation: true,
      domain: 'personal',
    });
    expect(bindConversationActionExecutionTurn({
      conversationId: conversation.id,
      userId,
      userText: '在桌面创建文件。',
      requestId,
      userMessageId,
    })).toMatchObject({ requestId, messageId: userMessageId });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '已经创建好了。',
      requestId,
      taskIntent: 'task',
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

  it('replays the formal WPS foreground sequence without replacing the blocked task or adopting LumiCore as its target', () => {
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const userId = `wps-foreground-continuation-${nonce}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const firstRequestId = `chat-wps-current-document-${nonce}`;
    const firstText = '帮我分析一下wps当前打开的文件';
    const firstMessageId = persistActionTurn({
      conversationId: conversation.id,
      userId,
      userText: firstText,
      requestId: firstRequestId,
    });
    const toolPolicy = {
      allowedTools: ['desktop_active_window', 'desktop_poll_activity'],
      requireConfirmation: [],
      forbiddenTools: [],
      maxIterations: 4,
    };
    const first = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: firstText,
      requestId: firstRequestId,
      userMessageId: firstMessageId,
      toolPolicy,
      forceTask: true,
    });
    const taskId = first.state?.taskId || '';
    expect(taskId).toBeTruthy();

    addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '我现在看到的前台窗口是 Visual Studio Code，不是可读取的 WPS 文档。请先把要分析的文档切到前台。',
      requestId: firstRequestId,
      taskIntent: 'task',
      domain: 'personal',
      source: 'test',
      channel: 'chat',
      toolCalls: [{
        id: `active-vscode-${nonce}`,
        key: 'desktop_active_window:{}',
        name: 'desktop_active_window',
        arguments: {},
        result: JSON.stringify({
          window_id: '4198450',
          title: 'lumiOS - Visual Studio Code',
          process_name: 'Code.exe',
          executable_path: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
        }),
        outcome: 'success',
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'The active window observation returned.',
        },
        taskId,
        requestId: firstRequestId,
        turnId: firstRequestId,
        recordedAt: '2026-08-28T10:15:41.044Z',
      }],
      terminalTaskDisposition: {
        outcome: 'blocked',
        taskId,
        requestId: firstRequestId,
        reason: 'desktop_execution_plan_receipt: target_mismatch',
      },
      timestamp: '2026-08-28T10:15:41.044Z',
    });

    const blocked = getOrCreateActiveConversation(userId, 'lumi', 'personal', '')
      .actionContinuationState;
    expect(blocked).toMatchObject({
      taskId,
      status: 'blocked',
      unfinished: true,
      activeRequestId: undefined,
      goal: firstText,
    });
    const taskBefore = structuredClone(
      (readDB().conversationActionTasks || []).find((row: any) => row.id === taskId),
    );
    expect(taskBefore).toBeDefined();

    const secondRequestId = `chat-wps-foreground-ready-${nonce}`;
    const secondText = '已经切到前台';
    const secondMessageId = persistActionTurn({
      conversationId: conversation.id,
      userId,
      userText: secondText,
      requestId: secondRequestId,
    });
    const second = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: secondText,
      requestId: secondRequestId,
      userMessageId: secondMessageId,
      toolPolicy,
      forceTask: true,
    });

    expect(second).not.toHaveProperty('bindingFailure');
    expect(second.kind).toBe('resume');
    expect(second.state).toMatchObject({
      taskId,
      goal: firstText,
      latestInstruction: secondText,
      status: 'planning',
      activeRequestId: secondRequestId,
    });
    expect(second.state?.taskCapsule?.target).toEqual(blocked?.taskCapsule?.target);

    const lumiRuntimePath = 'D:\\lumiOS\\src-tauri\\target-codex-lumicore-tauri\\release\\lumi-core.exe';
    addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '前台仍是 LumiCore，尚未获得 WPS 当前文档。',
      requestId: secondRequestId,
      taskIntent: 'task',
      domain: 'personal',
      source: 'test',
      channel: 'chat',
      toolCalls: [{
        id: `poll-lumicore-${nonce}`,
        key: 'desktop_poll_activity:{}',
        name: 'desktop_poll_activity',
        arguments: {},
        result: JSON.stringify({
          window: {
            window_id: '489555400',
            title: 'LumiCore',
            process_name: 'lumi-core.exe',
            executable_path: lumiRuntimePath,
          },
          idle: { idle_ms: 13094, idle_seconds: 13 },
        }),
        outcome: 'success',
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'The foreground observation returned.',
        },
        taskId,
        requestId: secondRequestId,
        turnId: secondRequestId,
        recordedAt: '2026-08-28T10:16:21.105Z',
      }],
      terminalTaskDisposition: {
        outcome: 'blocked',
        taskId,
        requestId: secondRequestId,
        reason: 'desktop_execution_plan_receipt: target_mismatch',
      },
      timestamp: '2026-08-28T10:16:21.105Z',
    });

    const finalConversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    expect(finalConversation.actionContinuationState).toMatchObject({
      taskId,
      status: 'blocked',
      unfinished: true,
      activeRequestId: undefined,
      goal: firstText,
    });
    expect(finalConversation.actionContinuationState?.sourcePaths).not.toContain(lumiRuntimePath);
    expect(finalConversation.actionContinuationState?.taskCapsule?.paths).not.toContain(lumiRuntimePath);
    expect(finalConversation.actionContinuationState?.taskCapsule?.target.path).not.toBe(lumiRuntimePath);

    const db = readDB();
    const tasks = (db.conversationActionTasks || [])
      .filter((row: any) => row.conversationId === conversation.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: taskId,
      goal: firstText,
      target: taskBefore.target,
      status: 'blocked',
      rootUserMessageId: firstMessageId,
    });
    expect(tasks[0].target).not.toContain('LumiCore');
    expect(tasks[0].target).not.toContain('lumi-core.exe');

    const turns = (db.conversationActionTurns || [])
      .filter((row: any) => row.conversationId === conversation.id)
      .filter((row: any) => [firstRequestId, secondRequestId].includes(row.requestId));
    expect(turns).toHaveLength(2);
    expect(turns.map((row: any) => row.taskId)).toEqual([taskId, taskId]);
    expect(turns.map((row: any) => row.requestId)).toEqual([firstRequestId, secondRequestId]);
  });

  it('persists receipt-only cancellation truth into the durable conversation task', () => {
    const userId = `conversation-receipt-only-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');

    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '\u505c\u6b62\u540e\u53f0\u4efb\u52a1',
      domain: 'personal',
    });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '\u540e\u53f0\u4efb\u52a1\u5df2\u53d6\u6d88\u3002',
      toolCalls: [{
        id: `receipt-only-cancel-${Date.now()}`,
        name: 'runtime_work_cancel',
        arguments: {},
        result: '',
        receipt: JSON.stringify(JSON.stringify({
          ok: true,
          status: 'cancelled',
          matchedCount: 1,
          cancelledCount: 1,
          cancellingCount: 0,
          failedCount: 0,
        })),
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'The unified runtime ledger confirmed cancellation.',
        },
      }],
      domain: 'personal',
    });

    expect(durableActionState(conversation.id, userId)).toMatchObject({
      goal: '\u505c\u6b62\u540e\u53f0\u4efb\u52a1',
      status: 'completed',
      unfinished: false,
      completionSource: 'tool_receipt',
      evidenceTools: ['runtime_work_cancel'],
    });
  });

  it('clears a deferred prior-action status turn after a deterministic zero-tool reply', () => {
    const userId = `conversation-prior-action-status-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const requestId = `prior-action-status-${Date.now()}`;
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: 'What did you just do, and what evidence proved it succeeded?',
      requestId,
      deferActionPreparation: true,
      domain: 'personal',
    });
    // Deferred status sidecars are transcript-only and never take ownership of
    // the foreground action pointer.
    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').pendingActionContinuation)
      .toBeUndefined();

    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '没有可验证的上一轮执行回执。',
      requestId,
      cognitiveIntent: 'task_status',
      llmWasCalled: false,
      domain: 'personal',
    });

    const stored = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    expect(stored.pendingActionContinuation).toBeUndefined();
    expect(stored.actionContinuationState).toBeUndefined();
  });

  it('does not create a durable task from user wording or ordinary model conversation alone', () => {
    const userId = `conversation-no-heuristic-task-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '打开客户端设置。',
      domain: 'personal',
    });
    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toBeUndefined();

    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '我们可以先确认你想调整哪一项。',
      taskIntent: 'conversation',
      domain: 'personal',
    });
    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toBeUndefined();
  });

  it('keeps canonical observation receipts ephemeral unless the model selects a durable capability', () => {
    const userId = `conversation-observation-ephemeral-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const verification = {
      strategy: 'terminal_receipt' as const,
      required: true,
      requiredFields: [] as string[],
      successSignals: [] as string[],
      limitations: [] as string[],
    };

    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '读取一下当前客户端状态。',
      domain: 'personal',
    });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '当前客户端状态正常。',
      toolCalls: [{
        name: 'client_get_state',
        arguments: {},
        result: '{"status":"ready"}',
        capability: {
          capabilityId: 'client.state.observe',
          lane: 'client',
          operation: 'observe',
          risk: 'low',
          sideEffects: [{ type: 'local_read', scope: 'client_state', reversible: true }],
          verification,
        },
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'Client state returned.',
        },
      }],
      domain: 'personal',
    });

    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toBeUndefined();

    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '打开客户端设置。',
      domain: 'personal',
    });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: '设置已打开。',
      toolCalls: [{
        name: 'client_action',
        arguments: { action: 'open_settings' },
        result: '{"status":"verified"}',
        capability: {
          capabilityId: 'client.navigation',
          lane: 'client',
          operation: 'mutate',
          risk: 'low',
          sideEffects: [{ type: 'local_state_change', scope: 'client_surface', reversible: true }],
          verification,
        },
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'Client surface changed.',
        },
      }],
      domain: 'personal',
    });

    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toBeUndefined();
    expect(durableActionState(conversation.id, userId))
      .toMatchObject({ goal: '打开客户端设置。', evidenceTools: ['client_action'] });
  });

  it('does not let an unrelated proactive message consume terminal task history', () => {
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
      .toBeUndefined();
    expect(durableActionState(conversation.id, userId))
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
      .toBeUndefined();
    expect(durableActionState(conversation.id, userId))
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
    prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: '打开 WPS 并新建 Word 文档',
      requestId: 'restart-recovery-request',
      userMessageId: persistActionTurn({
        conversationId: conversation.id,
        userId,
        userText: '打开 WPS 并新建 Word 文档',
        requestId: 'restart-recovery-request',
      }),
      toolPolicy: {
        allowedTools: ['desktop_open'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 5,
      },
      forceTask: true,
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
      userMessageId: persistActionTurn({
        conversationId: conversation.id,
        userId,
        userText: instruction,
        requestId: 'voice-request-1',
      }),
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

  it('keeps side-channel status transcript writes read-only for the durable task row', () => {
    const userId = `conversation-status-read-only-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const instruction = 'Create a local report and wait for confirmation.';
    const taskRequestId = 'status-read-only-task-request';
    const userMessageId = persistActionTurn({
      conversationId: conversation.id,
      userId,
      userText: instruction,
      requestId: taskRequestId,
    });
    const prepared = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: instruction,
      requestId: taskRequestId,
      userMessageId,
      toolPolicy: {
        allowedTools: ['write_file'],
        requireConfirmation: ['write_file'],
        forbiddenTools: [],
        maxIterations: 8,
      },
    });
    expect(prepared.state?.taskId).toBeTruthy();
    setConversationActionExecutionStatus(
      conversation.id,
      userId,
      'waiting_confirmation',
      { requestId: taskRequestId, assistantState: 'Waiting for confirmation.' },
    );

    const before = structuredClone(
      (readDB().conversationActionTasks || []).find((row: any) => row.id === prepared.state?.taskId),
    );
    expect(before).toBeDefined();

    const statusRequestId = 'status-read-only-query-request';
    addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: 'Is this task complete? Report status only.',
      source: 'chat_task_status',
      channel: 'chat',
      cognitiveIntent: 'task_status',
      requestId: statusRequestId,
      skipActionContinuation: true,
      timestamp: '2026-08-28T03:10:00.000Z',
    });
    addMessageIdempotent({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: 'The task is waiting for confirmation.',
      source: 'chat_task_status',
      channel: 'chat',
      cognitiveIntent: 'task_status',
      requestId: statusRequestId,
      skipActionContinuation: true,
      timestamp: '2026-08-28T03:10:01.000Z',
    });

    const after = (readDB().conversationActionTasks || [])
      .find((row: any) => row.id === prepared.state?.taskId);
    expect(after).toEqual(before);
  });

  it('rejects a different persisted turn while another request owns the action pointer', () => {
    const userId = `conversation-action-busy-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const firstText = 'Open the browser.';
    const firstRequestId = 'request-busy-first';
    const first = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: firstText,
      requestId: firstRequestId,
      userMessageId: persistActionTurn({
        conversationId: conversation.id,
        userId,
        userText: firstText,
        requestId: firstRequestId,
      }),
      toolPolicy: { allowedTools: ['desktop_open'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 },
      forceTask: true,
    });
    const secondText = 'Open the calculator.';
    const secondRequestId = 'request-busy-second';
    const rejected = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: secondText,
      requestId: secondRequestId,
      userMessageId: persistActionTurn({
        conversationId: conversation.id,
        userId,
        userText: secondText,
        requestId: secondRequestId,
      }),
      toolPolicy: { allowedTools: ['desktop_open'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 },
      forceTask: true,
    });

    expect(rejected).toMatchObject({
      state: null,
      kind: 'conversation',
      bindingFailure: 'busy',
      diagnosticCode: 'conversation_action_turn_busy',
    });
    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '')).toMatchObject({
      pendingActionContinuation: { requestId: firstRequestId },
      actionContinuationState: {
        taskId: first.state?.taskId,
        activeRequestId: firstRequestId,
      },
    });
  });

  it('repairs a terminal conversation pointer from the newer unfinished durable task', () => {
    const userId = `conversation-repair-terminal-pointer-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const terminalTaskId = `task-terminal-pointer-${Date.now()}-${Math.random()}`;
    const liveTaskId = `task-live-pointer-${Date.now()}-${Math.random()}`;
    const terminalAt = '2026-08-27T04:00:00.000Z';
    const liveAt = '2026-08-27T04:01:00.000Z';
    const terminalState = {
      version: 2 as const,
      taskId: terminalTaskId,
      goal: 'Finish the earlier task.',
      latestInstruction: 'Finish the earlier task.',
      status: 'completed' as const,
      unfinished: false,
      receipts: [],
      appTarget: '',
      sourcePaths: [],
      latestBlocker: '',
      evidenceTools: [],
      assistantState: 'Earlier task completed.',
      toolSummaries: [],
      revision: 2,
      updatedAt: terminalAt,
    };
    const liveState = {
      ...terminalState,
      taskId: liveTaskId,
      goal: 'Continue the newer interrupted task.',
      latestInstruction: 'Continue the newer interrupted task.',
      status: 'blocked' as const,
      unfinished: true,
      latestBlocker: 'The prior executor stopped before verification.',
      assistantState: '',
      revision: 1,
      updatedAt: liveAt,
    };
    conversation.actionContinuationState = terminalState;

    const db = readDB();
    for (const [state, createdAt] of [
      [terminalState, terminalAt],
      [liveState, liveAt],
    ] as const) {
      db.conversationActionTasks.push({
        id: state.taskId,
        conversationId: conversation.id,
        userId,
        domain: 'personal',
        orgId: '',
        parentTaskId: '',
        rootUserMessageId: '',
        intentKind: 'desktop_operation',
        operation: 'mutate',
        goal: state.goal,
        target: '',
        status: state.status,
        blocker: state.latestBlocker,
        activeRequestId: '',
        completionSource: state.status === 'completed' ? 'tool_receipt' : '',
        context: JSON.stringify({ actionState: state }),
        revision: state.revision,
        createdAt,
        updatedAt: state.updatedAt,
        completedAt: state.status === 'completed' ? state.updatedAt : '',
      });
    }

    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toMatchObject({
        taskId: liveTaskId,
        status: 'blocked',
        unfinished: true,
        latestBlocker: 'The prior executor stopped before verification.',
      });
  });

  it('rejects a missing transcript identity without creating action state', () => {
    const userId = `conversation-action-stale-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const rejected = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: 'Open settings.',
      requestId: 'request-stale-message',
      userMessageId: 'msg-does-not-exist',
      toolPolicy: { allowedTools: ['client_action'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 },
      forceTask: true,
    });

    expect(rejected).toMatchObject({
      state: null,
      kind: 'conversation',
      bindingFailure: 'stale',
      diagnosticCode: 'conversation_action_turn_not_persisted',
    });
    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toBeUndefined();
  });

  it('supersedes the previous foreground task without leaving its lease executing', () => {
    const userId = `conversation-action-supersede-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const first = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: '进入壁纸模式。',
      requestId: 'request-wallpaper',
      userMessageId: persistActionTurn({
        conversationId: conversation.id,
        userId,
        userText: '进入壁纸模式。',
        requestId: 'request-wallpaper',
      }),
      toolPolicy: { allowedTools: ['client_action'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 },
      forceTask: true,
    });
    expect(settleConversationActionExecutionRequest(
      conversation.id,
      userId,
      'request-wallpaper',
    )).toMatchObject({ status: 'blocked', activeRequestId: undefined });
    const second = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: '打开网易云音乐，放首歌给我听吧。',
      requestId: 'request-music',
      userMessageId: persistActionTurn({
        conversationId: conversation.id,
        userId,
        userText: '打开网易云音乐，放首歌给我听吧。',
        requestId: 'request-music',
      }),
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
  });

  it('binds a durable task and receipt to the real user message instead of assistant evidence', () => {
    const userId = `conversation-action-user-root-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const requestId = `request-user-root-${Date.now()}`;
    const userMessageId = addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: 'Open the desktop settings panel.',
      requestId,
      deferActionPreparation: true,
      domain: 'personal',
    });
    const prepared = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: 'Open the desktop settings panel.',
      requestId,
      userMessageId: persistActionTurn({
        conversationId: conversation.id,
        userId,
        userText: 'Open the desktop settings panel.',
        requestId,
      }),
      toolPolicy: { allowedTools: ['client_action'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 },
      forceTask: true,
    });
    const assistantMessageId = addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: 'The settings panel is open.',
      requestId,
      taskIntent: 'task',
      toolCalls: [{
        taskId: prepared.state?.taskId,
        requestId,
        name: 'client_action',
        arguments: { action: 'open_settings' },
        result: JSON.stringify({ ok: true, status: 'verified' }),
        capability: {
          capabilityId: 'client.navigation',
          lane: 'client',
          operation: 'mutate',
          risk: 'low',
          sideEffects: [{ type: 'local_state_change', scope: 'client_surface', reversible: true }],
          verification: {
            strategy: 'terminal_receipt', required: true, requiredFields: [], successSignals: [], limitations: [],
          },
        },
        terminalVerification: {
          status: 'verified', strategy: 'terminal_receipt', reason: 'Client surface changed.',
        },
      }],
      domain: 'personal',
    });

    const db = readDB();
    const task = (db.conversationActionTasks || []).find((row: any) => row.id === prepared.state?.taskId);
    expect(task?.rootUserMessageId).toBe(userMessageId);
    expect(task?.rootUserMessageId).not.toBe(assistantMessageId);
    expect((db.interactions || []).find((row: any) => row.id === task?.rootUserMessageId)?.role).toBe('user');
    const receipts = (db.conversationActionReceipts || []).filter((row: any) => row.taskId === task?.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ turnId: userMessageId, requestId });
  });

  it('archives a failed desktop attempt even when the same logical step later succeeds', () => {
    const userId = `conversation-action-attempts-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const requestId = `request-attempts-${Date.now()}`;
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: 'Enter wallpaper mode.',
      requestId,
      deferActionPreparation: true,
      domain: 'personal',
    });
    const prepared = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: 'Enter wallpaper mode.',
      requestId,
      userMessageId: persistActionTurn({
        conversationId: conversation.id,
        userId,
        userText: 'Enter wallpaper mode.',
        requestId,
      }),
      toolPolicy: { allowedTools: ['client_action'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 },
      forceTask: true,
    });
    const shared = {
      taskId: prepared.state?.taskId,
      requestId,
      name: 'client_action',
      arguments: { action: 'set_wallpaper_mode', enabled: true },
    };
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Wallpaper mode is on.',
      requestId,
      taskIntent: 'task',
      toolCalls: [{
        ...shared,
        id: 'wallpaper-attempt-timeout',
        result: '',
        error: 'Desktop control conflict: timed out waiting for global desktop lease.',
        terminalVerification: { status: 'failed', strategy: 'terminal_receipt', reason: 'lease_timeout' },
      }, {
        ...shared,
        id: 'wallpaper-attempt-success',
        result: JSON.stringify({ ok: true, status: 'verified' }),
        terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'wallpaper enabled' },
      }],
      domain: 'personal',
    });

    const db = readDB();
    const receipts = (db.conversationActionReceipts || [])
      .filter((row: any) => row.taskId === prepared.state?.taskId && row.toolName === 'client_action');
    expect(receipts.map((row: any) => row.outcome).sort()).toEqual(['timeout', 'verified_success']);
    expect(receipts.some((row: any) => JSON.parse(row.envelope).error?.includes('timed out'))).toBe(true);
    const task = (db.conversationActionTasks || []).find((row: any) => row.id === prepared.state?.taskId);
    expect(task?.status).toBe('completed');
    expect(task?.blocker).toBe('');
    expect(JSON.parse(String(task?.context || '{}')).actionState).toMatchObject({
      status: 'completed',
      unfinished: false,
      latestBlocker: '',
    });
  });

  it('archives every retry when a durable receipt creates the task without a prepare step', () => {
    const userId = `conversation-action-unprepared-attempts-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const requestId = `request-unprepared-attempts-${Date.now()}`;
    const userMessageId = addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: 'Enter wallpaper mode.',
      requestId,
      deferActionPreparation: true,
      domain: 'personal',
    });
    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toBeUndefined();
    expect(bindConversationActionExecutionTurn({
      conversationId: conversation.id,
      userId,
      userText: 'Enter wallpaper mode.',
      requestId,
      userMessageId,
    })).toMatchObject({ requestId, messageId: userMessageId });

    const shared = {
      taskId: 'runtime-provisional-wallpaper-task',
      requestId,
      name: 'client_action',
      arguments: { action: 'set_wallpaper_mode', enabled: true },
    };
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Wallpaper mode is on.',
      requestId,
      taskIntent: 'task',
      toolCalls: [{
        ...shared,
        id: 'unprepared-wallpaper-attempt-timeout',
        result: '',
        error: 'Desktop control conflict: timed out waiting for global desktop lease.',
        terminalVerification: { status: 'failed', strategy: 'terminal_receipt', reason: 'lease_timeout' },
      }, {
        ...shared,
        id: 'unprepared-wallpaper-attempt-success',
        result: JSON.stringify({ ok: true, status: 'verified' }),
        terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'wallpaper enabled' },
      }],
      domain: 'personal',
    });

    const db = readDB();
    const task = (db.conversationActionTasks || [])
      .find((row: any) => row.conversationId === conversation.id);
    const receipts = (db.conversationActionReceipts || [])
      .filter((row: any) => row.taskId === task?.id && row.toolName === 'client_action');
    expect(receipts.map((row: any) => row.outcome)).toEqual(['timeout', 'verified_success']);
    expect(task).toMatchObject({ status: 'completed', blocker: '' });
    expect(JSON.parse(String(task?.context || '{}')).actionState).toMatchObject({
      status: 'completed',
      unfinished: false,
      latestBlocker: '',
    });
    const assistant = (db.interactions || []).find((row: any) => (
      row.conversationId === conversation.id
      && row.role === 'assistant'
      && row.requestId === requestId
    ));
    expect(assistant?.toolCalls).toHaveLength(2);
    expect(assistant?.toolCalls?.[0]).toMatchObject({
      id: 'unprepared-wallpaper-attempt-timeout',
      error: 'Desktop control conflict: timed out waiting for global desktop lease.',
    });
    expect(assistant?.toolCalls?.[1]).toMatchObject({
      id: 'unprepared-wallpaper-attempt-success',
      terminalVerification: { status: 'verified' },
    });
  });

  it('detaches a stale confirmation task before model, voiceprint, and screen turns', () => {
    const userId = `conversation-action-detach-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const oldRequestId = `request-browser-${Date.now()}`;
    const oldUserMessageId = addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: 'Open the browser and sign in.',
      requestId: oldRequestId,
      deferActionPreparation: true,
      domain: 'personal',
    });
    const oldTask = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: 'Open the browser and sign in.',
      requestId: oldRequestId,
      userMessageId: persistActionTurn({
        conversationId: conversation.id,
        userId,
        userText: 'Open the browser and sign in.',
        requestId: oldRequestId,
      }),
      toolPolicy: { allowedTools: ['desktop_open'], requireConfirmation: ['desktop_open'], forbiddenTools: [], maxIterations: 4 },
      forceTask: true,
    });
    setConversationActionExecutionStatus(conversation.id, userId, 'waiting_confirmation', {
      requestId: oldRequestId,
    });

    for (const [requestId, userText, assistantText] of [
      ['request-model-question', 'Which model are you using right now?', 'The configured primary model.'],
      ['request-voiceprint-question', 'Check the voiceprint enrollment status.', 'No voiceprint is enrolled.'],
    ]) {
      addMessage({
        userId, agentId: 'lumi', conversationId: conversation.id, role: 'user',
        content: userText, requestId, domain: 'personal',
      });
      addMessage({
        userId, agentId: 'lumi', conversationId: conversation.id, role: 'assistant',
        content: assistantText, requestId, domain: 'personal',
      });
    }
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: 'Look at the current screen.',
      requestId: 'request-screen-question',
      domain: 'personal',
    });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'assistant',
      content: 'The active window is the Lumi client.',
      requestId: 'request-screen-question',
      toolCalls: [{
        name: 'desktop_get_active_window',
        arguments: {},
        result: JSON.stringify({ ok: true, title: 'Lumi' }),
        capability: {
          capabilityId: 'desktop.window.observe',
          lane: 'desktop',
          operation: 'observe',
          risk: 'low',
          sideEffects: [{ type: 'local_read', scope: 'active_window', reversible: true }],
          verification: {
            strategy: 'terminal_receipt', required: true, requiredFields: [], successSignals: [], limitations: [],
          },
        },
        terminalVerification: {
          status: 'verified', strategy: 'terminal_receipt', reason: 'Active window returned.',
        },
      }],
      domain: 'personal',
    });

    const db = readDB();
    const archived = (db.conversationActionTasks || []).find((row: any) => row.id === oldTask.state?.taskId);
    expect(archived).toMatchObject({
      status: 'cancelled', activeRequestId: '', rootUserMessageId: oldUserMessageId,
    });
    expect((db.conversationActionReceipts || []).filter((row: any) => row.taskId === oldTask.state?.taskId))
      .toHaveLength(0);
    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toBeUndefined();
  });

  it('returns no task identity when an unrelated plain turn detaches blocked work', () => {
    const userId = `conversation-action-plain-detach-${Date.now()}-${Math.random()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const oldTask = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: 'Open the browser.',
      requestId: 'request-old-browser',
      userMessageId: persistActionTurn({
        conversationId: conversation.id,
        userId,
        userText: 'Open the browser.',
        requestId: 'request-old-browser',
      }),
      toolPolicy: { allowedTools: ['desktop_open'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 },
      forceTask: true,
    });
    setConversationActionExecutionStatus(conversation.id, userId, 'blocked', {
      blocker: 'Browser launch failed.', requestId: 'request-old-browser',
    });
    settleConversationActionExecutionRequest(conversation.id, userId, 'request-old-browser');

    const plain = prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: 'Which model are you using right now?',
      requestId: 'request-new-model-question',
      userMessageId: persistActionTurn({
        conversationId: conversation.id,
        userId,
        userText: 'Which model are you using right now?',
        requestId: 'request-new-model-question',
      }),
      toolPolicy: { allowedTools: [], requireConfirmation: [], forbiddenTools: [], maxIterations: 1 },
    });

    expect(plain).toEqual({ state: null, kind: 'conversation' });
    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toBeUndefined();
    expect((readDB().conversationActionTasks || []).find((row: any) => row.id === oldTask.state?.taskId))
      .toMatchObject({ status: 'cancelled', activeRequestId: '' });
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
      userMessageId: persistActionTurn({
        conversationId: conversation.id,
        userId,
        userText: '打开 WPS。',
        requestId: 'request-old',
      }),
      toolPolicy: { allowedTools: ['desktop_open'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 },
      forceTask: true,
    });
    settleConversationActionExecutionRequest(conversation.id, userId, 'request-old');

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
      userMessageId: persistActionTurn({
        conversationId: conversation.id,
        userId,
        userText: '进入壁纸模式。',
        requestId: 'request-new',
      }),
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
