// @vitest-environment jsdom
import './helpers';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { act, renderHook } from '@testing-library/react';

const fixture = vi.hoisted(() => ({
  boundary: vi.fn(),
  transcribe: vi.fn(),
  stt: [] as any[],
  sttProvider: 'ark' as string | null,
  sttStartFails: false,
  ttsProvider: null as string | null,
  ttsVoices: vi.fn(),
}));
vi.mock('../server/socket/chat_terminal_boundary', () => ({ commitChatTerminalBoundary: (...args: any[]) => fixture.boundary(...args) }));
vi.mock('../server/stt/file_transcription', () => ({ transcribeAudioFile: (...args: any[]) => fixture.transcribe(...args) }));
vi.mock('../server/stt/adapter', () => ({
  getActiveStreamingSTTProvider: () => fixture.sttProvider,
  createResilientStreamingSession: (_options: any, lifecycle: any) => {
    if (fixture.sttStartFails) throw new Error('synthetic STT start failure');
    const stt = { lifecycle, end: vi.fn(), sendAudio: vi.fn(), onResult: vi.fn(), onError: vi.fn(), updateEndpointing: vi.fn() };
    fixture.stt.push(stt);
    return stt;
  },
}));
vi.mock('../server/tts/adapter', async importOriginal => ({
  ...await importOriginal<typeof import('../server/tts/adapter')>(),
  getActiveProvider: () => fixture.ttsProvider,
  listVoices: (...args: any[]) => fixture.ttsVoices(...args),
  synthesizeSpeech: vi.fn(() => { throw new Error('Forbidden real synthesis in audit'); }),
}));
vi.mock('../src/lib/voiceDevicePreferences', () => ({
  VOICE_DEVICE_PREFERENCE_CHANGED: 'fixture-voice-device-change',
  applyPreferredVoiceOutputDevice: async () => undefined,
  requestPreferredMicrophoneStream: async () => {
    const track = { enabled: true, readyState: 'live', stop: vi.fn() };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  },
}));
import { initDatabase } from '../db_layer';
import { registerVoiceHandlers } from '../server/socket/voice';
import { useVoiceCall } from '../src/hooks/useVoiceCall';
import { isRealtimeUserActive } from '../server/autonomy/foreground_activity';
import { executeNextAutonomousTask } from '../server/autonomy/task_executor';
import { getMessagesForAgent } from '../server/conversation/manager';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
class FixtureSocket extends EventEmitter {
  id = 'round5-voice-fixture';
  connected = true;
  data: any = { authenticatedUserId: 'round5-voice-user', authenticatedRole: 'user' };
  handshake = { address: '127.0.0.1', headers: {}, auth: {} };
  outputs: Array<[string, any]> = [];
  receiver?: (event: string, data: any) => void;
  emit(event: string, data?: any): boolean { this.outputs.push([event, data]); this.receiver?.(event, data); return true; }
  async receive(event: string, data?: any) { await Promise.all(this.listeners(event).map(listener => listener(data))); }
}
const sockets: FixtureSocket[] = [];
function createFixture() {
  const socket = new FixtureSocket();
  socket.id += `-${sockets.length}`;
  socket.data.authenticatedUserId += `-${sockets.length}`;
  const io = { to: vi.fn(() => ({ emit: vi.fn() })), emit: vi.fn() };
  registerVoiceHandlers(socket as any, {} as any, () => ({}), () => socket.data.authenticatedUserId, io as any);
  sockets.push(socket);
  return { socket, io };
}
const start = (id: string, transcriptionOnly = false) => ({ sessionId: id, captureSessionId: id, audioInputKind: 'physical_microphone', transcriptionOnly });
beforeAll(async () => { await initDatabase(); });
beforeEach(() => {
  fixture.boundary.mockReset().mockResolvedValue(true);
  fixture.transcribe.mockReset();
  fixture.stt.length = 0;
  fixture.sttProvider = 'ark';
  fixture.sttStartFails = false;
  fixture.ttsProvider = null;
  fixture.ttsVoices.mockReset().mockResolvedValue([]);
});
afterAll(async () => { for (const socket of sockets) await socket.receive('audio:stop'); });

describe('voice call ownership and terminal STT failure cleanup', () => {
  it('finishes the old stop without closing the newer call', async () => {
    const { socket } = createFixture();
    await socket.receive('audio:start', start('call-a'));
    const session = socket.data.audioSession;
    session.activeTurnRequestId = 'accepted-old-voice-turn';
    const persistence = deferred<boolean>();
    fixture.boundary.mockImplementationOnce(() => persistence.promise);
    const oldStop = socket.receive('audio:stop', { sessionId: 'call-a' });
    await Promise.resolve();
    expect(fixture.boundary).toHaveBeenCalledTimes(1);
    await socket.receive('audio:start', start('call-b'));
    const newStt = session.sttSession;
    expect(session.sessionId).toBe('call-b');
    expect(session.isActive).toBe(true);
    expect(newStt.end).not.toHaveBeenCalled();
    persistence.resolve(true);
    await oldStop;
    expect(session.sessionId).toBe('call-b');
    expect(session.isActive).toBe(true);
    expect(newStt.end).not.toHaveBeenCalled();
    expect(isRealtimeUserActive(socket.data.authenticatedUserId, 0)).toBe(true);
    expect(socket.outputs.at(-1)).toEqual(['audio:status', { status: 'listening', sessionId: 'call-b' }]);
  });

  it('does not abort the new pipeline or publish an old interrupt acknowledgement', async () => {
    const { socket } = createFixture();
    await socket.receive('audio:start', start('interrupt-a'));
    const session = socket.data.audioSession;
    session.activeTurnRequestId = 'accepted-interrupted-turn';
    const persistence = deferred<boolean>();
    fixture.boundary.mockImplementationOnce(() => persistence.promise);
    const oldInterrupt = socket.receive('audio:interrupt', { source: 'user_control' });
    await Promise.resolve();
    await socket.receive('audio:start', start('interrupt-b'));
    const newerPipeline = new AbortController();
    session.pipelineAbortController = newerPipeline;
    session.activeTurnRequestId = 'accepted-new-turn';
    session.isProcessing = true;
    persistence.resolve(true);
    await oldInterrupt;
    expect(newerPipeline.signal.aborted).toBe(false);
    expect(session.activeTurnRequestId).toBe('accepted-new-turn');
    expect(socket.outputs.some(([event]) => event === 'audio:interrupt-ack')).toBe(false);
  });

  it('accepts a stop for a pending start and never revives that start after its await', async () => {
    const { socket } = createFixture();
    await socket.receive('audio:start', start('pending-a'));
    const session = socket.data.audioSession;
    session.activeTurnRequestId = 'accepted-before-pending-start';
    const persistence = deferred<boolean>();
    fixture.boundary.mockImplementationOnce(() => persistence.promise);
    const pendingStart = socket.receive('audio:start', start('pending-b'));
    await Promise.resolve();
    expect(session.sessionId).toBe('pending-b');
    await socket.receive('audio:stop', { sessionId: 'pending-b' });
    persistence.resolve(true);
    await pendingStart;
    expect(session.isActive).toBe(false);
    expect(session.sttSession).toBeNull();
    expect(fixture.stt).toHaveLength(1);
    expect(isRealtimeUserActive(socket.data.authenticatedUserId, 0)).toBe(false);
  });

  it('the latest start wins even when a previous start is still cancelling the old request', async () => {
    const { socket } = createFixture();
    await socket.receive('audio:start', start('start-a'));
    const session = socket.data.audioSession;
    session.activeTurnRequestId = 'accepted-before-two-starts';
    const persistence = deferred<boolean>();
    fixture.boundary.mockImplementationOnce(() => persistence.promise);
    const earlierStart = socket.receive('audio:start', start('start-b'));
    await Promise.resolve();
    await socket.receive('audio:start', start('start-c'));
    const currentStt = session.sttSession;
    persistence.resolve(true);
    await earlierStart;
    expect(session.sessionId).toBe('start-c');
    expect(session.isActive).toBe(true);
    expect(session.sttSession).toBe(currentStt);
    expect(fixture.stt).toHaveLength(2);
    expect(currentStt.end).not.toHaveBeenCalled();
  });

  it('a newer request in the same call survives an older interrupt persistence wait', async () => {
    const { socket } = createFixture();
    await socket.receive('audio:start', start('same-call'));
    const session = socket.data.audioSession;
    const oldController = new AbortController();
    session.activeTurnRequestId = 'same-call-old';
    session.pipelineAbortController = oldController;
    const persistence = deferred<boolean>();
    fixture.boundary.mockImplementationOnce(() => persistence.promise);
    const interrupt = socket.receive('audio:interrupt', { sessionId: 'same-call', requestId: 'same-call-old' });
    expect(oldController.signal.aborted).toBe(true);
    const newController = new AbortController();
    session.activeTurnRequestId = 'same-call-new';
    session.pipelineAbortController = newController;
    persistence.resolve(true);
    await interrupt;
    expect(newController.signal.aborted).toBe(false);
    expect(session.activeTurnRequestId).toBe('same-call-new');
    expect(socket.outputs.some(([event]) => event === 'audio:interrupt-ack')).toBe(false);
  });

  it('late cancellation persists the original assistant identity without publishing into the new call', async () => {
    const { socket } = createFixture();
    await socket.receive('audio:start', start('identity-a'));
    const session = socket.data.audioSession;
    const userId = session.userId;
    session.activeTurnRequestId = 'old-identity-request';
    const persistence = deferred<void>();
    fixture.boundary.mockImplementationOnce(async input => {
      await persistence.promise;
      input.persistAssistantMessage();
      input.publishCommitted();
      return true;
    });
    const oldInterrupt = socket.receive('audio:interrupt');
    await socket.receive('audio:start', { ...start('identity-b'), agentId: 'second-agent', personalityId: 'second-personality' });
    persistence.resolve();
    await oldInterrupt;
    expect(getMessagesForAgent(userId, 'lumi').some(message => message.requestId === 'old-identity-request')).toBe(true);
    expect(getMessagesForAgent(userId, 'second-agent').some(message => message.requestId === 'old-identity-request')).toBe(false);
    expect(socket.outputs.some(([event]) => event === 'agent:response' || event === 'audio:interrupt-ack')).toBe(false);
    expect(session.isActive).toBe(true);
  });

  it('a late voice catalogue cannot install STT for an obsolete start', async () => {
    fixture.ttsProvider = 'official';
    const catalogue = deferred<any[]>();
    fixture.ttsVoices.mockImplementationOnce(() => catalogue.promise);
    const { socket } = createFixture();
    const earlierStart = socket.receive('audio:start', start('catalogue-a'));
    await Promise.resolve();
    expect(fixture.ttsVoices).toHaveBeenCalledOnce();
    await socket.receive('audio:start', start('catalogue-b'));
    const currentStt = socket.data.audioSession.sttSession;
    catalogue.resolve([]);
    await earlierStart;
    expect(socket.data.audioSession.sessionId).toBe('catalogue-b');
    expect(socket.data.audioSession.sttSession).toBe(currentStt);
    expect(fixture.stt).toHaveLength(1);
    expect(currentStt.end).not.toHaveBeenCalled();
  });

  it('a terminal STT error stops input immediately and cannot clear the next call after saving', async () => {
    const { socket } = createFixture();
    await socket.receive('audio:start', start('error-a'));
    const session = socket.data.audioSession;
    const oldStt = session.sttSession;
    const oldError = oldStt.onError.mock.calls[0][0];
    session.activeTurnRequestId = 'accepted-before-stt-error';
    const controller = new AbortController();
    session.pipelineAbortController = controller;
    const persistence = deferred<boolean>();
    fixture.boundary.mockImplementationOnce(() => persistence.promise);
    const failure = oldError(new Error('synthetic terminal error'));
    expect(session.isActive).toBe(false);
    expect(controller.signal.aborted).toBe(true);
    expect(oldStt.end).toHaveBeenCalledOnce();
    expect(socket.outputs.some(([event]) => event === 'audio:error')).toBe(false);
    await socket.receive('audio:start', start('error-b'));
    const newStt = session.sttSession;
    persistence.resolve(true);
    await failure;
    await oldError(new Error('late stale error'));
    oldStt.lifecycle.onRecovering({ attempt: 1, delayMs: 10, error: new Error('late recovery') });
    oldStt.lifecycle.onRecovered({ attempt: 1 });
    expect(session.isActive).toBe(true);
    expect(session.sttSession).toBe(newStt);
    expect(newStt.end).not.toHaveBeenCalled();
    expect(isRealtimeUserActive(socket.data.authenticatedUserId, 0)).toBe(true);
    expect(socket.outputs.at(-1)).toEqual(['audio:status', { status: 'listening', sessionId: 'error-b' }]);
    expect(socket.outputs.some(([event]) => event === 'audio:error')).toBe(false);
    newStt.lifecycle.onRecovering({ attempt: 1, delayMs: 10, error: new Error('current recovery') });
    expect(socket.outputs.at(-1)).toEqual(['audio:status', expect.objectContaining({ status: 'connecting', sessionId: 'error-b' })]);
    newStt.lifecycle.onRecovered({ attempt: 1 });
    expect(socket.outputs.at(-1)).toEqual(['audio:status', expect.objectContaining({ status: 'listening', sessionId: 'error-b' })]);
    expect(isRealtimeUserActive(socket.data.authenticatedUserId, 0)).toBe(true);
  });

  it.each(['not-configured', 'start-failure', 'runtime-failure'])('STT %s releases the server priority and returns the mounted client to idle', async failure => {
    if (failure === 'not-configured') fixture.sttProvider = null;
    if (failure === 'start-failure') fixture.sttStartFails = true;
    const { socket } = createFixture();
    const userId = socket.data.authenticatedUserId;
    class FixtureAudioContext {
      state = 'running'; currentTime = 0; destination = {};
      createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() { return { onaudioprocess: null, connect() {}, disconnect() {} }; }
      async resume() { this.state = 'running'; }
      async close() { this.state = 'closed'; }
    }
    vi.stubGlobal('AudioContext', FixtureAudioContext);
    const outbound: string[] = [];
    const pending: Promise<void>[] = [];
    class Client extends EventEmitter {
      connected = true;
      volatile = this;
      emit(event: string, data?: any) { outbound.push(event); pending.push(socket.receive(event, data)); return true; }
      deliver(event: string, data?: any) { return super.emit(event, data); }
    }
    const client = new Client();
    socket.receiver = (event, data) => client.deliver(event, data);
    const hook = renderHook(() => useVoiceCall({ socket: client }));
    try {
      await act(async () => { await hook.result.current.startCall(); await Promise.all(pending); });
      if (failure === 'runtime-failure') {
        expect(hook.result.current.callState).toBe('listening');
        const sessionId = socket.data.audioSession.sessionId;
        const priorError = hook.result.current.error;
        await act(async () => {
          client.deliver('audio:status', { status: 'thinking', sessionId, requestId: 'current-work' });
          client.deliver('audio:interrupt-ack', { workContinues: false, sessionId: 'stale-call' });
          client.deliver('audio:interrupt-ack', { workContinues: false, sessionId, requestId: 'old-work' });
          client.deliver('audio:status', { status: 'idle', sessionId: 'stale-call' });
          client.deliver('audio:error', { message: 'stale error', sessionId: 'stale-call' });
          client.deliver('audio:end-call-request', { sessionId: 'stale-call' });
        });
        expect(hook.result.current.callState).toBe('thinking');
        expect(hook.result.current.error).toBe(priorError);
        await act(async () => { client.deliver('audio:tts_error', { requestId: 'current-work' }); });
        expect(hook.result.current.callState).toBe('thinking');
        expect(socket.data.audioSession.isActive).toBe(true);
        const onSttError = fixture.stt.at(-1).onError.mock.calls[0][0];
        await act(async () => { await onSttError(new Error('synthetic fatal STT error')); });
      }
      expect(hook.result.current.callState).toBe('idle');
      expect(hook.result.current.error).toBeTruthy();
      expect(outbound).not.toContain('audio:stop');
      expect(socket.data.audioSession.isActive).toBe(false);
      expect(socket.data.audioSession.sttSession).toBeNull();
      expect(isRealtimeUserActive(userId, 0)).toBe(false);
      // Preserve the existing 15-second activity grace, then verify the actual
      // executor reaches its empty queue instead of remaining voice-blocked.
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15_001);
      try {
        expect(await executeNextAutonomousTask({} as any, {} as any, userId)).toEqual({ executed: false });
      } finally { clock.mockRestore(); }
    } finally {
      hook.unmount();
      socket.receiver = undefined;
      await socket.receive('audio:stop');
      expect(isRealtimeUserActive(userId, 0)).toBe(false);
      vi.unstubAllGlobals();
    }
  });
});


describe('selected voice conversation identity', () => {
  it('admits speech into the selected archived conversation after another chat becomes active', async () => {
    const { getOrCreateActiveConversation, startNewConversation, getMessages } = await import('../server/conversation/manager');
    const { prepareVoiceIdentityAndAdmission } = await import('../server/socket/voice/turn/prepare_voice_identity_and_admission');
    const { socket, io } = createFixture();
    const userId = socket.data.authenticatedUserId;
    const selected = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const active = startNewConversation(userId, 'lumi', 'personal', '');
    await socket.receive('audio:start', { ...start('selected-archive'), conversationId: selected.id });
    const resources = {} as import('../server/cognition/conversation_execution').ConversationResourceLifetime;
    try {
      const admitted = await prepareVoiceIdentityAndAdmission(socket as any, socket.data.audioSession, 'Tell me about the weather.', {} as any, () => ({}), io as any, undefined, true, {}, resources);
      expect(admitted.terminal).toBe(false);
      expect(admitted.context?.conversationTurn.conversation.id).toBe(selected.id);
      expect(socket.data.audioSession.conversationId).toBe(selected.id);
      expect(getMessages(selected.id).some(row => row.message === 'Tell me about the weather.')).toBe(true);
      expect(getMessages(active.id).some(row => row.message === 'Tell me about the weather.')).toBe(false);
      expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id).toBe(active.id);
    } finally { resources.admission?.release(); await socket.receive('audio:stop'); }
  });

  it.each(['missing', 'foreign', 'other-agent', 'other-scope'] as const)('refuses a %s selected anchor before starting STT', async kind => {
    const { getOrCreateActiveConversation } = await import('../server/conversation/manager');
    const { socket } = createFixture();
    const userId = socket.data.authenticatedUserId;
    const selected = kind === 'missing' ? { id: 'nonexistent-conversation' }
      : getOrCreateActiveConversation(kind === 'foreign' ? 'foreign-voice-user' : userId,
        kind === 'other-agent' ? 'separate-agent' : 'lumi', kind === 'other-scope' ? 'work' : 'personal', kind === 'other-scope' ? 'synthetic-org' : '');
    await socket.receive('audio:start', { ...start('invalid-anchor-' + kind), conversationId: selected.id });
    expect(socket.data.audioSession.isActive).toBe(false);
    expect(socket.data.audioSession.sttSession).toBeNull();
    expect(fixture.stt).toHaveLength(0);
    expect(socket.outputs).toContainEqual(['audio:error', expect.objectContaining({ code: 'CONVERSATION_UNAVAILABLE' })]);
    expect(isRealtimeUserActive(userId, 0)).toBe(false);
  });

  it('withdraws deleted queued voice work and never reads the replacement active transcript', async () => {
    const { getOrCreateActiveConversation, startNewConversation, getMessages } = await import('../server/conversation/manager');
    const { reserveConversationExecution } = await import('../server/cognition/conversation_execution');
    const { prepareVoiceIdentityAndAdmission } = await import('../server/socket/voice/turn/prepare_voice_identity_and_admission');
    const { readDB, writeDB } = await import('../db_layer');
    const { socket, io } = createFixture();
    const userId = socket.data.authenticatedUserId;
    const selected = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    await socket.receive('audio:start', { ...start('delete-selected'), conversationId: selected.id });
    const foreground = reserveConversationExecution({ userId, domain: 'personal', orgId: '', conversationId: selected.id, source: 'chat' }, 'foreground-before-selected-voice');
    await foreground.waitForTurn();
    const resources = {} as import('../server/cognition/conversation_execution').ConversationResourceLifetime;
    const pending = prepareVoiceIdentityAndAdmission(socket as any, socket.data.audioSession, 'A queued conversation question.', {} as any, () => ({}), io as any, undefined, true, {}, resources);
    const rejected = expect(pending).rejects.toThrow(/deleted|available|cancelled/);
    try {
      await vi.waitFor(() => expect(resources.admission?.waitingForRequestId).toBe('foreground-before-selected-voice'));
      const active = startNewConversation(userId, 'lumi', 'personal', '');
      const db = readDB(); db.conversations = db.conversations.filter((row: any) => row.id !== selected.id); writeDB(db);
      await vi.waitFor(() => expect(resources.admission?.controller.signal.aborted).toBe(true));
      foreground.release(); await rejected;
      expect(getMessages(active.id).some(row => row.message === 'A queued conversation question.')).toBe(false);
      expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id).toBe(active.id);
    } finally { foreground.release(); resources.admission?.release(); await pending.catch(() => undefined); await socket.receive('audio:stop'); }
  });

  it('keeps the mounted hook selected transcript through a reconnect', async () => {
    const { getOrCreateActiveConversation, startNewConversation } = await import('../server/conversation/manager');
    const { socket } = createFixture();
    const userId = socket.data.authenticatedUserId;
    const selected = getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const active = startNewConversation(userId, 'lumi', 'personal', '');
    class FixtureAudioContext {
      state = 'running'; currentTime = 0; destination = {};
      createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() { return { onaudioprocess: null, connect() {}, disconnect() {} }; }
      async resume() { this.state = 'running'; }
      async close() { this.state = 'closed'; }
    }
    vi.stubGlobal('AudioContext', FixtureAudioContext);
    const outbound: Array<[string, any]> = [];
    const pending: Promise<void>[] = [];
    class Client extends EventEmitter {
      connected = true; volatile = this;
      emit(event: string, data?: any) { outbound.push([event, data]); pending.push(socket.receive(event, data)); return true; }
      deliver(event: string, data?: any) { return super.emit(event, data); }
    }
    const client = new Client(); socket.receiver = (event, data) => client.deliver(event, data);
    const hook = renderHook(() => useVoiceCall({ socket: client }));
    try {
      await act(async () => { await hook.result.current.startCall(undefined, 'lumi', 'lumi', { domain: 'personal', conversationId: selected.id }); await Promise.all(pending); });
      expect(hook.result.current.callState).toBe('listening');
      await act(async () => { client.connected = false; client.deliver('disconnect'); });
      await act(async () => { client.connected = true; client.deliver('connect'); await Promise.all(pending); });
      const starts = outbound.filter(([event]) => event === 'audio:start');
      expect(starts).toHaveLength(2);
      expect(starts.every(([, payload]) => payload.conversationId === selected.id)).toBe(true);
      expect(socket.data.audioSession.conversationId).toBe(selected.id);
      expect(getOrCreateActiveConversation(userId, 'lumi', 'personal', '').id).toBe(active.id);
    } finally { hook.unmount(); socket.receiver = undefined; await socket.receive('audio:stop'); vi.unstubAllGlobals(); }
  });
});
