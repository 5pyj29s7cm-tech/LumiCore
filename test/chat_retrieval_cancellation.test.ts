import './helpers';
import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createSocketClient, type Socket as ClientSocket } from 'socket.io-client';

const mocks = vi.hoisted(() => ({
  runWithTools: vi.fn(),
  makeLLMCallStreaming: vi.fn(),
  queryMemoriesVector: vi.fn(async () => []),
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
    queryMemoriesVector: mocks.queryMemoriesVector,
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



  it('finishes cancellation during an uncooperative memory lookup and admits the next turn', async () => {
    let releaseRetrieval!: (items: any[]) => void;
    let markRetrievalStarted!: () => void;
    const retrievalStarted = new Promise<void>(resolve => { markRetrievalStarted = resolve; });
    mocks.queryMemoriesVector.mockImplementationOnce(() => {
      markRetrievalStarted();
      return new Promise(resolve => { releaseRetrieval = resolve; });
    });
    const terminalPromise = waitForRequestEvent<Record<string, any>>(client, 'agent:response', longRequestId);
    const ack = await client.timeout(5000).emitWithAck('agent:chat', {
      text: LONG_COMMAND, history: [], agentId: 'lumi', domain: 'personal',
      source: scope.source, requestId: longRequestId, conversationId,
    });
    expect(ack.ok).toBe(true);
    await retrievalStarted;
    try {
      const abortAck = await client.timeout(5000).emitWithAck('agent:abort_chat', {
        domain: 'personal', source: scope.source, conversationId, requestId: longRequestId,
      });
      expect(abortAck).toMatchObject({ok: true, status: 'cancelling'});
      const terminal = await terminalPromise;
      expect(terminal).toMatchObject({requestId: longRequestId, finalized: true, blocked: false});
      expect(getChatExecution({...scope, conversationId}, longRequestId)).toMatchObject({terminal: true, status: 'cancelled'});
      const retrievalOptions = (mocks.queryMemoriesVector.mock.calls as any[][])[0][0];
      expect(retrievalOptions.signal).toBeInstanceOf(AbortSignal);
      expect(retrievalOptions.signal.aborted).toBe(true);
      expect(mocks.runWithTools).not.toHaveBeenCalled();

      // Keep the old simulated transport unresolved: the next turn must not
      // depend on a cancelled read returning before the conversation can run.
      const followupId = `${longRequestId}-followup`;
      mocks.makeLLMCallStreaming.mockResolvedValue({text:'Software is a set of instructions.',toolCalls:null,usage:{promptTokens:1,completionTokens:1,totalTokens:2}});
      mocks.runWithTools.mockResolvedValue({text:'Software is a set of instructions.',toolCalls:[],usageRecords:[]});
      const followupTerminalPromise = waitForRequestEvent<Record<string, any>>(client, 'agent:response', followupId);
      const followupAck = await client.timeout(5000).emitWithAck('agent:chat', {
        text: '\u7528\u4e00\u53e5\u8bdd\u89e3\u91ca\u4ec0\u4e48\u662f\u8f6f\u4ef6\u3002', history: [], agentId:'lumi',domain:'personal',
        source:scope.source, requestId:followupId, conversationId,
      });
      expect(followupAck.ok).toBe(true);
      const followupTerminal = await followupTerminalPromise;
      expect(followupTerminal).toMatchObject({requestId:followupId, finalized:true, blocked:false});
      expect(String(followupTerminal.text)).toContain('Software');
      expect(getChatExecution({...scope,conversationId},followupId)).toMatchObject({terminal:true,status:'completed'});
    } finally {
      releaseRetrieval([]);
    }
  });
});
