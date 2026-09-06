// Real voice/meeting handlers with isolated models, PCM and DesktopUI callbacks.
import './helpers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

const mocks = vi.hoisted(() => ({
  stream: vi.fn(), model: vi.fn(), transcribe: vi.fn(), learning: vi.fn(),
  summaries: vi.fn(), flushGate: vi.fn(), stt: [] as any[],
}));
vi.mock('../server/stt/adapter', async original => ({
  ...await original<typeof import('../server/stt/adapter')>(),
  getActiveStreamingSTTProvider: () => 'ark',
  createResilientStreamingSession: () => {
    let result: (input: any) => any;
    const session = {
      end: vi.fn(), sendAudio: vi.fn(), updateEndpointing: vi.fn(), onError: vi.fn(),
      onResult: (handler: any) => { result = handler; },
      final: (text: string) => result({ text, isFinal: true }),
    };
    mocks.stt.push(session);
    return session;
  },
}));
vi.mock('../server/socket/chat_terminal_boundary', async original => {
  const actual = await original<typeof import('../server/socket/chat_terminal_boundary')>();
  return { ...actual, commitChatTerminalBoundary: (input: any) => actual.commitChatTerminalBoundary({ ...input, flush: async () => {
    await input.flush(); await mocks.flushGate();
  } }) };
});
vi.mock('../server/stt/file_transcription', () => ({ transcribeAudioFile: (...args: any[]) => mocks.transcribe(...args) }));
vi.mock('../server/tts/adapter', async original => ({
  ...await original<typeof import('../server/tts/adapter')>(),
  getActiveProvider: () => null,
  synthesizeSpeech: vi.fn(() => { throw new Error('Forbidden real TTS in audit'); }),
}));
vi.mock('../server/llm/providers', async original => ({
  ...await original<typeof import('../server/llm/providers')>(),
  makeLLMCallStreaming: (...args: any[]) => mocks.stream(...args),
  makeLLMCall: (...args: any[]) => mocks.model(...args),
}));
vi.mock('../server/llm/adapter', async original => ({
  ...await original<typeof import('../server/llm/adapter')>(),
  runWithTools: vi.fn(() => { throw new Error('Unexpected tool execution in voice audit'); }),
}));
vi.mock('../server/llm/embedding_provider', async original => ({
  ...await original<typeof import('../server/llm/embedding_provider')>(),
  generateConfiguredEmbedding: vi.fn(async () => null),
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
  ...await original<typeof import('../server/conversation/summary_scheduler')>(),
  scheduleConversationSummary: (...args: any[]) => mocks.summaries(...args),
}));
vi.mock('../server/cognition/post_turn_learning', async original => {
  const actual = await original<typeof import('../server/cognition/post_turn_learning')>();
  return { ...actual, persistLumiPostTurnLearning: (...args: Parameters<typeof actual.persistLumiPostTurnLearning>) => {
    const outcome = actual.persistLumiPostTurnLearning(...args);
    mocks.learning(args, outcome);
    return outcome;
  } };
});

import { initDatabase, readDB, flushDBOrThrow } from '../db_layer';
import { registerVoiceHandlers } from '../server/socket/voice';
import { createOrg, addMember, removeMember, getMember, updateMemberRole } from '../server/org/db';
import { addMessage, getMessages, getOrCreateActiveConversation } from '../server/conversation/manager';
import { waitForChatExecutionPersistence } from '../server/socket/chat_execution_registry';

const ORG_MARKER = 'SYNTHETIC_ORG_PLAN_ALPHA';
const USER_TEXT = '我希望你以后回答自然顺畅，请解释我们之前记录的项目安排。';
const MODEL_TEXT = `这次项目安排是 ${ORG_MARKER}，我会按你的表达偏好说明。`;
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
class FixtureSocket extends EventEmitter {
  connected = true;
  id: string;
  data: any;
  handshake = { address: '127.0.0.1', headers: {}, auth: {} };
  outputs: Array<[string, any]> = [];
  client = Object.assign(new EventEmitter(), { connected: true });
  constructor(id: string) { super(); this.id = id; this.data = { authenticatedUserId: id, authenticatedRole: 'user' }; }
  emit(event: string, data?: any): boolean { this.outputs.push([event, data]); this.client.emit(event, data); return true; }
  async receive(event: string, data?: any) { await Promise.all(this.listeners(event).map(listener => listener(data))); }
}
const sockets: FixtureSocket[] = [];
let sequence = 0;
function fixture(organization = false) {
  const socket = new FixtureSocket(`round6-voice-${++sequence}`);
  const userId = socket.data.authenticatedUserId;
  const org = organization ? createOrg('Synthetic voice audit org', `${userId}-org`, `${userId}-owner`) : null;
  if (org) {
    addMember(org.id, userId, 'member');
    Object.assign(socket.data, { authenticatedOrgId: org.id, authenticatedOrgRole: 'member' });
  }
  const emit = vi.fn((event, payload) => socket.client.emit(event, payload));
  const io = { to: vi.fn(() => ({ emit })), emit };
  const getter = () => ({});
  const llm = Object.fromEntries(['DeepSeek', 'Gemini', 'OpenAI', 'Anthropic', 'Qwen', 'Ollama', 'LmStudio', 'Ark', 'Xiaomi', 'Kimi', 'Glm', 'Relay'].map(name => [`get${name}`, getter]));
  registerVoiceHandlers(socket as any, llm as any, () => ({ audio: false, visual: false, spatial: false, activeDeviceTypes: [], deviceCount: 0 }), () => socket.data.authenticatedUserId, io as any);
  sockets.push(socket);
  return { socket, userId, org };
}
const start = (sessionId: string, transcriptionOnly = false) => ({ sessionId, captureSessionId: sessionId, audioInputKind: 'physical_microphone', transcriptionOnly });
beforeAll(async () => { await initDatabase(); });
beforeEach(() => {
  mocks.stream.mockReset(); mocks.model.mockReset(); mocks.transcribe.mockReset();
  mocks.learning.mockClear(); mocks.summaries.mockClear(); mocks.flushGate.mockReset().mockResolvedValue(undefined); mocks.stt.length = 0;
  mocks.model.mockResolvedValue({ text: JSON.stringify({ correctsIdentity: false }), toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    await socket.receive('audio:stop');
    socket.client.removeAllListeners();
  }
  await waitForChatExecutionPersistence();
});

// Extract and execute the exact callbacks from the currently mounted DesktopUI.
// React rendering and the OS media devices are intentionally not simulated here.
const desktopSource = fs.readFileSync(new URL('../src/components/DesktopUI.tsx', import.meta.url), 'utf8');
const desktopAst = ts.createSourceFile('DesktopUI.tsx', desktopSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function realDesktopCallback(name: string, context: Record<string, any>): any {
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(desktopAst) === name && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(desktopAst);
  if (!callback || !ts.isArrowFunction(callback)) throw new Error(`Missing actual DesktopUI callback ${name}`);
  const code = ts.transpileModule(`return (${callback.getText(desktopAst)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(context), code)(...Object.values(context));
}
function meetingUi(socket: FixtureSocket) {
  const state = { notes: [] as any[], persisted: [] as any[], report: '', startedAt: 1000, paused: false };
  const writes = new Map<string, string>();
  const events = new EventTarget();
  const common: Record<string, any> = {
    lang: 'en', meetingPreferenceScopeKey: 'fixture-scope', meetingStartedAt: state.startedAt, meetingStorageKeys: { report: 'report', notes: 'notes', startedAt: 'started' },
    setMeetingNotes: (value: any) => { state.notes = typeof value === 'function' ? value(state.notes) : value; },
    setMeetingSpeakerCount: vi.fn(), setMeetingReport: (value: string) => { state.report = value; },
    setMeetingStartedAt: (value: any) => { state.startedAt = typeof value === 'function' ? value(state.startedAt) : value; },
    persistMeetingNotes: (notes: any[]) => { state.persisted = notes; },
    localStorage: { getItem: (key: string) => writes.get(key) || null, setItem: (key: string, value: string) => writes.set(key, value), removeItem: (key: string) => writes.delete(key) },
    toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() }, uiMessage: (key: string) => key,
    lastMeetingTranscriptRef: { current: {} }, lastLegalMeetingArchiveRef: { current: '' },
    meetingModeRef: { current: true }, meetingPausedRef: { current: false },
    meetingIdentityRef: { current: { scope: 'fixture-scope', meetingId: '', refinementId: '' } },
    meetingRefinementCancelRef: { current: null }, meetingCaptureResetRef: { current: null },
    setMeetingReportGenerating: vi.fn(),
  };
  common.renewMeetingIdentity = realDesktopCallback('renewMeetingIdentity', common);
  const apply = realDesktopCallback('applyRefinedMeetingTranscript', common);
  const append = realDesktopCallback('appendMeetingTranscript', common);
  socket.client.on('audio:transcript', data => append(data.text, data.isFinal, data));
  const wait = realDesktopCallback('waitForMeetingRefinement', { ...common, socket: socket.client, applyRefinedMeetingTranscript: apply,
    window: { setTimeout, clearTimeout, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) },
  });
  return { state, apply, wait: (meetingId: string) => {
    const identity = { scope: 'fixture-scope', meetingId, refinementId: `refine-${meetingId}` };
    common.meetingIdentityRef.current = identity;
    return wait(identity);
  }, identity: common.meetingIdentityRef, resetCapture: common.meetingCaptureResetRef, clear: realDesktopCallback('clearMeetingNotes', common), events };
}

describe('voice organization authority through actual STT and model pipeline', () => {
  it.each(['normal', 'remove', 'rejoin', 'downgrade'])('%s: preserves normal replies and safely cancels revoked membership generations', async change => {
    const { socket, userId, org } = fixture(true);
    const conversation = getOrCreateActiveConversation(userId, 'lumi', 'work', org!.id);
    addMessage({ userId, agentId: 'lumi', conversationId: conversation.id, role: 'user', content: `Original organization plan ${ORG_MARKER}`, mode: 'text', domain: 'work', orgId: org!.id });
    const gate = deferred();
    const entered = deferred();
    let signal: AbortSignal | undefined;
    mocks.stream.mockImplementation(async (_messages: any, _tools: any, options: any, onChunk: any) => {
      signal = options.signal;
      entered.resolve();
      await gate.promise;
      onChunk(MODEL_TEXT); // Provider deliberately ignores abort: late output must still be discarded.
      return { text: MODEL_TEXT, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    await socket.receive('audio:start', start(`authority-${sequence}`));
    await mocks.stt.at(-1).final(USER_TEXT);
    await entered.promise;
    try {
      expect(JSON.stringify(mocks.stream.mock.calls[0][0])).toContain(ORG_MARKER);
      if (change !== 'normal') {
        if (change === 'downgrade') updateMemberRole(org!.id, userId, 'viewer');
        else { removeMember(org!.id, userId); if (change === 'rejoin') addMember(org!.id, userId, 'member'); }
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
        expect(socket.outputs.some(([event, data]) => event === 'agent:response' && data.finalized)).toBe(false);
      }
    } finally { gate.resolve(); }
    await vi.waitFor(() => expect(socket.outputs.some(([event, data]) => event === 'agent:response' && data.finalized)).toBe(true));
    await vi.waitFor(() => expect(socket.data.audioSession.isProcessing).toBe(false));
    const terminal = socket.outputs.filter(([event, data]) => event === 'agent:response' && data.finalized);
    expect(terminal).toHaveLength(1);
    if (change === 'normal') {
      expect(terminal[0][1].text).toContain(ORG_MARKER);
      expect(mocks.learning.mock.calls[0][1].result.storedMemories).toBeGreaterThan(0);
      expect(mocks.summaries.mock.calls[0][0].isAuthorized()).toBe(true);
      removeMember(org!.id, userId);
      expect(mocks.summaries.mock.calls[0][0].isAuthorized()).toBe(false);
    } else {
      expect(terminal[0][1].reason).toBe('cancelled');
      expect(JSON.stringify(socket.outputs.filter(([event]) => event === 'agent:response' || event === 'agent:chunk'))).not.toContain(ORG_MARKER);
      expect(mocks.learning).not.toHaveBeenCalled();
      expect(mocks.summaries).not.toHaveBeenCalled();
      expect(getMessages(conversation.id, 20).filter(message => message.mode === 'voice' && message.role === 'assistant').every(message => !message.message.includes(ORG_MARKER))).toBe(true);
      expect((readDB().memories || []).some((memory: any) => memory.userId === userId && memory.source === 'voice')).toBe(false);
    }
    await flushDBOrThrow();
  }, 15000);

  it('revocation during terminal flush replaces unpublished success with one safe cancellation and skips learning', async () => {
    const { socket, userId, org } = fixture(true);
    const entered = deferred(); const gate = deferred();
    mocks.stream.mockImplementation(async (_m: any, _t: any, _o: any, onChunk: any) => {
      // This result is held at the real terminal persistence boundary.
      onChunk(MODEL_TEXT);
      return { text: MODEL_TEXT, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    });
    mocks.flushGate.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; });
    await socket.receive('audio:start', start('terminal-authority'));
    await mocks.stt.at(-1).final(USER_TEXT);
    await entered.promise;
    removeMember(org!.id, userId);
    gate.resolve();
    await vi.waitFor(() => expect(socket.outputs.filter(([event, data]) => event === 'agent:response' && data.finalized)).toHaveLength(1));
    expect(socket.outputs.filter(([event, data]) => event === 'agent:response' && data.finalized)[0][1]).toMatchObject({ reason: 'cancelled' });
    expect(mocks.learning).not.toHaveBeenCalled();
    expect(mocks.summaries).not.toHaveBeenCalled();
  });
});

describe('meeting capture ownership and complete paused recordings', () => {
  it('normal uninterrupted capture refines both recorded chunks and applies the full result', async () => {
    const { socket } = fixture();
    const ui = meetingUi(socket);
    const first = Buffer.alloc(16000, 0x11);
    const second = Buffer.alloc(16000, 0x22);
    mocks.transcribe.mockResolvedValue({ text: 'FIRST SECOND', provider: 'fixture', model: 'inert' });
    await socket.receive('audio:start', start('normal-meeting', true));
    await socket.receive('audio:chunk', first);
    await mocks.stt.at(-1).final('FIRST');
    await socket.receive('audio:chunk', second);
    await mocks.stt.at(-1).final('SECOND');
    expect(ui.state.persisted.map(note => note.text)).toEqual(['FIRST', 'SECOND']);
    const completed = ui.wait('normal-meeting');
    await socket.receive('audio:stop', { sessionId: 'normal-meeting', refineTranscript: true, refinementId: ui.identity.current.refinementId });
    await completed;
    expect(Buffer.from(mocks.transcribe.mock.calls[0][0]).subarray(44)).toEqual(Buffer.concat([first, second]));
    expect(ui.state.persisted.map(note => note.text)).toEqual(['FIRST SECOND']);
  });

  it('late refinement after clear/new meeting cannot overwrite the current notes', async () => {
    const { socket } = fixture();
    const ui = meetingUi(socket);
    const firstRefinement = deferred<any>();
    mocks.transcribe.mockReturnValueOnce(firstRefinement.promise);
    await socket.receive('audio:start', start('meeting-before-clear', true));
    await socket.receive('audio:chunk', Buffer.alloc(16000, 0x33));
    const firstWaiter = ui.wait('meeting-before-clear');
    await socket.receive('audio:stop', { sessionId: 'meeting-before-clear', refineTranscript: true, refinementId: ui.identity.current.refinementId });
    expect(mocks.transcribe).toHaveBeenCalledOnce();
    ui.clear(); // The real Clear button is enabled even while reportGenerating.
    expect(ui.state.notes).toEqual([]);
    await socket.receive('audio:start', start('meeting-after-clear', true));
    await socket.receive('audio:chunk', Buffer.alloc(16000, 0x44));
    await mocks.stt.at(-1).final('CURRENT MEETING NOTES');
    expect(ui.state.persisted.map(note => note.text)).toEqual(['CURRENT MEETING NOTES']);
    firstRefinement.resolve({ text: 'OLD MEETING ONLY', provider: 'fixture', model: 'inert' });
    expect(await firstWaiter).toBeNull();
    await vi.waitFor(() => expect(socket.outputs.some(([event]) => event === 'meeting:refined_transcript')).toBe(true));
    expect(socket.data.audioSession.sessionId).toBe('meeting-after-clear');
    expect(socket.data.audioSession.isActive).toBe(true);
    expect(ui.state.notes.map(note => note.text)).toEqual(['CURRENT MEETING NOTES']);
    expect(ui.state.persisted.map(note => note.text)).toEqual(['CURRENT MEETING NOTES']);
    const event = socket.outputs.find(([name]) => name === 'meeting:refined_transcript')![1];
    expect(event).toMatchObject({ sessionId: 'meeting-before-clear', meetingId: 'meeting-before-clear', refinementId: 'refine-meeting-before-clear' });
  });

  it('pause/resume keeps both PCM segments and refines the complete meeting', async () => {
    const { socket } = fixture();
    const ui = meetingUi(socket);
    const first = Buffer.alloc(16000, 0x55);
    const second = Buffer.alloc(16000, 0x66);
    mocks.transcribe.mockResolvedValue({ text: 'FIRST AND SECOND HALF', provider: 'fixture', model: 'inert' });
    await socket.receive('audio:start', { ...start('before-pause', true), meetingId: 'paused-meeting' });
    await socket.receive('audio:chunk', first);
    const firstPath = socket.data.audioSession.meetingPcmPath;
    expect(fs.existsSync(firstPath)).toBe(true);
    await mocks.stt.at(-1).final('FIRST HALF');
    const stopped = deferred();
    const pause = realDesktopCallback('pauseMeetingCapture', {
      setMeetingPaused: (paused: boolean) => { ui.state.paused = paused; },
      meetingVoiceActiveRef: { current: true }, meetingStartAttemptRef: { current: 0 }, callState: 'listening',
      endCall: (options: any) => { void socket.receive('audio:stop', { sessionId: 'before-pause', ...options }).then(() => stopped.resolve()); },
      toast: { success: vi.fn() }, uiMessage: (key: string) => key, lang: 'en',
    });
    pause();
    await stopped.promise;
    expect(ui.state.paused).toBe(true);
    expect(fs.existsSync(firstPath)).toBe(true);
    expect(mocks.transcribe).not.toHaveBeenCalled();
    await socket.receive('audio:start', { ...start('after-resume', true), meetingId: 'paused-meeting' });
    await socket.receive('audio:chunk', second);
    await mocks.stt.at(-1).final('SECOND HALF');
    expect(ui.state.persisted.map(note => note.text)).toEqual(['FIRST HALF', 'SECOND HALF']);
    const completed = ui.wait('paused-meeting');
    await socket.receive('audio:stop', { sessionId: 'after-resume', refineTranscript: true, refinementId: ui.identity.current.refinementId });
    await completed;
    expect(Buffer.from(mocks.transcribe.mock.calls[0][0]).subarray(44)).toEqual(Buffer.concat([first, second]));
    expect(ui.state.persisted.map(note => note.text)).toEqual(['FIRST AND SECOND HALF']);
  });

  it('can finish a paused meeting without opening another microphone capture', async () => {
    const { socket } = fixture(); const ui = meetingUi(socket);
    mocks.transcribe.mockResolvedValue({ text: 'PAUSED FULL RECORD', provider: 'fixture', model: 'inert' });
    await socket.receive('audio:start', { ...start('paused-finish-capture', true), meetingId: 'paused-finish' });
    await socket.receive('audio:chunk', Buffer.alloc(16000, 0x42));
    await socket.receive('audio:stop', { sessionId: 'paused-finish-capture', preserveMeeting: true });
    const done = ui.wait('paused-finish');
    await socket.receive('meeting:refine', { ...ui.identity.current });
    await done;
    expect(mocks.stt).toHaveLength(1);
    expect(ui.state.persisted[0].text).toBe('PAUSED FULL RECORD');
  });

  it('ignores a different refinement result/error without consuming the matching listener', async () => {
    const { socket } = fixture(); const ui = meetingUi(socket);
    const done = ui.wait('current');
    socket.client.emit('meeting:refine_error', { meetingId: 'old', refinementId: 'old', message: 'old error' });
    socket.client.emit('meeting:refined_transcript', { meetingId: 'old', refinementId: 'old', text: 'OLD' });
    expect(ui.state.persisted).toEqual([]);
    socket.client.emit('meeting:refined_transcript', { ...ui.identity.current, text: 'CURRENT' });
    expect((await done)[0].text).toBe('CURRENT');
    expect(socket.client.listenerCount('meeting:refined_transcript')).toBe(0);
  });

  it('a domain-change event invalidates the pending identity before any report continuation can run', async () => {
    const { socket } = fixture(); const ui = meetingUi(socket);
    const done = ui.wait('domain-change'); const original = ui.identity.current;
    ui.events.dispatchEvent(new Event('lumi:domain-changed'));
    expect(await done).toBeNull();
    expect(ui.identity.current).not.toBe(original);
    socket.client.emit('meeting:refined_transcript', { ...original, text: 'STALE DOMAIN' });
    expect(ui.state.persisted).toEqual([]);
  });

  it('old stop waiting for persistence cannot delete the next capture even with the same meeting ID', async () => {
    const { socket } = fixture();
    await socket.receive('audio:start', { ...start('old-stop-capture', true), meetingId: 'overlap' });
    await socket.receive('audio:chunk', Buffer.alloc(16000, 0x51));
    const oldPath = socket.data.audioSession.meetingPcmPath;
    socket.data.audioSession.activeTurnRequestId = 'synthetic-cancellation-owner';
    const entered = deferred(); const gate = deferred();
    mocks.flushGate.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; });
    const stopped = socket.receive('audio:stop', { sessionId: 'old-stop-capture' });
    await entered.promise;
    await socket.receive('audio:start', { ...start('new-stop-capture', true), meetingId: 'overlap' });
    await socket.receive('audio:chunk', Buffer.alloc(16000, 0x52));
    const currentPath = socket.data.audioSession.meetingPcmPath;
    expect(currentPath).not.toBe(oldPath);
    gate.resolve(); await stopped;
    expect(fs.existsSync(currentPath)).toBe(true);
    expect(fs.existsSync(oldPath)).toBe(false);
    expect(socket.data.audioSession.meetingCapture.recording.segments).toHaveLength(1);
    expect(socket.data.audioSession.isActive).toBe(true);
  });

  it('clearing a paused meeting discards its exact recording without restarting the microphone', async () => {
    const { socket } = fixture(); const ui = meetingUi(socket);
    await socket.receive('audio:start', { ...start('clear-paused-capture', true), meetingId: 'clear-paused' });
    await socket.receive('audio:chunk', Buffer.alloc(16000));
    const rawPath = socket.data.audioSession.meetingPcmPath;
    await socket.receive('audio:stop', { sessionId: 'clear-paused-capture', preserveMeeting: true });
    ui.identity.current = { scope: 'fixture-scope', meetingId: 'clear-paused', refinementId: '' };
    let discarded: Promise<void> | undefined;
    ui.resetCapture.current = (meetingId: string) => { discarded = socket.receive('meeting:discard', { meetingId }); };
    ui.clear(); await discarded;
    expect(fs.existsSync(rawPath)).toBe(false);
    expect(mocks.stt).toHaveLength(1);
  });

  it.each([false, true])('cold recording cache/reconnected socket checks persisted original membership (rejoin=%s)', async rejoin => {
    const first = fixture(true);
    const meetingId = `recover-${sequence}`;
    await first.socket.receive('audio:start', { ...start(`capture-${sequence}`, true), meetingId });
    await first.socket.receive('audio:chunk', Buffer.alloc(16000, 0x21));
    await first.socket.receive('audio:stop', { preserveMeeting: true });
    first.socket.connected = false;
    await first.socket.receive('disconnect'); // Releases the cache; recovery must use the persisted manifest.
    if (rejoin) { removeMember(first.org!.id, first.userId); addMember(first.org!.id, first.userId, 'member'); }
    const second = fixture();
    Object.assign(second.socket.data, { authenticatedUserId: first.userId, authenticatedOrgId: first.org!.id, authenticatedOrgRole: 'member' });
    mocks.transcribe.mockResolvedValue({ text: 'RESTORED PAUSED MEETING', provider: 'fixture', model: 'inert' });
    const ui = meetingUi(second.socket); const done = ui.wait(meetingId);
    await second.socket.receive('meeting:refine', { ...ui.identity.current });
    const result = await done;
    if (rejoin) {
      expect(result).toBeNull();
      expect(mocks.transcribe).not.toHaveBeenCalled();
      expect(second.socket.outputs.at(-1)?.[0]).toBe('meeting:refine_error');
    } else {
      expect(result[0].text).toBe('RESTORED PAUSED MEETING');
      expect(mocks.transcribe).toHaveBeenCalledOnce();
    }
    expect(mocks.stt).toHaveLength(1); // No extra microphone start on reconnect.
  });

  it('does not rebind raw PCM without ownership metadata and returns a matching refinement error', async () => {
    const first = fixture(); const meetingId = 'missing-manifest';
    await first.socket.receive('audio:start', { ...start('metadata-capture', true), meetingId });
    await first.socket.receive('audio:chunk', Buffer.alloc(16000));
    const rawPath = first.socket.data.audioSession.meetingPcmPath;
    await first.socket.receive('audio:stop', { preserveMeeting: true });
    first.socket.connected = false; await first.socket.receive('disconnect');
    fs.unlinkSync(path.join(path.dirname(rawPath), `meeting_${meetingId.length}_${meetingId}_segments.json`));
    const second = fixture(); second.socket.data.authenticatedUserId = first.userId;
    const ui = meetingUi(second.socket); const done = ui.wait(meetingId);
    await second.socket.receive('meeting:refine', { ...ui.identity.current });
    expect(await done).toBeNull();
    expect(mocks.transcribe).not.toHaveBeenCalled();
    expect(second.socket.outputs.at(-1)?.[1]).toMatchObject({ meetingId, refinementId: `refine-${meetingId}` });
  });

  it('a failed atomic manifest replacement preserves the previous paused segment and rolls back the new empty capture', async () => {
    const { socket } = fixture(); const meetingId = 'atomic-manifest';
    await socket.receive('audio:start', { ...start('atomic-first', true), meetingId });
    await socket.receive('audio:chunk', Buffer.alloc(16000, 0x37));
    const firstPath = socket.data.audioSession.meetingPcmPath;
    await socket.receive('audio:stop', { preserveMeeting: true });
    const directory = path.dirname(firstPath);
    const manifest = path.join(directory, `meeting_${meetingId.length}_${meetingId}_segments.json`);
    const original = fs.readFileSync(manifest, 'utf8');
    const rename = fs.renameSync;
    const failure = vi.spyOn(fs, 'renameSync').mockImplementation((source, target) => {
      if (String(target) === manifest) throw new Error('Synthetic disk replacement failure');
      return rename(source, target);
    });
    try { await socket.receive('audio:start', { ...start('atomic-second', true), meetingId }); }
    finally { failure.mockRestore(); }
    expect(fs.readFileSync(manifest, 'utf8')).toBe(original);
    expect(fs.readFileSync(firstPath)).toEqual(Buffer.alloc(16000, 0x37));
    expect(fs.readdirSync(directory).filter(name => name.endsWith('.pcm'))).toEqual([path.basename(firstPath)]);
    expect(fs.readdirSync(directory).some(name => name.endsWith('.tmp'))).toBe(false);
  });
});
