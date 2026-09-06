import './helpers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import sharp from 'sharp';

const fixture = vi.hoisted(() => ({
  model: vi.fn(), synthesis: vi.fn(), stts: [] as any[], provider: 'ark' as string | null,
  strict: false, flush: null as null | ((actual: () => Promise<void>) => Promise<void>),
  memories: vi.fn(async () => []), rag: vi.fn(async () => []),
  portraitReady: true, portraitSpeak: vi.fn(), portraitStop: vi.fn(),
}));
vi.mock('../server/memory_avatar/portrait_sessions', () => ({
  isMemoryAvatarPortraitReady: () => fixture.portraitReady,
  speakMemoryAvatarPortrait: (...args: any[]) => fixture.portraitSpeak(...args),
  stopMemoryAvatarPortrait: (...args: any[]) => fixture.portraitStop(...args),
}));
vi.mock('../db_layer', async original => {
  const actual = await original<typeof import('../db_layer')>();
  return { ...actual, flushDBOrThrow: () => fixture.flush ? fixture.flush(actual.flushDBOrThrow) : actual.flushDBOrThrow() };
});
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: (...args: any[]) => fixture.model(...args) }));
vi.mock('../server/memory', async original => ({ ...await original<typeof import('../server/memory')>(), queryMemoriesVector: (...args: any[]) => (fixture.memories as any)(...args) }));
vi.mock('../server/agents/rag', () => ({ retrieveChunks: (...args: any[]) => (fixture.rag as any)(...args) }));
vi.mock('../server/config/privacy', async original => ({ ...await original<typeof import('../server/config/privacy')>(), isStrictPrivacy: () => fixture.strict }));
vi.mock('../server/stt/adapter', () => ({
  getActiveStreamingSTTProvider: () => fixture.strict ? null : fixture.provider,
  createResilientStreamingSession: () => {
    const stt = { end: vi.fn(), sendAudio: vi.fn(), result: null as any, error: null as any,
      onResult(fn: any) { stt.result = fn; }, onError(fn: any) { stt.error = fn; } };
    fixture.stts.push(stt); return stt;
  },
}));
vi.mock('../server/tts/adapter', () => ({ getActiveProvider: () => 'ark', listVoices: async () => [{ voiceId: 'default-fixture' }], synthesizeSpeech: (...args: any[]) => fixture.synthesis(...args) }));

import { initDatabase, readDB, flushDBOrThrow } from '../db_layer';
import { createMemoryAvatar, archiveMemoryAvatar } from '../server/memory_avatar/store';
import { registerVoiceHandlers } from '../server/socket/voice';
import { registerMemoryAvatarVoiceHandlers } from '../server/socket/memory_avatar_voice';
import { createVoiceCallAdmission } from '../server/socket/voice_call_admission';
import { getOrCreateActiveConversation, addMessage, getMessages } from '../server/conversation/manager';
import { isRealtimeUserActive } from '../server/autonomy/foreground_activity';

class Socket extends EventEmitter {
  id = `fixture-${Math.random()}`; connected = true; userId = `fixture-user-${Math.random()}`;
  data = { authenticatedOrgId: '' };
  outputs: Array<[string, any]> = [];
  emit(event: string, data?: any): boolean { this.outputs.push([event, data]); return true; }
  async receive(event: string, data?: any) { await Promise.all(this.listeners(event).map(fn => fn(data))); }
}
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function setup(portrait = false, orgId = '') {
  const socket = new Socket();
  socket.data.authenticatedOrgId = orgId;
  const avatar = await createMemoryAvatar({ userId: socket.userId, name: 'Mira', voice: { voiceId: 'default-fixture' }, narrative: 'Mira enjoys observing garden birds.', seedMemories: [{ content: 'Our favorite flower was lavender.' }] });
  const admission = createVoiceCallAdmission();
  registerMemoryAvatarVoiceHandlers(socket as any, {} as any, s => (s as any).userId, admission);
  const data = { avatarId: avatar.id, sessionId: 'fixture-call-a', portrait };
  await socket.receive('avatar:audio:start', data);
  const stt = fixture.stts.at(-1);
  return { socket, avatar, data, stt, admission };
}
const terminal = (socket: Socket) => socket.outputs.filter(([event]) => event === 'avatar:agent:response');
beforeAll(() => initDatabase());
beforeEach(() => {
  fixture.stts = []; fixture.provider = 'ark'; fixture.strict = false; fixture.flush = null;
  fixture.model.mockReset().mockResolvedValue({ text: 'I remember the lavender garden.', toolCalls: [] });
  fixture.synthesis.mockReset().mockResolvedValue({ audioBuffer: Buffer.from([1, 2, 3]), format: 'wav' });
  fixture.memories.mockClear(); fixture.rag.mockClear();
  fixture.portraitReady = true; fixture.portraitSpeak.mockReset().mockResolvedValue({ status: 'accepted' });
  fixture.portraitStop.mockReset().mockResolvedValue(undefined);
});

describe('private Memory Territory voice handlers', () => {
  it('rejects a work-scoped socket before opening private speech recognition', async () => {
    const { socket } = await setup(false, 'organization');
    expect(fixture.stts).toHaveLength(0);
    expect(socket.outputs.at(-1)?.[1].code).toBe('AVATAR_UNAVAILABLE');
  });

  it('releases private input and prevents a late reply after changing to a work session', async () => {
    const { socket, data, stt } = await setup(true);
    const gate = deferred<any>(); fixture.model.mockReturnValueOnce(gate.promise);
    const pending = stt.result({ text: 'A private memory', isFinal: true });
    await vi.waitFor(() => expect(fixture.model).toHaveBeenCalledOnce());
    socket.data.authenticatedOrgId = 'organization'; gate.resolve({ text: 'Private reply' }); await pending;
    expect(stt.end).toHaveBeenCalled(); expect(fixture.portraitSpeak).not.toHaveBeenCalled();
    expect(fixture.synthesis).not.toHaveBeenCalled(); expect(terminal(socket)).toEqual([]);
    await socket.receive('avatar:audio:stop', data);
  });

  it('uses the saved reply and existing TTS to speak through the portrait without duplicate local audio', async () => {
    const { socket, data, stt, avatar } = await setup(true);
    await stt.result({ text: 'Tell me about the garden', isFinal: true });
    expect(fixture.portraitSpeak).toHaveBeenCalledOnce();
    expect(fixture.portraitSpeak).toHaveBeenCalledWith(expect.objectContaining({ userId: socket.userId, avatarId: avatar.id,
      callSessionId: data.sessionId, audioBuffer: Buffer.from([1, 2, 3]), format: 'wav', signal: expect.any(AbortSignal) }));
    expect(terminal(socket)).toHaveLength(1);
    expect(socket.outputs.filter(([event]) => event === 'avatar:audio:response')).toEqual([]);
    await socket.receive('avatar:audio:stop', data);
    expect(fixture.portraitStop).toHaveBeenCalledWith(expect.objectContaining({ userId: socket.userId, avatarId: avatar.id, callSessionId: data.sessionId }));
  });

  it('does not open recognition before the portrait is ready', async () => {
    fixture.portraitReady = false;
    const { socket } = await setup(true);
    expect(fixture.stts).toHaveLength(0);
    expect(socket.outputs.some(([event, data]) => event === 'avatar:audio:error' && data.code === 'PORTRAIT_UNAVAILABLE')).toBe(true);
    expect(fixture.portraitStop).toHaveBeenCalledOnce();
  });

  it('keeps the durable text when renderer acceptance is unknown, without replaying speech', async () => {
    fixture.portraitSpeak.mockRejectedValueOnce(new Error('Upstream response lost'));
    const { socket, data, stt } = await setup(true);
    await stt.result({ text: 'Remember our walk?', isFinal: true });
    expect(terminal(socket)).toHaveLength(1);
    expect(socket.outputs.some(([event, data]) => event === 'avatar:audio:tts_error' && data.code === 'PORTRAIT_UNAVAILABLE')).toBe(true);
    expect(socket.outputs.filter(([event]) => event === 'avatar:audio:response')).toEqual([]);
    expect(fixture.portraitSpeak).toHaveBeenCalledOnce();
    await socket.receive('avatar:audio:stop', data);
  });

  it('uses the same private text history and frozen sources, empty tools and a durable terminal before speech', async () => {
    const { socket, avatar, data, stt } = await setup();
    const conversation = getOrCreateActiveConversation(socket.userId, avatar.id, 'personal', '');
    addMessage({ userId: socket.userId, agentId: avatar.id, conversationId: conversation.id, role: 'user', content: 'Earlier text-only conversation', skipActionContinuation: true });
    const memoryCount = readDB().memories.length;
    await stt.result({ text: 'Tell me about our favorite flower', isFinal: true });
    const [messages, tools, config] = fixture.model.mock.calls[0];
    expect(tools).toEqual([]);
    expect(JSON.stringify(messages)).toContain('Earlier text-only conversation');
    expect(messages[0].content).toContain('lavender');
    expect(messages[0].content).toContain('Mira');
    expect(config).toMatchObject({ userId: socket.userId, domain: 'personal', conversationId: conversation.id });
    expect(fixture.memories).toHaveBeenCalledWith(expect.objectContaining({ agentId: avatar.id, domain: 'personal', orgId: '' }));
    expect(readDB().memories).toHaveLength(memoryCount);
    expect(terminal(socket)).toHaveLength(1);
    expect(getMessages(conversation.id).at(-1)?.message).toBe('I remember the lavender garden.');
    expect(socket.outputs.findIndex(([event]) => event === 'avatar:agent:response')).toBeLessThan(socket.outputs.findIndex(([event]) => event === 'avatar:audio:response'));
    expect((readDB().tasks || []).filter((task: any) => task.userId === socket.userId)).toEqual([]);
    await socket.receive('avatar:audio:stop', data);
  });

  it('sends only a fresh, validated frame to the configured vision role and never stores the image', async () => {
    const { socket, avatar, data, stt } = await setup();
    const jpeg = await (sharp as any)({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).jpeg().toBuffer();
    const frame = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    await socket.receive('avatar:audio:video', { ...data, enabled: true, sequence: 1, frame });
    await stt.result({ text: 'What can you see?', isFinal: true });
    expect(fixture.model.mock.calls[0][2]).toMatchObject({ role: 'vision', noImplicitFailover: true });
    expect(fixture.model.mock.calls[0][0].at(-1).content).toContainEqual({ type: 'image_url', image_url: { url: frame, detail: 'low' } });
    const conv = getOrCreateActiveConversation(socket.userId, avatar.id, 'personal', '');
    expect(JSON.stringify(getMessages(conv.id))).not.toContain('base64');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6001);
    await stt.result({ text: 'And now?', isFinal: true }); clock.mockRestore();
    expect(fixture.model.mock.calls[1][0].at(-1).content).toBe('And now?');
    await socket.receive('avatar:audio:stop', data);
  });

  it('rejects another user, cross-call PCM/frame and invalid image input', async () => {
    const { socket, avatar, data, stt } = await setup();
    await socket.receive('avatar:audio:chunk', { ...data, sessionId: 'other', chunk: new Uint8Array([1, 2]) });
    await socket.receive('avatar:audio:chunk', { ...data, chunk: new Uint8Array([1, 2]) });
    expect(stt.sendAudio).toHaveBeenCalledOnce();
    await socket.receive('avatar:audio:video', { ...data, enabled: true, sequence: 1, frame: 'data:image/jpeg;base64,aGVsbG8=' });
    await stt.result({ text: 'A normal question', isFinal: true });
    expect(typeof fixture.model.mock.calls[0][0].at(-1).content).toBe('string');
    await socket.receive('avatar:audio:stop', data);
    socket.userId = 'a-different-account';
    await socket.receive('avatar:audio:start', { avatarId: avatar.id, sessionId: 'forbidden' });
    expect(fixture.stts).toHaveLength(1);
    expect(socket.outputs.at(-1)?.[1].code).toBe('AVATAR_UNAVAILABLE');
  });

  it.each(['camera-off', 'expired'] as const)('does not upload a captured frame after %s while acceptance is saving', async reason => {
    const { socket, data, stt } = await setup();
    const jpeg = await (sharp as any)({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).jpeg().toBuffer();
    await socket.receive('avatar:audio:video', { ...data, enabled: true, sequence: 1, frame: `data:image/jpeg;base64,${jpeg.toString('base64')}` });
    const entered = deferred(); const release = deferred(); let held = false;
    fixture.flush = async actual => { if (!held) { held = true; entered.resolve(); await release.promise; } await actual(); };
    const work = stt.result({ text: 'What is visible?', isFinal: true }); await entered.promise;
    const clock = reason === 'expired' ? vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6001) : null;
    if (reason === 'camera-off') await socket.receive('avatar:audio:video', { ...data, enabled: false });
    release.resolve(); await work; clock?.mockRestore(); fixture.flush = null;
    expect(fixture.model.mock.calls[0][0].at(-1).content).toBe('What is visible?');
    expect(fixture.model.mock.calls[0][2].role).not.toBe('vision');
    await socket.receive('avatar:audio:stop', data);
  });

  it.each(['archive', 'account-switch', 'interrupt'] as const)('a held model cannot speak or retain a late success after %s', async reason => {
    const { socket, avatar, data, stt } = await setup();
    const gate = deferred<any>(); fixture.model.mockReturnValueOnce(gate.promise);
    const work = stt.result({ text: 'Please recall our conversation', isFinal: true });
    await vi.waitFor(() => expect(fixture.model).toHaveBeenCalledOnce());
    if (reason === 'archive') await archiveMemoryAvatar(socket.userId, avatar.id, avatar.revision);
    else if (reason === 'account-switch') { socket.userId = 'new-account'; await socket.receive('avatar:audio:stop', data); }
    else await socket.receive('avatar:audio:interrupt', data);
    gate.resolve({ text: 'This late success must never be visible.' });
    await work;
    expect(terminal(socket)).toEqual([]);
    expect(fixture.synthesis).not.toHaveBeenCalled();
    const rows = (readDB().interactions || []).filter((row: any) => row.agentId === avatar.id && row.role === 'assistant');
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe('This voice reply was cancelled.');
    await socket.receive('avatar:audio:stop', data);
  });

  it.each([false, true])('manual interruption cancels queued speech and permits a fresh repeat=%s', async repeatAfterInterrupt => {
    const { socket, avatar, data, stt } = await setup();
    const entered = deferred(); const release = deferred(); let saves = 0;
    fixture.flush = async actual => { if (++saves === 2) { entered.resolve(); await release.promise; } await actual(); };
    const first = stt.result({ text: 'First question waiting for storage', isFinal: true });
    let second: Promise<void> | undefined; let repeated: Promise<void> | undefined; let interruption: Promise<void> | undefined;
    try {
      await entered.promise;
      const requestId = socket.outputs.find(([event, value]) => event === 'avatar:audio:status' && value.status === 'thinking')![1].requestId;
      second = stt.result({ text: 'Queued question', isFinal: true });
      interruption = socket.receive('avatar:audio:interrupt', { ...data, requestId, source: 'user_control' });
      expect(socket.outputs.at(-1)).toEqual(['avatar:audio:interrupt-ack', expect.objectContaining({ requestId, workContinues: false })]);
      if (repeatAfterInterrupt) repeated = stt.result({ text: 'Queued question', isFinal: true });
      release.resolve(); await Promise.all([first, second, interruption, repeated]); fixture.flush = null;
      expect(fixture.model).toHaveBeenCalledTimes(repeatAfterInterrupt ? 2 : 1);
      expect(fixture.synthesis).toHaveBeenCalledTimes(repeatAfterInterrupt ? 1 : 0);
      const transcripts = socket.outputs.filter(([event]) => event === 'avatar:audio:transcript').map(([, value]) => value.text);
      expect(transcripts).toEqual(repeatAfterInterrupt ? ['First question waiting for storage', 'Queued question'] : ['First question waiting for storage']);
      const conversation = getOrCreateActiveConversation(socket.userId, avatar.id, 'personal', '');
      const history = getMessages(conversation.id);
      expect(history.filter(row => row.role === 'user' && row.message === 'Queued question')).toHaveLength(repeatAfterInterrupt ? 1 : 0);
      expect(history.filter(row => row.role === 'assistant' && row.message === 'This voice reply was cancelled.')).toHaveLength(1);
    } finally {
      release.resolve(); await Promise.allSettled([first, second, interruption, repeated]); fixture.flush = null;
      await socket.receive('avatar:audio:stop', data);
    }
  });

  it('an interruption for an older request does not clear newer queued speech', async () => {
    const { socket, data, stt } = await setup();
    const entered = deferred(); const release = deferred(); let saves = 0;
    fixture.flush = async actual => { if (++saves === 2) { entered.resolve(); await release.promise; } await actual(); };
    const first = stt.result({ text: 'Current question', isFinal: true });
    let second: Promise<void> | undefined;
    try {
      await entered.promise;
      second = stt.result({ text: 'Newer queued question', isFinal: true });
      const before = socket.outputs.length;
      await socket.receive('avatar:audio:interrupt', { ...data, requestId: 'stale-request', source: 'user_control' });
      expect(socket.outputs).toHaveLength(before);
      release.resolve(); await Promise.all([first, second]); fixture.flush = null;
      expect(fixture.model).toHaveBeenCalledTimes(2);
      expect(fixture.model.mock.calls[1][0].at(-1).content).toBe('Newer queued question');
      expect(fixture.synthesis).toHaveBeenCalledOnce();
    } finally {
      release.resolve(); await Promise.allSettled([first, second]); fixture.flush = null;
      await socket.receive('avatar:audio:stop', data);
    }
  });

  it('archive while the terminal flush is held rewrites the unpublished success before releasing', async () => {
    const { socket, avatar, data, stt } = await setup();
    const entered = deferred(); const release = deferred(); let count = 0;
    fixture.flush = async actual => { count++; if (count === 2) { entered.resolve(); await release.promise; } await actual(); };
    const work = stt.result({ text: 'Tell me a story', isFinal: true });
    await entered.promise;
    const archive = archiveMemoryAvatar(socket.userId, avatar.id, avatar.revision);
    await vi.waitFor(() => expect(readDB().memoryAvatars.find((row: any) => row.id === avatar.id)?.status).toBe('archived'));
    release.resolve(); await Promise.all([work, archive]);
    expect(terminal(socket)).toHaveLength(0); expect(fixture.synthesis).not.toHaveBeenCalled();
    expect((readDB().interactions || []).find((row: any) => row.agentId === avatar.id && row.role === 'assistant')?.message).toBe('This voice reply was cancelled.');
    fixture.flush = null; await socket.receive('avatar:audio:stop', data);
  });

  it('failed terminal durability quarantines the reply and emits neither success nor audio', async () => {
    const { socket, avatar, data, stt } = await setup(); let count = 0;
    fixture.flush = async actual => { if (++count >= 2) throw new Error('synthetic disk failure'); await actual(); };
    await stt.result({ text: 'Remember this', isFinal: true });
    expect(terminal(socket)).toHaveLength(0); expect(fixture.synthesis).not.toHaveBeenCalled();
    const rows = (readDB().interactions || []).filter((row: any) => row.agentId === avatar.id && row.role === 'assistant');
    expect(rows[0]?.message).not.toBe('I remember the lavender garden.');
    expect(socket.outputs.some(([event, payload]) => event === 'avatar:audio:error' && payload.code === 'PERSISTENCE_UNKNOWN')).toBe(true);
    fixture.flush = null; await flushDBOrThrow(); await socket.receive('avatar:audio:stop', data);
  });

  it('old stop waiting for cancellation cannot erase the new call', async () => {
    const { socket, data, stt } = await setup();
    const model = deferred<any>(); fixture.model.mockReturnValueOnce(model.promise);
    const work = stt.result({ text: 'An old question', isFinal: true });
    await vi.waitFor(() => expect(fixture.model).toHaveBeenCalledOnce());
    const gate = deferred(); const entered = deferred(); let held = false;
    fixture.flush = async actual => { if (!held) { held = true; entered.resolve(); await gate.promise; } await actual(); };
    const oldStop = socket.receive('avatar:audio:stop', data); await entered.promise;
    const next = { ...data, sessionId: 'fixture-call-b' };
    const nextStart = socket.receive('avatar:audio:start', next);
    gate.resolve(); await Promise.all([oldStop, nextStart, work]); fixture.flush = null;
    const latest = fixture.stts.at(-1);
    expect(latest).not.toBe(stt); expect(latest.end).not.toHaveBeenCalled();
    model.resolve({ text: 'Late old reply' });
    await latest.result({ text: 'The new question', isFinal: true });
    expect(terminal(socket).at(-1)?.[1].sessionId).toBe(next.sessionId);
    await socket.receive('avatar:audio:stop', next);
  });

  it.each(['strict', 'stt-failure', 'tts-failure'] as const)('%s preserves the documented availability and cleanup boundary', async failure => {
    if (failure === 'strict') fixture.strict = true;
    const { socket, data, stt } = await setup();
    if (failure === 'strict') {
      expect(fixture.stts).toHaveLength(0); expect(socket.outputs.some(([, p]) => p.code === 'STRICT_VOICE_UNAVAILABLE')).toBe(true);
    } else if (failure === 'stt-failure') {
      stt.error(new Error('synthetic')); await vi.waitFor(() => expect(stt.end).toHaveBeenCalled());
      expect(isRealtimeUserActive(socket.userId, 0)).toBe(false);
    } else {
      fixture.synthesis.mockRejectedValueOnce(new Error('synthetic TTS failure'));
      await stt.result({ text: 'One response', isFinal: true });
      expect(terminal(socket)).toHaveLength(1); expect(stt.end).not.toHaveBeenCalled();
      expect(socket.outputs.some(([event]) => event === 'avatar:audio:tts_error')).toBe(true);
    }
    await socket.receive('avatar:audio:stop', data);
  });

  it('the real registration hands a meeting microphone to an avatar and back to Lumi without overlapping STT', async () => {
    const socket = new Socket();
    (socket as any).data = { authenticatedUserId: socket.userId };
    const avatar = await createMemoryAvatar({ userId: socket.userId, name: 'Aster', voice: { voiceId: 'default-fixture' } });
    registerVoiceHandlers(socket as any, {} as any, () => ({}), s => (s as any).userId, {} as any);
    await socket.receive('audio:start', { sessionId: 'meeting-before', transcriptionOnly: true, meetingId: 'fixture-meeting', domain: 'personal' });
    const meetingStt = fixture.stts.at(-1);
    await socket.receive('avatar:audio:start', { avatarId: avatar.id, sessionId: 'avatar-between' });
    const avatarStt = fixture.stts.at(-1);
    expect(meetingStt.end).toHaveBeenCalled(); expect(avatarStt).not.toBe(meetingStt);
    await socket.receive('audio:start', { sessionId: 'lumi-after', domain: 'personal' });
    expect(avatarStt.end).toHaveBeenCalled();
    expect(fixture.stts.at(-1)).not.toBe(avatarStt);
    expect((socket as any).data.audioSession.isActive).toBe(true);
    await socket.receive('audio:stop', { sessionId: 'lumi-after' });
  });

  it('a stop cancels a pending Lumi start while the old avatar cancellation is still saving', async () => {
    const socket = new Socket(); (socket as any).data = { authenticatedUserId: socket.userId };
    const avatar = await createMemoryAvatar({ userId: socket.userId, name: 'Aster', voice: { voiceId: 'default-fixture' } });
    registerVoiceHandlers(socket as any, {} as any, () => ({}), s => (s as any).userId, {} as any);
    await socket.receive('avatar:audio:start', { avatarId: avatar.id, sessionId: 'old-avatar' });
    const model = deferred<any>(); fixture.model.mockReturnValueOnce(model.promise);
    const work = fixture.stts.at(-1).result({ text: 'Waiting for an answer', isFinal: true });
    await vi.waitFor(() => expect(fixture.model).toHaveBeenCalledOnce());
    const gate = deferred(); const entered = deferred(); let held = false;
    fixture.flush = async actual => { if (!held) { held = true; entered.resolve(); await gate.promise; } await actual(); };
    const mainStart = socket.receive('audio:start', { sessionId: 'pending-main', domain: 'personal' });
    await entered.promise;
    await socket.receive('audio:stop', { sessionId: 'pending-main' });
    gate.resolve(); await Promise.all([work, mainStart]); fixture.flush = null;
    model.resolve({ text: 'Late answer' });
    expect(fixture.stts).toHaveLength(1);
    expect((socket as any).data.audioSession?.isActive).not.toBe(true);
  });

  it('STT failure cleanup stays in the handover and disconnect drain until the old cancellation is saved', async () => {
    const { socket, data, stt } = await setup();
    const model = deferred<any>(); fixture.model.mockReturnValueOnce(model.promise);
    const work = stt.result({ text: 'Waiting before STT fails', isFinal: true });
    await vi.waitFor(() => expect(fixture.model).toHaveBeenCalledOnce());
    const entered = deferred(); const gate = deferred(); let held = false;
    fixture.flush = async actual => { if (!held) { held = true; entered.resolve(); await gate.promise; } await actual(); };
    stt.error(new Error('synthetic STT failure')); await entered.promise;
    const secondStart = socket.receive('avatar:audio:start', { ...data, sessionId: 'call-b' });
    let drained = false;
    const disconnect = socket.receive('disconnect').then(() => { drained = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(drained).toBe(false); expect(fixture.stts).toHaveLength(1);
    gate.resolve(); await Promise.all([work, secondStart, disconnect]); fixture.flush = null;
    model.resolve({ text: 'Old answer' });
    expect(drained).toBe(true); expect(fixture.stts).toHaveLength(1);
  });

  it('the model deadline closes the call with a visible error instead of silently dropping the turn', async () => {
    const { socket, data, stt } = await setup();
    const model = deferred<any>(); fixture.model.mockReturnValueOnce(model.promise);
    const originalTimer = globalThis.setTimeout;
    let deadline: (() => void) | undefined;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms: number, ...args: any[]) => {
      if (ms === 90_000) deadline = fn;
      return originalTimer(fn, ms, ...args);
    }) as any);
    try {
      const work = stt.result({ text: 'Wait for a slow reply', isFinal: true });
      await vi.waitFor(() => expect(fixture.model).toHaveBeenCalledOnce());
      deadline!(); await work;
      expect(socket.outputs.some(([event, payload]) => event === 'avatar:audio:error' && payload.code === 'VOICE_REPLY_TIMEOUT')).toBe(true);
      expect(stt.end).toHaveBeenCalled(); expect(terminal(socket)).toHaveLength(0);
      model.resolve({ text: 'A late response' });
      await socket.receive('avatar:audio:stop', data);
    } finally { timer.mockRestore(); }
  });
});
