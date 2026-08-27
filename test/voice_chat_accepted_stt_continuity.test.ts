import './helpers';
import fs from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server as SocketIOServer } from 'socket.io';
import { io as createSocketClient, type Socket as ClientSocket } from 'socket.io-client';

const sttHarness = vi.hoisted(() => ({
  sessions: [] as Array<{
    chunks: Buffer[];
    emitResult: (result: Record<string, any>) => Promise<void>;
  }>,
}));

const mocks = vi.hoisted(() => ({
  makeLLMCall: vi.fn(),
  makeLLMCallStreaming: vi.fn(),
  runWithTools: vi.fn(),
}));

vi.mock('../server/stt/adapter', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/stt/adapter')>();
  return {
    ...actual,
    getActiveStreamingSTTProvider: vi.fn(() => 'ark'),
    createResilientStreamingSession: vi.fn(() => {
      let resultHandler: ((result: Record<string, any>) => void | Promise<void>) | null = null;
      let errorHandler: ((error: Error) => void) | null = null;
      const chunks: Buffer[] = [];
      const session = {
        chunks,
        sendAudio: vi.fn((chunk: Buffer) => chunks.push(Buffer.from(chunk))),
        end: vi.fn(),
        updateEndpointing: vi.fn(),
        onResult: vi.fn((handler: (result: Record<string, any>) => void | Promise<void>) => {
          resultHandler = handler;
        }),
        onError: vi.fn((handler: (error: Error) => void) => {
          errorHandler = handler;
        }),
        emitResult: async (result: Record<string, any>) => {
          if (!resultHandler) throw new Error('Voice handler did not bind the deterministic STT result seam');
          await resultHandler(result);
        },
        emitError: (error: Error) => errorHandler?.(error),
      };
      sttHarness.sessions.push(session);
      return session;
    }),
  };
});

vi.mock('../server/llm/providers', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/llm/providers')>();
  return {
    ...actual,
    makeLLMCall: mocks.makeLLMCall,
    makeLLMCallStreaming: mocks.makeLLMCallStreaming,
  };
});

vi.mock('../server/llm/adapter', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/llm/adapter')>();
  return { ...actual, runWithTools: mocks.runWithTools };
});

vi.mock('../server/tts/adapter', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/tts/adapter')>();
  return {
    ...actual,
    getActiveProvider: vi.fn(() => null),
    synthesizeSpeech: vi.fn(async () => {
      throw new Error('S6 isolation must not synthesize audio');
    }),
  };
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

vi.mock('../server/memory/store', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/memory/store')>();
  return {
    ...actual,
    queryMemories: vi.fn(() => []),
    addMemory: vi.fn(),
  };
});

vi.mock('../server/agents/rag', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/agents/rag')>();
  return { ...actual, retrieveChunks: vi.fn(async () => []) };
});

vi.mock('../server/conversation/summary_scheduler', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/conversation/summary_scheduler')>();
  return { ...actual, scheduleConversationSummary: vi.fn() };
});

import { initDatabase, readDB } from '../db_layer';
import { getConversationActionStateByTaskId } from '../server/conversation/action_ledger';
import { getConversationActionTurn } from '../server/conversation/action_turn_ledger';
import { getMessages } from '../server/conversation/manager';
import {
  deviceRegistry,
  nativeClientIdentitySha256,
  normalizeNativeClientIdentity,
} from '../server/devices';
import { saveVoiceprint } from '../server/biometrics/store';
import { registerChatHandler } from '../server/socket/chat';
import { registerDeviceHandlers } from '../server/socket/device';
import { registerVoiceHandlers } from '../server/socket/voice';
import { executeToolCall } from '../server/tools/execution_engine';
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';

function waitForEvent<T>(
  socket: ClientSocket,
  event: string,
  predicate: (payload: T) => boolean = () => true,
  timeoutMs = 12_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timeout);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error('Timed out waiting for isolated state');
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

describe('accepted STT Voice -> Chat task continuity', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const userId = `s6-voice-chat-${suffix}`;
  const captureSessionId = `capture-s6-${suffix}`;
  const executionSessionId = '6'.repeat(64);
  const isolatedDataDir = String(process.env.LUMI_DATA_DIR || '');
  const fixturePath = path.join(isolatedDataDir, `s6-correct-${suffix}.txt`);
  // Keep the intentionally missing target relative. An absolute missing path
  // correctly falls back to the registered native desktop, which would make
  // this isolated server wait for a real desktop-read receipt.
  const missingPath = `s6-missing-${suffix}.txt`;
  const fixtureText = `S6 accepted STT continuity fixture ${suffix}`;
  const voiceText = `请在目录 ${isolatedDataDir} 中查找并读取文件 ${missingPath}，如果找不到就明确告诉我，等我纠正后继续这个任务。`;
  const chatText = `不是那个路径，改成读取 ${fixturePath}，继续刚才的同一个任务。`;
  const chatRequestId = `chat-s6-correction-${suffix}`;
  const nativeClaim = {
    schemaVersion: 1 as const,
    clientKind: 'tauri' as const,
    pid: 46_000 + Math.floor(Math.random() * 1_000),
    startedAtUnixMs: Math.floor(Date.now() / 1_000) * 1_000 - 30_000,
    executablePath: process.platform === 'win32'
      ? `C:\\Program Files\\LumiCore\\s6-${suffix}.exe`
      : `/Applications/LumiCore.app/Contents/MacOS/s6-${suffix}`,
    executableSha256: '6'.repeat(64),
    binaryHashUnavailable: false,
    buildId: '6'.repeat(40),
    buildIdSemantics: 'baseline_commit' as const,
    sourceFingerprint: '7'.repeat(64),
    sourceDirty: false,
    appVersion: '3.1.0',
  };

  let httpServer: HttpServer;
  let io: SocketIOServer;
  let client: ClientSocket;
  let latestVoiceprintEpoch = 0;
  let conversationId = '';
  let voiceRequestId = '';
  let voiceTaskId = '';
  const providerInputs: Array<{
    channel: 'voice' | 'chat';
    messages: any[];
    context?: Record<string, any>;
    options?: Record<string, any>;
    declarations?: any[];
  }> = [];
  const clientEvents: Array<{ event: string; payload: Record<string, any> }> = [];

  beforeAll(async () => {
    await initDatabase();
    fs.writeFileSync(fixturePath, fixtureText, 'utf8');
    if (!toolRegistry.get('read_file')) registerAllTools(toolRegistry);
    saveVoiceprint(userId, {
      voiceprintId: `s6-owner-${suffix}`,
      label: 'S6 isolated owner',
      mfccFeatures: [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]],
      sampleCount: 1,
    });

    mocks.makeLLMCall.mockImplementation(async (_messages: any[], _tools: any[], options: any) => ({
      text: options?.source === 'chat_intent_classifier'
        ? JSON.stringify({ category: 'command', confidence: 0.99, entities: {} })
        : JSON.stringify({ correctsIdentity: false }),
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }));

    let voiceModelIteration = 0;
    mocks.makeLLMCallStreaming.mockImplementation(async (...args: any[]) => {
      voiceModelIteration += 1;
      const [messages, declarations, options, onChunk] = args;
      providerInputs.push({ channel: 'voice', messages, declarations, options });
      if (voiceModelIteration === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: `voice-search-missing-${suffix}`,
              name: 'search_files',
              arguments: { directory: isolatedDataDir, pattern: missingPath },
            },
            {
              id: `voice-read-missing-${suffix}`,
              name: 'read_file',
              arguments: { path: missingPath },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        };
      }
      const text = '我没有找到你指定的文件。请告诉我正确路径，我会接着这个任务继续读取。';
      onChunk?.(text);
      return {
        text,
        toolCalls: [],
        usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
      };
    });

    mocks.runWithTools.mockImplementation(async (...args: any[]) => {
      const messages = args[0] as any[];
      const onToolCall = args[3] as ((record: Record<string, any>) => void) | undefined;
      const context = args[11] as Record<string, any>;
      if (context?.source === 'voice_guard_recovery') {
        return {
          text: '我没有找到你指定的文件。请告诉我正确路径，我会接着这个任务继续读取。',
          toolCalls: [],
          usageRecords: [],
        };
      }
      providerInputs.push({ channel: 'chat', messages, context });
      const searchRecord = await executeToolCall({
        registry: toolRegistry,
        id: `chat-search-correct-${suffix}`,
        name: 'search_files',
        arguments: { directory: isolatedDataDir, pattern: path.basename(fixturePath) },
        context,
      });
      onToolCall?.(searchRecord);
      const readRecord = await executeToolCall({
        registry: toolRegistry,
        id: `chat-read-correct-${suffix}`,
        name: 'read_file',
        arguments: { path: fixturePath },
        context,
      });
      onToolCall?.(readRecord);
      return {
        text: `已经按你的纠正读取了正确文件，内容是：${fixtureText}`,
        toolCalls: [searchRecord, readRecord],
        usageRecords: [],
      };
    });

    const normalizedIdentity = normalizeNativeClientIdentity(nativeClaim);
    expect(normalizedIdentity).not.toBeNull();
    httpServer = createServer();
    io = new SocketIOServer(httpServer, { transports: ['websocket'] });
    io.on('connection', serverSocket => {
      serverSocket.data.authenticatedUserId = userId;
      serverSocket.data.authenticatedRole = 'admin';
      serverSocket.data.authenticatedOrgId = '';
      serverSocket.data.trustedLocalExecution = true;
      serverSocket.data.nativeClientIdentity = normalizedIdentity;
      serverSocket.data.executionSessionId = executionSessionId;
      serverSocket.join(`user:${userId}:personal`);
      registerDeviceHandlers(serverSocket, () => userId, io);
      const llmGetters = {
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
      };
      const sensory = () => ({
        audio: false,
        visual: false,
        spatial: false,
        haptic: false,
        holographic: false,
        activeDeviceTypes: [],
        deviceCount: 0,
      });
      registerVoiceHandlers(serverSocket, llmGetters, sensory, () => userId, io);
      registerChatHandler(serverSocket, llmGetters, sensory, () => userId, io);
    });
    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Unable to bind isolated S6 server');
    client = createSocketClient(`http://127.0.0.1:${address.port}`, {
      transports: ['websocket'],
      auth: { fingerprint: `s6-${suffix}` },
    });
    client.onAny((event, payload) => {
      if (payload && typeof payload === 'object') clientEvents.push({ event, payload });
    });
    client.on('voiceprint:utterance_reset', payload => {
      latestVoiceprintEpoch = Math.max(latestVoiceprintEpoch, Number(payload?.epoch) || 0);
    });
    await waitForEvent(client, 'connect');

    client.emit('device:register', {
      name: 'LumiCore S6 isolated desktop',
      type: 'desktop',
      capabilities: { audio: true },
      osInfo: process.platform,
      nativeClientIdentity: nativeClaim,
    });
    await waitUntil(() => deviceRegistry.getUserDevices(userId).some(device => (
      device.socketId === client.id && device.status === 'online'
    )));
  });

  afterAll(async () => {
    if (client?.connected) {
      const stopped = waitForEvent<Record<string, any>>(
        client,
        'audio:status',
        payload => payload?.status === 'idle',
        5_000,
      ).catch(() => null);
      client.emit('audio:stop');
      await stopped;
    }
    client?.disconnect();
    if (io) await new Promise<void>(resolve => io.close(() => resolve()));
    if (httpServer?.listening) await new Promise<void>(resolve => httpServer.close(() => resolve()));
  });

  it('rejects empty/unverified STT, admits verified STT, then resumes the same task through Chat', async () => {
    const listening = waitForEvent<Record<string, any>>(
      client,
      'audio:status',
      payload => payload?.status === 'listening',
    );
    client.emit('audio:start', {
      agentId: 'lumi',
      domain: 'personal',
      sessionId: captureSessionId,
      captureSessionId,
      audioInputKind: 'physical_microphone',
    });
    await listening;
    await waitUntil(() => sttHarness.sessions.length === 1 && latestVoiceprintEpoch > 0);
    const stt = sttHarness.sessions[0];

    const countUserTurns = () => (readDB().interactions || []).filter((row: any) => (
      row.userId === userId && row.role === 'user'
    )).length;
    const countTasks = () => (readDB().conversationActionTasks || []).filter((row: any) => (
      row.userId === userId
    )).length;
    const countTurns = () => (readDB().conversationActionTurns || []).filter((row: any) => (
      row.userId === userId
    )).length;

    await stt.emitResult({ text: '   ', isFinal: true, speechFinal: true });
    await new Promise(resolve => setTimeout(resolve, 220));
    expect(countUserTurns()).toBe(0);
    expect(countTasks()).toBe(0);
    expect(countTurns()).toBe(0);
    expect(mocks.makeLLMCallStreaming).not.toHaveBeenCalled();

    client.emit('audio:chunk', Buffer.alloc(640, 3));
    client.emit('voiceprint:result', {
      isOwnerSpeaking: true,
      confidence: 0.41,
      quality: 0.92,
      frameCount: 12,
      source: 'local-mfcc',
      utteranceEpoch: latestVoiceprintEpoch,
    });
    await new Promise(resolve => setTimeout(resolve, 40));
    const rejected = waitForEvent<Record<string, any>>(client, 'audio:voice_rejected');
    await stt.emitResult({
      text: `低置信度语音不应被接受 ${suffix}`,
      isFinal: true,
      speechStarted: true,
      speechFinal: true,
    });
    await expect(rejected).resolves.toMatchObject({ reason: 'voiceprint_unverified' });
    expect(countUserTurns()).toBe(0);
    expect(countTasks()).toBe(0);
    expect(countTurns()).toBe(0);
    expect(mocks.makeLLMCallStreaming).not.toHaveBeenCalled();

    await waitUntil(() => latestVoiceprintEpoch >= 2);
    client.emit('audio:chunk', Buffer.alloc(640, 7));
    client.emit('voiceprint:result', {
      isOwnerSpeaking: true,
      confidence: 0.99,
      quality: 0.95,
      frameCount: 16,
      source: 'local-mfcc',
      speakerLabel: 'S6 owner',
      utteranceEpoch: latestVoiceprintEpoch,
    });
    await new Promise(resolve => setTimeout(resolve, 40));
    const voiceTerminal = waitForEvent<Record<string, any>>(
      client,
      'agent:response',
      payload => payload?.channel === 'voice' && payload?.finalized === true,
      20_000,
    );
    await stt.emitResult({
      text: voiceText,
      isFinal: true,
      speechStarted: true,
      speechFinal: true,
    });
    const voiceResponse = await voiceTerminal;
    voiceRequestId = String(voiceResponse.requestId || '');
    conversationId = String(voiceResponse.conversationId || '');
    expect(voiceRequestId).toMatch(/^voice_/u);
    expect(conversationId).toMatch(/^conv_/u);
    expect(String(voiceResponse.text || '')).toMatch(/文件|路径/u);
    expect(String(voiceResponse.text || '')).not.toMatch(/No successful current-turn|persistence_unknown/u);
    expect(clientEvents.some(item => (
      item.event === 'audio:confirm'
      && String(item.payload.text || '').includes(missingPath)
    ))).toBe(true);

    const voiceMessages = getMessages(conversationId);
    const voiceUser = voiceMessages.find((row: any) => (
      row.role === 'user' && row.requestId === voiceRequestId
    ));
    const voiceAssistant = voiceMessages.find((row: any) => (
      row.role === 'assistant' && row.requestId === voiceRequestId
    ));
    expect(voiceUser).toMatchObject({
      source: 'voice',
      channel: 'voice',
      audioInputKind: 'physical_microphone',
      syntheticAudio: false,
      captureSessionId,
      executionSessionId,
    });
    expect(String(voiceUser?.message || '')).toContain(missingPath);
    expect(String(voiceUser?.message || '')).toContain(isolatedDataDir);
    expect(voiceUser?.nativeClientIdentitySha256).toBe(nativeClientIdentitySha256(nativeClaim));
    expect(voiceUser?.contextChainId).toMatch(/^[a-f0-9]{64}$/u);
    expect(voiceUser?.sttReceiptId).toMatch(/^stt_[0-9a-f-]{36}$/u);
    expect(voiceUser?.previousRequestId).toBe('');
    expect(voiceAssistant).toMatchObject({
      source: 'voice',
      channel: 'voice',
      requestId: voiceRequestId,
      contextChainId: voiceUser?.contextChainId,
      captureSessionId,
      sttReceiptId: voiceUser?.sttReceiptId,
    });
    const voiceSearch = (voiceAssistant?.toolCalls || []).find((record: any) => (
      record.name === 'search_files'
    ));
    const failedVoiceRead = (voiceAssistant?.toolCalls || []).find((record: any) => (
      record.name === 'read_file'
    ));
    expect(voiceSearch).toMatchObject({
      requestId: voiceRequestId,
      turnId: voiceRequestId,
      arguments: { directory: isolatedDataDir, pattern: missingPath },
      adapterStarted: true,
      envelope: { status: 'verified_success' },
    });
    expect(voiceSearch?.result).toBe('[]');
    expect(failedVoiceRead).toMatchObject({
      requestId: voiceRequestId,
      turnId: voiceRequestId,
      arguments: { path: missingPath },
    });
    expect(failedVoiceRead?.adapterStarted).not.toBe(true);
    expect(String(failedVoiceRead?.error || '')).toBeTruthy();

    const voiceTask = (readDB().conversationActionTasks || []).find((row: any) => (
      row.userId === userId && row.conversationId === conversationId
    ));
    voiceTaskId = String(voiceTask?.id || '');
    expect(voiceTaskId).toMatch(/^task_/u);
    expect(getConversationActionTurn({ conversationId, userId, requestId: voiceRequestId }))
      .toMatchObject({
        taskId: voiceTaskId,
        requestId: voiceRequestId,
        status: 'terminal',
      });
    expect(getConversationActionStateByTaskId(readDB(), {
      conversationId,
      userId,
      taskId: voiceTaskId,
    })).toMatchObject({ taskId: voiceTaskId, status: 'blocked', unfinished: true });

    const voiceProviderInput = providerInputs.find(input => input.channel === 'voice');
    expect(voiceProviderInput?.declarations?.map((item: any) => item.function?.name))
      .toEqual(expect.arrayContaining(['search_files', 'read_file']));
    expect(voiceProviderInput?.messages?.some((message: any) => (
      message?.role === 'user'
      && String(message.content || '').includes(isolatedDataDir)
      && String(message.content || '').includes(missingPath)
      && /查找|读取/u.test(String(message.content || ''))
    ))).toBe(true);
    expect(voiceProviderInput?.options).toMatchObject({
      requestId: voiceRequestId,
      conversationId,
      captureSessionId,
      contextChainId: voiceUser?.contextChainId,
      sttReceiptId: voiceUser?.sttReceiptId,
      executionSessionId,
    });
    expect(clientEvents.some(item => (
      item.event === 'agent:tool_call'
      && item.payload.requestId === voiceRequestId
      && item.payload.name === 'read_file'
      && Boolean(item.payload.error)
    ))).toBe(true);

    const chatTerminal = waitForEvent<Record<string, any>>(
      client,
      'agent:response',
      payload => payload?.requestId === chatRequestId && payload?.finalized === true,
      20_000,
    );
    const chatAck = await client.timeout(5_000).emitWithAck('agent:chat', {
      text: chatText,
      history: [],
      agentId: 'lumi',
      domain: 'personal',
      source: 'command-center-chat',
      requestId: chatRequestId,
      conversationId,
    });
    expect(chatAck).toMatchObject({ ok: true, requestId: chatRequestId });
    const chatResponse = await chatTerminal;
    expect(chatResponse).toMatchObject({
      requestId: chatRequestId,
      conversationId,
      finalized: true,
    });
    expect(String(chatResponse.text || '')).toContain(fixtureText);
    expect(String(chatResponse.text || '')).not.toMatch(/No successful current-turn|persistence_unknown/u);
    expect(chatResponse.taskRelation).toMatchObject({ taskId: voiceTaskId });

    const chatTurn = getConversationActionTurn({
      conversationId,
      userId,
      requestId: chatRequestId,
    });
    expect(chatTurn).toMatchObject({
      taskId: voiceTaskId,
      requestId: chatRequestId,
      status: 'terminal',
    });
    expect(chatRequestId).not.toBe(voiceRequestId);
    const chatProviderInput = providerInputs.find(input => input.channel === 'chat');
    expect(chatProviderInput?.context).toMatchObject({
      taskId: voiceTaskId,
      requestId: chatRequestId,
      conversationId,
    });
    const rawChatInput = (chatProviderInput?.messages || [])
      .map((message: any) => String(message?.content || ''))
      .join('\n');
    expect(rawChatInput).toContain(missingPath);
    expect(rawChatInput).toContain(path.basename(fixturePath));
    expect(rawChatInput).toContain('read_file');
    expect(rawChatInput).toMatch(/不是那个路径|纠正|继续/u);

    const chatAssistant = getMessages(conversationId).find((row: any) => (
      row.role === 'assistant' && row.requestId === chatRequestId
    ));
    const successfulChatRead = (chatAssistant?.toolCalls || []).find((record: any) => (
      record.name === 'read_file'
    ));
    expect(successfulChatRead).toMatchObject({
      taskId: voiceTaskId,
      requestId: chatRequestId,
      turnId: chatRequestId,
      arguments: { path: fixturePath },
      adapterStarted: true,
      envelope: { status: 'verified_success' },
    });
    expect(successfulChatRead?.result).toBe(fixtureText);

    const completedState = getConversationActionStateByTaskId(readDB(), {
      conversationId,
      userId,
      taskId: voiceTaskId,
    });
    expect(completedState).toMatchObject({
      taskId: voiceTaskId,
      status: 'completed',
      unfinished: false,
      completionSource: 'tool_receipt',
    });
    expect(completedState?.activeRequestId).toBeUndefined();
    expect(completedState?.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'read_file',
        error: expect.any(String),
      }),
      expect.objectContaining({
        name: 'read_file',
        result: fixtureText,
        outcome: 'success',
      }),
    ]));
    const durableTask = (readDB().conversationActionTasks || []).find((row: any) => (
      row.id === voiceTaskId && row.userId === userId && row.conversationId === conversationId
    ));
    expect(durableTask).toMatchObject({
      status: 'completed',
      activeRequestId: '',
      completionSource: 'tool_receipt',
    });
    expect((readDB().conversations || []).find((row: any) => row.id === conversationId)
      ?.pendingActionContinuation).toBeUndefined();
  });
});
