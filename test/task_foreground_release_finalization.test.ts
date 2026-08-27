import './helpers';
import { createServer, type Server as HttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createSocketClient, type Socket as ClientSocket } from 'socket.io-client';

const mocks = vi.hoisted(() => ({
  processInputError: null as Error | null,
  processInputDelayMs: 0,
  heartbeatError: null as Error | null,
}));

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

vi.mock('../server/cognition', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/cognition')>();
  return {
    ...actual,
    processInput: async (...args: Parameters<typeof actual.processInput>) => {
      if (mocks.processInputDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, mocks.processInputDelayMs));
        mocks.processInputDelayMs = 0;
      }
      const error = mocks.processInputError;
      mocks.processInputError = null;
      if (error) throw error;
      return actual.processInput(...args);
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

import { initDatabase, readDB, writeDB } from '../db_layer';
import {
  addMessageIdempotent,
  getOrCreateActiveConversation,
  prepareConversationActionExecution,
} from '../server/conversation/manager';
import { getConversationActionTurn } from '../server/conversation/action_turn_ledger';
import {
  convergeTaskForegroundRequestBeforeRelease,
  registerTaskHandler,
  type TaskForegroundRequestIdentity,
} from '../server/socket/task';
import { CN_TASK_EXECUTION_MESSAGES, CN_VOICE_WORK_MESSAGES } from '../server/regions/packs/cn/voice_fast_path_messages';

const TOOL_POLICY = {
  allowedTools: ['desktop_open'],
  requireConfirmation: [],
  forbiddenTools: [],
  maxIterations: 4,
};

function prepareTaskRequest(label: string): TaskForegroundRequestIdentity {
  const nonce = `${Date.now()}-${Math.random()}`;
  const userId = `task-release-${label}-${nonce}`;
  const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
  const requestId = `request-${label}-${nonce}`;
  const userText = `Run the ${label} task.`;
  const userMessageId = addMessageIdempotent({
    userId,
    agentId: 'lumi',
    conversationId: conversation.id,
    role: 'user',
    content: userText,
    requestId,
    deferActionPreparation: true,
    domain: 'personal',
    source: 'test',
    channel: 'task',
  });
  const prepared = prepareConversationActionExecution({
    conversationId: conversation.id,
    userId,
    userText,
    requestId,
    userMessageId,
    toolPolicy: TOOL_POLICY,
    forceTask: true,
  });
  expect(prepared.state?.taskId).toBeTruthy();
  return Object.freeze({
    conversationId: conversation.id,
    userId,
    requestId,
    expectedTaskId: prepared.state!.taskId!,
  });
}

function taskFor(identity: TaskForegroundRequestIdentity): any {
  return readDB().conversationActionTasks.find((row: any) => (
    row.id === identity.expectedTaskId
    && row.conversationId === identity.conversationId
    && row.userId === identity.userId
  ));
}

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
  });

  it('blocks and quarantines a non-aborted Task executor before release', async () => {
    const identity = prepareTaskRequest('blocked');
    const result = await convergeTaskForegroundRequestBeforeRelease({
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
    const result = await convergeTaskForegroundRequestBeforeRelease({
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
      cognitiveIntent: 'task_execution_failed',
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

    const result = await convergeTaskForegroundRequestBeforeRelease({
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
    const source = readFileSync('server/socket/task.ts', 'utf8');
    const releaseStart = source.indexOf('const taskReleaseGate = createDurableForegroundReleaseGate({');
    const convergeAt = source.indexOf('convergeTaskForegroundRequestBeforeRelease({', releaseStart);
    const durableSuccessAt = source.indexOf('if (!releaseResult.converged)', convergeAt);
    const transportReleaseAt = source.indexOf('releaseResources: releaseTaskTransportResources', durableSuccessAt);
    const transportHelperStart = source.indexOf('const releaseTaskTransportResources = (): void => {');
    const desktopReleaseAt = source.indexOf('releaseDesktopControlLease?.();', transportHelperStart);
    const serialReleaseAt = source.indexOf('taskLease.release();', transportHelperStart);
    const bindAt = source.indexOf('const actionTaskExecution = prepareConversationActionExecution({');
    const identityAt = source.indexOf('taskForegroundRequestIdentity = Object.freeze({', bindAt);
    expect(releaseStart).toBeGreaterThan(-1);
    expect(convergeAt).toBeGreaterThan(releaseStart);
    expect(durableSuccessAt).toBeGreaterThan(convergeAt);
    expect(transportReleaseAt).toBeGreaterThan(durableSuccessAt);
    expect(transportHelperStart).toBeGreaterThan(-1);
    expect(desktopReleaseAt).toBeGreaterThan(transportHelperStart);
    expect(serialReleaseAt).toBeGreaterThan(desktopReleaseAt);
    expect(identityAt).toBeGreaterThan(bindAt);
    expect(source.slice(releaseStart, bindAt)).not.toContain('taskForegroundRequestIdentity = Object.freeze({');

    const ordinaryFailureStart = source.indexOf('console.error("[Agent Task Error]:", err);');
    const ordinaryFailureEnd = source.indexOf('} finally {', ordinaryFailureStart);
    const ordinaryFailure = source.slice(ordinaryFailureStart, ordinaryFailureEnd);
    expect(ordinaryFailure).toContain('CN_VOICE_WORK_MESSAGES.processingFailed');
    expect(ordinaryFailure).toContain("role: 'assistant'");
    expect(ordinaryFailure).toContain('requestId,');
    expect(ordinaryFailure).not.toContain("event: 'agent:error'");

    const cancellationHandler = source.slice(
      source.indexOf("socket.on('agent:task_cancel'"),
      source.indexOf('socket.on("agent:task"'),
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
      registerTaskHandler(
        serverSocket,
        {
          getDeepSeek: () => ({}),
          getGemini: () => ({}),
          getOpenAI: () => ({}),
          getAnthropic: () => ({}),
          getQwen: () => ({}),
          getOllama: () => ({}),
          getLmStudio: () => ({}),
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

  it('persists an ordinary Task exception as one natural assistant response', async () => {
    const requestId = `task-natural-failure-${suffix}`;
    const errorFrames: any[] = [];
    const onAgentError = (payload: any) => {
      if (String(payload?.requestId || '') === requestId) errorFrames.push(payload);
    };
    client.on('agent:error', onAgentError);
    mocks.processInputError = new Error('private Task failure detail');
    const responsePromise = waitForRequestEvent<Record<string, any>>(client, 'agent:response', requestId);
    const ack = await client.timeout(5_000).emitWithAck('agent:task', {
      text: '请打开当前前台窗口并告诉我窗口标题。',
      history: [],
      personalityId: 'lumi',
      domain: 'personal',
      requestId,
      conversationId,
    });
    expect(ack).toMatchObject({ ok: true, requestId });

    const response = await responsePromise;
    client.off('agent:error', onAgentError);
    expect(response).toMatchObject({
      requestId,
      finalized: true,
      blocked: true,
      reason: 'task_execution_failed',
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
      cognitiveIntent: 'task_execution_failed',
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

  it('converges a failure thrown immediately after immutable action binding', async () => {
    const requestId = `task-post-binding-failure-${suffix}`;
    mocks.heartbeatError = new Error('private heartbeat setup detail');
    const responsePromise = waitForRequestEvent<Record<string, any>>(client, 'agent:response', requestId);
    const ack = await client.timeout(5_000).emitWithAck('agent:task', {
      text: '请打开当前前台窗口并告诉我窗口标题。',
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
      reason: 'task_execution_failed',
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
      cognitiveIntent: 'task_execution_failed',
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
    mocks.processInputDelayMs = 150;
    const responsePromise = waitForRequestEvent<Record<string, any>>(client, 'agent:response', requestId);
    const ack = await client.timeout(5_000).emitWithAck('agent:task', {
      text: '请打开当前前台窗口并告诉我窗口标题。',
      history: [],
      personalityId: 'lumi',
      domain: 'personal',
      requestId,
      conversationId,
    });
    expect(ack).toMatchObject({ ok: true, requestId });
    const cancelAck = await client.timeout(5_000).emitWithAck('agent:task_cancel', {
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
