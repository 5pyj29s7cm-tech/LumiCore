import './helpers';
import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createSocketClient, type Socket as ClientSocket } from 'socket.io-client';
import { initDatabase, readDB } from '../db_layer';
import {
  addMessage,
  bindConversationActionExecutionTurn,
  getOrCreateActiveConversation,
  setConversationActionExecutionStatus,
} from '../server/conversation/manager';
import { registerChatHandler } from '../server/socket/chat';
import { getChatExecution } from '../server/socket/chat_execution_registry';
import { queryMemoriesVector } from '../server/memory';
import { retrieveChunks } from '../server/agents/rag';

vi.mock('../server/memory', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/memory')>();
  return {
    ...actual,
    queryMemoriesVector: vi.fn(async () => []),
  };
});

vi.mock('../server/agents/rag', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/agents/rag')>();
  return {
    ...actual,
    retrieveChunks: vi.fn(async () => []),
  };
});

function waitForRequestEvent<T extends Record<string, any>>(
  socket: ClientSocket,
  event: string,
  requestId: string,
  timeoutMs = 8_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event} (${requestId})`));
    }, timeoutMs);
    const handler = (payload: T) => {
      if (String(payload?.requestId || '') !== requestId) return;
      clearTimeout(timeout);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

function storedToolCalls(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

describe('chat prior-action status handler', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `chat-prior-action-${suffix}`;
  const priorRequestId = `chat-prior-action-seed-${suffix}`;
  const firstRequestId = `chat-prior-action-first-${suffix}`;
  const secondRequestId = `chat-prior-action-second-${suffix}`;
  const windowSeedRequestId = `chat-prior-action-window-seed-${suffix}`;
  const exactReceiptRequestId = `chat-prior-action-exact-receipt-${suffix}`;
  const cancelSeedRequestId = `chat-durable-cancel-seed-${suffix}`;
  const cancelRequestId = `chat-durable-cancel-${suffix}`;
  const englishStatusQuestion = 'What did you just do, and what evidence proved it succeeded?';
  const chineseStatusQuestion = '你刚才做了什么，什么证据证明成功了？';
  const exactReceiptQuestion = '你上一轮是否真的调用过工具？不要再次调用工具，只根据已保存的回执告诉我：工具名、成功还是失败。';
  const llmTripwire = vi.fn(() => {
    throw new Error('The prior-action status fast path must not resolve an LLM client.');
  });
  const observedEvents: Array<{ event: string; payload: Record<string, any> }> = [];
  let conversationId = '';
  let baselineActionReceiptIds: string[] = [];
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let client: ClientSocket;

  beforeAll(async () => {
    await initDatabase();
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    conversationId = conversation.id;

    const seedUserMessageId = addMessage({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'user',
      content: '打开 Lumi 设置里的语音与声音。',
      domain: 'personal',
      orgId: '',
      source: 'chat',
      channel: 'chat',
      requestId: priorRequestId,
      deferActionPreparation: true,
    });
    expect(bindConversationActionExecutionTurn({
      conversationId,
      userId,
      userText: '打开 Lumi 设置里的语音与声音。',
      requestId: priorRequestId,
      userMessageId: seedUserMessageId,
    })).toMatchObject({ requestId: priorRequestId, messageId: seedUserMessageId });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'assistant',
      content: '已打开设置中的语音与声音。',
      domain: 'personal',
      orgId: '',
      source: 'chat',
      channel: 'chat',
      requestId: priorRequestId,
      taskIntent: 'task',
      llmWasCalled: true,
      toolCalls: [{
        id: 'voice_settings_open',
        key: 'client_action:open_settings:voice',
        name: 'client_action',
        arguments: { action: 'open_settings', section: 'voice' },
        result: JSON.stringify({
          ok: true,
          action: 'open_settings',
          target: 'settings',
          section: 'voice',
          verification: {
            status: 'verified',
            matched: ['surface:settings:open', 'settings-section:voice'],
          },
        }),
        error: '',
        outcome: 'success',
        terminalVerification: {
          status: 'verified',
          strategy: 'state_diff',
          reason: 'voice settings rendered',
        },
      }],
    });

    const seededReceipts = (readDB().conversationActionReceipts || []).filter((receipt: any) => (
      receipt.conversationId === conversationId
    ));
    expect(seededReceipts).toHaveLength(1);
    expect(seededReceipts[0]).toMatchObject({
      toolName: 'client_action',
      outcome: 'verified_success',
    });
    baselineActionReceiptIds = seededReceipts.map((receipt: any) => String(receipt.id));

    httpServer = createServer();
    io = new SocketIOServer(httpServer, { transports: ['websocket'] });
    io.on('connection', serverSocket => {
      serverSocket.data.authenticatedUserId = userId;
      serverSocket.data.authenticatedRole = 'admin';
      serverSocket.data.trustedLocalExecution = true;
      serverSocket.join(`user:${userId}:personal`);
      registerChatHandler(
        serverSocket,
        {
          getDeepSeek: llmTripwire,
          getGemini: llmTripwire,
          getOpenAI: llmTripwire,
          getAnthropic: llmTripwire,
          getQwen: llmTripwire,
          getOllama: llmTripwire,
          isOllamaAvailable: () => false,
          getLmStudio: llmTripwire,
          isLmStudioAvailable: () => false,
          getArk: llmTripwire,
          getXiaomi: llmTripwire,
          getKimi: llmTripwire,
          getGlm: llmTripwire,
          getRelay: llmTripwire,
        },
        () => ({
          audio: false,
          visual: false,
          spatial: false,
          haptic: false,
          holographic: false,
          activeDeviceTypes: [],
          deviceCount: 0,
        }),
        () => userId,
        io,
      );
    });
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Unable to bind chat handler test server');
    client = createSocketClient(`http://127.0.0.1:${address.port}`, { transports: ['websocket'] });
    client.onAny((event, payload) => {
      if (payload && typeof payload === 'object') observedEvents.push({ event, payload });
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting chat handler test client')), 5_000);
      client.once('connect', () => {
        clearTimeout(timeout);
        resolve();
      });
      client.once('connect_error', error => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  });

  afterAll(async () => {
    client?.disconnect();
    if (io) await new Promise<void>(resolve => io.close(() => resolve()));
    if (httpServer?.listening) {
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
    }
  });

  async function sendStatusQuestion(requestId: string, text: string): Promise<Record<string, any>> {
    const responsePromise = waitForRequestEvent<Record<string, any>>(
      client,
      'agent:response',
      requestId,
    );
    const ack = await client.timeout(5_000).emitWithAck('agent:chat', {
      text,
      history: [],
      agentId: 'lumi',
      domain: 'personal',
      source: 'command-center-chat',
      requestId,
      conversationId,
    });
    expect(ack).toMatchObject({ ok: true, requestId });
    return responsePromise;
  }

  function expectVerifiedLedgerAnswer(
    response: Record<string, any>,
    requestId: string,
    language: 'en' | 'zh',
  ): void {
    expect(response).toMatchObject({
      requestId,
      conversationId,
      source: 'command-center-chat',
      reason: 'task_status',
      finalized: true,
      blocked: false,
    });
    if (language === 'en') {
      expect(response.text).toContain('Executed action: open_settings');
      expect(response.text).toContain('Target: settings');
      expect(response.text).toContain('Target section: voice');
      expect(response.text).toContain('Verification status: verified');
      expect(response.text).toContain('Final status: blocked — The task has no verified completion receipt.');
      expect(response.text).not.toMatch(/执行动作|目标页面|最终状态/u);
    } else {
      expect(response.text).toContain('执行动作：open_settings');
      expect(response.text).toContain('目标页面：settings');
      expect(response.text).toContain('目标分区：voice');
      expect(response.text).toContain('验证状态：verified');
      expect(response.text).toContain('最终状态：');
      expect(response.text).not.toContain('最终状态：已完成（持久回执已验证）');
    }
    expect(response.text).toContain('surface:settings:open');
    expect(response.text).toContain('settings-section:voice');
    expect(response.text).not.toMatch(/No successful current-turn tool execution|No successful tool execution|这一轮没有记录到成功的真实工具执行|我还不能说客户端动作已经完成/u);
  }

  it('answers two prior-action evidence queries without tools, LLM calls, receipts, or a leaked session', async () => {
    const firstResponse = await sendStatusQuestion(firstRequestId, englishStatusQuestion);
    expectVerifiedLedgerAnswer(firstResponse, firstRequestId, 'en');
    expect(getChatExecution({
      userId,
      domain: 'personal',
      orgId: '',
      source: 'command-center-chat',
      conversationId,
    }, firstRequestId)).toMatchObject({
      terminal: true,
      status: 'completed',
      terminalEvent: {
        event: 'agent:response',
        payload: { source: 'command-center-chat' },
      },
    });
    expect((readDB().conversations || []).find((item: any) => item.id === conversationId))
      .not.toHaveProperty('pendingActionContinuation');

    // A leaked foreground lease would route this status question into the
    // active-session sidecar and return stale_control instead of ledger proof.
    const secondResponse = await sendStatusQuestion(secondRequestId, chineseStatusQuestion);
    expectVerifiedLedgerAnswer(secondResponse, secondRequestId, 'zh');
    expect(getChatExecution({
      userId,
      domain: 'personal',
      orgId: '',
      source: 'command-center-chat',
      conversationId,
    }, secondRequestId)).toMatchObject({
      terminal: true,
      status: 'completed',
      terminalEvent: {
        event: 'agent:response',
        payload: { source: 'command-center-chat' },
      },
    });

    const requestIds = new Set([firstRequestId, secondRequestId]);
    expect(observedEvents.filter(item => (
      requestIds.has(String(item.payload.requestId || ''))
      && (item.event === 'agent:tool_call' || item.event === 'agent:tool')
    ))).toEqual([]);

    const finalDb = readDB();
    expect((finalDb.conversationActionReceipts || [])
      .filter((receipt: any) => receipt.conversationId === conversationId)
      .map((receipt: any) => String(receipt.id)))
      .toEqual(baselineActionReceiptIds);
    expect((finalDb.conversations || []).find((item: any) => item.id === conversationId))
      .not.toHaveProperty('pendingActionContinuation');

    const statusReplies = (finalDb.interactions || []).filter((item: any) => (
      item.role === 'assistant' && requestIds.has(String(item.requestId || item.externalMessageId || ''))
    ));
    expect(statusReplies).toHaveLength(2);
    for (const reply of statusReplies) {
      expect(reply).toMatchObject({
        source: 'chat_task_status',
        cognitiveIntent: 'task_status',
        llmWasCalled: false,
      });
      expect(storedToolCalls(reply.toolCalls)).toEqual([]);
    }
    expect(llmTripwire).not.toHaveBeenCalled();
    expect(queryMemoriesVector).not.toHaveBeenCalled();
    expect(retrieveChunks).not.toHaveBeenCalled();
  });

  it('answers the exact history-empty prior-turn tool question from the adjacent persisted receipt', async () => {
    const windowSeedUserMessageId = addMessage({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'user',
      content: '只读查看当前前台窗口并告诉我窗口标题。',
      domain: 'personal',
      orgId: '',
      source: 'command-center-chat',
      channel: 'chat',
      requestId: windowSeedRequestId,
      deferActionPreparation: true,
    });
    expect(bindConversationActionExecutionTurn({
      conversationId,
      userId,
      userText: '只读查看当前前台窗口并告诉我窗口标题。',
      requestId: windowSeedRequestId,
      userMessageId: windowSeedUserMessageId,
    })).toMatchObject({ requestId: windowSeedRequestId, messageId: windowSeedUserMessageId });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'assistant',
      content: '当前前台窗口是 LumiCore。',
      domain: 'personal',
      orgId: '',
      source: 'command-center-chat',
      channel: 'chat',
      requestId: windowSeedRequestId,
      llmWasCalled: true,
      toolCalls: [{
        id: 'active_window_receipt',
        key: 'desktop_active_window:{}',
        name: 'desktop_active_window',
        arguments: {},
        result: JSON.stringify({
          ok: true,
          status: 'verified',
          title: 'LumiCore',
          processName: 'lumi-core.exe',
        }),
        error: '',
        outcome: 'success',
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'active window returned',
        },
        envelope: {
          status: 'verified_success',
          verification: { status: 'verified' },
        },
        capability: {
          capabilityId: 'desktop.active_window',
          lane: 'desktop',
          operation: 'observe',
          risk: 'none',
          sideEffects: [{ type: 'local_read', scope: 'foreground window', reversible: true }],
          verification: {
            strategy: 'terminal_receipt',
            required: true,
            requiredFields: ['title'],
            successSignals: ['active window returned'],
            limitations: [],
          },
        },
      }],
    });

    const baselineReceiptCount = (readDB().conversationActionReceipts || []).length;
    const eventStart = observedEvents.length;
    const response = await sendStatusQuestion(exactReceiptRequestId, exactReceiptQuestion);

    expect(response).toMatchObject({
      requestId: exactReceiptRequestId,
      conversationId,
      source: 'command-center-chat',
      reason: 'execution_facts',
      finalized: true,
      blocked: false,
      text: '上一轮确实调用了工具：desktop_active_window（成功）。',
    });
    expect(response.text).not.toMatch(/desktop_poll_activity|保存产物|写入\/验收|No successful current-turn tool execution|我还不能说/iu);
    expect(observedEvents.slice(eventStart).filter(item => (
      String(item.payload.requestId || '') === exactReceiptRequestId
      && (item.event === 'agent:tool_call' || item.event === 'agent:tool')
    ))).toEqual([]);
    expect((readDB().conversationActionReceipts || []).length).toBe(baselineReceiptCount);

    const reply = (readDB().interactions || []).find((item: any) => (
      item.role === 'assistant'
      && String(item.requestId || item.externalMessageId || '') === exactReceiptRequestId
    ));
    expect(reply).toMatchObject({
      source: 'chat_conversation_execution_facts',
      cognitiveIntent: 'execution_facts',
      llmWasCalled: false,
    });
    expect(storedToolCalls(reply?.toolCalls)).toEqual([]);
    expect(llmTripwire).not.toHaveBeenCalled();
    expect(queryMemoriesVector).not.toHaveBeenCalled();
    expect(retrieveChunks).not.toHaveBeenCalled();
  });

  it('cancels an exact unfinished durable task even after its foreground request lease is gone', async () => {
    const cancelSeedUserMessageId = addMessage({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'user',
      content: '在桌面创建一个文件。',
      domain: 'personal',
      orgId: '',
      source: 'command-center-chat',
      channel: 'chat',
      requestId: cancelSeedRequestId,
      deferActionPreparation: true,
    });
    expect(bindConversationActionExecutionTurn({
      conversationId,
      userId,
      userText: '在桌面创建一个文件。',
      requestId: cancelSeedRequestId,
      userMessageId: cancelSeedUserMessageId,
    })).toMatchObject({ requestId: cancelSeedRequestId });
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'assistant',
      content: '创建尚未完成。',
      domain: 'personal',
      orgId: '',
      source: 'command-center-chat',
      channel: 'chat',
      requestId: cancelSeedRequestId,
      taskIntent: 'task',
      llmWasCalled: true,
    });
    const idleTask = setConversationActionExecutionStatus(
      conversationId,
      userId,
      'blocked',
      { blocker: 'Waiting for retry.', requestId: '' },
    );
    expect(idleTask).toMatchObject({
      status: 'blocked',
      unfinished: true,
      activeRequestId: undefined,
    });

    const responsePromise = waitForRequestEvent<Record<string, any>>(
      client,
      'agent:response',
      cancelRequestId,
    );
    const ack = await client.timeout(5_000).emitWithAck('agent:chat', {
      text: '取消当前任务',
      history: [],
      agentId: 'lumi',
      domain: 'personal',
      source: 'command-center-chat',
      requestId: cancelRequestId,
      conversationId,
      controlTargetRequestId: cancelSeedRequestId,
      controlTargetTaskId: idleTask?.taskId,
      controlTargetRevision: idleTask?.revision,
    });
    expect(ack).toMatchObject({ ok: true, requestId: cancelRequestId });
    const response = await responsePromise;
    expect(response).toMatchObject({
      requestId: cancelRequestId,
      conversationId,
      source: 'command-center-chat',
      reason: 'cancelled_by_user',
      finalized: true,
      blocked: false,
      taskRelation: {
        taskId: idleTask?.taskId,
        feedback: 'cancel',
      },
    });
    expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState)
      .toMatchObject({ taskId: idleTask?.taskId, status: 'cancelled', unfinished: false });
    expect(llmTripwire).not.toHaveBeenCalled();
  });
});
