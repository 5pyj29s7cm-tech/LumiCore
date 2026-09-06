import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import { DidPortraitProvider, normalizePortraitApiKey } from '../server/memory_avatar/portrait_provider';
import { PortraitRepository } from '../server/memory_avatar/portrait_repository';
import { MemoryAvatarPortraitSessions } from '../server/memory_avatar/portrait_sessions';
import { mountMemoryAvatarPortraitRoutes } from '../server/memory_avatar/portrait_routes';
import { runtimeBackgroundWork } from '../server/runtime/shutdown_work';

const mocks = vi.hoisted(() => ({ strict: false }));
vi.mock('../server/config/privacy', () => ({ isStrictPrivacy: () => mocks.strict }));
vi.mock('../server/config/local_identity', () => ({ getJwtSecret: () => 'synthetic-portrait-jwt-secret' }));
vi.mock('../server/org/db', () => ({ getMember: () => ({ status: 'active', role: 'member' }) }));
vi.mock('../server/memory_avatar/store', () => ({ getMemoryAvatar: vi.fn() }));
vi.mock('../server/memory_avatar/media', () => ({ getMemoryAvatarMediaFile: vi.fn() }));
vi.mock('../server/memory_avatar/lifecycle', () => ({ captureMemoryAvatarAuthorization: vi.fn() }));

const owner = 'portrait-owner';
const scope = { userId: owner, avatarId: 'person-one', callSessionId: 'call-one' };
const createInput = { ...scope, clientRequestId: 'create-one', cloudConsent: true };
const encodedKey = Buffer.from('synthetic-user:synthetic-password').toString('base64');
const answer = { type: 'answer' as const, sdp: 'v=0\r\ns=synthetic-answer\r\n' };
const speechInput = { ...scope, requestId: 'reply-one', audioBuffer: Buffer.from('synthetic encoded audio fixture'), format: 'mp3' };
type Call = { url: string; method: string; body: any; signal?: AbortSignal; headers: any; redirect: string };
let directory: string;
let calls: Call[];
let intercept: ((call: Call) => Promise<Response | undefined> | Response | undefined) | undefined;
let manager: MemoryAvatarPortraitSessions;
let repository: PortraitRepository;
let avatars: Map<string, any>;
let revoked: boolean;
let controllers: Set<AbortController>;
let server: Server | undefined;
let sourceRequests: string[];
let injectedSaveFailure: (() => boolean) | undefined;

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const json = (value: any, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function provider(timeoutMs = 1000) {
  return new DidPortraitProvider((async (url: any, options: any) => {
    const call: Call = { url: String(url), method: options.method, body: options.body instanceof FormData ? options.body : options.body ? JSON.parse(options.body) : undefined,
      signal: options.signal, headers: options.headers, redirect: options.redirect };
    calls.push(call);
    const replacement = await intercept?.(call); if (replacement) return replacement;
    const parsed = new URL(call.url);
    if (call.method === 'DELETE') return new Response(null, { status: 204 });
    if (parsed.pathname === '/images') return json({ id: 'image-one', url: 'https://private-bucket.s3.us-west-2.amazonaws.com/portrait/image.jpg' }, 201);
    if (parsed.pathname === '/audios') return json({ id: `audio-${calls.length}`, url: 'https://private-bucket.s3.us-west-2.amazonaws.com/portrait/audio.wav' }, 201);
    if (parsed.pathname === '/agents') return json({ id: `agent-${calls.length}` });
    if (/\/streams$/.test(parsed.pathname)) return json({ id: `stream-${calls.length}`, session_id: 'private-provider-session', jsep: { type: 'offer', sdp: 'v=0\r\ns=synthetic-offer\r\n' }, ice_servers: [{ urls: 'stun:stun.example.test:3478' }] }, 201);
    return json({});
  }) as typeof fetch, timeoutMs);
}
function newRepository() {
  return new PortraitRepository({ directory, platform: 'linux', files: {
    ensurePrivateDirectory(folder) { fs.mkdirSync(folder, { recursive: true }); },
    writeTextAtomic(filename, text) {
      if (injectedSaveFailure?.()) throw new Error('Synthetic fsync failure');
      const temporary = `${filename}.tmp`; const descriptor = fs.openSync(temporary, 'w');
      try { fs.writeFileSync(descriptor, text); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, filename);
    },
  } });
}
function newManager(extra: ConstructorParameters<typeof MemoryAvatarPortraitSessions>[0] = {}) {
  return new MemoryAvatarPortraitSessions({ repository: newRepository(), provider: provider(), readyWaitMs: 70,
    avatar: ((uid: string, id: string) => uid === owner ? avatars.get(id) : undefined) as any,
    authorize: (() => ({ isCurrent: () => !revoked, assertCurrent: () => { if (revoked) throw new DOMException('Revoked.', 'AbortError'); },
      watch: (controller: AbortController) => { controllers.add(controller); return () => controllers.delete(controller); } })) as any,
    mediaFile: ((uid: string, avatarId: string, mediaId: string, variant = 'original') => {
      if (uid !== owner || !avatars.has(avatarId) || mediaId !== avatars.get(avatarId).presentation.mediaId) throw new Error('Wrong media scope');
      sourceRequests.push(variant);
      return { path: path.join(directory, 'synthetic.jpg'), mimeType: 'image/jpeg', sizeBytes: 16, media: { id: mediaId, kind: avatars.get(avatarId).kind || 'image' } };
    }) as any, ...extra });
}
async function ready(input = createInput) { const stream = await manager.create(input); await manager.answer(input, stream.portraitSessionId, answer); return stream; }
const posted = (fragment: string) => calls.filter(call => call.method === 'POST' && call.url.endsWith(fragment));

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-portrait-test-'));
  fs.writeFileSync(path.join(directory, 'synthetic.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  calls = []; intercept = undefined; mocks.strict = false; revoked = false; controllers = new Set(); sourceRequests = []; injectedSaveFailure = undefined;
  avatars = new Map([['person-one', { status: 'active', presentation: { mode: 'portrait', mediaId: 'photo-one' } }], ['person-two', { status: 'active', presentation: { mode: 'portrait', mediaId: 'photo-two' } }]]);
  repository = newRepository(); manager = newManager();
  await manager.configure(owner, { apiKey: 'synthetic-user:synthetic-password', cloudConsent: true });
});
afterEach(async () => {
  intercept = undefined; injectedSaveFailure = undefined; mocks.strict = false;
  await manager.stop(scope).catch(() => {});
  for (const controller of [...controllers]) controller.abort();
  await runtimeBackgroundWork.waitForIdle();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined;
  fs.rmSync(directory, { recursive: true, force: true });
});

describe('D-ID renderer protocol and private configuration', () => {
  it('keeps configuration editable before a key exists and normalizes Basic credentials once', () => {
    expect(manager.config('new-owner')).toMatchObject({ configured: false, cloudAllowed: true, available: false });
    expect(normalizePortraitApiKey('synthetic-user:synthetic-password')).toBe(encodedKey);
    expect(normalizePortraitApiKey(`Basic ${encodedKey}`)).toBe(encodedKey);
    expect(() => normalizePortraitApiKey('https://other.example/key')).toThrow();
  });
  it('persists only authenticated ciphertext, reopens per owner, and rejects copied ciphertext under another owner', () => {
    expect(newManager().config(owner).configured).toBe(true);
    expect(newManager().config('other-owner').configured).toBe(false);
    const files = fs.readdirSync(directory).filter(file => file.endsWith('.json'));
    const stored = fs.readFileSync(path.join(directory, files[0]), 'utf8');
    expect(stored).not.toContain(encodedKey); expect(stored).not.toContain('synthetic-password');
    const other = requireHash('other-owner'); fs.copyFileSync(path.join(directory, files[0]), path.join(directory, `${other}.json`));
    expect(() => newManager().config('other-owner')).toThrow(/could not be opened/);
  });
  it('does not fall back to a plaintext key when Windows DPAPI fails', () => {
    const folder = path.join(directory, 'dpapi-failure');
    const vault = new PortraitRepository({ directory: folder, platform: 'win32', protection: { protectKey() { throw new Error('DPAPI unavailable'); }, unprotectKey() { return Buffer.alloc(32); } }, files: {
      ensurePrivateDirectory(target) { fs.mkdirSync(target, { recursive: true }); }, writeTextAtomic: vi.fn(),
    } });
    expect(() => vault.write(owner, repository.read(owner))).toThrow(/could not be saved/);
    expect(fs.readdirSync(folder)).toEqual([]);
  });
  it('blocks strict privacy and missing cloud consent before all provider calls', async () => {
    mocks.strict = true;
    expect(manager.config(owner)).toMatchObject({ available: false, cloudAllowed: false });
    await expect(manager.create(createInput)).rejects.toMatchObject({ code: 'portrait_privacy_blocked' });
    await expect(manager.configure(owner, { apiKey: 'user:pass', cloudConsent: true })).rejects.toMatchObject({ code: 'portrait_privacy_blocked' });
    mocks.strict = false;
    await expect(manager.create({ ...createInput, cloudConsent: false })).rejects.toMatchObject({ code: 'portrait_consent_required' });
    expect(calls).toHaveLength(0);
  });
  it('uploads private image/audio and speaks through Agents Streams without another LLM or public local URLs', async () => {
    const stream = await ready();
    expect(stream).not.toHaveProperty('session_id'); expect(stream).not.toHaveProperty('agentId');
    expect(manager.ready(scope)).toBe(true);
    await manager.ice(scope, stream.portraitSessionId, { candidate: 'candidate:synthetic', sdpMid: '0', sdpMLineIndex: 0 });
    await manager.ice(scope, stream.portraitSessionId, null);
    expect(await manager.speak(speechInput)).toMatchObject({ status: 'accepted', portraitSessionId: stream.portraitSessionId });
    expect(posted('/images')[0].body.get('image')).toBeInstanceOf(Blob);
    expect(posted('/images')[0].body.get('source_url')).toBeNull();
    expect(posted('/audios')[0].body.get('audio')).toBeInstanceOf(Blob);
    expect(posted('/agents')[0].body).toMatchObject({ presenter: { type: 'talk', thumbnail: expect.stringContaining('amazonaws.com') } });
    expect(posted('/agents')[0].body).not.toHaveProperty('llm');
    expect(posted('/streams')[0].body).toEqual({ stream_warmup: true });
    expect(calls.at(-1)?.body).toMatchObject({ session_id: 'private-provider-session', script: { type: 'audio', audio_url: expect.stringContaining('audio.wav') } });
    expect(calls.every(call => call.url.startsWith('https://api.d-id.com/') && call.headers.Authorization === `Basic ${encodedKey}` && call.redirect === 'error')).toBe(true);
    expect(calls.some(call => call.url.includes('/chat'))).toBe(false);
  });
  it('uses a video poster rather than uploading the original video', async () => {
    avatars.get('person-one').kind = 'video'; await ready(); expect(sourceRequests).toEqual(['original', 'poster']);
  });
  it('refuses provider-returned arbitrary or local asset URLs and performs no follow-up request', async () => {
    intercept = call => call.url.endsWith('/images') ? json({ id: 'image-one', url: 'https://127.0.0.1/private' }, 201) : undefined;
    await expect(manager.create(createInput)).rejects.toMatchObject({ code: 'portrait_provider_response' });
    expect(posted('/agents')).toHaveLength(0);
  });
});

describe('durable request identity and cancellation', () => {
  it('joins concurrent create retries and rejects changed owner/person/call/source identity', async () => {
    const [a, b] = await Promise.all([manager.create(createInput), manager.create(createInput)]);
    expect(a.portraitSessionId).toBe(b.portraitSessionId); expect(posted('/streams')).toHaveLength(1);
    await expect(manager.create({ ...createInput, callSessionId: 'other-call' })).rejects.toMatchObject({ code: 'portrait_request_conflict' });
    await expect(manager.answer({ ...scope, userId: 'stranger' }, a.portraitSessionId, answer)).rejects.toMatchObject({ code: 'portrait_session_not_found' });
    await expect(manager.answer({ ...scope, avatarId: 'person-two' }, a.portraitSessionId, answer)).rejects.toMatchObject({ code: 'portrait_session_not_found' });
  });
  it('persists a cancel-before-create tombstone, including after reopening', async () => {
    await manager.stopById(scope, createInput.clientRequestId, true);
    await expect(newManager().create(createInput)).rejects.toMatchObject({ code: 'portrait_request_ended' });
    expect(calls).toHaveLength(0);
  });
  it('does not create or upload if the durable reservation fails', async () => {
    injectedSaveFailure = () => true;
    await expect(manager.create(createInput)).rejects.toMatchObject({ code: 'portrait_save_failed' });
    expect(calls).toHaveLength(0);
  });
  it('retains an unknown create through reopening and never retries the paid POST', async () => {
    intercept = call => { if (call.method === 'POST' && call.url.endsWith('/streams')) throw new TypeError('Synthetic lost response'); return undefined; };
    await expect(manager.create(createInput)).rejects.toMatchObject({ code: 'portrait_outcome_unknown' });
    await expect(newManager().create(createInput)).rejects.toMatchObject({ code: 'portrait_request_ended' });
    expect(posted('/streams')).toHaveLength(1);
  });
  it('deduplicates accepted speech and rejects changed payload or unknown speech after reconnect', async () => {
    await ready(); await manager.speak(speechInput); await manager.speak(speechInput);
    expect(posted('/audios')).toHaveLength(1);
    await expect(manager.speak({ ...speechInput, audioBuffer: Buffer.from('different') })).rejects.toMatchObject({ code: 'portrait_speech_not_replayed' });
    await manager.stop(scope);
    manager = newManager(); await ready({ ...createInput, clientRequestId: 'reconnected-stream' });
    await expect(manager.speak(speechInput)).rejects.toMatchObject({ code: 'portrait_speech_not_replayed' });
    expect(posted('/audios')).toHaveLength(1);
  });
  it('keeps speech unknown after a lost rendering response and refuses automatic re-upload', async () => {
    await ready();
    intercept = call => { if (call.method === 'POST' && /\/streams\/[^/]+$/.test(new URL(call.url).pathname)) throw new Error('Synthetic response lost'); return undefined; };
    await expect(manager.speak(speechInput)).rejects.toMatchObject({ code: 'portrait_outcome_unknown' });
    intercept = undefined; manager = newManager(); await ready({ ...createInput, clientRequestId: 'new-after-unknown' });
    await expect(manager.speak(speechInput)).rejects.toMatchObject({ code: 'portrait_speech_not_replayed' });
    expect(posted('/audios')).toHaveLength(1);
  });
  it('fails closed at the final speech receipt save and does not replay after reopening', async () => {
    await ready(); let fail = false;
    intercept = call => { if (call.method === 'POST' && /\/streams\/[^/]+$/.test(new URL(call.url).pathname)) fail = true; return undefined; };
    injectedSaveFailure = () => fail;
    await expect(manager.speak(speechInput)).rejects.toMatchObject({ code: 'portrait_save_failed' });
    fail = false; injectedSaveFailure = undefined; intercept = undefined;
    manager = newManager();
    await manager.stopById(scope, createInput.clientRequestId, true);
    await ready({ ...createInput, clientRequestId: 'new-after-save-failure' });
    await expect(manager.speak(speechInput)).rejects.toMatchObject({ code: 'portrait_speech_not_replayed' });
    expect(posted('/audios')).toHaveLength(1);
  });
  it('deletes a late accepted upload even when cancellation was already deleting another resource', async () => {
    await ready(); const upload = deferred<Response>(); const deletion = deferred<Response>(); const uploadStarted = deferred<void>(); let held = false;
    intercept = call => {
      if (call.url.endsWith('/audios')) { uploadStarted.resolve(); return upload.promise; }
      if (call.method === 'DELETE' && /\/streams\/[^/]+$/.test(new URL(call.url).pathname) && !held) { held = true; return deletion.promise; }
    };
    const controller = new AbortController(); const work = manager.speak({ ...speechInput, signal: controller.signal }); const assertion = expect(work).rejects.toBeDefined();
    await uploadStarted.promise; controller.abort();
    expect(manager.ready(scope)).toBe(false);
    upload.resolve(json({ id: 'late-audio', url: 'https://private-bucket.s3.us-west-2.amazonaws.com/late.wav' }));
    deletion.resolve(new Response(null, { status: 204 })); await assertion;
    expect(calls.some(call => call.method === 'DELETE' && call.url.endsWith('/audios/late-audio'))).toBe(true);
    expect(calls.filter(call => call.method === 'POST' && /\/streams\/[^/]+$/.test(new URL(call.url).pathname))).toHaveLength(0);
    expect((manager as any).active.size).toBe(0);
  });
  it('collects a late stream after stop and never deletes the replacement stream', async () => {
    const gate = deferred<Response>(); const entered = deferred<void>(); let first = true;
    intercept = call => { if (first && call.method === 'POST' && call.url.endsWith('/streams')) { first = false; entered.resolve(); return gate.promise; } };
    const old = manager.create(createInput); const rejected = expect(old).rejects.toBeDefined(); await entered.promise;
    await manager.stop(scope);
    const replacement = await ready({ ...createInput, clientRequestId: 'replacement' });
    gate.resolve(json({ id: 'late-stream', session_id: 'late-session', jsep: { type: 'offer', sdp: 'v=0\r\n' }, ice_servers: [] }));
    await rejected;
    expect(calls.some(call => call.method === 'DELETE' && call.url.endsWith('/streams/late-stream'))).toBe(true);
    expect(manager.ready(scope)).toBe(true);
    await manager.answer(scope, replacement.portraitSessionId, answer);
  });
  it('revokes an active source synchronously and refuses later TTS uploads', async () => {
    await ready(); revoked = true; for (const controller of [...controllers]) controller.abort();
    expect(manager.ready(scope)).toBe(false);
    await expect(manager.speak(speechInput)).rejects.toBeDefined();
    expect(posted('/audios')).toHaveLength(0);
  });
  it('waits for a replacement ready stream and cancels readiness waiting promptly', async () => {
    const controller = new AbortController(); const pending = manager.speak({ ...speechInput, signal: controller.signal });
    controller.abort(); await expect(pending).rejects.toBeDefined(); expect(posted('/audios')).toHaveLength(0);
    const waiting = manager.speak(speechInput); await ready(); expect((await waiting).status).toBe('accepted');
  });
  it('times out provider requests without reporting a successful render', async () => {
    const client = provider(15);
    intercept = call => new Promise((_resolve, reject) => { call.signal!.addEventListener('abort', () => reject(call.signal!.reason), { once: true }); });
    await expect(client.uploadAudio(encodedKey, Buffer.from('test'), 'mp3')).rejects.toMatchObject({ code: 'portrait_outcome_unknown', outcomeUnknown: true });
    expect(calls).toHaveLength(1);
  });
  it('retains exact stream cleanup identity after timeout and reopens cleanup with the original credential', async () => {
    manager = newManager({ cleanupTimeoutMs: 15 }); const stream = await ready();
    intercept = call => {
      if (call.method === 'DELETE') return new Promise((_resolve, reject) => call.signal!.addEventListener('abort', () => reject(call.signal!.reason), { once: true }));
    };
    await expect(manager.stop(scope)).rejects.toMatchObject({ code: 'portrait_cleanup_pending', outcomeUnknown: true });
    expect(manager.ready(scope)).toBe(false); expect((manager as any).active.size).toBe(0);
    const row = repository.read(owner).sessions.find(item => item.id === stream.portraitSessionId)!;
    expect(row.stream).toBeDefined(); expect(row.agentId).toBeDefined(); expect(row.credential).toBe(encodedKey);
    intercept = undefined; calls = [];
    manager = newManager(); manager.config(owner); await runtimeBackgroundWork.waitForIdle();
    expect(calls.some(call => call.method === 'DELETE' && call.url.endsWith(`/streams/${row.stream!.id}`))).toBe(true);
    expect(calls.every(call => call.method === 'DELETE' && call.headers.Authorization === `Basic ${encodedKey}`)).toBe(true);
    expect(repository.read(owner).sessions.find(item => item.id === stream.portraitSessionId)!.stream).toBeUndefined();
  });
  it('retains prototype-like request IDs as real durable speech entries', async () => {
    await ready(); await manager.speak({ ...speechInput, requestId: '__proto__' }); await manager.speak({ ...speechInput, requestId: '__proto__' });
    expect(posted('/audios')).toHaveLength(1); expect(Object.hasOwn(repository.read(owner).sessions[0].speeches, '__proto__')).toBe(true);
  });
  it('does not invoke a provider for oversized or unsupported audio', async () => {
    await ready();
    await expect(manager.speak({ ...speechInput, format: 'pcm' })).rejects.toMatchObject({ code: 'portrait_audio_invalid' });
    expect(posted('/audios')).toHaveLength(0);
    await expect(provider().uploadAudio(encodedKey, Buffer.alloc(6 * 1024 * 1024 + 1), 'mp3')).rejects.toMatchObject({ code: 'portrait_audio_invalid' });
    expect(posted('/audios')).toHaveLength(0);
  });
  it('returns a clear insufficient-credit error without retrying another create or provider', async () => {
    intercept = call => call.method === 'POST' && call.url.endsWith('/agents') ? json({ description: 'private provider error content' }, 402) : undefined;
    await expect(manager.create(createInput)).rejects.toMatchObject({ code: 'portrait_credits_required', outcomeUnknown: false });
    expect(posted('/agents')).toHaveLength(1); expect(posted('/streams')).toHaveLength(0);
  });
  it('does not claim complete cleanup when official URL-only uploads have no deletion identifier', async () => {
    intercept = call => call.url.endsWith('/images') ? json({ url: 'https://private-bucket.s3.us-west-2.amazonaws.com/no-id.jpg' })
      : call.url.endsWith('/audios') ? json({ url: 'https://private-bucket.s3.us-west-2.amazonaws.com/no-id.wav' }) : undefined;
    const stream = await ready(); await manager.speak(speechInput);
    await expect(manager.stop(scope)).rejects.toMatchObject({ code: 'portrait_cleanup_pending', outcomeUnknown: true });
    const row = repository.read(owner).sessions.find(item => item.id === stream.portraitSessionId)!;
    expect(row.unlocatedUploads).toBe(2); expect(row.errorCode).toBe('portrait_cleanup_pending');
    expect(manager.config(owner).cleanupPending).toBe(true); expect((manager as any).active.size).toBe(0);
  });
  it('keeps cleanup unknown when an audio upload may be accepted but its response is lost', async () => {
    const stream = await ready();
    intercept = call => { if (call.url.endsWith('/audios')) throw new Error('Synthetic upload response lost'); return undefined; };
    await expect(manager.speak(speechInput)).rejects.toMatchObject({ code: 'portrait_outcome_unknown' });
    const row = repository.read(owner).sessions.find(item => item.id === stream.portraitSessionId)!;
    expect(row.unlocatedUploads).toBe(1); expect(row.errorCode).toBe('portrait_cleanup_pending');
    expect(row.speeches[speechInput.requestId].status).toBe('unknown'); expect(posted('/audios')).toHaveLength(1);
  });
});

describe('authenticated real HTTP routes', () => {
  it('enforces personal owner scope, secret projection and cross-call signaling', async () => {
    const app = express(); app.use(express.json()); const router = express.Router(); app.use('/api', router); mountMemoryAvatarPortraitRoutes(router, manager);
    server = await new Promise<Server>(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    const address = server.address() as { port: number };
    const request = async (route: string, method = 'GET', body?: any, identity: any = { uid: owner }) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api${route}`, { method, headers: { 'Content-Type': 'application/json', ...(identity ? { Authorization: `Bearer ${jwt.sign(identity, 'synthetic-portrait-jwt-secret')}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
    };
    expect((await request('/memory-avatar-portrait/config', 'GET', undefined, null)).status).toBe(401);
    expect((await request('/memory-avatar-portrait/config', 'GET', undefined, { uid: owner, orgId: 'work' })).status).toBe(403);
    const config = await request('/memory-avatar-portrait/config'); expect(config.body).not.toHaveProperty('apiKey'); expect(config.cache).toBe('no-store');
    const route = '/memory-avatars/person-one/portrait/streams';
    expect((await request(route, 'POST', createInput, { uid: 'other-owner' })).status).toBe(404);
    const created = await request(route, 'POST', createInput); expect(created.status).toBe(201);
    const id = created.body.portraitSessionId;
    expect((await request(`${route}/${id}/answer`, 'POST', { callSessionId: 'another-call', answer })).status).toBe(404);
    expect((await request(`${route}/${id}/answer`, 'POST', { callSessionId: scope.callSessionId, answer })).status).toBe(200);
    expect((await request(`${route}/${id}`, 'DELETE', { callSessionId: scope.callSessionId })).status).toBe(200);
  });
});

function requireHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
