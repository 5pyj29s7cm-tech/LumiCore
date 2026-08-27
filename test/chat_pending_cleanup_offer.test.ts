import './helpers';
import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createSocketClient, type Socket as ClientSocket } from 'socket.io-client';

const mocks = vi.hoisted(() => ({
  runWithTools: vi.fn(() => {
    throw new Error('Accepted cleanup offers must not ask the model to reconstruct targets.');
  }),
}));

vi.mock('../server/llm/adapter', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/llm/adapter')>();
  return { ...actual, runWithTools: mocks.runWithTools };
});

vi.mock('../server/memory', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/memory')>();
  return {
    ...actual,
    queryMemories: vi.fn(() => []),
    queryMemoriesVector: vi.fn(async () => []),
    extractMemories: vi.fn(async () => ({ memories: [], reminders: [] })),
  };
});

vi.mock('../server/agents/rag', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/agents/rag')>();
  return { ...actual, retrieveChunks: vi.fn(async () => []) };
});

import { initDatabase, readDB } from '../db_layer';
import {
  addMessage,
  bindConversationActionExecutionTurn,
  getOrCreateActiveConversation,
  prepareConversationActionExecution,
  setConversationActionExecutionStatus,
} from '../server/conversation/manager';
import {
  registerBackgroundTask,
  resetBackgroundTasksForTest,
} from '../server/agents/background_tasks';
import { getRuntimeWorkSnapshot } from '../server/runtime/work_control';
import { registerChatHandler } from '../server/socket/chat';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';

function waitForRequestEvent<T extends Record<string, any>>(
  socket: ClientSocket,
  event: string,
  requestId: string,
  timeoutMs = 12_000,
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

describe('Chat accepted pending runtime cleanup offer', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `chat-cleanup-offer-${suffix}`;
  const seedRequestId = `chat-cleanup-offer-seed-${suffix}`;
  const requestId = `chat-cleanup-offer-accept-${suffix}`;
  const toolEvents: Array<Record<string, any>> = [];
  let conversationId = '';
  let conversationTaskId = '';
  let offeredTaskIds: string[] = [];
  let laterTaskId = '';
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let client: ClientSocket;

  beforeAll(async () => {
    await initDatabase();
    resetBackgroundTasksForTest({ markHydrated: true });
    if (!toolRegistry.get('runtime_work_cancel')) registerAllTools(toolRegistry);

    conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
    const seedUserMessageId = addMessage({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'user',
      content: '\u67e5\u770b\u6b63\u5728\u8fd0\u884c\u7684\u540e\u53f0\u4efb\u52a1\u3002',
      domain: 'personal',
      orgId: '',
      source: 'command-center-chat',
      channel: 'chat',
      requestId: seedRequestId,
      deferActionPreparation: true,
    });
    expect(bindConversationActionExecutionTurn({
      conversationId,
      userId,
      userText: '\u67e5\u770b\u6b63\u5728\u8fd0\u884c\u7684\u540e\u53f0\u4efb\u52a1\u3002',
      requestId: seedRequestId,
      userMessageId: seedUserMessageId,
    })).toMatchObject({ requestId: seedRequestId });
    const prepared = prepareConversationActionExecution({
      conversationId,
      userId,
      userText: '\u67e5\u770b\u6b63\u5728\u8fd0\u884c\u7684\u540e\u53f0\u4efb\u52a1\u3002',
      requestId: seedRequestId,
      userMessageId: seedUserMessageId,
      forceTask: true,
      forceNewTask: true,
      toolPolicy: {
        allowedTools: ['runtime_work_status', 'runtime_work_cancel'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 2,
      },
    });
    conversationTaskId = String(prepared.state?.taskId || '');
    expect(conversationTaskId).toBeTruthy();
    setConversationActionExecutionStatus(conversationId, userId, 'blocked', {
      blocker: 'Waiting for the user to accept the exact cleanup offer.',
      requestId: '',
    });

    const first = registerBackgroundTask({
      userId,
      title: 'offered background A',
      prompt: 'isolated A',
      context: { domain: 'personal', conversationId },
    });
    const second = registerBackgroundTask({
      userId,
      title: 'offered background B',
      prompt: 'isolated B',
      context: { domain: 'personal', conversationId },
    });
    offeredTaskIds = [first.id, second.id];
    const frozenSnapshot = getRuntimeWorkSnapshot(
      userId,
      ['delegation'],
      { domain: 'personal' },
    );
    expect(frozenSnapshot.items.filter(item => item.controls.canCancel).map(item => item.id).sort())
      .toEqual([...offeredTaskIds].sort());
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'assistant',
      content: '\u662f\u5426\u5e2e\u4f60\u6e05\u7406\u8fd9\u4e9b\u540e\u53f0\u4efb\u52a1\uff1f',
      domain: 'personal',
      orgId: '',
      source: 'command-center-chat',
      channel: 'chat',
      requestId: seedRequestId,
      llmWasCalled: false,
      skipActionContinuation: true,
      toolCalls: [{
        id: `runtime-status-${suffix}`,
        taskId: conversationTaskId,
        turnId: seedRequestId,
        requestId: seedRequestId,
        executionOrigin: 'deterministic_route',
        name: 'runtime_work_status',
        arguments: {},
        result: JSON.stringify(frozenSnapshot),
        error: '',
        outcome: 'success',
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'server-owned frozen runtime snapshot',
        },
        envelope: { status: 'verified_success' },
      }],
    });

    // This task starts after the assistant made the offer. Acceptance must not
    // widen the frozen target set to include it.
    laterTaskId = registerBackgroundTask({
      userId,
      title: 'later background C',
      prompt: 'must remain active',
      context: { domain: 'personal', conversationId },
    }).id;

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
          getDeepSeek: mocks.runWithTools,
          getGemini: mocks.runWithTools,
          getOpenAI: mocks.runWithTools,
          getAnthropic: mocks.runWithTools,
          getQwen: mocks.runWithTools,
          getOllama: mocks.runWithTools,
          isOllamaAvailable: () => false,
          getLmStudio: mocks.runWithTools,
          isLmStudioAvailable: () => false,
          getArk: mocks.runWithTools,
          getXiaomi: mocks.runWithTools,
          getKimi: mocks.runWithTools,
          getGlm: mocks.runWithTools,
          getRelay: mocks.runWithTools,
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
    if (!address || typeof address === 'string') throw new Error('Unable to bind isolated Chat cleanup test server');
    client = createSocketClient(`http://127.0.0.1:${address.port}`, { transports: ['websocket'] });
    client.on('agent:tool_call', payload => {
      if (String(payload?.requestId || '') === requestId) toolEvents.push(payload);
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting isolated Chat cleanup client')), 5_000);
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
    if (httpServer?.listening) await new Promise<void>(resolve => httpServer.close(() => resolve()));
    resetBackgroundTasksForTest({ markHydrated: true });
  });

  it('confirms the adjacent offer and invokes one exact canonical cancellation without an LLM', async () => {
    const responsePromise = waitForRequestEvent<Record<string, any>>(
      client,
      'agent:response',
      requestId,
    );
    const ack = await client.timeout(5_000).emitWithAck('agent:chat', {
      text: '\u6e05\u7406\u4e00\u4e0b',
      history: [],
      agentId: 'lumi',
      domain: 'personal',
      source: 'command-center-chat',
      requestId,
      conversationId,
    });
    expect(ack).toMatchObject({ ok: true, requestId });

    const response = await responsePromise;
    expect(response).toMatchObject({
      requestId,
      conversationId,
      finalized: true,
      blocked: false,
      reason: 'runtime_cleanup_offer_completed',
      taskRelation: {
        feedback: 'accept',
        taskRelation: 'confirm',
        taskId: conversationTaskId,
      },
    });
    for (const targetId of offeredTaskIds) expect(response.text).toContain(targetId);
    expect(response.text).not.toContain(laterTaskId);
    expect(mocks.runWithTools).not.toHaveBeenCalled();

    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]).toMatchObject({
      name: 'runtime_work_cancel',
    });
    expect([...(toolEvents[0]?.arguments?.taskIds || [])].sort())
      .toEqual([...offeredTaskIds].sort());

    const snapshot = getRuntimeWorkSnapshot(userId, ['delegation'], { domain: 'personal' });
    for (const targetId of offeredTaskIds) {
      expect(snapshot.items.find(item => item.id === targetId)).toMatchObject({ phase: 'cancelled' });
    }
    expect(snapshot.items.find(item => item.id === laterTaskId)).toMatchObject({
      phase: 'queued',
      controls: { canCancel: true },
    });

    const receipts = (readDB().conversationActionReceipts || []).filter((row: any) => (
      row.conversationId === conversationId
      && row.requestId === requestId
      && row.toolName === 'runtime_work_cancel'
    ));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      taskId: conversationTaskId,
      outcome: 'verified_success',
      executionOrigin: 'deterministic_route',
    });
    expect(receipts[0].taskId).not.toBe(offeredTaskIds[0]);
    expect(receipts[0].taskId).not.toBe(offeredTaskIds[1]);
  });
});
