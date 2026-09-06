import './helpers';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';

const mocks = vi.hoisted(() => ({ model: vi.fn(), tools: vi.fn(), stt: [] as any[] }));
vi.mock('../server/llm/providers', async original => ({
  ...await original<typeof import('../server/llm/providers')>(),
  makeLLMCall: mocks.model, makeLLMCallStreaming: mocks.model,
}));
vi.mock('../server/llm/adapter', async original => ({
  ...await original<typeof import('../server/llm/adapter')>(), runWithTools: mocks.tools,
}));
vi.mock('../server/stt/adapter', async original => ({
  ...await original<typeof import('../server/stt/adapter')>(),
  getActiveStreamingSTTProvider: () => 'ark',
  createResilientStreamingSession: () => {
    let onResult: (result: any) => any;
    const session = {
      end: vi.fn(), sendAudio: vi.fn(), updateEndpointing: vi.fn(), onError: vi.fn(),
      onResult: (callback: any) => { onResult = callback; },
      final: (text: string) => onResult({ text, isFinal: true }),
    };
    mocks.stt.push(session);
    return session;
  },
}));
vi.mock('../server/tts/adapter', async original => ({
  ...await original<typeof import('../server/tts/adapter')>(),
  getActiveProvider: () => null,
  synthesizeSpeech: vi.fn(() => { throw new Error('No real TTS in isolated regression'); }),
}));
vi.mock('../server/llm/embedding_provider', async original => ({
  ...await original<typeof import('../server/llm/embedding_provider')>(), generateConfiguredEmbedding: vi.fn(async () => null),
}));
vi.mock('../server/memory', async original => ({
  ...await original<typeof import('../server/memory')>(),
  queryMemories: vi.fn(() => []), queryMemoriesVector: vi.fn(async () => []),
  extractMemories: vi.fn(async () => ({ memories: [], reminders: [] })),
}));
vi.mock('../server/agents/rag', async original => ({
  ...await original<typeof import('../server/agents/rag')>(), retrieveChunks: vi.fn(async () => []),
}));
vi.mock('../server/conversation/summary_scheduler', async original => ({
  ...await original<typeof import('../server/conversation/summary_scheduler')>(), scheduleConversationSummary: vi.fn(),
}));

import { initDatabase, readDB, flushDBOrThrow } from '../db_layer';
import {
  addMessage, addMessageIdempotent, completeConversationActionFromUserObservation,
  getOrCreateActiveConversation, prepareConversationActionExecution, settleConversationActionExecutionRequest,
} from '../server/conversation/manager';
import { getConversationActionStateFromLedger } from '../server/conversation/action_ledger';
import { isUserObservedTaskCompletion } from '../server/cognition/action_continuation';
import { recordsToTaskReceipts } from '../server/cognition/task_execution_ledger';
import type { ToolExecutionRecord } from '../server/tools/types';
import {
  buildTransportNeutralConfirmationScope, getPendingConfirmationDurably, recordPendingConfirmationDurably,
} from '../server/tools/pending_confirmation';
import { registerChatHandler } from '../server/socket/chat';
import { registerVoiceHandlers } from '../server/socket/voice';
import { waitForChatExecutionPersistence } from '../server/socket/chat_execution_registry';

const correction = '你已经打开并播放了，但是你还进行了很多其他操作';
const getter = () => ({});
const llm = Object.fromEntries(['DeepSeek', 'Gemini', 'OpenAI', 'Anthropic', 'Qwen', 'Ollama', 'LmStudio', 'Ark', 'Xiaomi', 'Kimi', 'Glm', 'Relay'].map(name => [`get${name}`, getter]));
const devices = () => ({ audio: false, visual: false, spatial: false, haptic: false, holographic: false, activeDeviceTypes: [], deviceCount: 0 });

function historicalUnverifiedRecords(modern = false): ToolExecutionRecord[] {
  return [{ name: 'computer_use', arguments: { task: '用爱奇艺播放蜡笔小新第一集', maxIterations: 15 },
    result: JSON.stringify({ ok: false, status: 'unverified', completionVerified: false, steps: 15,
      ...(modern
        ? { resumeStrategy: 'observe_only', completionCandidate: '已打开并播放。', lastActions: [] }
        : { lastActions: ['[14/15] click (440,240)', '[15/15] DONE_CANDIDATE: 已打开并播放。'] }),
    }),
    terminalVerification: { status: 'failed', strategy: 'visual', reason: 'Final playback observation could not be verified.' },
  }, { name: 'capture_screen', arguments: {}, result: 'Synthetic screenshot captured.' },
  { name: 'computer_use', arguments: { task: '用爱奇艺播放蜡笔小新第一集', maxIterations: 8 },
    result: 'Tool "computer_use" requires user confirmation and was not approved.',
    terminalVerification: { status: 'failed', strategy: 'terminal_receipt', reason: 'Requires user confirmation.' },
  }];
}

function seed(userId = `observed-playback-${randomUUID()}`, toolCalls?: ToolExecutionRecord[]) {
  const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
  const priorRequest = `playback-${randomUUID()}`;
  addMessage({ userId, agentId: 'lumi', conversationId: conversation.id, role: 'user',
    content: '用爱奇艺播放蜡笔小新第一集', domain: 'personal', requestId: priorRequest });
  addMessage({ userId, agentId: 'lumi', conversationId: conversation.id, role: 'assistant',
    content: '已经打开播放器，播放结果无法确认。', domain: 'personal', requestId: priorRequest,
    toolCalls: toolCalls || [{ name: 'desktop_open', arguments: { target: '爱奇艺' },
      result: JSON.stringify({ ok: true, status: 'verified', target: '爱奇艺', targetMatched: true,
        actualTarget: { processName: 'QyClient.exe', title: '爱奇艺' } }),
      terminalVerification: { status: 'verified', strategy: 'terminal_receipt', reason: 'Player opened only.' },
    }],
  });
  const state = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState!;
  expect(state).toMatchObject({ unfinished: true });
  const scope = buildTransportNeutralConfirmationScope({ domain: 'personal', conversationId: conversation.id, taskId: state.taskId });
  return { userId, conversationId: conversation.id, priorRequest, state, scope };
}

beforeAll(async () => {
  await initDatabase();
  mocks.model.mockResolvedValue({ text: '请说明你当前看到的播放状态。', toolCalls: [] });
  mocks.tools.mockImplementation(() => { throw new Error('User completion must not execute more tools'); });
});
afterAll(async () => { await waitForChatExecutionPersistence(); });

describe('user-observed playback completion recognition', () => {
  it.each([
    correction, '你已经打开并播放了。', '现在已经开始播放了', '我看到视频正在播放。',
    '你已经打开并播放了，但是你还进行了那么多其他操作',
    '你已经播放了，但是你没停下来', 'You already opened and played it, but kept clicking.',
  ])('accepts an explicit visible playback report: %s', text => {
    expect(isUserObservedTaskCompletion(text, seed().state)).toBe(true);
  });

  it.each([
    '你已经打开了', '只是打开了没有播放', '没有播放', '还没播放', '你没打开并播放了',
    '如果播放了就好了', '你已经播放了吗', '你播放了吗？', '你是不是已经打开并播放了',
    '要是你已经播放了就不要再点', '你已经播放了，但是现在暂停了',
    '你已经播放了，但是没有声音', '你已经播放了，再播放下一集',
    '你说你已经播放了', '你以为你已经播放了', '好像已经播放了', '你已经播放了，但是不是我要的那集',
    'You opened it but did not play it.',
  ])('does not accept a question, denial, partial result or new command: %s', text => {
    expect(isUserObservedTaskCompletion(text, seed().state)).toBe(false);
  });

  it('requires an unfinished media task with an actuation attempt', () => {
    const { state } = seed();
    expect(isUserObservedTaskCompletion(correction, { ...state, unfinished: false, status: 'completed' })).toBe(false);
    expect(isUserObservedTaskCompletion(correction, { ...state, receipts: [] })).toBe(false);
    expect(isUserObservedTaskCompletion(correction, { ...state, receipts: state.receipts!.map(receipt => ({ ...receipt, name: 'desktop_snapshot' })) })).toBe(false);
    expect(isUserObservedTaskCompletion(correction, { ...state, goal: '打开 WPS 并创建文档' })).toBe(false);
  });

  it.each([false, true])('retains performed actions despite failed final verification (modern=%s)', modern => {
    const { state } = seed(undefined, historicalUnverifiedRecords(modern));
    expect(state.receipts!.find(receipt => receipt.name === 'computer_use')).toMatchObject({ outcome: 'failure', terminalVerification: { status: 'failed' } });
    expect(isUserObservedTaskCompletion(correction, state)).toBe(true);
  });

  it.each([
    { status: 'requires_confirmation', steps: 15 },
    { status: 'unverified', steps: 0 },
    { status: 'unverified', steps: -1 },
    { status: 'unverified', steps: 2.5 },
    { status: 'unverified', steps: 15, lastActions: [], resumeStrategy: undefined },
    { status: 'unverified', steps: 0, resumeStrategy: 'observe_only', completionCandidate: 'Unstarted' },
  ])('rejects denied, unstarted, or non-candidate failures: %j', overrides => {
    const { state } = seed();
    const record = historicalUnverifiedRecords()[0];
    record.result = JSON.stringify({ ...JSON.parse(record.result!), ...overrides });
    expect(isUserObservedTaskCompletion(correction, { ...state, receipts: recordsToTaskReceipts([record]) })).toBe(false);
  });

  it('does not accept a confirmation-blocked call even if it carries candidate-like metadata', () => {
    const { state } = seed();
    const record = historicalUnverifiedRecords()[0];
    record.error = 'Requires user confirmation and was not approved.';
    expect(isUserObservedTaskCompletion(correction, { ...state, receipts: recordsToTaskReceipts([record]) })).toBe(false);
  });

  it('fences user, conversation, task and accepted request without rewriting machine receipts', () => {
    const fixture = seed();
    const requestId = `observed-${randomUUID()}`;
    const userMessageId = addMessageIdempotent({ userId: fixture.userId, agentId: 'lumi', conversationId: fixture.conversationId,
      role: 'user', content: correction, requestId, domain: 'personal', deferActionPreparation: true });
    const ownership = { taskId: fixture.state.taskId!, requestId, userMessageId };
    for (const wrong of [{ ...ownership, taskId: 'another-task' }, { ...ownership, requestId: 'another-request' }, { ...ownership, userMessageId: 'another-message' }]) {
      expect(completeConversationActionFromUserObservation(fixture.conversationId, fixture.userId, correction, wrong)).toBeNull();
    }
    expect(completeConversationActionFromUserObservation(fixture.conversationId, 'another-user', correction, ownership)).toBeNull();
    expect(completeConversationActionFromUserObservation('another-conversation', fixture.userId, correction, ownership)).toBeNull();
    const completed = completeConversationActionFromUserObservation(fixture.conversationId, fixture.userId, correction, ownership);
    expect(completed).toMatchObject({ taskId: fixture.state.taskId, status: 'completed', completionSource: 'user_observation' });
    expect(completed!.receipts).toEqual(fixture.state.receipts);
  });

  it('keeps a fresh exact-task OCR completion after persistence and request release', () => {
    const fixture = seed();
    const requestId = `playback-observe-${randomUUID()}`;
    const userMessageId = addMessageIdempotent({ userId: fixture.userId, agentId: 'lumi', conversationId: fixture.conversationId,
      role: 'user', content: '继续', requestId, domain: 'personal', deferActionPreparation: true });
    const prepared = prepareConversationActionExecution({ conversationId: fixture.conversationId, userId: fixture.userId,
      userText: '继续', requestId, userMessageId, forceTask: true, forceResume: true,
      toolPolicy: { allowedTools: ['ocr_screen'], requireConfirmation: [], forbiddenTools: [], maxIterations: 1 },
    });
    expect(prepared.state?.taskId).toBe(fixture.state.taskId);
    addMessageIdempotent({ userId: fixture.userId, agentId: 'lumi', conversationId: fixture.conversationId,
      role: 'assistant', content: '已确认当前在爱奇艺播放蜡笔小新第一集。', domain: 'personal', requestId,
      toolCalls: [{ id: `ocr-${randomUUID()}`, name: 'ocr_screen', arguments: { query: '确认当前播放器、节目、集数和播放状态' },
        result: '当前窗口是爱奇艺播放器。正在播放蜡笔小新第一集，正片进度 00:37 / 23:58。',
        requestId, taskId: fixture.state.taskId,
        terminalVerification: { status: 'verified', strategy: 'visual', reason: 'Synthetic current OCR observation.' },
      }],
    });
    settleConversationActionExecutionRequest(fixture.conversationId, fixture.userId, requestId);
    const completed = getConversationActionStateFromLedger(readDB(), { userId: fixture.userId, conversationId: fixture.conversationId });
    expect(completed).toMatchObject({ taskId: fixture.state.taskId, status: 'completed', completionSource: 'tool_receipt' });
    expect(completed!.receipts!.at(-1)).toMatchObject({ requestId, taskId: fixture.state.taskId, name: 'ocr_screen' });
    expect(getOrCreateActiveConversation(fixture.userId, 'lumi', 'personal', '').actionContinuationState).toBeUndefined();
  });
});

describe('actual chat transport and terminal persistence', () => {
  it.each(['opened', 'historical_unverified', 'observe_only'])('%s: records user observation, clears only its pending retry and never calls tools or model', async variant => {
    const fixture = seed(undefined, variant === 'opened' ? undefined : historicalUnverifiedRecords(variant === 'observe_only'));
    await recordPendingConfirmationDurably(fixture.userId, 'desktop_open', { target: '爱奇艺' }, 'chat', { ...fixture.scope, actionIntent: fixture.state.goal });
    const otherScope = { ...fixture.scope, taskId: 'unrelated-task' };
    await recordPendingConfirmationDurably(fixture.userId, 'desktop_open', { target: 'WPS' }, 'chat', { ...otherScope, actionIntent: '打开 WPS' });
    const http = createServer();
    const io = new Server(http, { transports: ['websocket'] });
    io.on('connection', socket => {
      socket.data.authenticatedUserId = fixture.userId;
      socket.data.authenticatedRole = 'admin';
      socket.data.trustedLocalExecution = true;
      socket.join(`user:${fixture.userId}:personal`);
      registerChatHandler(socket, llm as any, devices, () => fixture.userId, io);
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('No isolated port');
    const client = connect(`http://127.0.0.1:${address.port}`, { transports: ['websocket'] });
    try {
      await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
      const requestId = `feedback-${randomUUID()}`;
      const modelCalls = mocks.model.mock.calls.length;
      const toolCalls = mocks.tools.mock.calls.length;
      const result = new Promise<any>(resolve => client.on('agent:response', data => { if (data.requestId === requestId && data.finalized) resolve(data); }));
      expect(await client.timeout(5000).emitWithAck('agent:chat', { text: correction, requestId,
        conversationId: fixture.conversationId, agentId: 'lumi', domain: 'personal', source: 'command-center-chat' })).toMatchObject({ ok: true });
      const response = await result;
      expect(response).toMatchObject({ finalized: true, blocked: false, reason: 'task_user_observation' });
      expect(response.text).toContain('以你看到的桌面结果为准');
      expect(mocks.tools.mock.calls).toHaveLength(toolCalls);
      expect(mocks.model.mock.calls).toHaveLength(modelCalls);
      await flushDBOrThrow();
      expect(await getPendingConfirmationDurably(fixture.userId, fixture.scope)).toBeNull();
      expect(await getPendingConfirmationDurably(fixture.userId, otherScope)).not.toBeNull();
      expect(getOrCreateActiveConversation(fixture.userId, 'lumi', 'personal', '').actionContinuationState).toBeUndefined();
      const completed = getConversationActionStateFromLedger(readDB(), { userId: fixture.userId, conversationId: fixture.conversationId });
      expect(completed).toMatchObject({ taskId: fixture.state.taskId, status: 'completed', completionSource: 'user_observation' });
      expect(completed!.receipts).toEqual(fixture.state.receipts);
      const task = readDB().conversationActionTasks.find((row: any) => row.id === fixture.state.taskId);
      expect(JSON.parse(task!.context).taskFinalization.requestId).toBe(requestId);
      const assistant = readDB().interactions.find((row: any) => row.userId === fixture.userId && row.requestId === requestId && row.role === 'assistant');
      expect(assistant).toMatchObject({ cognitiveIntent: 'task_user_observation', llmWasCalled: false });
    } finally {
      client.disconnect();
      await new Promise<void>(resolve => io.close(() => resolve()));
    }
  }, 15000);
});

class VoiceSocket extends EventEmitter {
  connected = true;
  id = `observation-voice-${randomUUID()}`;
  data: any;
  handshake = { address: '127.0.0.1', headers: {}, auth: {} };
  outputs: Array<[string, any]> = [];
  constructor(userId: string) { super(); this.data = { authenticatedUserId: userId, authenticatedRole: 'admin', trustedLocalExecution: true }; }
  emit(event: string, data?: any) { this.outputs.push([event, data]); return true; }
  async receive(event: string, data?: any) { await Promise.all(this.listeners(event).map(listener => listener(data))); }
}

describe('actual accepted STT transcript to voice terminal', () => {
  it('completes from the user report with no retry and releases the foreground voice lane', async () => {
    const fixture = seed(undefined, historicalUnverifiedRecords());
    await recordPendingConfirmationDurably(fixture.userId, 'desktop_open', { target: '爱奇艺' }, 'voice', { ...fixture.scope, actionIntent: fixture.state.goal });
    const socket = new VoiceSocket(fixture.userId);
    const io = { to: () => ({ emit: (event: string, data: any) => socket.emit(event, data) }), emit: (event: string, data: any) => socket.emit(event, data) };
    registerVoiceHandlers(socket as any, llm as any, devices, () => fixture.userId, io as any);
    const toolCalls = mocks.tools.mock.calls.length;
    try {
      const sessionId = `synthetic-mic-${randomUUID()}`;
      await socket.receive('audio:start', { sessionId, captureSessionId: sessionId, audioInputKind: 'physical_microphone' });
      await mocks.stt.at(-1).final(correction);
      await vi.waitFor(() => expect(socket.outputs.some(([event, data]) => event === 'agent:response' && data.finalized)).toBe(true), { timeout: 10000 });
      const terminal = socket.outputs.filter(([event, data]) => event === 'agent:response' && data.finalized).at(-1)![1];
      expect(terminal).toMatchObject({ blocked: false, source: 'voice_task_user_observation' });
      expect(terminal.text).toContain('以你看到的桌面结果为准');
      expect(mocks.tools.mock.calls).toHaveLength(toolCalls);
      await vi.waitFor(() => expect(socket.data.audioSession.isProcessing).toBe(false));
      await flushDBOrThrow();
      expect(await getPendingConfirmationDurably(fixture.userId, fixture.scope)).toBeNull();
      expect(getOrCreateActiveConversation(fixture.userId, 'lumi', 'personal', '').actionContinuationState).toBeUndefined();
      const completed = getConversationActionStateFromLedger(readDB(), { userId: fixture.userId, conversationId: fixture.conversationId });
      expect(completed).toMatchObject({ taskId: fixture.state.taskId, status: 'completed', completionSource: 'user_observation' });
      expect(completed!.receipts).toEqual(fixture.state.receipts);
    } finally { await socket.receive('audio:stop'); }
  }, 15000);
});
