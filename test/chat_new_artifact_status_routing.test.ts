import './helpers';
import fs from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createSocketClient, type Socket as ClientSocket } from 'socket.io-client';

const mocks = vi.hoisted(() => ({
  runWithTools: vi.fn(),
  printerJobRead: vi.fn(),
  printTripwire: vi.fn(async () => { throw new Error('READ_ONLY_TEST_MUST_NOT_PRINT'); }),
}));

vi.mock('../server/llm/adapter', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/llm/adapter')>();
  return { ...actual, runWithTools: mocks.runWithTools };
});

vi.mock('../server/devices/printer_jobs', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/devices/printer_jobs')>();
  return { ...actual, readPrinterJobStatus: mocks.printerJobRead, submitPrinterTestPage: mocks.printTripwire };
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
  startIsolatedConversation,
} from '../server/conversation/manager';
import { registerChatHandler } from '../server/socket/chat';
import {
  clearAllPendingConfirmationsForTests,
} from '../server/tools/pending_confirmation';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';

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
    expect((readDB().conversationActionTasks || []).find((row: any) => row.id === priorTaskId))
      .toMatchObject({ status: 'completed', activeRequestId: '' });

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

  it.each(['device-job', 'order-file', 'download-file', 'prior-receipt-and-file'] as const)(
    'reads the new %s source through the real chat handler without resuming the old task', async kind => {
      const liveRequestId = 'fresh-read-' + kind + '-' + suffix;
      const isolated = startIsolatedConversation(userId, 'lumi', 'personal', '');
      const oldGoal = 'Open the prior isolated settings task.';
      const oldRequestId = 'old-read-' + kind + '-' + suffix;
      const messageId = addMessage({ userId, agentId: 'lumi', conversationId: isolated.id, role: 'user', content: oldGoal,
        domain: 'personal', orgId: '', source: 'chat', channel: 'chat', requestId: oldRequestId, deferActionPreparation: true });
      bindConversationActionExecutionTurn({ conversationId: isolated.id, userId, userText: oldGoal, requestId: oldRequestId, userMessageId: messageId });
      const old = prepareConversationActionExecution({ conversationId: isolated.id, userId, userText: oldGoal,
        requestId: oldRequestId, userMessageId: messageId, forceTask: true, forceNewTask: true,
        toolPolicy: { allowedTools: ['client_action'], forbiddenTools: [], requireConfirmation: [], maxIterations: 1 } });
      const oldTaskId = String(old.state?.taskId || '');
      setConversationActionExecutionStatus(isolated.id, userId, 'blocked', { assistantState: 'Prior action needs independent follow-up.', blocker: 'old receipt incomplete' });
      addMessage({ userId, agentId: 'lumi', conversationId: isolated.id, role: 'assistant', content: 'The prior action ended without a completion receipt.',
        domain: 'personal', orgId: '', source: 'chat', channel: 'chat', requestId: oldRequestId, taskIntent: 'task', llmWasCalled: true, toolCalls: [] });
      expect((readDB().conversationActionTasks || []).find((row: any) => row.id === oldTaskId)).toMatchObject({ status: 'blocked', activeRequestId: '' });
      const sourcePath = path.join(String(process.env.LUMI_DATA_DIR || ''), kind + '-CAD-图纸-任务状态.json');
      fs.writeFileSync(sourcePath, JSON.stringify({ orderId: 'ORD-9841', jobId: 17, status: 'paused', downloadedBytes: 4097 }));
      const queue = 'Fixture physical network queue';
      const prompt = kind === 'device-job'
        ? '刚才 Job ID 2 已正常出纸。请只使用 printer_job_status 读取队列“' + queue + '”中任务编号 2 的状态，按回执说明是否仍可观察到。不要再次打印，不要查询其他队列，不要修改任何设置。'
        : kind === 'prior-receipt-and-file'
          ? '你上一轮用了哪个工具？现在读取本地文件“' + sourcePath + '”，给出订单 ORD-9841 的任务状态；订单状态以这次新读取的合成材料为准，不联系平台、不执行订单，不修改文件。'
          : '请只读取本地文件“' + sourcePath + '”，告诉我其中任务编号 17 的状态和已下载字节数，只以文件字段为准，不运行其他程序，不修改文件。';
      mocks.printerJobRead.mockResolvedValue({ ok: true, supported: true, platform: 'win32', source: 'windows_spooler_getjob',
        status: 'not_observed', observedAt: new Date().toISOString(), printerName: queue, jobId: 2, queue: null, job: null,
        physicalCompletionVerified: false, win32ResultCode: 87, errors: [], limitations: ['Not proof of physical completion.'] });
      mocks.runWithTools.mockReset();
      const executions: string[] = [];
      const modelInputs: Array<{taskId: unknown; actionIntent: unknown; routedTaskText: unknown}> = [];
      mocks.runWithTools.mockImplementation(async (...args: any[]) => {
        const context = args[11];
        modelInputs.push({ taskId: context.taskId, actionIntent: context.actionIntent, routedTaskText: context.routedTaskText });
        const name = kind === 'device-job' ? 'printer_job_status' : 'read_file';
        const exactArgs = kind === 'device-job' ? { printerName: queue, jobId: 2 } : { path: sourcePath };
        expect(context.toolPolicy.forbiddenTools).not.toContain(name);
        const record = await executeToolCall({ registry: toolRegistry, name, arguments: exactArgs,
          executionOrigin: 'model_selected', context, id: liveRequestId + '-read' });
        expect(record.error).toBeFalsy();
        expect(record.adapterStarted).toBe(true);
        executions.push(name);
        args[3]?.(record);
        return { text: record.result, toolCalls: [record], usageRecords: [] };
      });
      const responsePromise = waitForRequestEvent<Record<string, any>>(client, 'agent:response', liveRequestId);
      const ack = await client.timeout(5_000).emitWithAck('agent:chat', { text: prompt, agentId: 'lumi', domain: 'personal',
        source: 'command-center-chat', requestId: liveRequestId, conversationId: isolated.id });
      expect(ack).toMatchObject({ ok: true, requestId: liveRequestId });
      const response = await responsePromise;
      expect(response.reason).not.toBe('task_status');
      expect(response.taskRelation?.feedback).toBe('new_task');
      expect(executions, JSON.stringify({ modelInputs, response })).toEqual([kind === 'device-job' ? 'printer_job_status' : 'read_file']);
      expect(modelInputs).toHaveLength(1);
      expect(modelInputs[0].actionIntent).toBe(prompt);
      expect(modelInputs[0].routedTaskText).toBe(prompt);
      expect(modelInputs[0].taskId).not.toBe(oldTaskId);
      expect(response.taskRelation?.taskId).not.toBe(oldTaskId);
      expect(mocks.runWithTools).toHaveBeenCalledOnce();
      expect(mocks.printTripwire).not.toHaveBeenCalled();
      const reply = (readDB().interactions || []).find((row: any) => row.conversationId === isolated.id
        && row.role === 'assistant' && String(row.requestId || row.externalMessageId || '') === liveRequestId);
      expect(reply?.source).not.toBe('chat_task_status');
      expect(reply?.cognitiveIntent).not.toBe('task_status');
    },
  );

});
