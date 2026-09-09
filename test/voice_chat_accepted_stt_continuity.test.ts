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
  // Observe the transport handoff without replacing any loop decisions,
  // tool execution, replay protection, cancellation, or completion policy.
  mocks.runWithTools.mockImplementation(actual.runWithTools);
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

import { initDatabase, readDB, querySQL } from '../db_layer';
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
import { registerAllTools } from '../server/tools/definitions';
import { toolRegistry } from '../server/tools/registry';
import { getPendingConfirmation, clearAllPendingConfirmationsForTests } from '../server/tools/pending_confirmation';

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

    mocks.makeLLMCall.mockImplementation(async (messages: any[], declarations: any[], options: any) => {
      if (declarations.length && mocks.runWithTools.mock.calls.length) {
        return mocks.makeLLMCallStreaming(messages, declarations, options, undefined);
      }
      return {
        text: options?.source === 'chat_intent_classifier'
          ? JSON.stringify({ category: 'command', confidence: 0.99, entities: {} })
          : JSON.stringify({ correctsIdentity: false }),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    });

    const modelIterations = new Map<string, number>();
    mocks.makeLLMCallStreaming.mockImplementation(async (...args: any[]) => {
      const [messages, declarations, options, onChunk] = args;
      const context = mocks.runWithTools.mock.calls.at(-1)?.[11] as Record<string, any>;
      const channel = String(context?.source || '').startsWith('voice') ? 'voice' : 'chat';
      const iterationKey = `${channel}:${context?.requestId}`;
      const iteration = (modelIterations.get(iterationKey) || 0) + 1;
      modelIterations.set(iterationKey, iteration);
      providerInputs.push({ channel, messages, declarations, options, context });
      if (iteration === 1) {
        const targetPath = channel === 'voice' ? missingPath : fixturePath;
        return {
          text: '',
          toolCalls: [
            {
              id: `${channel}-search-${suffix}`,
              name: 'search_files',
              arguments: { directory: isolatedDataDir, pattern: path.basename(targetPath) },
            },
            {
              id: `${channel}-read-${suffix}`,
              name: 'read_file',
              arguments: { path: targetPath },
            },
          ],
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
        };
      }
      const text = channel === 'voice'
        ? '我没有找到你指定的文件。请告诉我正确路径，我会接着这个任务继续读取。'
        : `已经按你的纠正读取了正确文件，内容是：${fixtureText}`;
      onChunk?.(text);
      return {
        text,
        toolCalls: [],
        usage: { promptTokens: 12, completionTokens: 8, totalTokens: 20 },
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
    expect(JSON.parse(String(voiceSearch?.result || '{}'))).toMatchObject({
      kind: 'desktop_files_summary',
      originalCount: 0,
      truncated: false,
      entries: [],
    });
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
    const blockedVoiceState = getConversationActionStateByTaskId(readDB(), {
      conversationId,
      userId,
      taskId: voiceTaskId,
    });
    expect(blockedVoiceState).toMatchObject({ taskId: voiceTaskId, status: 'blocked', unfinished: true });
    expect(blockedVoiceState?.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'read_file', arguments: { path: missingPath }, error: expect.any(String) }),
    ]));

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
    expect(chatProviderInput?.context?.priorToolRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'read_file', arguments: { path: missingPath }, error: expect.any(String) }),
    ]));
    expect(mocks.runWithTools.mock.calls.map(call => call[11]?.source)).toEqual(expect.arrayContaining(['voice', 'chat']));
    expect(chatProviderInput?.declarations?.map((item: any) => item.function?.name))
      .toEqual(expect.arrayContaining(['search_files', 'read_file']));
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

  it('keeps a second confirmation waiting after a voice-approved first write executes through the shared loop', async () => {
    const firstPath = path.join(isolatedDataDir, `s6-confirm-first-${suffix}.txt`);
    const secondPath = path.join(isolatedDataDir, `s6-confirm-second-${suffix}.txt`);
    const firstArgs = { path: firstPath, content: `first confirmed ${suffix}` };
    const secondArgs = { path: secondPath, content: `second pending ${suffix}` };
    const proposalText = `请用 write_file 创建两个文件：${firstPath} 内容为 ${firstArgs.content}；${secondPath} 内容为 ${secondArgs.content}。必须先等待我确认才能写第一份，写第二份前也必须等待我确认，不得自行确认。`;
    mocks.runWithTools.mockClear();
    mocks.makeLLMCallStreaming.mockImplementation(async (...args: any[]) => {
      const context = mocks.runWithTools.mock.calls.at(-1)?.[11];
      const alreadyWroteFirst = context?.priorToolRecords?.some((record: any) => (
        record.name === 'write_file' && record.arguments?.path === firstPath && record.adapterStarted === true && !record.error
      ));
      return {
        text: '',
        toolCalls: alreadyWroteFirst
          ? [{ id: `second-pending-${suffix}`, name: 'write_file', arguments: secondArgs }]
          : [
              { id: `first-pending-${suffix}`, name: 'write_file', arguments: firstArgs },
              { id: `second-must-not-start-${suffix}`, name: 'write_file', arguments: secondArgs },
            ],
        usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
      };
    });
    let precedingVoiceRequest = voiceRequestId;
    const speak = async (text: string) => {
      const terminal = waitForEvent<Record<string, any>>(
        client, 'agent:response',
        payload => payload?.channel === 'voice' && payload.finalized === true && payload.requestId !== precedingVoiceRequest,
        20_000,
      );
      client.emit('audio:chunk', Buffer.alloc(640, 7));
      client.emit('voiceprint:result', {
        isOwnerSpeaking: true, confidence: 0.99, quality: 0.95, frameCount: 16,
        source: 'local-mfcc', speakerLabel: 'S6 owner', utteranceEpoch: latestVoiceprintEpoch,
      });
      await new Promise(resolve => setTimeout(resolve, 40));
      await sttHarness.sessions[0].emitResult({ text, isFinal: true, speechStarted: true, speechFinal: true });
      const result = await terminal;
      precedingVoiceRequest = result.requestId;
      return result;
    };
    const firstTerminal = await speak(proposalText);
    expect(firstTerminal).toMatchObject({ reason: 'waiting_confirmation', blocked: false });
    const firstPending = getPendingConfirmation(userId);
    expect(firstPending).toMatchObject({ toolName: 'write_file', exactArgs: firstArgs });
    expect(fs.existsSync(firstPath)).toBe(false);
    expect(fs.existsSync(secondPath)).toBe(false);

    const secondTerminal = await speak('确认');
    expect(secondTerminal).toMatchObject({
      conversationId: firstTerminal.conversationId,
      reason: 'waiting_confirmation', blocked: false, finalized: true,
    });
    const secondPending = getPendingConfirmation(userId);
    expect(secondPending).toMatchObject({
      toolName: 'write_file', exactArgs: secondArgs, taskId: firstPending?.taskId,
    });
    expect(secondPending?.id).not.toBe(firstPending?.id);
    expect(fs.readFileSync(firstPath, 'utf8')).toBe(firstArgs.content);
    expect(fs.existsSync(secondPath)).toBe(false);
    expect(getConversationActionStateByTaskId(readDB(), {
      conversationId: firstTerminal.conversationId, userId, taskId: firstPending!.taskId!,
    })).toMatchObject({ status: 'waiting_confirmation', unfinished: true });
    const assistant = getMessages(firstTerminal.conversationId).find((row: any) => (
      row.role === 'assistant' && row.requestId === secondTerminal.requestId
    ));
    expect(assistant?.message).toBe(secondTerminal.text);
    expect(mocks.runWithTools.mock.calls.length).toBe(2);
    expect(mocks.runWithTools.mock.calls[1][11].priorToolRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'write_file', arguments: firstArgs, adapterStarted: true }),
    ]));
  }, 30_000);

  it.each([false, true])('completes an exact voice-confirmed write with required readback=%s through the same bounded finalizer', async readbackRequired => {
    clearAllPendingConfirmationsForTests();
    const target = path.join(isolatedDataDir, `voice-bounded-${readbackRequired}-${suffix}.txt`);
    const content = `LC voice bounded ${suffix}`;
    const task = `在 ${target} 新建文本文件，只写入“${content}”。先等待我确认才能写入，不得自行确认。${readbackRequired ? '写完回读并告诉我全文。' : ''}`;
    mocks.runWithTools.mockClear();
    mocks.makeLLMCallStreaming.mockClear();
    mocks.makeLLMCallStreaming.mockImplementation(async () => {
      const context = mocks.runWithTools.mock.calls.at(-1)?.[11];
      const written = context?.priorToolRecords?.some((record: any) => record.name === 'write_file'
        && record.arguments?.path === target && record.terminalVerification?.status === 'verified');
      return {
        text: '', toolCalls: [{ id: `voice-bounded-call-${written ? 'read' : 'write'}-${suffix}`,
          name: written ? 'read_file' : 'write_file', arguments: written ? { path: target } : { path: target, content } }],
        usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
      };
    });
    const speak = async (text: string) => {
      const terminal = waitForEvent<Record<string, any>>(client, 'agent:response',
        payload => payload?.channel === 'voice' && payload.finalized === true, 20_000);
      client.emit('audio:chunk', Buffer.alloc(640, 7));
      client.emit('voiceprint:result', { isOwnerSpeaking: true, confidence: 0.99, quality: 0.95,
        frameCount: 16, source: 'local-mfcc', utteranceEpoch: latestVoiceprintEpoch });
      await new Promise(resolve => setTimeout(resolve, 40));
      await sttHarness.sessions[0].emitResult({ text, isFinal: true, speechStarted: true, speechFinal: true });
      return terminal;
    };
    const proposal = await speak(task);
    expect(proposal).toMatchObject({ reason: 'waiting_confirmation', blocked: false });
    const pending = getPendingConfirmation(userId);
    expect(pending).toMatchObject({ toolName: 'write_file', exactArgs: { path: target, content } });
    expect(fs.existsSync(target)).toBe(false);
    const result = await speak('确认');
    expect(result).toMatchObject({ blocked: false, finalized: true });
    expect(result.text).toContain(target);
    if (readbackRequired) expect(result.text).toContain(content);
    expect(fs.readFileSync(target, 'utf8')).toBe(content);
    expect(getPendingConfirmation(userId)).toBeNull();
    expect(mocks.runWithTools).toHaveBeenCalledTimes(readbackRequired ? 2 : 1);
    expect(mocks.makeLLMCallStreaming).toHaveBeenCalledTimes(readbackRequired ? 2 : 1);
    const receipts = await querySQL('SELECT toolName,outcome FROM conversation_action_receipts WHERE requestId=?', [result.requestId]);
    expect(receipts).toEqual(expect.arrayContaining([expect.objectContaining({ toolName: 'write_file', outcome: 'verified_success' })]));
    if (readbackRequired) expect(receipts).toEqual(expect.arrayContaining([expect.objectContaining({ toolName: 'read_file', outcome: 'verified_success' })]));
    expect(getConversationActionStateByTaskId(readDB(), { conversationId: proposal.conversationId, userId, taskId: pending!.taskId! }))
      .toMatchObject({ status: 'completed', unfinished: false });
  }, 30_000);

  it.each(['success', 'failure', 'unsettled'])('persists a voice-confirmed tool that settles as %s after duplicate cancellation', async outcome => {
    clearAllPendingConfirmationsForTests();
    const target = path.join(isolatedDataDir, `voice-late-${outcome}-${suffix}.txt`);
    const content = `LC late voice ${outcome}`;
    const original = toolRegistry.get('write_file')!;
    let started!: () => void;
    const handlerStarted = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const handlerReleased = new Promise<void>(resolve => { release = resolve; });
    let activeRequestId = '';
    let abortObserved = false;
    toolRegistry.unregister('write_file');
    toolRegistry.register({ ...original, handler: async (args, context) => {
      if (args.path !== target) return original.handler(args, context);
      activeRequestId = context?.requestId || '';
      context?.executionSignal?.addEventListener('abort', () => { abortObserved = true; }, { once: true });
      started();
      await handlerReleased;
      if (outcome === 'failure') throw new Error('isolated voice late failure');
      return original.handler(args, context);
    } });
    mocks.runWithTools.mockClear();
    mocks.makeLLMCallStreaming.mockClear();
    mocks.makeLLMCallStreaming.mockResolvedValue({ text: '', toolCalls: [{ id: `late-${outcome}-${suffix}`,
      name: 'write_file', arguments: { path: target, content } }], usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 } });
    const speak = async (text: string) => {
      const terminal = waitForEvent<Record<string, any>>(client, 'agent:response',
        payload => payload?.channel === 'voice' && payload.finalized === true, 20_000);
      client.emit('audio:chunk', Buffer.alloc(640, 7));
      client.emit('voiceprint:result', { isOwnerSpeaking: true, confidence: 0.99, quality: 0.95,
        frameCount: 16, source: 'local-mfcc', utteranceEpoch: latestVoiceprintEpoch });
      await new Promise(resolve => setTimeout(resolve, 40));
      await sttHarness.sessions[0].emitResult({ text, isFinal: true, speechStarted: true, speechFinal: true });
      return terminal;
    };
    try {
      const proposal = await speak(`在 ${target} 新建文件，只写入“${content}”。先等待我确认才能写入，不得自行确认。`);
      expect(proposal.reason).toBe('waiting_confirmation');
      const pending = getPendingConfirmation(userId)!;
      const cancelledTerminal = speak('确认');
      await Promise.race([handlerStarted, cancelledTerminal.then(value => { throw new Error(`Ended before tool entry: ${JSON.stringify(value)}`); })]);
      expect(activeRequestId).toBeTruthy();
      client.emit('audio:cancel_turn', { requestId: activeRequestId, reason: 'user_cancelled' });
      client.emit('audio:cancel_turn', { requestId: activeRequestId, reason: 'user_cancelled' });
      await waitUntil(() => abortObserved);
      // The already started handler owns its real result; cancellation waits
      // for it and prevents the model/next tool from running afterwards.
      expect((await querySQL('SELECT id FROM interactions WHERE requestId=? AND role=?', [activeRequestId, 'assistant']))).toHaveLength(0);
      if (outcome !== 'unsettled') release();
      const result = await cancelledTerminal;
      expect(result.reason).toBe(outcome === 'unsettled' ? 'execution_settlement_unknown' : 'cancelled');
      if (outcome === 'unsettled') {
        expect(getConversationActionStateByTaskId(readDB(), { conversationId: proposal.conversationId, userId, taskId: pending.taskId! }))
          .toMatchObject({ status: 'blocked' });
        release();
        await waitUntil(() => (readDB().conversationActionReceipts || []).some((row: any) => row.requestId === activeRequestId && row.outcome === 'verified_success'));
      }
      await waitUntil(() => getMessages(proposal.conversationId).some((row: any) => row.role === 'assistant' && row.requestId === activeRequestId));
      const receipts = await querySQL('SELECT toolName,outcome FROM conversation_action_receipts WHERE requestId=?', [activeRequestId]);
      if (outcome === 'unsettled') {
        expect(receipts).toEqual(expect.arrayContaining([expect.objectContaining({ toolName: 'write_file', outcome: 'verified_success' })]));
      } else {
        expect(receipts).toEqual([expect.objectContaining({ toolName: 'write_file', outcome: outcome === 'success' ? 'verified_success' : 'failed' })]);
      }
      expect(await querySQL('SELECT id FROM interactions WHERE requestId=? AND role=?', [activeRequestId, 'assistant'])).toHaveLength(1);
      expect(getConversationActionStateByTaskId(readDB(), { conversationId: proposal.conversationId, userId, taskId: pending.taskId! }))
        .toMatchObject(outcome === 'unsettled' ? { status: 'blocked' } : { status: 'cancelled', unfinished: false });
      if (outcome !== 'unsettled') expect(getConversationActionTurn({ conversationId: proposal.conversationId, userId, requestId: activeRequestId }))
        .toMatchObject({ status: 'cancelled' });
      expect(mocks.runWithTools).toHaveBeenCalledTimes(1);
      if (outcome !== 'failure') expect(fs.readFileSync(target, 'utf8')).toBe(content);
      else expect(fs.existsSync(target)).toBe(false);
    } finally {
      release();
      toolRegistry.unregister('write_file');
      toolRegistry.register(original);
    }
  }, 30_000);
  it('routes an explicit forget request through durable memory storage before any tool loop', async () => {
    const store = await import('../server/memory/store');
    const actual = await vi.importActual<typeof store>('../server/memory/store');
    const beforeQuery = vi.mocked(store.queryMemories).getMockImplementation();
    const beforeCall = mocks.makeLLMCall.getMockImplementation();
    const target = actual.addMemory({ userId, type: 'fact', content: 'The violet index fixture belongs on shelf 2.',
      keywords: ['violet index fixture'], confidence: 1, sourceInteractionId: 'memory-routing-fixture' },
      { source: 'manual', perspective: 'shared_memory', generateEmbedding: false, deduplicate: false });
    const requestId = `chat-memory-forget-${suffix}`;
    const text = 'Forget the violet index fixture and delete its stored memory.';
    vi.mocked(store.queryMemories).mockImplementation(actual.queryMemories);
    mocks.makeLLMCall.mockImplementation(async (...args: any[]) => {
      if (args[2]?.source === 'memory_turn') return { text: JSON.stringify({ changes: [{ operation: 'forget',
        targetId: target.id, evidence: 'Forget the violet index fixture' }] }) };
      return beforeCall?.(...args);
    });
    const toolsBefore = mocks.runWithTools.mock.calls.length;
    try {
      const terminal = waitForEvent<Record<string, any>>(client, 'agent:response', p => p.requestId === requestId && p.finalized, 15000);
      expect(await client.timeout(5000).emitWithAck('agent:chat', { text, history: [], agentId: 'lumi',
        domain: 'personal', source: 'command-center-chat', requestId })).toMatchObject({ ok: true });
      expect(await terminal).toMatchObject({ blocked: false, reason: 'memory_saved' });
      expect(mocks.runWithTools).toHaveBeenCalledTimes(toolsBefore);
      expect(await querySQL('SELECT id FROM memories WHERE id=?', [target.id])).toEqual([]);
      expect(await querySQL('SELECT id FROM interactions WHERE requestId=? AND role=?', [requestId, 'assistant'])).toHaveLength(1);
    } finally {
      vi.mocked(store.queryMemories).mockImplementation(beforeQuery!);
      mocks.makeLLMCall.mockImplementation(beforeCall!);
    }
  }, 20000);

  it('routes accepted voice memory deletion to the same durable service without a tool loop', async () => {
    clearAllPendingConfirmationsForTests();
    const store = await import('../server/memory/store');
    const actual = await vi.importActual<typeof store>('../server/memory/store');
    const beforeQuery = vi.mocked(store.queryMemories).getMockImplementation();
    const beforeCall = mocks.makeLLMCall.getMockImplementation();
    const target = actual.addMemory({ userId, type: 'fact', content: 'The orange memory fixture belongs on shelf 3.',
      keywords: ['orange memory fixture'], confidence: 1, sourceInteractionId: 'voice-memory-routing-fixture' },
      { source: 'manual', perspective: 'shared_memory', generateEmbedding: false, deduplicate: false });
    vi.mocked(store.queryMemories).mockImplementation(actual.queryMemories);
    mocks.makeLLMCall.mockImplementation(async (...args: any[]) => args[2]?.source === 'memory_turn'
      ? { text: JSON.stringify({ changes: [{ operation: 'forget', targetId: target.id, evidence: 'Forget the orange memory fixture' }] }) }
      : beforeCall?.(...args));
    const toolsBefore = mocks.runWithTools.mock.calls.length;
    try {
      client.emit('audio:chunk', Buffer.alloc(640, 7));
      client.emit('voiceprint:result', { isOwnerSpeaking: true, confidence: 0.99, quality: 0.95,
        frameCount: 16, source: 'local-mfcc', utteranceEpoch: latestVoiceprintEpoch });
      await new Promise(resolve => setTimeout(resolve, 40));
      const terminal = waitForEvent<Record<string, any>>(client, 'agent:response', p => p.channel === 'voice' && p.finalized, 15000);
      await sttHarness.sessions[0].emitResult({ text: 'Forget the orange memory fixture and delete its stored memory.', isFinal: true, speechStarted: true, speechFinal: true });
      const response = await terminal;
      expect(response).toMatchObject({ blocked: false, reason: 'memory_saved' });
      expect(mocks.runWithTools).toHaveBeenCalledTimes(toolsBefore);
      expect(await querySQL('SELECT id FROM memories WHERE id=?', [target.id])).toEqual([]);
      expect(await querySQL('SELECT id FROM interactions WHERE requestId=? AND role=?', [response.requestId, 'assistant'])).toHaveLength(1);
    } finally {
      vi.mocked(store.queryMemories).mockImplementation(beforeQuery!);
      mocks.makeLLMCall.mockImplementation(beforeCall!);
    }
  }, 20000);

});
