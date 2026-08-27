import './helpers';
import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createSocketClient, type Socket as ClientSocket } from 'socket.io-client';

type ModelInvocation = {
  hook: 'runWithTools' | 'makeLLMCallStreaming';
  messages: Array<{ role?: string; content?: string }>;
};

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
import {
  getActiveConversation,
  getOrCreateActiveConversation,
  startIsolatedConversation,
} from '../server/conversation/manager';
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

describe('closed isolated Chat conversation continuity', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `chat-isolated-continuity-${suffix}`;
  const firstRequestId = `chat-isolated-continuity-first-${suffix}`;
  const secondRequestId = `chat-isolated-continuity-second-${suffix}`;
  const statusOwnerRequestId = `chat-isolated-status-owner-${suffix}`;
  const statusSidecarRequestId = `chat-isolated-status-sidecar-${suffix}`;
  const cupCode = `cup-${Math.random().toString(36).slice(2, 12)}`;
  const firstText = `[LUMI-E2E-${suffix}] 这是虚构的上下文验收，不需要任何工具。请记住杯子代号 ${cupCode}，只简短确认已经记住。`;
  const secondText = '继续保持不调用工具。刚才杯子的代号是什么？只回复代号。';
  const statusOwnerText = '这是隔离的状态旁路验收。请实际查看当前前台窗口，必须调用相应桌面观察工具，然后告诉我窗口标题。';
  const statusQuestionText = '你在干嘛';
  let activeConversationId = '';
  let isolatedConversationId = '';
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let client: ClientSocket;
  const modelInvocations: ModelInvocation[] = [];
  const toolEvents: Array<{ event: string; requestId: string }> = [];
  let markStatusOwnerStarted!: () => void;
  const statusOwnerStarted = new Promise<void>(resolve => {
    markStatusOwnerStarted = resolve;
  });
  let releaseStatusOwnerModel: (() => void) | undefined;

  beforeAll(async () => {
    await initDatabase();
    if (!toolRegistry.get('client_get_state')) registerAllTools(toolRegistry);

    activeConversationId = getOrCreateActiveConversation(
      userId,
      'lumi',
      'personal',
      '',
    ).id;
    const isolated = startIsolatedConversation(userId, 'lumi', 'personal', '');
    isolatedConversationId = isolated.id;
    expect(isolated.status).toBe('closed');
    expect(isolatedConversationId).not.toBe(activeConversationId);

    const answerFromModelMessages = (
      hook: ModelInvocation['hook'],
      rawMessages: Array<{ role?: string; content?: string }>,
    ): string => {
      const messages = rawMessages.map(message => ({
        role: String(message?.role || ''),
        content: String(message?.content || ''),
      }));
      modelInvocations.push({ hook, messages });
      const currentUserText = [...messages]
        .reverse()
        .find(message => message.role === 'user')?.content || '';
      if (currentUserText === firstText) return '已经记住。';
      if (currentUserText !== secondText) {
        throw new Error(`Unexpected model turn: ${currentUserText}`);
      }

      const historicalUserText = messages
        .slice(0, -1)
        .filter(message => message.role === 'user')
        .map(message => message.content)
        .find(content => content.includes('请记住杯子代号')) || '';
      const rememberedCode = historicalUserText.match(/杯子代号\s+(cup-[a-z0-9-]+)/u)?.[1] || '';
      return rememberedCode || 'HISTORY_MISSING';
    };

    mocks.runWithTools.mockImplementation(async (...args: any[]) => {
      const messages = args[0] || [];
      const currentUserText = [...messages]
        .reverse()
        .find((message: any) => message?.role === 'user')?.content || '';
      if (currentUserText === statusOwnerText) {
        modelInvocations.push({
          hook: 'runWithTools',
          messages: messages.map((message: any) => ({
            role: String(message?.role || ''),
            content: String(message?.content || ''),
          })),
        });
        const onToolCall = args[3] as ((record: Record<string, any>) => void) | undefined;
        markStatusOwnerStarted();
        return new Promise(resolve => {
          releaseStatusOwnerModel = () => {
            const record = {
              id: `isolated-status-window-${suffix}`,
              key: 'desktop_active_window:{}',
              name: 'desktop_active_window',
              arguments: {},
              result: JSON.stringify({
                ok: true,
                status: 'verified',
                title: 'Isolated Status Window',
                processName: 'isolated-status.exe',
              }),
              error: '',
              outcome: 'success',
              terminalVerification: {
                status: 'verified',
                strategy: 'terminal_receipt',
                reason: 'isolated status owner was released after sidecar inspection',
              },
            };
            onToolCall?.(record);
            resolve({
              text: '当前前台窗口标题是 Isolated Status Window。',
              toolCalls: [record],
              usageRecords: [],
            });
          };
        });
      }
      return {
        text: answerFromModelMessages('runWithTools', messages),
        toolCalls: [],
        usageRecords: [],
      };
    });
    mocks.makeLLMCallStreaming.mockImplementation(async (...args: any[]) => ({
      text: answerFromModelMessages('makeLLMCallStreaming', args[0] || []),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }));

    httpServer = createServer();
    io = new SocketIOServer(httpServer, { transports: ['websocket'] });
    io.on('connection', serverSocket => {
      serverSocket.data.authenticatedUserId = userId;
      serverSocket.data.authenticatedRole = 'admin';
      serverSocket.data.trustedLocalExecution = true;
      serverSocket.data.lumiDeviceType = 'desktop';
      serverSocket.data.lumiDesktopDomain = 'personal';
      serverSocket.data.lumiDesktopOrgId = '';
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
    if (!address || typeof address === 'string') {
      throw new Error('Unable to bind isolated continuity Chat server');
    }
    client = createSocketClient(`http://127.0.0.1:${address.port}`, {
      transports: ['websocket'],
    });
    client.onAny((event, payload) => {
      if (
        (event === 'agent:tool' || event === 'agent:tool_call')
        && payload
        && typeof payload === 'object'
      ) {
        toolEvents.push({ event, requestId: String(payload.requestId || '') });
      }
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timed out connecting isolated continuity Chat client')),
        5_000,
      );
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

  it('feeds persisted UTF-8 Chinese history into the second model turn without activating the conversation', async () => {
    const firstResponsePromise = waitForRequestEvent<Record<string, any>>(
      client,
      'agent:response',
      firstRequestId,
    );
    const firstAck = await client.timeout(5_000).emitWithAck('agent:chat', {
      text: firstText,
      history: [],
      agentId: 'lumi',
      personalityId: 'lumi',
      domain: 'personal',
      source: 'e2e-formal-client',
      requestId: firstRequestId,
      conversationId: isolatedConversationId,
    });
    expect(firstAck).toMatchObject({ ok: true, requestId: firstRequestId });
    const firstResponse = await firstResponsePromise;
    expect(firstResponse).toMatchObject({
      requestId: firstRequestId,
      conversationId: isolatedConversationId,
      text: '已经记住。',
      finalized: true,
      blocked: false,
    });
    expect(firstResponse.completionFeedback).toBeUndefined();

    const secondResponsePromise = waitForRequestEvent<Record<string, any>>(
      client,
      'agent:response',
      secondRequestId,
    );
    const secondAck = await client.timeout(5_000).emitWithAck('agent:chat', {
      text: secondText,
      history: [],
      agentId: 'lumi',
      personalityId: 'lumi',
      domain: 'personal',
      source: 'e2e-formal-client',
      requestId: secondRequestId,
      conversationId: isolatedConversationId,
    });
    expect(secondAck).toMatchObject({ ok: true, requestId: secondRequestId });
    const secondResponse = await secondResponsePromise;
    expect(secondResponse).toMatchObject({
      requestId: secondRequestId,
      conversationId: isolatedConversationId,
      text: cupCode,
      finalized: true,
      blocked: false,
    });
    expect(secondResponse.completionFeedback).toBeUndefined();
    expect(toolEvents).toEqual([]);

    const secondModelInvocations = modelInvocations.filter(invocation => (
      [...invocation.messages]
        .reverse()
        .find(message => message.role === 'user')?.content === secondText
    ));
    expect(secondModelInvocations).toHaveLength(1);
    expect(secondModelInvocations[0].hook).toBe('makeLLMCallStreaming');
    const secondMessages = secondModelInvocations[0].messages;
    const firstUserIndex = secondMessages.findIndex(message => (
      message.role === 'user' && message.content === firstText
    ));
    const firstAssistantIndex = secondMessages.findIndex(message => (
      message.role === 'assistant' && message.content === '已经记住。'
    ));
    const secondUserIndex = secondMessages.findIndex(message => (
      message.role === 'user' && message.content === secondText
    ));
    expect(firstUserIndex).toBeGreaterThan(0);
    expect(firstAssistantIndex).toBeGreaterThan(firstUserIndex);
    expect(secondUserIndex).toBeGreaterThan(firstAssistantIndex);
    expect(secondMessages[firstUserIndex].content).toContain(cupCode);

    const db = readDB();
    const persistedTurns = (db.interactions || []).filter((row: any) => (
      row.userId === userId
      && row.conversationId === isolatedConversationId
      && [firstRequestId, secondRequestId].includes(
        String(row.requestId || row.externalMessageId || ''),
      )
    ));
    for (const exactRequestId of [firstRequestId, secondRequestId]) {
      expect(persistedTurns.filter((row: any) => (
        row.role === 'user'
        && String(row.requestId || row.externalMessageId || '') === exactRequestId
      ))).toHaveLength(1);
      const assistantRows = persistedTurns.filter((row: any) => (
        row.role === 'assistant'
        && String(row.requestId || row.externalMessageId || '') === exactRequestId
      ));
      expect(assistantRows).toHaveLength(1);
      expect(assistantRows[0].llmWasCalled).toBe(true);
    }
    const persistedSecondAssistant = persistedTurns.find((row: any) => (
      row.role === 'assistant'
      && String(row.requestId || row.externalMessageId || '') === secondRequestId
    ));
    expect(persistedSecondAssistant?.message).toBe(cupCode);

    expect(getActiveConversation(userId, 'lumi', 'personal', '')?.id)
      .toBe(activeConversationId);
    const isolatedAfterTurns = (db.conversations || []).find(
      (row: any) => row.id === isolatedConversationId,
    );
    expect(isolatedAfterTurns).toMatchObject({ status: 'closed' });
  });

  it('keeps a live isolated conversation status sidecar out of the user active conversation', async () => {
    const statusIsolatedConversationId = startIsolatedConversation(
      userId,
      'lumi',
      'personal',
      '',
    ).id;
    expect(statusIsolatedConversationId).not.toBe(activeConversationId);
    expect(getActiveConversation(userId, 'lumi', 'personal', '')?.id)
      .toBe(activeConversationId);

    const ownerResponsePromise = waitForRequestEvent<Record<string, any>>(
      client,
      'agent:response',
      statusOwnerRequestId,
    );
    const ownerAck = await client.timeout(5_000).emitWithAck('agent:chat', {
      text: statusOwnerText,
      history: [],
      agentId: 'lumi',
      personalityId: 'lumi',
      domain: 'personal',
      source: 'e2e-formal-client',
      requestId: statusOwnerRequestId,
      conversationId: statusIsolatedConversationId,
    });
    expect(ownerAck).toMatchObject({ ok: true, requestId: statusOwnerRequestId });
    await statusOwnerStarted;

    const sidecarResponsePromise = waitForRequestEvent<Record<string, any>>(
      client,
      'agent:response',
      statusSidecarRequestId,
    );
    const sidecarAck = await client.timeout(5_000).emitWithAck('agent:chat', {
      text: statusQuestionText,
      history: [],
      agentId: 'lumi',
      personalityId: 'lumi',
      domain: 'personal',
      source: 'e2e-formal-client',
      requestId: statusSidecarRequestId,
      conversationId: statusIsolatedConversationId,
    });
    expect(sidecarAck).toMatchObject({ ok: true, requestId: statusSidecarRequestId });
    const sidecarResponse = await sidecarResponsePromise;
    expect(sidecarResponse).toMatchObject({
      requestId: statusSidecarRequestId,
      conversationId: statusIsolatedConversationId,
      sidecar: true,
      finalized: true,
      blocked: false,
    });

    expect(releaseStatusOwnerModel).toBeTypeOf('function');
    releaseStatusOwnerModel?.();
    const ownerResponse = await ownerResponsePromise;
    expect(ownerResponse).toMatchObject({
      requestId: statusOwnerRequestId,
      conversationId: statusIsolatedConversationId,
      finalized: true,
      blocked: false,
    });

    const statusRows = (readDB().interactions || []).filter((row: any) => (
      row.userId === userId
      && String(row.requestId || row.externalMessageId || '') === statusSidecarRequestId
    ));
    expect(statusRows).toHaveLength(2);
    expect(statusRows.map((row: any) => row.role).sort()).toEqual(['assistant', 'user']);
    expect(statusRows.every((row: any) => (
      row.conversationId === statusIsolatedConversationId
    ))).toBe(true);
    expect(statusRows.some((row: any) => (
      row.conversationId === activeConversationId
    ))).toBe(false);
    expect(getActiveConversation(userId, 'lumi', 'personal', '')?.id)
      .toBe(activeConversationId);
    const isolatedAfterStatus = (readDB().conversations || []).find(
      (row: any) => row.id === statusIsolatedConversationId,
    );
    expect(isolatedAfterStatus).toMatchObject({ status: 'closed' });
  });
});
