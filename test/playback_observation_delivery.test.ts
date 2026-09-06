import './helpers';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ model: vi.fn(), stream: vi.fn(), control: vi.fn(), synthesis: vi.fn(), stts: [] as any[] }));
vi.mock('../server/llm/providers', async original => ({
  ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: fixture.model, makeLLMCallStreaming: fixture.stream,
}));
vi.mock('../server/agents/computer_use', () => ({ computerUseLoop: fixture.control }));
vi.mock('../server/stt/adapter', async original => ({
  ...await original<typeof import('../server/stt/adapter')>(),
  getActiveStreamingSTTProvider: () => 'ark',
  createResilientStreamingSession: () => {
    let onResult: (result: any) => any;
    const session = { end: vi.fn(), sendAudio: vi.fn(), updateEndpointing: vi.fn(), onError: vi.fn(),
      onResult: (callback: any) => { onResult = callback; }, final: (text: string) => onResult({ text, isFinal: true }) };
    fixture.stts.push(session); return session;
  },
}));
vi.mock('../server/tts/adapter', async original => ({
  ...await original<typeof import('../server/tts/adapter')>(), getActiveProvider: () => 'ark',
  listVoices: async () => [{ voiceId: 'default-fixture' }], synthesizeSpeech: fixture.synthesis,
}));
vi.mock('../server/llm/embedding_provider', async original => ({
  ...await original<typeof import('../server/llm/embedding_provider')>(), generateConfiguredEmbedding: vi.fn(async () => null),
}));
vi.mock('../server/memory', async original => ({
  ...await original<typeof import('../server/memory')>(), queryMemories: vi.fn(() => []), queryMemoriesVector: vi.fn(async () => []),
  extractMemories: vi.fn(async () => ({ memories: [], reminders: [] })),
}));
vi.mock('../server/agents/rag', async original => ({ ...await original<typeof import('../server/agents/rag')>(), retrieveChunks: vi.fn(async () => []) }));
vi.mock('../server/conversation/summary_scheduler', async original => ({
  ...await original<typeof import('../server/conversation/summary_scheduler')>(), scheduleConversationSummary: vi.fn(),
}));

import { initDatabase, readDB, flushDBOrThrow } from '../db_layer';
import { registerVoiceHandlers } from '../server/socket/voice';
import { registerChatHandler } from '../server/socket/chat';
import { getConversationActionStateFromLedger } from '../server/conversation/action_ledger';
import { addMessage, getMessages, getOrCreateActiveConversation } from '../server/conversation/manager';
import { buildTransportNeutralConfirmationScope, recordPendingConfirmationDurably } from '../server/tools/pending_confirmation';
import { getChatExecution, waitForChatExecutionPersistence } from '../server/socket/chat_execution_registry';
import { toolRegistry } from '../server/tools/registry';
import { registerComputerUseTool } from '../server/tools/definitions/computer_use_tool';
import { capabilityContract } from '../server/tools/capability_contracts';
import { buildPlaybackVerification, type PlaybackSample } from '../server/cognition/playback_verification';
import { CN_EXECUTION_EVIDENCE_MESSAGES } from '../server/regions/packs/cn/execution_evidence_messages';

const task = '用爱奇艺播放蜡笔小新第一集';
const getter = () => ({});
const llm = Object.fromEntries(['DeepSeek', 'Gemini', 'OpenAI', 'Anthropic', 'Qwen', 'Ollama', 'LmStudio', 'Ark', 'Xiaomi', 'Kimi', 'Glm', 'Relay'].map(name => [`get${name}`, getter]));
Object.assign(llm, { isOllamaAvailable: () => false, isLmStudioAvailable: () => false });
const devices = () => ({ audio: false, visual: false, spatial: false, haptic: false, holographic: false, activeDeviceTypes: [], deviceCount: 0 });
const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const extraClick = vi.fn(async () => '{"ok":true}');

class VoiceSocket extends EventEmitter {
  connected = true;
  id = `playback-voice-${randomUUID()}`;
  data: any;
  handshake = { address: '127.0.0.1', headers: {}, auth: {} };
  outputs: Array<[string, any]> = [];
  constructor(readonly userId: string) { super(); this.data = { authenticatedUserId: userId, authenticatedRole: 'admin', trustedLocalExecution: true }; }
  emit(event: string, data?: any) { this.outputs.push([event, data]); return true; }
  async receive(event: string, data?: any) { await Promise.all(this.listeners(event).map(listener => listener(data))); }
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function verifiedPayload() {
  const sample: PlaybackSample = { player: '爱奇艺', title: '蜡笔小新', season: '', episode: '1', phase: 'content',
    positionSeconds: 37, capturedAt: 10_000, windowId: 'synthetic-player', pid: 3456, frameDigest: 'a'.repeat(64) };
  const playbackVerification = buildPlaybackVerification(task, [sample,
    { ...sample, positionSeconds: 40, capturedAt: 13_000, frameDigest: 'b'.repeat(64) }]);
  expect(playbackVerification).not.toBeNull();
  return JSON.stringify({ ok: true, status: 'verified', completionVerified: true, observations: 2,
    applicationMatched: true, message: 'Current player and progressing content independently verified.', playbackVerification });
}
function unconfirmedPayload(phase: string) {
  return JSON.stringify({ ok: false, status: 'unverified', completionVerified: false, observations: 1, steps: 2,
    resumeStrategy: 'observe_only', completionCandidate: 'Player is open.', verificationReason: 'observation_timeout',
    playbackObservation: { phase }, message: 'Synthetic bounded observation finished without playback evidence.' });
}
const terminals = (socket: VoiceSocket) => socket.outputs.filter(([event, data]) => event === 'agent:response' && data.finalized);

beforeAll(async () => {
  await initDatabase();
  registerComputerUseTool(toolRegistry);
  toolRegistry.register({ name: 'desktop_active_window', description: 'Synthetic foreground observation', permission: 'public', securityLevel: 'safe',
    capability: capabilityContract({ id: 'test.playback.foreground-observation', family: 'desktop', lane: 'desktop', operation: 'observe', risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'synthetic desktop window', reversible: true }], verification: { strategy: 'terminal_receipt', required: true,
        requiredFields: ['title', 'process_name', 'pid'], successStatuses: [], successSignals: [], limitations: [] } }),
    parameters: { type: 'object', properties: {} }, handler: async () => JSON.stringify({ title: '爱奇艺 - 蜡笔小新第一集', process_name: 'QyClient.exe', pid: 3456 }) });
  toolRegistry.register({ name: 'desktop_mouse_click_at', description: 'Synthetic extra click', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } }, handler: extraClick });
});
beforeEach(() => {
  vi.clearAllMocks();
  fixture.model.mockResolvedValue({ text: '{"category":"command","confidence":0.99,"entities":{}}', toolCalls: [], usage });
  fixture.stream.mockImplementation(async (_messages, _declarations, _options, onChunk) => {
    onChunk?.('已经播放完成。');
    return { text: '已经播放完成。', toolCalls: [
      { id: `observe-${randomUUID()}`, name: 'desktop_active_window', arguments: {} },
      { id: `play-${randomUUID()}`, name: 'computer_use', arguments: { task, target_application: '爱奇艺', max_steps: 2 } },
      { id: `extra-${randomUUID()}`, name: 'desktop_mouse_click_at', arguments: { x: 20, y: 20 } },
    ], usage };
  });
});
afterAll(async () => { await waitForChatExecutionPersistence(); });

describe('actual accepted voice task observes playback before its durable terminal and speech', () => {
  it.each([
    ['verified', false], ['advertisement', true], ['unknown', true], ['cancelled', true],
  ] as const)('delivers %s without premature success or repeating desktop control', async (outcome, blocked) => {
    const socket = new VoiceSocket(`playback-delivery-${randomUUID()}`);
    const io = { to: () => ({ emit: (event: string, data: any) => socket.emit(event, data) }), emit: (event: string, data: any) => socket.emit(event, data) };
    registerVoiceHandlers(socket as any, llm as any, devices, () => socket.userId, io as any);
    const gate = deferred();
    fixture.control.mockImplementation(async (_task, options) => {
      options.onProgress(CN_EXECUTION_EVIDENCE_MESSAGES.waitingPlaybackAd);
      await gate.promise;
      options.onProgress(CN_EXECUTION_EVIDENCE_MESSAGES.checkingPlayback);
      return outcome === 'verified' || outcome === 'cancelled' ? verifiedPayload() : unconfirmedPayload(outcome);
    });
    const spoken: string[] = [];
    fixture.synthesis.mockImplementation(async (text: string) => {
      const terminal = terminals(socket).at(-1)?.[1];
      expect(terminal).toBeDefined();
      expect(getMessages(terminal.conversationId).some(message => message.role === 'assistant' && message.message === terminal.text), 'assistant response must precede speech').toBe(true);
      expect(getChatExecution({ userId: socket.userId, domain: 'personal', orgId: '', source: 'voice', conversationId: terminal.conversationId }, terminal.requestId), 'durable terminal must precede speech').toMatchObject({ terminal: true });
      spoken.push(text);
      return { audioBuffer: Buffer.from([1, 2, 3]), format: 'wav' };
    });
    try {
      const sessionId = `synthetic-mic-${randomUUID()}`;
      await socket.receive('audio:start', { sessionId, captureSessionId: sessionId, audioInputKind: 'physical_microphone', voiceId: 'default-fixture' });
      const pending = fixture.stts.at(-1).final(task);
      await vi.waitFor(() => expect(fixture.control).toHaveBeenCalledOnce(), { timeout: 8000 });
      expect(terminals(socket)).toHaveLength(0);
      expect(spoken).toHaveLength(0);
      expect(socket.outputs.some(([event, data]) => event === 'agent:chunk' && /播放完成/u.test(data.text || ''))).toBe(false);
      const progress = socket.outputs.filter(([event, data]) => event === 'agent:progress' && data.text === CN_EXECUTION_EVIDENCE_MESSAGES.waitingPlaybackAd);
      expect(progress.length).toBeGreaterThan(0);
      if (outcome === 'cancelled') {
        await socket.receive('audio:cancel_turn', { requestId: progress.at(-1)![1].requestId });
        gate.resolve();
        await pending;
        await vi.waitFor(() => expect(socket.data.audioSession.isProcessing).toBe(false));
        expect(terminals(socket).every(([, data]) => data.blocked === true)).toBe(true);
        expect(spoken).toHaveLength(0);
        expect(extraClick).not.toHaveBeenCalled();
        expect(socket.outputs.some(([event, data]) => event === 'agent:progress' && data.text === CN_EXECUTION_EVIDENCE_MESSAGES.checkingPlayback)).toBe(false);
        return;
      }
      gate.resolve();
      await pending;
      await vi.waitFor(() => expect(terminals(socket)).toHaveLength(1), { timeout: 8000 });
      await vi.waitFor(() => expect(spoken.length).toBeGreaterThan(0), { timeout: 8000 });
      const terminal = terminals(socket)[0][1];
      expect(terminal).toMatchObject({ blocked, source: 'voice', requestId: progress.at(-1)![1].requestId, conversationId: progress.at(-1)![1].conversationId });
      if (outcome === 'verified') {
        expect(terminal.text).toContain('蜡笔小新');
        expect(terminal.text).toContain('播放');
      } else {
        expect(terminal.reason).toBe('desktop_completion_needs_observation');
        expect(terminal.text).toContain(outcome === 'advertisement' ? '广告仍在播放' : '还没看到可靠的播放进度');
      }
      expect(spoken.join('')).toBe(terminal.text);
      expect(extraClick).not.toHaveBeenCalled();
      expect(fixture.stream).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(socket.data.audioSession.isProcessing).toBe(false));
      await flushDBOrThrow();
      const state = getConversationActionStateFromLedger(readDB(), { userId: socket.userId, conversationId: terminal.conversationId });
      expect(state?.status).toBe(blocked ? 'blocked' : 'completed');
      expect(state?.completionSource).not.toBe('user_observation');
    } finally { gate.resolve(); await socket.receive('audio:stop'); }
  }, 20000);
});

describe('actual chat progress retains the current request during playback observation', () => {
  it.each(['normal', 'confirmation'] as const)('forwards waiting progress through the %s tool path', async path => {
    const userId = `chat-playback-${randomUUID()}`;
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const requestId = `chat-playback-request-${randomUUID()}`;
    if (path === 'confirmation') {
      const previousRequest = `previous-${randomUUID()}`;
      addMessage({ userId, agentId: 'lumi', conversationId: conversation.id, role: 'user', content: task, requestId: previousRequest });
      addMessage({ userId, agentId: 'lumi', conversationId: conversation.id, role: 'assistant', content: '正在等待允许执行。', requestId: previousRequest,
        toolCalls: [{ name: 'computer_use', arguments: { task, target_application: '爱奇艺', max_steps: 2 },
          result: 'Tool "computer_use" requires user confirmation and was not approved.',
          terminalVerification: { status: 'failed', strategy: 'terminal_receipt', reason: 'Requires confirmation.' } }] });
      const state = getOrCreateActiveConversation(userId, 'lumi', 'personal', '').actionContinuationState!;
      const scope = buildTransportNeutralConfirmationScope({ domain: 'personal', conversationId: conversation.id, taskId: state.taskId });
      await recordPendingConfirmationDurably(userId, 'computer_use', { task, target_application: '爱奇艺', max_steps: 2 }, 'chat', { ...scope, actionIntent: task });
    }
    const http = createServer();
    const io = new Server(http, { transports: ['websocket'] });
    io.on('connection', socket => {
      Object.assign(socket.data, { authenticatedUserId: userId, authenticatedRole: 'admin', trustedLocalExecution: true });
      socket.join(`user:${userId}:personal`);
      registerChatHandler(socket, llm as any, devices, () => userId, io);
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('No isolated test port');
    const client = connect(`http://127.0.0.1:${address.port}`, { transports: ['websocket'] });
    const gate = deferred();
    const events: Array<[string, any]> = [];
    client.onAny((event, data) => { events.push([event, data]); });
    fixture.control.mockImplementation(async (_task, options) => {
      options.onProgress(CN_EXECUTION_EVIDENCE_MESSAGES.waitingPlaybackAd);
      await gate.promise;
      return unconfirmedPayload('advertisement');
    });
    fixture.model.mockImplementation(async (_messages, declarations) => {
      if (declarations?.some((declaration: any) => declaration.function?.name === 'computer_use')) {
        return { text: '', usage, toolCalls: [
          { id: `chat-observe-${randomUUID()}`, name: 'desktop_active_window', arguments: {} },
          { id: `chat-play-${randomUUID()}`, name: 'computer_use', arguments: { task, target_application: '爱奇艺', max_steps: 2 } },
        ] };
      }
      return { text: '{"category":"command","confidence":0.99,"entities":{}}', toolCalls: [], usage };
    });
    try {
      await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
      expect(await client.timeout(5000).emitWithAck('agent:chat', { text: path === 'confirmation' ? '确认执行' : task,
        requestId, conversationId: conversation.id, agentId: 'lumi', domain: 'personal', source: 'command-center-chat' })).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(fixture.control).toHaveBeenCalledOnce(), { timeout: 8000 });
      await vi.waitFor(() => expect(events.some(([event, data]) => event === 'agent:progress'
        && data.text === CN_EXECUTION_EVIDENCE_MESSAGES.waitingPlaybackAd && data.requestId === requestId && data.conversationId === conversation.id)).toBe(true));
      expect(events.filter(([event, data]) => event === 'agent:response' && data.finalized)).toHaveLength(0);
      gate.resolve();
      await vi.waitFor(() => expect(events.filter(([event, data]) => event === 'agent:response' && data.requestId === requestId && data.finalized)).toHaveLength(1), { timeout: 8000 });
      const terminal = events.find(([event, data]) => event === 'agent:response' && data.requestId === requestId && data.finalized)![1];
      expect(terminal).toMatchObject({ blocked: true, reason: 'desktop_completion_needs_observation' });
      expect(terminal.text).toContain('广告仍在播放');
      expect(terminal.text).not.toMatch(/请.*(?:确认|核对)/u);
    } finally {
      gate.resolve(); client.disconnect();
      await new Promise<void>(resolve => io.close(() => resolve()));
    }
  }, 15000);
});
