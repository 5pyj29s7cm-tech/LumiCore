import './helpers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DidPortraitProvider } from '../server/memory_avatar/portrait_provider';
import { PortraitRepository } from '../server/memory_avatar/portrait_repository';
import { MemoryAvatarPortraitSessions } from '../server/memory_avatar/portrait_sessions';
import { synthesizeSpeech } from '../server/tts/providers/relay';
import { runtimeBackgroundWork } from '../server/runtime/shutdown_work';

vi.mock('../server/config/keys', () => ({ loadKeys: () => ({}), getKey: () => '' }));
vi.mock('../server/config/local_identity', () => ({ getJwtSecret: () => 'synthetic-audit10-portrait-secret' }));

const scope = { userId: 'audit10-portrait-owner', avatarId: 'audit10-person', callSessionId: 'audit10-call' };
let directory: string;
let manager: MemoryAvatarPortraitSessions;
let providerCalls: Array<{ path: string; method: string; audioType?: string; audioName?: string }>;

beforeEach(async () => {
  vi.stubEnv('RELAY_API_KEY', 'synthetic-relay-key');
  vi.stubEnv('RELAY_BASE_URL', 'https://relay.example.test/v1');
  vi.stubEnv('RELAY_TTS_FORMAT', 'mp3');
  vi.stubEnv('LUMI_PRIVACY', 'standard');
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    if (String(input) !== 'https://relay.example.test/v1/audio/speech') throw new Error('Unexpected outbound URL');
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 0x04]), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
  }));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'audit10-portrait-'));
  fs.writeFileSync(path.join(directory, 'synthetic.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  providerCalls = [];
  const provider = new DidPortraitProvider(async (input, options) => {
    const url = new URL(String(input));
    if (url.origin !== 'https://api.d-id.com') throw new Error('Unexpected provider URL');
    const method = String(options?.method);
    const audio = options?.body instanceof FormData ? options.body.get('audio') : null;
    providerCalls.push({ path: url.pathname, method, ...(audio instanceof File ? { audioType: audio.type, audioName: audio.name } : {}) });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    let payload: object = {};
    if (url.pathname === '/images') payload = { id: 'image', url: 'https://synthetic.s3.amazonaws.com/image.jpg' };
    else if (url.pathname === '/audios') payload = { id: 'audio', url: 'https://synthetic.s3.amazonaws.com/audio.mp3' };
    else if (url.pathname === '/agents') payload = { id: 'agent' };
    else if (url.pathname === '/agents/agent/streams' && typeof options?.body === 'string' && !JSON.parse(options.body).script) {
      payload = { id: 'stream', session_id: 'supplier-session', jsep: { type: 'offer', sdp: 'v=0\r\ns=synthetic\r\n' }, ice_servers: [] };
    }
    return new Response(JSON.stringify(payload), { status: 201, headers: { 'Content-Type': 'application/json' } });
  }, 1000);
  const repository = new PortraitRepository({ directory, platform: 'linux', files: {
    ensurePrivateDirectory(folder) { fs.mkdirSync(folder, { recursive: true }); },
    writeTextAtomic(filename, text) {
      const temporary = `${filename}.tmp`;
      const descriptor = fs.openSync(temporary, 'w');
      try { fs.writeFileSync(descriptor, text); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, filename);
    },
  } });
  manager = new MemoryAvatarPortraitSessions({ provider, repository,
    avatar: (() => ({ status: 'active', presentation: { mode: 'portrait', mediaId: 'photo' } })) as any,
    authorize: (() => ({ isCurrent: () => true, assertCurrent: () => {}, watch: () => () => {} })) as any,
    mediaFile: (() => ({ path: path.join(directory, 'synthetic.jpg'), mimeType: 'image/jpeg', sizeBytes: 4, media: { id: 'photo', kind: 'image' } })) as any,
  });
  await manager.configure(scope.userId, { apiKey: 'synthetic:user', cloudConsent: true });
  const stream = await manager.create({ ...scope, clientRequestId: 'audit10-create', cloudConsent: true });
  await manager.answer(scope, stream.portraitSessionId, { type: 'answer', sdp: 'v=0\r\ns=answer\r\n' });
});

afterEach(async () => {
  await manager.stop(scope);
  await runtimeBackgroundWork.waitForIdle();
  fs.rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
});

it('passes the actual official TTS MIME through a ready portrait session and deduplicates the reply', async () => {
  const audio = await synthesizeSpeech('Synthetic reply', 'longxiaochun_v3');
  expect(audio.format).toBe('audio/mp3');
  const input = { ...scope, requestId: 'reply', audioBuffer: audio.audioBuffer, format: audio.format };
  expect((await manager.speak(input)).status).toBe('accepted');
  expect((await manager.speak(input)).status).toBe('accepted');
  expect(providerCalls.filter(call => call.method === 'POST' && call.path === '/audios')).toHaveLength(1);
  expect(providerCalls.filter(call => call.method === 'POST' && call.path === '/agents/agent/streams/stream')).toHaveLength(1);
});

it.each(['pcm', 'audio/pcm', 'audio/L16', 'audio/wav; codecs=pcm', 'unknown'])('rejects unqualified raw or unsupported audio %s without upload', async format => {
  const audio = await synthesizeSpeech('Synthetic reply', 'longxiaochun_v3');
  await expect(manager.speak({ ...scope, requestId: 'raw', audioBuffer: audio.audioBuffer, format })).rejects.toMatchObject({ code: 'portrait_audio_invalid' });
  expect(providerCalls.filter(call => call.method === 'POST' && call.path === '/audios')).toEqual([]);
});

it('control: the exact same audio bytes with a bare mp3 format reach upload and rendering once', async () => {
  const audio = await synthesizeSpeech('Synthetic reply', 'longxiaochun_v3');
  const result = await manager.speak({ ...scope, requestId: 'reply', audioBuffer: audio.audioBuffer, format: 'mp3' });
  expect(result.status).toBe('accepted');
  expect(providerCalls.filter(call => call.method === 'POST' && call.path === '/audios')).toHaveLength(1);
  expect(providerCalls.filter(call => call.method === 'POST' && call.path === '/agents/agent/streams/stream')).toHaveLength(1);
});

it.each([
  ['audio/mpeg', 'audio/mpeg', 'reply.mp3'],
  [' AUDIO/WAV ', 'audio/wav', 'reply.wav'],
  ['audio/x-wav', 'audio/wav', 'reply.wav'],
  ['audio/mp4', 'audio/mp4', 'reply.m4a'],
  ['audio/flac', 'audio/flac', 'reply.flac'],
])('normalizes encoded MIME %s without changing the upload bytes', async (format, audioType, audioName) => {
  await manager.speak({ ...scope, requestId: 'encoded', audioBuffer: Buffer.from('synthetic encoded audio'), format });
  expect(providerCalls.find(call => call.method === 'POST' && call.path === '/audios')).toMatchObject({ audioType, audioName });
});

it('does not upload or speak after cancellation, even for a valid MIME', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(manager.speak({ ...scope, requestId: 'cancelled', audioBuffer: Buffer.from('synthetic audio'), format: 'audio/mp3', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(providerCalls.some(call => call.method === 'POST' && call.path === '/audios')).toBe(false);
});
