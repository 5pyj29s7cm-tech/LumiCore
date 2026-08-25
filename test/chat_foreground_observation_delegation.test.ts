import './helpers';
import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createSocketClient, type Socket as ClientSocket } from 'socket.io-client';

const mocks = vi.hoisted(() => ({
  runWithTools: vi.fn(),
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
    extractMemories: vi.fn(async () => []),
  };
});

vi.mock('../server/agents/rag', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/agents/rag')>();
  return { ...actual, retrieveChunks: vi.fn(async () => []) };
});

import { initDatabase, readDB, writeDB } from '../db_layer';
import {
  listBackgroundTasks,
  resetBackgroundTasksForTest,
} from '../server/agents/background_tasks';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import {
  handleDesktopRelayResult,
} from '../server/socket/desktop_relay';
import { registerChatHandler } from '../server/socket/chat';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';

const EXACT_OBSERVATION_REQUEST = '\u8fd9\u662f\u9694\u79bb\u7684\u53ea\u8bfb\u9a8c\u6536\u3002\u8bf7\u5b9e\u9645\u67e5\u770b\u5f53\u524d\u524d\u53f0\u7a97\u53e3\uff0c\u5fc5\u987b\u8c03\u7528\u76f8\u5e94\u684c\u9762\u89c2\u5bdf\u5de5\u5177\uff0c\u7136\u540e\u53ea\u544a\u8bc9\u6211\u7a97\u53e3\u6807\u9898\uff1b\u4e0d\u8981\u70b9\u51fb\u3001\u8f93\u5165\u6216\u4fee\u6539\u4efb\u4f55\u5185\u5bb9\u3002';

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

describe('chat foreground desktop observation delegation gate', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `chat-foreground-observation-${suffix}`;
  const requestId = `chat-foreground-observation-request-${suffix}`;
  let conversationId = '';
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let client: ClientSocket;
  const backgroundEvents: any[] = [];
  const desktopCalls: Array<{ name: string; arguments: Record<string, any> }> = [];

  beforeAll(async () => {
    await initDatabase();
    resetBackgroundTasksForTest({ clearPersisted: true, markHydrated: true });
    if (!toolRegistry.get('desktop_active_window')) registerAllTools(toolRegistry);

    const db = readDB();
    db.agents = [
      ...(db.agents || []),
      ...Array.from({ length: 8 }, (_, index) => ({
        id: `foreground-worker-${suffix}-${index}`,
        name: `Foreground worker ${index}`,
        status: 'active',
        domain: 'personal',
        orgId: '',
        ownerUid: userId,
      })),
    ];
    writeDB(db);
    conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;

    mocks.runWithTools.mockImplementation(async (...args: any[]) => {
      const registry = args[1];
      const onToolCall = args[3] as ((record: Record<string, any>) => void) | undefined;
      const context = args[11];
      expect(context.toolPolicy.allowedTools).toContain('desktop_active_window');
      const result = await registry.execute('desktop_active_window', {}, context);
      const record = {
        id: `desktop-active-window-${requestId}`,
        key: 'desktop_active_window:{}',
        name: 'desktop_active_window',
        arguments: {},
        result,
        error: '',
        outcome: 'success',
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'active window returned',
        },
      };
      onToolCall?.(record);
      return {
        text: '\u5f53\u524d\u524d\u53f0\u7a97\u53e3\u6807\u9898\u662f Acceptance Window\u3002',
        toolCalls: [record],
        usageRecords: [],
      };
    });

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
          activeDeviceTypes: ['desktop'],
          deviceCount: 1,
        }),
        () => userId,
        io,
      );
    });
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Unable to bind chat handler test server');
    client = createSocketClient(`http://127.0.0.1:${address.port}`, { transports: ['websocket'] });
    client.on('agent:background_task_update', payload => backgroundEvents.push(payload));
    client.on('tool:desktop_exec', payload => {
      desktopCalls.push({ name: payload.name, arguments: payload.arguments || {} });
      handleDesktopRelayResult(payload.correlationId, {
        output: JSON.stringify({
          ok: true,
          status: 'verified',
          title: 'Acceptance Window',
          processName: 'acceptance.exe',
        }),
      }, client.id);
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting chat test client')), 5_000);
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

  it('executes desktop_active_window in the current Socket turn without registering background work', async () => {
    const responsePromise = waitForRequestEvent<Record<string, any>>(
      client,
      'agent:response',
      requestId,
    );
    const ack = await client.timeout(5_000).emitWithAck('agent:chat', {
      text: EXACT_OBSERVATION_REQUEST,
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
    });
    expect(response.text).toContain('Acceptance Window');
    expect(desktopCalls).toEqual([{ name: 'desktop_active_window', arguments: {} }]);
    expect(mocks.runWithTools).toHaveBeenCalledTimes(1);
    expect(backgroundEvents).toEqual([]);
    expect(listBackgroundTasks(userId)).toEqual([]);
  });
});
