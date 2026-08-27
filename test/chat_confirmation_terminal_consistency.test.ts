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
    extractMemories: vi.fn(async () => ({ memories: [], reminders: [] })),
  };
});

vi.mock('../server/agents/rag', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/agents/rag')>();
  return { ...actual, retrieveChunks: vi.fn(async () => []) };
});

import { initDatabase, readDB } from '../db_layer';
import { getConversationActionStateByTaskId } from '../server/conversation/action_ledger';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import { registerChatHandler } from '../server/socket/chat';
import { getChatExecution } from '../server/socket/chat_execution_registry';
import {
  clearAllPendingConfirmationsForTests,
  formatPendingConfirmationRequest,
  getPendingConfirmation,
} from '../server/tools/pending_confirmation';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';

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

describe('chat pending-confirmation terminal consistency', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `chat-confirmation-consistency-${suffix}`;
  const requestId = `chat-confirmation-request-${suffix}`;
  const source = 'command-center-chat';
  const exactArgs = {
    path: 'C:\\isolated-lumi-test\\confirmation-target.txt',
    content: 'isolated confirmation content',
    encoding: 'utf-8',
    overwritePolicy: 'fail_if_exists',
    password: 'must-never-reach-the-user',
    apiSecret: 'also-must-never-reach-the-user',
  };
  let conversationId = '';
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let client: ClientSocket;

  beforeAll(async () => {
    await initDatabase();
    clearAllPendingConfirmationsForTests();
    if (!toolRegistry.get('desktop_write_text_file')) registerAllTools(toolRegistry);
    conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;

    mocks.runWithTools.mockImplementation(async (...args: any[]) => {
      const context = args[11];
      expect(context.requestId).toBe(requestId);
      expect(typeof context.requestConfirmation).toBe('function');
      const approved = await context.requestConfirmation('desktop_write_text_file', exactArgs);
      expect(approved).toBe(false);
      return {
        text: 'This model draft must not replace the exact confirmation request.',
        toolCalls: [{
          id: `confirmation-call-${suffix}`,
          taskId: context.taskId,
          turnId: requestId,
          requestId,
          executionOrigin: 'model_selected',
          name: 'desktop_write_text_file',
          arguments: exactArgs,
          result: 'Tool "desktop_write_text_file" requires user confirmation and was not approved.',
          adapterStarted: false,
          terminalVerification: {
            status: 'unverified',
            strategy: 'terminal_receipt',
            reason: 'waiting_confirmation',
          },
        }],
        usageRecords: [],
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
    if (!address || typeof address === 'string') throw new Error('Unable to bind confirmation consistency server');
    client = createSocketClient(`http://127.0.0.1:${address.port}`, { transports: ['websocket'] });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting confirmation consistency client')), 5_000);
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
    clearAllPendingConfirmationsForTests();
    client?.disconnect();
    if (io) await new Promise<void>(resolve => io.close(() => resolve()));
    if (httpServer?.listening) await new Promise<void>(resolve => httpServer.close(() => resolve()));
  });

  it('emits, persists and checkpoints one exact safe confirmation request', async () => {
    const terminalPromise = waitForRequestEvent<Record<string, any>>(
      client,
      'agent:response',
      requestId,
    );
    const ack = await client.timeout(5_000).emitWithAck('agent:chat', {
      text: `Create ${exactArgs.path} with desktop_write_text_file and stop for confirmation.`,
      history: [],
      agentId: 'lumi',
      domain: 'personal',
      source,
      requestId,
      conversationId,
    });
    expect(ack).toMatchObject({ ok: true, requestId });

    const terminal = await terminalPromise;
    const pending = getPendingConfirmation(userId);
    expect(pending).not.toBeNull();
    const expectedConfirmationRequest = formatPendingConfirmationRequest(pending!);
    expect(terminal).toMatchObject({
      requestId,
      finalized: true,
      blocked: false,
      reason: 'waiting_confirmation',
      text: expectedConfirmationRequest,
    });
    expect(terminal.text).toContain(exactArgs.path);
    expect(terminal.text).not.toContain('must-never-reach-the-user');
    expect(terminal.text).not.toContain('also-must-never-reach-the-user');

    const db = readDB();
    const assistant = (db.interactions || []).find((item: any) => (
      item.role === 'assistant'
      && String(item.requestId || item.externalMessageId || '') === requestId
    ));
    const persistedAssistantText = String(assistant?.message || assistant?.content || '');
    expect(persistedAssistantText).toBe(expectedConfirmationRequest);

    const conversation = (db.conversations || []).find((item: any) => item.id === conversationId);
    expect(conversation?.actionContinuationState).toMatchObject({
      status: 'waiting_confirmation',
      assistantState: expectedConfirmationRequest,
    });
    expect(getConversationActionStateByTaskId(db, {
      conversationId,
      userId,
      taskId: String(conversation?.actionContinuationState?.taskId || ''),
    })).toMatchObject({
      status: 'waiting_confirmation',
      assistantState: expectedConfirmationRequest,
    });
    expect(getChatExecution({
      userId,
      domain: 'personal',
      orgId: '',
      source,
      conversationId,
    }, requestId)).toMatchObject({
      terminal: true,
      status: 'completed',
      terminalEvent: {
        payload: { text: expectedConfirmationRequest, reason: 'waiting_confirmation' },
      },
    });
    expect(terminal.text).toBe(persistedAssistantText);
    expect(terminal.text).toBe(conversation?.actionContinuationState?.assistantState);
    expect(mocks.runWithTools).toHaveBeenCalledTimes(1);
  });
});
