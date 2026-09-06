import './helpers';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

const fixture = vi.hoisted(() => ({ manager: null as any, stts: [] as any[], model: vi.fn(), synthesis: vi.fn() }));
vi.mock('../server/memory_avatar/portrait_sessions', async original => {
  const actual = await original<typeof import('../server/memory_avatar/portrait_sessions')>();
  const { runtimeBackgroundWork } = await import('../server/runtime/shutdown_work');
  // Replace singleton selection only. The actual sessions, provider, repository,
  // lifecycle and private media functions execute unchanged below.
  return { ...actual,
    getMemoryAvatarPortraitSessions: () => fixture.manager,
    isMemoryAvatarPortraitReady: (scope: any) => fixture.manager.ready(scope),
    speakMemoryAvatarPortrait: (input: any) => runtimeBackgroundWork.track(fixture.manager.speak(input)),
    stopMemoryAvatarPortrait: (scope: any) => runtimeBackgroundWork.track(fixture.manager.stop(scope)),
  };
});
vi.mock('../server/llm/providers', async original => ({ ...await original<typeof import('../server/llm/providers')>(), makeLLMCall: (...args: any[]) => fixture.model(...args) }));
vi.mock('../server/memory', async original => ({ ...await original<typeof import('../server/memory')>(), queryMemoriesVector: async () => [] }));
vi.mock('../server/agents/rag', () => ({ retrieveChunks: async () => [] }));
vi.mock('../server/stt/adapter', () => ({
  getActiveStreamingSTTProvider: () => 'ark',
  createResilientStreamingSession: () => {
    const stt = { end: vi.fn(), sendAudio: vi.fn(), result: null as any, error: null as any,
      onResult(fn: any) { stt.result = fn; }, onError(fn: any) { stt.error = fn; } };
    fixture.stts.push(stt); return stt;
  },
}));
vi.mock('../server/tts/adapter', () => ({ getActiveProvider: () => 'ark', listVoices: async () => [{ voiceId: 'default-fixture' }], synthesizeSpeech: (...args: any[]) => fixture.synthesis(...args) }));

import { initDatabase, closeDatabase, flushDBOrThrow, readDB } from '../db_layer';
import { getDataPath } from '../server/config/data_path';
import { createMemoryAvatar, updateMemoryAvatar } from '../server/memory_avatar/store';
import { uploadMemoryAvatarMedia } from '../server/memory_avatar/media';
import { avatarMediaDirectory } from '../server/memory_avatar/media_files';
import { MemoryAvatarPortraitSessions } from '../server/memory_avatar/portrait_sessions';
import { DidPortraitProvider } from '../server/memory_avatar/portrait_provider';
import { PortraitRepository } from '../server/memory_avatar/portrait_repository';
import { registerMemoryAvatarVoiceHandlers } from '../server/socket/memory_avatar_voice';
import { createVoiceCallAdmission } from '../server/socket/voice_call_admission';
import { runtimeBackgroundWork } from '../server/runtime/shutdown_work';
import { isRealtimeUserActive } from '../server/autonomy/foreground_activity';

class TestSocket extends EventEmitter {
  id = `integration-${randomUUID()}`;
  userId = `synthetic-owner-${randomUUID()}`;
  connected = true;
  data = { authenticatedOrgId: '', authenticatedUserId: this.userId };
  outputs: Array<[string, any]> = [];
  emit(event: string, value?: any): boolean { this.outputs.push([event, value]); return true; }
  async receive(event: string, value?: any) { await Promise.all(this.listeners(event).map(fn => fn(value))); }
}
type ProviderCall = { route: string; method: string; body: any; signal: AbortSignal };
let socket: TestSocket;
let manager: MemoryAvatarPortraitSessions;
let repository: PortraitRepository;
let avatarId: string;
let calls: ProviderCall[];
let intercept: ((call: ProviderCall) => Promise<Response> | undefined) | undefined;
let releaseGates: Array<() => void>;
const answer = { type: 'answer' as const, sdp: 'v=0\r\ns=synthetic-answer\r\n' };
const json = (body: any) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const scope = (callSessionId: string) => ({ userId: socket.userId, avatarId, callSessionId });
const audioInput = (sessionId: string) => ({ avatarId, sessionId, portrait: true });
const renderPosts = () => calls.filter(call => call.method === 'POST' && /^\/agents\/[^/]+\/streams\/[^/]+$/.test(call.route));

async function ready(callSessionId: string) {
  const input = { ...scope(callSessionId), clientRequestId: randomUUID(), cloudConsent: true };
  const offered = await manager.create(input);
  await manager.answer(input, offered.portraitSessionId, answer);
  return repository.read(socket.userId).sessions.find(row => row.id === offered.portraitSessionId)!;
}

beforeAll(() => initDatabase());
beforeEach(async () => {
  // All outbound service work must use the explicitly injected synthetic D-ID
  // transport. An accidental real fetch anywhere else fails this test.
  vi.stubGlobal('fetch', () => { throw new Error('Real network is forbidden in portrait/voice integration tests.'); });
  calls = []; intercept = undefined; releaseGates = []; fixture.stts = [];
  fixture.model.mockReset().mockResolvedValue({ text: 'A synthetic reply about the garden.', toolCalls: [] });
  fixture.synthesis.mockReset().mockResolvedValue({ audioBuffer: Buffer.from('synthetic-encoded-audio'), format: 'mp3' });
  socket = new TestSocket();
  const avatar = await createMemoryAvatar({ userId: socket.userId, name: 'Synthetic person', voice: { voiceId: 'default-fixture' } });
  avatarId = avatar.id;
  const filename = path.join(avatarMediaDirectory(socket.userId, avatarId), `.upload-${randomUUID()}`);
  const image = await (sharp as any)({ create: { width: 24, height: 24, channels: 3, background: '#779966' } }).png().toBuffer();
  fs.writeFileSync(filename, image);
  const saved = await uploadMemoryAvatarMedia(socket.userId, avatarId, { path: filename, title: 'Synthetic portrait', clientRequestId: randomUUID(), revision: avatar.revision });
  await updateMemoryAvatar(socket.userId, avatarId, { revision: saved.avatar.revision, presentation: { mode: 'portrait', mediaId: saved.media.id } });
  const directory = getDataPath(`portrait-integration-${randomUUID()}`);
  repository = new PortraitRepository({ directory, platform: 'linux', files: {
    ensurePrivateDirectory(folder) { fs.mkdirSync(folder, { recursive: true, mode: 0o700 }); },
    writeTextAtomic(target, text) {
      const temporary = `${target}.tmp`; const fd = fs.openSync(temporary, 'w', 0o600);
      try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, target);
    },
  } });
  const provider = new DidPortraitProvider((async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://api.d-id.com') throw new Error('Unexpected provider endpoint.');
    const call: ProviderCall = { route: url.pathname, method: String(init?.method), body: init?.body instanceof FormData ? init.body : init?.body ? JSON.parse(String(init.body)) : undefined, signal: init!.signal as AbortSignal };
    calls.push(call); const held = intercept?.(call); if (held) return held;
    const id = String(calls.length);
    if (call.method === 'DELETE') return new Response(null, { status: 204 });
    if (call.route === '/images') return json({ id: `image-${id}`, url: `https://private-fixture.s3.amazonaws.com/${id}.jpg` });
    if (call.route === '/audios') return json({ id: `audio-${id}`, url: `https://private-fixture.s3.amazonaws.com/${id}.mp3` });
    if (call.route === '/agents') return json({ id: `agent-${id}` });
    if (call.route.endsWith('/streams')) return json({ id: `stream-${id}`, session_id: `synthetic-session-${id}`, jsep: { type: 'offer', sdp: 'v=0\r\ns=synthetic-offer\r\n' }, ice_servers: [] });
    return json({});
  }) as typeof fetch);
  manager = new MemoryAvatarPortraitSessions({ repository, provider, readyWaitMs: 1000 }); fixture.manager = manager;
  await manager.configure(socket.userId, { apiKey: 'synthetic-user:synthetic-password', cloudConsent: true });
  registerMemoryAvatarVoiceHandlers(socket as any, {} as any, current => (current as any).userId, createVoiceCallAdmission());
});
afterEach(async () => {
  for (const release of releaseGates) release();
  intercept = undefined;
  if (socket) await socket.receive('disconnect');
  if (manager && repository && socket) {
    for (const record of repository.read(socket.userId).sessions) await manager.stopById(scope(record.callSessionId), record.id).catch(() => {});
  }
  await runtimeBackgroundWork.waitForIdle(); await flushDBOrThrow(); vi.unstubAllGlobals();
});

it('takes a saved private source through the real voice and renderer pipeline, then durably cleans known resources', async () => {
  const callSessionId = 'normal-call'; const record = await ready(callSessionId);
  await socket.receive('avatar:audio:start', audioInput(callSessionId));
  await fixture.stts[0].result({ text: 'Tell me about this garden', isFinal: true });
  expect(fixture.model).toHaveBeenCalledOnce(); expect(fixture.model.mock.calls[0][1]).toEqual([]);
  expect(fixture.synthesis).toHaveBeenCalledOnce(); expect(renderPosts()).toHaveLength(1);
  expect(socket.outputs.filter(([event]) => event === 'avatar:audio:response')).toEqual([]);
  expect(socket.outputs.filter(([event]) => event === 'avatar:agent:response')).toHaveLength(1);
  const receipt = repository.read(socket.userId).sessions.find(row => row.id === record.id)!;
  expect(Object.values(receipt.speeches).map(speech => speech.status)).toEqual(['accepted']);
  expect((readDB().interactions || []).filter((row: any) => row.agentId === avatarId && row.role === 'assistant')).toHaveLength(1);
  await socket.receive('avatar:audio:stop', audioInput(callSessionId)); await runtimeBackgroundWork.waitForIdle();
  const stopped = repository.read(socket.userId).sessions.find(row => row.id === record.id)!;
  expect(stopped).toMatchObject({ stopRequested: true, audioIds: [] });
  expect(stopped.stream).toBeUndefined(); expect(stopped.agentId).toBeUndefined(); expect(stopped.imageId).toBeUndefined(); expect(stopped.credential).toBeUndefined();
  expect(fixture.stts[0].end).toHaveBeenCalled(); expect(manager.ready(scope(callSessionId))).toBe(false);
  await closeDatabase(); await initDatabase();
  const savedReplies = (readDB().interactions || []).filter((row: any) => row.agentId === avatarId && row.role === 'assistant');
  expect(savedReplies).toHaveLength(1); expect(savedReplies[0].message).toBe('A synthetic reply about the garden.');
});

it.each(['stop', 'interrupt'] as const)('%s aborts the real provider request and drains delayed old deletion without deleting the replacement', async action => {
  const oldSessionId = 'old-call'; const old = await ready(oldSessionId);
  const oldRoute = `/agents/${old.agentId}/streams/${old.stream!.id}`;
  const rendering = deferred<AbortSignal>(); const deleting = deferred(); const releaseDelete = deferred();
  releaseGates.push(() => releaseDelete.resolve()); let deletionHeld = false;
  intercept = call => {
    if (call.method === 'POST' && call.route === oldRoute) {
      rendering.resolve(call.signal);
      return new Promise((_resolve, reject) => {
        const abort = () => reject(call.signal.reason);
        call.signal.addEventListener('abort', abort, { once: true }); if (call.signal.aborted) abort();
      });
    }
    if (call.method === 'DELETE' && call.route === oldRoute && !deletionHeld) {
      deletionHeld = true; deleting.resolve();
      return releaseDelete.promise.then(() => new Response(null, { status: 204 }));
    }
  };
  await socket.receive('avatar:audio:start', audioInput(oldSessionId)); const oldStt = fixture.stts[0];
  const oldTurn = oldStt.result({ text: 'First pending reply', isFinal: true }); const providerSignal = await rendering.promise;
  let stopped = false;
  const ending = socket.receive(`avatar:audio:${action}`, audioInput(oldSessionId)).then(() => { stopped = true; });
  await deleting.promise; expect(providerSignal.aborted).toBe(true); expect(manager.ready(scope(oldSessionId))).toBe(false);
  // The actual frontend opens a new stream after the interrupt ack, while a
  // stopped call starts a distinct voice session. Keep old DELETE held in both.
  const nextSessionId = action === 'stop' ? 'new-call' : oldSessionId;
  const replacement = await ready(nextSessionId); const replacementRoute = `/agents/${replacement.agentId}/streams/${replacement.stream!.id}`;
  let newStart: Promise<void> = Promise.resolve(); let started = false;
  if (action === 'stop') {
    expect(oldStt.end).toHaveBeenCalled(); expect(isRealtimeUserActive(socket.userId, 0)).toBe(false);
    newStart = socket.receive('avatar:audio:start', audioInput(nextSessionId)).then(() => { started = true; });
    await oldStt.result({ text: 'An obsolete callback after stop', isFinal: true });
  } else {
    expect(socket.outputs.some(([event]) => event === 'avatar:audio:interrupt-ack')).toBe(true);
    expect(oldStt.end).not.toHaveBeenCalled();
  }
  await new Promise(resolve => setTimeout(resolve, 25));
  expect(stopped).toBe(false); expect(started).toBe(false); expect(fixture.stts).toHaveLength(1);
  expect(fixture.model).toHaveBeenCalledOnce(); expect(fixture.synthesis).toHaveBeenCalledOnce();
  expect(calls.filter(call => call.method === 'DELETE' && call.route === replacementRoute)).toEqual([]);
  releaseDelete.resolve(); await Promise.all([oldTurn, ending, newStart]); await runtimeBackgroundWork.waitForIdle();
  expect(stopped).toBe(true); expect(manager.ready(scope(nextSessionId))).toBe(true);
  expect(calls.filter(call => call.method === 'DELETE' && call.route === replacementRoute)).toEqual([]);
  const after = repository.read(socket.userId).sessions.find(row => row.id === old.id)!;
  expect(after.stopRequested).toBe(true); expect(after.stream).toBeUndefined(); expect(after.agentId).toBeUndefined();
  expect(Object.values(after.speeches).map(speech => speech.status)).toEqual(['unknown']);
  const nextStt = fixture.stts.at(-1); if (action === 'stop') expect(nextStt).not.toBe(oldStt);
  await nextStt.result({ text: 'A fresh question after cleanup', isFinal: true });
  expect(fixture.model).toHaveBeenCalledTimes(2); expect(fixture.synthesis).toHaveBeenCalledTimes(2);
  expect(renderPosts().map(call => call.route)).toEqual([oldRoute, replacementRoute]);
  expect(socket.outputs.filter(([event]) => event === 'avatar:audio:response')).toEqual([]);
  await socket.receive('avatar:audio:stop', audioInput(nextSessionId));
});
