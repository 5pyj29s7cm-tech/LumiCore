import './helpers';
import { prepareForegroundRequest, taskFor } from './foreground_request_fixture';
import { createServer, type Server as HttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createSocketClient, type Socket as ClientSocket } from 'socket.io-client';

const mocks = vi.hoisted(() => ({
  loopError: null as Error | null,
  loopDelayMs: 0,
  heartbeatError: null as Error | null,
  loopFailure: null as 'error' | 'cancel' | 'cancel_return' | 'late_cancel' | null,
  lateRelease: undefined as (() => void) | undefined,
  lateExecution: undefined as Promise<unknown> | undefined,
  loopPause: null as { entered: () => void; wait: Promise<void> } | null,
  loopRequests: [] as string[],
  budgetProbe: false,
  budgetStates: [] as unknown[],
}));

vi.mock('../server/llm/adapter', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/llm/adapter')>();
  return {
    ...actual,
    runWithTools: async (...args: Parameters<typeof actual.runWithTools>) => {
      mocks.loopRequests.push(String(args[2].requestId || ''));
      const pause = mocks.loopPause;
      mocks.loopPause = null;
      if (pause) { pause.entered(); await pause.wait; }
      const delayMs = mocks.loopDelayMs;
      mocks.loopDelayMs = 0;
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      args[2].signal?.throwIfAborted();
      if (mocks.budgetProbe) {
        mocks.budgetStates.push(args[2].modelTurnState);
        if (mocks.budgetStates.length % 2 === 1) return { text: '文件已经读取完成。', toolCalls: [], usageRecords: [] };
        mocks.budgetProbe = false;
        throw new Error('Fixture ends recovery without calling a provider');
      }
      const error = mocks.loopError;
      mocks.loopError = null;
      if (error) throw error;
      const failure = mocks.loopFailure;
      mocks.loopFailure = null;
      if (!failure) throw new Error('Unexpected model call in isolated socket fixture');
      const context = args[11]!;
      if (failure === 'late_cancel') {
        const { ToolRegistry } = await import('../server/tools/registry');
        const { executeToolCall } = await import('../server/tools/execution_engine');
        const registry = new ToolRegistry();
        let started!: () => void;
        const pending = new Promise<void>(resolve => { started = resolve; });
        registry.register({
          name: 'read_file', description: 'Isolated suspended read', permission: 'public', securityLevel: 'safe',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
          handler: async () => {
            started();
            await new Promise<void>(resolve => { mocks.lateRelease = resolve; });
            return 'Late read returned after the task transport finished.';
          },
        });
        mocks.lateExecution = executeToolCall({ registry, id: `late-${context.requestId}`, name: 'read_file',
          arguments: { path: 'D:/synthetic/completed-read.txt' }, context });
        await Promise.race([pending, mocks.lateExecution.then(record => {
          throw new Error(`Suspended-read fixture did not reach its handler: ${JSON.stringify(record)}`);
        })]);
        const signal = args[2].signal!;
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        throw new DOMException('Stopped waiting while the adapter is still pending', 'AbortError');
      }
      // Simulate a completed read followed by a model failure/cancellation.
      // No provider or native desktop operation runs in this socket fixture.
      const record = {
        id: `completed-read-${context.requestId}`,
        name: 'read_file',
        arguments: { path: 'D:/synthetic/completed-read.txt' },
        result: 'Completed read retained before the model loop failed.',
        duration: 1,
        taskId: context.taskId,
        requestId: context.requestId,
        turnId: context.turnId,
        terminalVerification: { status: 'verified' as const, strategy: 'terminal_receipt' as const, reason: 'fixture_read' },
      };
      await args[3]?.(record);
      if (failure !== 'error') {
        const signal = args[2].signal!;
        if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        if (failure === 'cancel_return') return { text: 'Task cancelled after read.', toolCalls: [record], usageRecords: [] };
        throw new DOMException('Fixture cancelled after completed read', 'AbortError');
      }
      throw new Error('Fixture model failed after completed read');
    },
  };
});

vi.mock('../server/conversation/manager', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/conversation/manager')>();
  return {
    ...actual,
    startConversationActionExecutionHeartbeat: (
      ...args: Parameters<typeof actual.startConversationActionExecutionHeartbeat>
    ) => {
      const error = mocks.heartbeatError;
      mocks.heartbeatError = null;
      if (error) throw error;
      return actual.startConversationActionExecutionHeartbeat(...args);
    },
  };
});

vi.mock('../server/memory', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/memory')>();
  return {
    ...actual,
    queryMemories: vi.fn(() => []),
    extractMemories: vi.fn(async () => ({ memories: [], reminders: [] })),
  };
});

import { flushDBOrThrow, initDatabase, readDB, writeDB } from '../db_layer';
import {
  addMessageIdempotent,
  getOrCreateActiveConversation,
  startIsolatedConversation,
  convergeForegroundRequestBeforeRelease,
  getMessages,
  prepareConversationActionExecution,
} from '../server/conversation/manager';
import { getConversationActionTurn } from '../server/conversation/action_turn_ledger';
import { registerChatHandler } from '../server/socket/chat';
import { CN_TASK_EXECUTION_MESSAGES, CN_VOICE_WORK_MESSAGES } from '../server/regions/packs/cn/voice_fast_path_messages';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';

const TOOL_POLICY = {
  allowedTools: ['desktop_open'],
  requireConfirmation: [],
  forbiddenTools: [],
  maxIterations: 4,
};

const prepareTaskRequest = (label: string) => prepareForegroundRequest('task', label, TOOL_POLICY);

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

describe('task foreground release manager convergence', () => {
  beforeAll(async () => {
    await initDatabase();
    registerAllTools(toolRegistry);
  });

  it('blocks and quarantines a non-aborted Task executor before release', async () => {
    const identity = prepareTaskRequest('blocked');
    const result = await convergeForegroundRequestBeforeRelease({
      channel: 'Chat',
      identity,
      aborted: false,
      reason: 'Task executor left without an assistant terminal.',
    });

    expect(result).toMatchObject({
      converged: true,
      convergence: { converged: false, reason: 'nonterminal_task_still_active' },
      finalization: {
        requestedOutcome: 'blocked',
        effectiveOutcome: 'blocked',
        taskStatus: 'blocked',
        actionTurnStatus: 'persistence_unknown',
      },
    });
    expect(taskFor(identity)).toMatchObject({ status: 'blocked', activeRequestId: '' });
    expect(getConversationActionTurn(identity)).toMatchObject({
      status: 'persistence_unknown',
      leaseOwnerId: '',
    });
  });

  it('cancels only the exact aborted Task request before release', async () => {
    const identity = prepareTaskRequest('cancelled');
    const result = await convergeForegroundRequestBeforeRelease({
      channel: 'Chat',
      identity,
      aborted: true,
      reason: 'Exact Task request was aborted.',
    });

    expect(result).toMatchObject({
      converged: true,
      finalization: {
        requestedOutcome: 'cancelled',
        effectiveOutcome: 'cancelled',
        taskStatus: 'cancelled',
        actionTurnStatus: 'cancelled',
      },
    });
    expect(taskFor(identity)).toMatchObject({ status: 'cancelled', activeRequestId: '' });
  });

  it('accepts one exact durable assistant failure as terminal evidence', async () => {
    const identity = prepareTaskRequest('natural-failure');
    const assistantMessageId = addMessageIdempotent({
      userId: identity.userId,
      agentId: 'lumi',
      conversationId: identity.conversationId,
      role: 'assistant',
      content: CN_VOICE_WORK_MESSAGES.processingFailed,
      requestId: identity.requestId,
      domain: 'personal',
      source: 'test',
      channel: 'task',
      cognitiveIntent: 'chat_execution_failed',
      llmWasCalled: false,
    });
    // Recreate the durable split-brain this release fence must repair: the
    // assistant/action terminal is exact, but its task projection still owns
    // the request lease.
    const splitBrainDb = readDB();
    const splitBrainTask = splitBrainDb.conversationActionTasks.find((row: any) => (
      row.id === identity.expectedTaskId
    ));
    splitBrainTask.status = 'planning';
    splitBrainTask.activeRequestId = identity.requestId;
    writeDB(splitBrainDb);

    const result = await convergeForegroundRequestBeforeRelease({
      channel: 'Chat',
      identity,
      aborted: false,
    });
    expect(result).toMatchObject({
      converged: true,
      convergence: {
        converged: false,
        finalStatus: 'terminal',
        assistantMessageId,
      },
      finalization: {
        requestedOutcome: 'blocked',
        effectiveOutcome: 'blocked',
        assistantMessageId,
        taskStatus: 'blocked',
        actionTurnStatus: 'terminal',
      },
    });
    expect(taskFor(identity)).toMatchObject({ status: 'blocked', activeRequestId: '' });
    expect(getConversationActionTurn(identity)).toMatchObject({
      status: 'terminal',
      terminalMessageId: assistantMessageId,
    });
  });

  it('keeps pre-binding paths identity-free and orders convergence before resource release', () => {
    const source = readFileSync('server/socket/chat.ts', 'utf8');
    const releaseStart = source.indexOf('const chatReleaseGate = createDurableForegroundReleaseGate({');
    const convergeAt = source.indexOf('convergeChatForegroundRequestBeforeRelease({', releaseStart);
    const durableSuccessAt = source.indexOf('if (!releaseResult.converged)', convergeAt);
    const transportReleaseAt = source.indexOf('releaseResources: releaseChatTransportResources', durableSuccessAt);
    const transportHelperStart = source.indexOf('const releaseChatTransportResources = (): void => {');
    const desktopReleaseAt = source.indexOf('releaseDesktopControlLease?.();', transportHelperStart);
    const serialReleaseAt = source.indexOf('sessionLease.release();', transportHelperStart);
    const identityAt = source.indexOf('foregroundRequestIdentity = Object.freeze({');
    const bindAt = source.lastIndexOf('prepareConversationActionExecution({', identityAt);
    expect(releaseStart).toBeGreaterThan(-1);
    expect(convergeAt).toBeGreaterThan(releaseStart);
    expect(durableSuccessAt).toBeGreaterThan(convergeAt);
    expect(transportReleaseAt).toBeGreaterThan(durableSuccessAt);
    expect(transportHelperStart).toBeGreaterThan(-1);
    expect(desktopReleaseAt).toBeGreaterThan(transportHelperStart);
    expect(serialReleaseAt).toBeGreaterThan(desktopReleaseAt);
    expect(identityAt).toBeGreaterThan(bindAt);
    expect(source.slice(releaseStart, bindAt)).not.toContain('foregroundRequestIdentity = Object.freeze({');

    const ordinaryFailureStart = source.indexOf('console.error("[Socket Agent Error]:", error);');
    const ordinaryFailureEnd = source.indexOf('} finally {', ordinaryFailureStart);
    const ordinaryFailure = source.slice(ordinaryFailureStart, ordinaryFailureEnd);
    expect(ordinaryFailure).toContain('CN_VOICE_WORK_MESSAGES.processingFailed');
    expect(ordinaryFailure).toContain("role: 'assistant'");
    expect(ordinaryFailure).toContain('requestId,');
    expect(ordinaryFailure).not.toContain("event: 'agent:error'");

    const cancellationHandler = source.slice(
      source.indexOf('socket.on("agent:abort_chat"'),
      source.indexOf('socket.on("agent:chat"'),
    );
    expect(cancellationHandler).toContain("status: 'cancelling'");
    expect(cancellationHandler).not.toContain('cancelConversationActionExecution(');
  });
});

describe('task foreground Socket terminal integration', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `task-foreground-socket-${suffix}`;
  let conversationId = '';
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let client: ClientSocket;

  beforeAll(async () => {
    await initDatabase();
    conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
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
          getLmStudio: () => ({}),
          isOllamaAvailable: () => false,
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
    if (!address || typeof address === 'string') throw new Error('Unable to bind Task handler test server');
    client = createSocketClient(`http://127.0.0.1:${address.port}`, { transports: ['websocket'] });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out connecting Task test client')), 5_000);
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

  it('answers a runtime ledger query without waiting for or completing the active Task writer', async () => {
    const writerId = 'task-writer-status-' + suffix;
    const queryId = 'task-sidecar-status-' + suffix;
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    mocks.loopPause = { entered, wait: waiting };
    mocks.loopError = new Error('Fixture writer ends after the status read');
    const writerResponse = waitForRequestEvent<Record<string, any>>(client, 'agent:response', writerId);
    try {
      expect(await client.timeout(5000).emitWithAck('agent:chat', { source: 'task',
        text: '读取 D:/synthetic/receipt.txt 并告诉我内容。', requestId: writerId, conversationId,
      })).toMatchObject({ ok: true, requestId: writerId });
      await started;
      const writerTask = (readDB().conversationActionTasks || []).find((row: any) => row.activeRequestId === writerId);
      expect(writerTask).toBeDefined();
      const before = { id: writerTask!.id, revision: writerTask!.revision, status: writerTask!.status, activeRequestId: writerId };
      const queryResponse = waitForRequestEvent<Record<string, any>>(client, 'agent:response', queryId, 2000);
      expect(await client.timeout(5000).emitWithAck('agent:chat', { source: 'task',
        text: '后台正在执行什么任务？', requestId: queryId, conversationId,
      })).toMatchObject({ ok: true, requestId: queryId });
      expect(await queryResponse).toMatchObject({ reason: 'runtime_work_status', blocked: false, finalized: true, sidecar: true });
      expect((readDB().conversationActionTasks || []).find((row: any) => row.id === before.id)).toMatchObject(before);
      const replayResponse = waitForRequestEvent<Record<string, any>>(client, 'agent:response', queryId, 2000);
      expect(await client.timeout(5000).emitWithAck('agent:chat', { source: 'task',
        text: '后台正在执行什么任务？', requestId: queryId, conversationId,
      })).toMatchObject({ ok: true, requestId: queryId });
      expect(await replayResponse).toMatchObject({ replayed: true, reason: 'runtime_work_status', blocked: false });
      expect((readDB().conversationActionTasks || []).find((row: any) => row.id === before.id)).toMatchObject(before);
      expect(mocks.loopRequests).not.toContain(queryId);
      const queryTurns = getMessages(conversationId).filter(row => row.requestId === queryId);
      expect(queryTurns.filter(row => row.role === 'assistant')).toHaveLength(1);
      expect(queryTurns.find(row => row.role === 'assistant')?.toolCalls).toEqual([
        expect.objectContaining({ name: 'runtime_work_status', requestId: queryId }),
      ]);
    } finally {
      release();
      await writerResponse;
    }
  }, 15000);

  it('keeps the runtime read sidecar closed when the scoped personality forbids tools', async () => {
    const { personalityRegistry } = await import('../server/personality/registry');
    const config = personalityRegistry.getDefault();
    const scoped = vi.spyOn(personalityRegistry, 'getForUser').mockReturnValue({ ...config,
      toolPolicy: { allowedTools: [], requireConfirmation: [], forbiddenTools: ['*'], maxIterations: 0 } });
    const requestId = 'task-runtime-denied-' + suffix;
    try {
      const response = waitForRequestEvent<Record<string, any>>(client, 'agent:response', requestId);
      expect(await client.timeout(5000).emitWithAck('agent:chat', { source: 'task',
        text: '你现在有在执行的任务吗', requestId, conversationId,
      })).toMatchObject({ ok: true, requestId });
      expect(await response).toMatchObject({ reason: 'runtime_work_status', blocked: true, sidecar: true });
      const row = getMessages(conversationId).find(item => item.role === 'assistant' && item.requestId === requestId)!;
      expect(row.toolCalls?.[0]).toMatchObject({ name: 'runtime_work_status', requestId });
      expect(row.toolCalls?.[0].error).toBeTruthy();
      expect(mocks.loopRequests).not.toContain(requestId);
    } finally { scoped.mockRestore(); }
  });

  it('persists an ordinary Task exception as one natural assistant response', async () => {
    const requestId = `task-natural-failure-${suffix}`;
    const errorFrames: any[] = [];
    const onAgentError = (payload: any) => {
      if (String(payload?.requestId || '') === requestId) errorFrames.push(payload);
    };
    client.on('agent:error', onAgentError);
    mocks.loopError = new Error('private Task failure detail');
    const responsePromise = waitForRequestEvent<Record<string, any>>(client, 'agent:response', requestId);
    const ack = await client.timeout(5_000).emitWithAck('agent:chat', { source: 'task',
      text: '请读取 D:/synthetic/completed-read.txt 并总结内容。',
      history: [],
      personalityId: 'lumi',
      domain: 'personal',
      requestId,
      conversationId,
    });
    expect(ack).toMatchObject({ ok: true, requestId });

    const response = await responsePromise;
    client.off('agent:error', onAgentError);
    expect(response, JSON.stringify(response)).toMatchObject({
      requestId,
      finalized: true,
      blocked: true,
      reason: 'chat_execution_failed',
    });
    expect(response.text).toBe(CN_VOICE_WORK_MESSAGES.processingFailed);
    expect(JSON.stringify(response)).not.toContain('private Task failure detail');
    expect(errorFrames).toEqual([]);

    const db = readDB();
    const assistant = (db.interactions || []).find((row: any) => (
      row.userId === userId
      && row.conversationId === conversationId
      && row.role === 'assistant'
      && String(row.requestId || row.externalMessageId || '') === requestId
    ));
    expect(assistant).toMatchObject({
      message: CN_VOICE_WORK_MESSAGES.processingFailed,
      cognitiveIntent: 'chat_execution_failed',
    });
    const actionTurn = (db.conversationActionTurns || []).find((row: any) => (
      row.userId === userId
      && row.conversationId === conversationId
      && row.requestId === requestId
    ));
    expect(actionTurn).toMatchObject({
      status: 'terminal',
      terminalMessageId: assistant.id,
      leaseOwnerId: '',
    });
    const task = (db.conversationActionTasks || []).find((row: any) => row.id === actionTurn.taskId);
    expect(task).toMatchObject({ status: 'blocked', activeRequestId: '' });
  });

  it('shares the model budget with recovery and starts a fresh budget for the next request', async () => {
    mocks.budgetStates = [];
    for (let index = 0; index < 2; index++) {
      const requestId = `task-budget-${index}-${suffix}`;
      const conversationId = startIsolatedConversation(userId, 'lumi', 'personal', '').id;
      mocks.budgetProbe = true;
      const responsePromise = waitForRequestEvent(client, 'agent:response', requestId);
      await client.timeout(5_000).emitWithAck('agent:chat', { source: 'task',
        text: '请读取 D:/synthetic/completed-read.txt 并总结内容。',
        history: [], personalityId: 'lumi', domain: 'personal', requestId, conversationId,
      });
      await responsePromise;
      expect(mocks.budgetStates).toHaveLength((index + 1) * 2);
      expect(mocks.budgetStates[index * 2]).toBeDefined();
      expect(mocks.budgetStates[index * 2]).toBe(mocks.budgetStates[index * 2 + 1]);
    }
    expect(mocks.budgetStates[0]).not.toBe(mocks.budgetStates[2]);
  });

  it.each(['error', 'cancel', 'cancel_return'] as const)('retains completed tool receipts when the task loop ends with %s', async failure => {
    const conversationId = startIsolatedConversation(userId, 'lumi', 'personal', '').id;
    const requestId = `task-receipt-${failure}-${suffix}`;
    mocks.loopFailure = failure;
    const responsePromise = waitForRequestEvent<Record<string, any>>(client, 'agent:response', requestId);
    const toolPromise = waitForRequestEvent<Record<string, any>>(client, 'agent:tool_call', requestId);
    const ack = await client.timeout(5_000).emitWithAck('agent:chat', { source: 'task',
      text: '请读取 D:/synthetic/completed-read.txt 并总结内容。',
      history: [], personalityId: 'lumi', domain: 'personal', requestId, conversationId,
    });
    expect(ack).toMatchObject({ ok: true, requestId });
    await toolPromise;
    if (failure !== 'error') {
      const cancelAck = await client.timeout(5_000).emitWithAck('agent:abort_chat', { source: 'task', requestId, domain: 'personal' });
      expect(cancelAck).toMatchObject({ ok: true, status: 'cancelling' });
    }
    const response = await responsePromise;
    expect(response).toMatchObject({ finalized: true, requestId });
    const db = readDB();
    const assistant = db.interactions.find((row: any) => row.userId === userId
      && row.conversationId === conversationId && row.role === 'assistant'
      && (row.requestId || row.externalMessageId) === requestId);
    expect(assistant?.toolCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'read_file', requestId, result: 'Completed read retained before the model loop failed.' }),
    ]));
    const turn = db.conversationActionTurns.find((row: any) => row.userId === userId
      && row.conversationId === conversationId && row.requestId === requestId);
    expect(turn).toBeDefined();
    expect(assistant?.toolCalls?.[0]?.taskId).toBe(turn!.taskId);
    const receipts = db.conversationActionReceipts.filter((row: any) => row.taskId === turn!.taskId && row.requestId === requestId);
    expect(receipts).toEqual(expect.arrayContaining([expect.objectContaining({ toolName: 'read_file' })]));
    const task = db.conversationActionTasks.find((row: any) => row.id === turn!.taskId);
    expect(task).toMatchObject({ status: failure === 'error' ? 'blocked' : 'cancelled', activeRequestId: '' });
  });

  it('archives the canonical tool result after the socket request has already ended cancelled', async () => {
    const conversationId = startIsolatedConversation(userId, 'lumi', 'personal', '').id;
    const requestId = `task-late-receipt-${suffix}`;
    mocks.loopFailure = 'late_cancel';
    const responsePromise = waitForRequestEvent<Record<string, any>>(client, 'agent:response', requestId);
    await client.timeout(5_000).emitWithAck('agent:chat', { source: 'task',
      text: '请读取 D:/synthetic/completed-read.txt 并总结内容。',
      history: [], personalityId: 'lumi', domain: 'personal', requestId, conversationId,
    });
    await vi.waitFor(() => expect(mocks.lateRelease).toBeTypeOf('function'));
    await client.timeout(5_000).emitWithAck('agent:abort_chat', { source: 'task', requestId, domain: 'personal' });
    await responsePromise;
    const db = readDB();
    const turn = db.conversationActionTurns.find((row: any) => row.requestId === requestId)!;
    const taskBefore = JSON.stringify(db.conversationActionTasks.find((row: any) => row.id === turn.taskId));
    mocks.lateRelease!();
    await mocks.lateExecution;
    await flushDBOrThrow();
    expect(JSON.stringify(db.conversationActionTasks.find((row: any) => row.id === turn.taskId))).toBe(taskBefore);
    expect(db.conversationActionReceipts.filter((row: any) => row.taskId === turn.taskId && row.requestId === requestId))
      .toEqual(expect.arrayContaining([expect.objectContaining({ toolName: 'read_file', requestId })]));
    const reply = getMessages(conversationId).find(row => row.role === 'assistant' && row.requestId === requestId)!;
    expect(reply.toolCalls).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'read_file', result: 'Late read returned after the task transport finished.' })]));
    mocks.lateRelease = undefined;
    mocks.lateExecution = undefined;
  });

  it('converges a failure thrown immediately after immutable action binding', async () => {
    const requestId = `task-post-binding-failure-${suffix}`;
    mocks.heartbeatError = new Error('private heartbeat setup detail');
    const responsePromise = waitForRequestEvent<Record<string, any>>(client, 'agent:response', requestId);
    const ack = await client.timeout(5_000).emitWithAck('agent:chat', { source: 'task',
      text: '请读取 D:/synthetic/completed-read.txt 并总结内容。',
      history: [],
      personalityId: 'lumi',
      domain: 'personal',
      requestId,
      conversationId,
    });
    expect(ack).toMatchObject({ ok: true, requestId });

    const response = await responsePromise;
    expect(response).toMatchObject({
      requestId,
      text: CN_VOICE_WORK_MESSAGES.processingFailed,
      finalized: true,
      blocked: true,
      reason: 'chat_execution_failed',
    });
    expect(JSON.stringify(response)).not.toContain('private heartbeat setup detail');
    const db = readDB();
    const assistant = (db.interactions || []).find((row: any) => (
      row.userId === userId
      && row.conversationId === conversationId
      && row.role === 'assistant'
      && String(row.requestId || row.externalMessageId || '') === requestId
    ));
    const actionTurn = (db.conversationActionTurns || []).find((row: any) => (
      row.userId === userId
      && row.conversationId === conversationId
      && row.requestId === requestId
    ));
    expect(assistant).toMatchObject({
      message: CN_VOICE_WORK_MESSAGES.processingFailed,
      cognitiveIntent: 'chat_execution_failed',
    });
    expect(actionTurn).toMatchObject({
      status: 'terminal',
      terminalMessageId: assistant.id,
      leaseOwnerId: '',
    });
    const task = (db.conversationActionTasks || []).find((row: any) => row.id === actionTurn.taskId);
    expect(task).toMatchObject({ status: 'blocked', activeRequestId: '' });
  });

  it('reports cancellation as cancelling until the exact executor settles cancelled', async () => {
    const requestId = `task-cancelled-${suffix}`;
    mocks.loopDelayMs = 150;
    const responsePromise = waitForRequestEvent<Record<string, any>>(client, 'agent:response', requestId);
    const ack = await client.timeout(5_000).emitWithAck('agent:chat', { source: 'task',
      text: '请读取 D:/synthetic/completed-read.txt 并总结内容。',
      history: [],
      personalityId: 'lumi',
      domain: 'personal',
      requestId,
      conversationId,
    });
    expect(ack).toMatchObject({ ok: true, requestId });
    await vi.waitFor(() => expect(mocks.loopRequests).toContain(requestId));
    const cancelAck = await client.timeout(5_000).emitWithAck('agent:abort_chat', { source: 'task',
      requestId,
      domain: 'personal',
    });
    expect(cancelAck).toMatchObject({ ok: true, requestId, status: 'cancelling' });

    const response = await responsePromise;
    expect(response).toMatchObject({
      requestId,
      text: CN_TASK_EXECUTION_MESSAGES.cancelled,
      finalized: true,
      blocked: false,
      reason: 'request_cancelled',
    });
    const db = readDB();
    const actionTurn = (db.conversationActionTurns || []).find((row: any) => (
      row.userId === userId
      && row.conversationId === conversationId
      && row.requestId === requestId
    ));
    expect(actionTurn).toMatchObject({ status: 'cancelled', leaseOwnerId: '' });
    const task = (db.conversationActionTasks || []).find((row: any) => row.id === actionTurn.taskId);
    expect(task).toMatchObject({ status: 'cancelled', activeRequestId: '' });
  });
});
