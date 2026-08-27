import './helpers';
import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createSocketClient, type Socket as ClientSocket } from 'socket.io-client';

const mocks = vi.hoisted(() => ({
  runWithTools: vi.fn(),
  makeLLMCallStreaming: vi.fn(),
}));

vi.mock('../server/llm/adapter', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/llm/adapter')>();
  return { ...actual, runWithTools: mocks.runWithTools };
});

vi.mock('../server/llm/providers', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/llm/providers')>();
  return { ...actual, makeLLMCallStreaming: mocks.makeLLMCallStreaming };
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
import { getConversationActionStateByTaskId } from '../server/conversation/action_ledger';
import { getConversationActionTurn } from '../server/conversation/action_turn_ledger';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import {
  getChatExecution,
  getChatSidecarCancellationTarget,
  initializeChatExecutionRegistryPersistence,
  resetChatExecutionRegistryForTests,
  waitForChatExecutionPersistence,
} from '../server/socket/chat_execution_registry';
import { registerChatHandler } from '../server/socket/chat';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';

const LONG_COMMAND = '\u8bf7\u5b9e\u9645\u67e5\u770b\u5f53\u524d\u524d\u53f0\u7a97\u53e3\uff0c\u5fc5\u987b\u8c03\u7528\u684c\u9762\u89c2\u5bdf\u5de5\u5177\uff0c\u7136\u540e\u544a\u8bc9\u6211\u7a97\u53e3\u6807\u9898\u3002';

function waitForRequestEvent<T extends Record<string, any>>(
  socket: ClientSocket,
  event: string,
  requestId: string,
  timeoutMs = 10_000,
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

describe('chat status/stop/repeat control chain', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `chat-control-chain-${suffix}`;
  const longRequestId = `chat-control-long-${suffix}`;
  const statusRequestId = `chat-control-status-${suffix}`;
  const stopRequestId = `chat-control-stop-${suffix}`;
  const repeatRequestId = `chat-control-repeat-${suffix}`;
  const directAbortRequestId = `chat-control-direct-abort-${suffix}`;
  const scope = {
    userId,
    domain: 'personal' as const,
    orgId: '',
    source: 'command-center-chat',
  };
  let conversationId = '';
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let client: ClientSocket;
  let releaseStarted!: () => void;
  const started = new Promise<void>(resolve => { releaseStarted = resolve; });
  const events: Array<{ event: string; payload: Record<string, any> }> = [];

  beforeAll(async () => {
    await initDatabase();
    if (!toolRegistry.get('desktop_active_window')) registerAllTools(toolRegistry);
    conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;

    mocks.runWithTools.mockImplementation(async (...args: any[]) => {
      const signal = args[2]?.signal as AbortSignal | undefined;
      const context = args[11];
      if (context.requestId === repeatRequestId) {
        const messages = args[0] as any[];
        const immediatePriorAssistant = [...messages].reverse().find(message => message?.role === 'assistant');
        return {
          text: String(immediatePriorAssistant?.content || ''),
          toolCalls: [],
          usageRecords: [],
        };
      }
      expect(context.requestId).toBe(longRequestId);
      expect(signal).toBeInstanceOf(AbortSignal);
      releaseStarted();
      return new Promise(resolve => {
        const finishCancelled = () => resolve({
          text: 'Task was cancelled before the model response could be applied.',
          toolCalls: [],
          usageRecords: [],
        });
        if (signal?.aborted) finishCancelled();
        else signal?.addEventListener('abort', finishCancelled, { once: true });
      });
    });
    mocks.makeLLMCallStreaming.mockImplementation(async (messages: any[]) => {
      const immediatePriorAssistant = [...messages].reverse().find(message => message?.role === 'assistant');
      return {
        text: String(immediatePriorAssistant?.content || ''),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    });

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
          getDeepSeek: () => ({}),
          getGemini: () => ({}),
          getOpenAI: () => ({}),
          getAnthropic: () => ({}),
          getQwen: () => ({}),
          getOllama: () => ({}),
          isOllamaAvailable: () => false,
          getLmStudio: () => ({}),
          isLmStudioAvailable: () => false,
          getArk: () => ({}),
          getXiaomi: () => ({}),
          getKimi: () => ({}),
          getGlm: () => ({}),
          getRelay: () => ({}),
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
    if (!address || typeof address === 'string') throw new Error('Unable to bind chat control-chain server');
    client = createSocketClient(`http://127.0.0.1:${address.port}`, { transports: ['websocket'] });
    client.onAny((event, payload) => {
      if (payload && typeof payload === 'object') events.push({ event, payload });
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting chat control-chain client')), 5_000);
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
  });

  it('stops the exact live request, reports that terminal by adjacent tombstone, and repeats the status answer', async () => {
    const longTerminalPromise = waitForRequestEvent<Record<string, any>>(client, 'agent:response', longRequestId);
    const longAck = await client.timeout(5_000).emitWithAck('agent:chat', {
      text: LONG_COMMAND,
      history: [],
      agentId: 'lumi',
      domain: 'personal',
      source: scope.source,
      requestId: longRequestId,
      conversationId,
    });
    expect(longAck).toMatchObject({ ok: true, requestId: longRequestId });
    await started;

    const liveConversation = (readDB().conversations || []).find((item: any) => item.id === conversationId);
    const taskId = String(liveConversation?.actionContinuationState?.taskId || '');
    expect(taskId).toMatch(/^task_/u);
    expect(liveConversation?.actionContinuationState).toMatchObject({
      taskId,
      activeRequestId: longRequestId,
      unfinished: true,
    });

    const stopTerminalPromise = waitForRequestEvent<Record<string, any>>(client, 'agent:response', stopRequestId);
    const stopAck = await client.timeout(5_000).emitWithAck('agent:chat', {
      text: '\u505c\u6b62',
      history: [],
      agentId: 'lumi',
      domain: 'personal',
      source: scope.source,
      requestId: stopRequestId,
      conversationId,
    });
    expect(stopAck).toMatchObject({ ok: true, requestId: stopRequestId });
    const [longTerminal, stopTerminal] = await Promise.all([longTerminalPromise, stopTerminalPromise]);
    expect(longTerminal).toMatchObject({
      requestId: longRequestId,
      finalized: true,
      blocked: false,
      reason: 'request_cancelled',
    });
    expect(stopTerminal).toMatchObject({
      requestId: stopRequestId,
      finalized: true,
      blocked: false,
      reason: 'cancelled_by_user',
    });

    const finalDb = readDB();
    const finalConversation = (finalDb.conversations || []).find((item: any) => item.id === conversationId);
    expect(finalConversation?.actionContinuationState).toBeUndefined();
    expect(finalConversation?.pendingActionContinuation).toBeUndefined();
    expect(getConversationActionStateByTaskId(finalDb, {
      conversationId,
      userId,
      taskId,
    })).toMatchObject({ taskId, status: 'cancelled', unfinished: false });
    expect(getConversationActionTurn({ conversationId, userId, requestId: longRequestId }))
      .toMatchObject({ status: 'cancelled' });
    expect(getChatExecution({ ...scope, conversationId }, longRequestId))
      .toMatchObject({ terminal: true, status: 'cancelled' });
    expect(getChatExecution({ ...scope, conversationId }, stopRequestId))
      .toMatchObject({ terminal: true, status: 'completed' });

    // Simulate a backend restart after the cancel sidecar has overwritten its
    // earlier `cancelling` row with a completed terminal receipt. The exact
    // long-request tombstone must survive hydration or the next natural
    // status question would fall through to the model/latest-task path.
    await waitForChatExecutionPersistence();
    resetChatExecutionRegistryForTests();
    expect(await initializeChatExecutionRegistryPersistence(undefined, Date.now()))
      .toBeGreaterThanOrEqual(2);
    expect(getChatSidecarCancellationTarget(
      { ...scope, conversationId },
      stopRequestId,
    )).toBe(longRequestId);

    const statusTerminalPromise = waitForRequestEvent<Record<string, any>>(client, 'agent:response', statusRequestId);
    const statusAck = await client.timeout(5_000).emitWithAck('agent:chat', {
      text: '\u4f60\u5728\u5e72\u5565',
      history: [],
      agentId: 'lumi',
      domain: 'personal',
      source: scope.source,
      requestId: statusRequestId,
      conversationId,
    });
    expect(statusAck).toMatchObject({ ok: true, requestId: statusRequestId });
    const statusTerminal = await statusTerminalPromise;
    expect(statusTerminal).toMatchObject({
      finalized: true,
      blocked: false,
      reason: 'target_execution_status',
      controlIntent: 'status',
      targetRequestId: longRequestId,
    });
    expect(String(statusTerminal.text || '').trim()).toBe(String(longTerminal.text || '').trim());
    expect(getChatExecution({ ...scope, conversationId }, statusRequestId)).toMatchObject({
      terminal: true,
      status: 'completed',
      sidecar: true,
      terminalEvent: {
        payload: {
          controlIntent: 'status',
          targetRequestId: longRequestId,
        },
      },
    });

    await new Promise(resolve => setTimeout(resolve, 30));
    const afterStatusDb = readDB();
    for (const exactRequestId of [longRequestId, stopRequestId, statusRequestId]) {
      expect(events.filter(item => (
        item.event === 'agent:response'
        && String(item.payload.requestId || '') === exactRequestId
      ))).toHaveLength(1);
      expect((afterStatusDb.interactions || []).filter((item: any) => (
        item.role === 'assistant'
        && String(item.requestId || item.externalMessageId || '') === exactRequestId
      ))).toHaveLength(1);
    }

    const repeatTerminalPromise = waitForRequestEvent<Record<string, any>>(client, 'agent:response', repeatRequestId);
    const repeatAck = await client.timeout(5_000).emitWithAck('agent:chat', {
      text: '\u600e\u4e48\u8bf4',
      history: [],
      agentId: 'lumi',
      domain: 'personal',
      source: scope.source,
      requestId: repeatRequestId,
      conversationId,
    });
    expect(repeatAck).toMatchObject({ ok: true, requestId: repeatRequestId });
    const repeatTerminal = await repeatTerminalPromise;
    expect(repeatTerminal).toMatchObject({ finalized: true, blocked: false });
    expect(String(repeatTerminal.text || '').trim()).toBe(String(statusTerminal.text || '').trim());
    expect(mocks.runWithTools).toHaveBeenCalledTimes(1);
    expect(mocks.makeLLMCallStreaming).not.toHaveBeenCalled();
    const repeatTranscript = (readDB().interactions || []).find((item: any) => (
      item.role === 'assistant'
      && String(item.requestId || item.externalMessageId || '') === repeatRequestId
    ));
    expect(String(repeatTranscript?.message || repeatTranscript?.content || '').trim())
      .toBe(String(statusTerminal.text || '').trim());
    expect(repeatTranscript).toMatchObject({
      cognitiveIntent: 'task_repeat',
      llmWasCalled: false,
    });
  });

  it('keeps direct abort non-terminal until the foreground owner durably cancels it', async () => {
    let markDirectStarted!: () => void;
    const directStarted = new Promise<void>(resolve => { markDirectStarted = resolve; });
    mocks.runWithTools.mockImplementationOnce(async (...args: any[]) => {
      const signal = args[2]?.signal as AbortSignal | undefined;
      const context = args[11];
      expect(context.requestId).toBe(directAbortRequestId);
      markDirectStarted();
      return new Promise(resolve => {
        const finishCancelled = () => resolve({
          text: 'Task was cancelled before the model response could be applied.',
          toolCalls: [],
          usageRecords: [],
        });
        if (signal?.aborted) finishCancelled();
        else signal?.addEventListener('abort', finishCancelled, { once: true });
      });
    });

    const terminalPromise = waitForRequestEvent<Record<string, any>>(
      client,
      'agent:response',
      directAbortRequestId,
    );
    const startAck = await client.timeout(5_000).emitWithAck('agent:chat', {
      text: LONG_COMMAND,
      history: [],
      agentId: 'lumi',
      domain: 'personal',
      source: scope.source,
      requestId: directAbortRequestId,
      conversationId,
    });
    expect(startAck).toMatchObject({ ok: true, requestId: directAbortRequestId });
    await directStarted;

    const liveConversation = (readDB().conversations || []).find((item: any) => item.id === conversationId);
    const taskId = String(liveConversation?.actionContinuationState?.taskId || '');
    expect(taskId).toMatch(/^task_/u);
    const abortAck = await client.timeout(5_000).emitWithAck('agent:abort_chat', {
      requestId: directAbortRequestId,
      conversationId,
      domain: 'personal',
      source: scope.source,
    });
    expect(abortAck).toMatchObject({
      ok: true,
      requestId: directAbortRequestId,
      status: 'cancelling',
    });

    const terminal = await terminalPromise;
    expect(terminal).toMatchObject({
      requestId: directAbortRequestId,
      finalized: true,
      blocked: false,
      reason: 'request_cancelled',
    });
    expect(events.filter(item => (
      item.event === 'agent:response'
      && String(item.payload.requestId || '') === directAbortRequestId
    ))).toHaveLength(1);
    const finalDb = readDB();
    expect(getConversationActionStateByTaskId(finalDb, {
      conversationId,
      userId,
      taskId,
    })).toMatchObject({ taskId, status: 'cancelled', unfinished: false });
    expect((finalDb.conversations || []).find((item: any) => item.id === conversationId))
      .not.toHaveProperty('actionContinuationState');
    expect(getChatExecution({ ...scope, conversationId }, directAbortRequestId))
      .toMatchObject({ terminal: true, status: 'cancelled' });
  });
});
