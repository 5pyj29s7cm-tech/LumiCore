import { makeApp } from './helpers';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import { io as createSocketClient, type Socket } from 'socket.io-client';

const mocks = vi.hoisted(() => ({ runWithTools: vi.fn() }));
vi.mock('../server/llm/adapter', async importOriginal => ({
  ...await importOriginal<typeof import('../server/llm/adapter')>(), runWithTools: mocks.runWithTools,
}));
vi.mock('../server/memory', async importOriginal => ({
  ...await importOriginal<typeof import('../server/memory')>(),
  queryMemories: vi.fn(() => []), queryMemoriesVector: vi.fn(async () => []),
  extractMemories: vi.fn(async () => ({ memories: [], reminders: [] })),
}));
vi.mock('../server/agents/rag', async importOriginal => ({
  ...await importOriginal<typeof import('../server/agents/rag')>(), retrieveChunks: vi.fn(async () => []),
}));

import { flushDB, readDB } from '../db_layer';
import { getOrCreateActiveConversation } from '../server/conversation/manager';
import { getConversationActionTurn } from '../server/conversation/action_turn_ledger';
import { registerChatHandler } from '../server/socket/chat';
import { countUnsettledChatExecutions, getChatExecution, waitForChatExecutionPersistence } from '../server/socket/chat_execution_registry';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';
import { installShutdownIngress, RuntimeShutdownCoordinator } from '../server/runtime/shutdown';
import { runtimeBackgroundWork, runtimeShutdownCancellation, waitUntilRuntimeIdle } from '../server/runtime/shutdown_work';

describe('real chat shutdown cancellation boundary', () => {
  let io: Server | undefined;
  let client: Socket | undefined;
  afterAll(async () => {
    client?.close();
    if (io) await new Promise<void>(resolve => io!.close(() => resolve()));
  });

  it('cancels an active model call and persists its terminal before authorizing exit', async () => {
    const app = await makeApp();
    const userId = 'runtime-shutdown-chat';
    const requestId = 'runtime-shutdown-request';
    const source = 'command-center-chat';
    const conversationId = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id;
    if (!toolRegistry.get('desktop_active_window')) registerAllTools(toolRegistry);
    let started!: () => void;
    const modelStarted = new Promise<void>(resolve => { started = resolve; });
    let releaseTerminal!: () => void;
    const terminalGate = new Promise<void>(resolve => { releaseTerminal = resolve; });
    let modelSignal: AbortSignal | undefined;
    mocks.runWithTools.mockImplementation(async (...args: any[]) => {
      modelSignal = args[2]?.signal;
      started();
      await new Promise<void>(resolve => {
        if (modelSignal?.aborted) resolve();
        else modelSignal?.addEventListener('abort', () => resolve(), { once: true });
      });
      await terminalGate;
      return { text: 'Cancelled model operation.', toolCalls: [], usageRecords: [] };
    });

    io = new Server(app.server, { transports: ['websocket'] });
    const ingress = installShutdownIngress(app.app, app.apiRouter, io);
    io.on('connection', socket => {
      socket.data.authenticatedUserId = userId;
      socket.data.authenticatedRole = 'admin';
      socket.data.trustedLocalExecution = true;
      socket.join(`user:${userId}:personal`);
      registerChatHandler(socket, {
        getDeepSeek: () => ({}), getGemini: () => ({}), getOpenAI: () => ({}), getAnthropic: () => ({}),
        getQwen: () => ({}), getOllama: () => ({}), isOllamaAvailable: () => false,
        getLmStudio: () => ({}), isLmStudioAvailable: () => false, getRelay: () => ({}),
      }, () => ({ audio: false, visual: false, spatial: false, activeDeviceTypes: [], deviceCount: 0 }), () => userId, io!);
    });
    ingress.trackRegisteredHttpHandlers();
    const exit = vi.fn();
    const save = vi.fn(async () => {
      expect(getChatExecution({ userId, domain: 'personal', source, conversationId }, requestId))
        .toMatchObject({ terminal: true, status: 'cancelled' });
      expect(getConversationActionTurn({ conversationId, userId, requestId })).toMatchObject({ status: 'cancelled' });
      expect(readDB().conversations.find((row: any) => row.id === conversationId)?.actionContinuationState).toBeUndefined();
      await flushDB();
    });
    const shutdown = new RuntimeShutdownCoordinator({
      stopAdmission() { runtimeShutdownCancellation.request(); ingress.stopAdmission(); },
      async drain() {
        await ingress.waitForIdle();
        await waitUntilRuntimeIdle(() => countUnsettledChatExecutions() === 0);
        await runtimeBackgroundWork.waitForIdle();
        await waitForChatExecutionPersistence();
      },
      saveAndClose: save,
      exit,
      timeoutMs: 5_000,
    });
    ingress.configure(shutdown);
    client = createSocketClient(app.url, { transports: ['websocket'], reconnection: false });
    await new Promise<void>(resolve => client!.once('connect', resolve));
    await client.timeout(5_000).emitWithAck('agent:chat', {
      text: '请实际查看当前前台窗口，必须调用桌面观察工具，然后告诉我窗口标题。',
      history: [], agentId: 'lumi', domain: 'personal', source, requestId, conversationId,
    });
    await modelStarted;
    const closing = shutdown.request();
    expect(modelSignal?.aborted).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    releaseTerminal();
    await closing;
    shutdown.requestExit();
    expect(save).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
