import './helpers';
import fs from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
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
import {
  addMessage,
  bindConversationActionExecutionTurn,
  getOrCreateActiveConversation,
  prepareConversationActionExecution,
} from '../server/conversation/manager';
import { registerChatHandler } from '../server/socket/chat';
import {
  clearAllPendingConfirmationsForTests,
} from '../server/tools/pending_confirmation';
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

describe('Chat new artifact routing after a completed task', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `chat-new-artifact-${suffix}`;
  const priorRequestId = `chat-new-artifact-prior-${suffix}`;
  const requestId = `chat-new-artifact-live-${suffix}`;
  const targetPath = path.join(
    String(process.env.LUMI_DATA_DIR || ''),
    `stale-live-owner-${suffix}.txt`,
  );
  const prompt = `[LUMI_REGRESSION:S4:LIVE] Write the exact text "stale receipt live-owner sentinel" to ${targetPath}. Call write_file exactly once. Do not report task status. Stop when confirmation is required.`;
  let conversationId = '';
  let priorTaskId = '';
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let client: ClientSocket;

  beforeAll(async () => {
    await initDatabase();
    clearAllPendingConfirmationsForTests();
    if (!toolRegistry.get('write_file')) registerAllTools(toolRegistry);
    conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;

    const priorUserMessageId = addMessage({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'user',
      content: 'Open the prior isolated settings task.',
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
      userText: 'Open the prior isolated settings task.',
      requestId: priorRequestId,
      userMessageId: priorUserMessageId,
    })).toMatchObject({ requestId: priorRequestId });
    const priorPreparation = prepareConversationActionExecution({
      conversationId,
      userId,
      userText: 'Open the prior isolated settings task.',
      requestId: priorRequestId,
      userMessageId: priorUserMessageId,
      forceTask: true,
      forceNewTask: true,
      toolPolicy: {
        allowedTools: ['client_action'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 1,
      },
    });
    expect(priorPreparation.state).toMatchObject({ taskId: expect.any(String), unfinished: true });
    priorTaskId = String(priorPreparation.state?.taskId || '');
    addMessage({
      userId,
      agentId: 'lumi',
      conversationId,
      role: 'assistant',
      content: 'The prior isolated settings task completed.',
      domain: 'personal',
      orgId: '',
      source: 'chat',
      channel: 'chat',
      requestId: priorRequestId,
      taskIntent: 'task',
      llmWasCalled: true,
      toolCalls: [{
        id: `prior-client-action-${suffix}`,
        key: 'client_action:open_settings',
        name: 'client_action',
        arguments: { action: 'open_settings' },
        result: JSON.stringify({ ok: true, status: 'verified', target: 'settings' }),
        error: '',
        outcome: 'success',
        terminalVerification: {
          status: 'verified',
          strategy: 'state_diff',
          reason: 'settings rendered',
        },
      }],
    });
    expect((readDB().conversationActionTasks || []).find((row: any) => row.id === priorTaskId))
      .toMatchObject({ status: 'completed', activeRequestId: '' });

    let attempt = 0;
    mocks.runWithTools.mockImplementation(async (...args: any[]) => {
      attempt += 1;
      const context = args[11];
      if (attempt === 1) {
        return {
          text: `Created ${targetPath}.`,
          toolCalls: [],
          usageRecords: [],
        };
      }

      expect(attempt).toBe(2);
      expect(context.source).toBe('chat_guard_recovery');
      expect(context.requestId).toBe(requestId);
      expect(context.toolPolicy.allowedTools).toContain('write_file');
      const exactArguments = {
        path: targetPath,
        content: 'stale receipt live-owner sentinel',
      };
      const result = await toolRegistry.execute('write_file', exactArguments, context);
      const manifest = toolRegistry.getCapabilityManifestEntry(
        'write_file',
        context.toolPolicy,
      );
      expect(manifest).toBeDefined();
      const record = {
        id: `write-file-recovery-${suffix}`,
        taskId: context.taskId,
        turnId: requestId,
        requestId,
        executionOrigin: 'model_selected',
        name: 'write_file',
        arguments: exactArguments,
        result,
        receipt: {
          ok: true,
          status: 'verified',
          path: targetPath,
          contentMatched: true,
        },
        error: '',
        outcome: 'success',
        adapterStarted: true,
        evidence: toolRegistry.buildEvidenceRecord('write_file', exactArguments),
        capability: manifest ? {
          capabilityId: manifest.capabilityId,
          lane: manifest.lane,
          operation: manifest.operation,
          risk: manifest.risk,
          sideEffects: manifest.sideEffects,
          verification: manifest.verification,
          ...(manifest.reconciliation ? { reconciliation: manifest.reconciliation } : {}),
        } : undefined,
        terminalVerification: {
          status: 'verified',
          strategy: manifest?.verification.strategy || 'artifact',
          reason: 'exact file content verified by the isolated tool stub',
        },
      };
      const onToolCall = args[3] as ((value: Record<string, any>) => void) | undefined;
      onToolCall?.(record);
      return {
        text: `Created ${targetPath} with the exact requested text.`,
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
    if (!address || typeof address === 'string') throw new Error('Unable to bind isolated Chat test server');
    client = createSocketClient(`http://127.0.0.1:${address.port}`, { transports: ['websocket'] });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting isolated Chat test client')), 5_000);
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

  it('executes the new turn through the tool loop instead of returning prior task status', async () => {
    const responsePromise = waitForRequestEvent<Record<string, any>>(
      client,
      'agent:response',
      requestId,
    );
    const ack = await client.timeout(5_000).emitWithAck('agent:chat', {
      text: prompt,
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
      reason: '',
      taskRelation: {
        taskRelation: 'new',
        feedback: 'new_task',
      },
    });
    expect(String(response.text || '')).toContain(targetPath);
    expect(response.reason).not.toBe('task_status');
    expect(response.taskRelation?.taskId).not.toBe(priorTaskId);
    expect(mocks.runWithTools).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe('stale receipt live-owner sentinel');

    const assistant = (readDB().interactions || []).find((row: any) => (
      row.userId === userId
      && row.conversationId === conversationId
      && row.role === 'assistant'
      && String(row.requestId || row.externalMessageId || '') === requestId
    ));
    expect(assistant?.source).not.toBe('chat_task_status');
    expect(assistant?.cognitiveIntent).not.toBe('task_status');
  });
});
