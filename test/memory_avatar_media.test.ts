import { JWT_SECRET, LLM_GETTERS, makeApp } from './helpers';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
const model = vi.hoisted(() => ({ vision: vi.fn(), transcription: vi.fn() }));
vi.mock('../server/llm/providers', () => ({ makeLLMCall: (...args: any[]) => model.vision(...args) }));
vi.mock('../server/stt/file_transcription', () => ({ transcribeAudioFile: (...args: any[]) => model.transcription(...args) }));
import { mountMemoryAvatarRoutes } from '../server/routes/memory_avatar_routes';
import { buildMemoryAvatarContext, getMemoryAvatar } from '../server/memory_avatar/store';
import { getMemoryAvatarMediaFile, waitForMemoryAvatarMediaJobs } from '../server/memory_avatar/media';
import { avatarMediaDirectory, probeAvatarMedia, runMediaProcess } from '../server/memory_avatar/media_files';
import { captureMemoryAvatarAuthorization } from '../server/memory_avatar/lifecycle';
import { closeDatabase, flushDBOrThrow, initDatabase, readDB, runSQL } from '../db_layer';
import { getDataPath } from '../server/config/data_path';

let base = ''; let server: Awaited<ReturnType<typeof makeApp>>['server']; let sequence = 0; let png: Buffer;
const originalFetch = globalThis.fetch;
const owner = 'media-owner';
function token(user = owner, orgId?: string) { return jwt.sign({ uid: user, username: user, role: 'user', ...(orgId ? { orgId } : {}) }, JWT_SECRET); }
async function request(url: string, method = 'GET', body?: any, user = owner, orgId?: string) {
  const response = await fetch(`${base}/api/memory-avatars${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token(user, orgId)}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function create() { return (await request('', 'POST', { name: 'Synthetic media person', clientRequestId: `create-${++sequence}` })).body; }
async function upload(avatar: any, bytes = png, extra: Record<string, any> = {}, user = owner, orgId?: string) {
  const form = new FormData(); form.set('revision', String(extra.revision ?? avatar.revision)); form.set('clientRequestId', extra.clientRequestId || `upload-${++sequence}`); form.set('title', extra.title || 'Synthetic source');
  if (extra.caption) form.set('caption', extra.caption);
  form.set('file', new Blob([new Uint8Array(bytes)], { type: extra.mime || 'image/png' }), extra.filename || 'source.png');
  const response = await fetch(`${base}/api/memory-avatars/${avatar.id}/media`, { method: 'POST', headers: { Authorization: `Bearer ${token(user, orgId)}` }, body: form });
  return { status: response.status, body: await response.json() };
}
const status = async (id: string) => (await request(`/${id}/media`)).body;
beforeAll(async () => {
  const app = await makeApp(); base = app.url; server = app.server; mountMemoryAvatarRoutes(app.apiRouter, LLM_GETTERS);
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== base) throw new Error('This suite only permits its isolated HTTP app.');
    return originalFetch(input, init);
  });
  png = await (sharp as any)({ create: { width: 24, height: 24, channels: 3, background: '#228866' } }).png().toBuffer();
});
beforeEach(() => { model.vision.mockReset().mockResolvedValue({ text: 'A synthetic green image with a violet observatory caption.' }); model.transcription.mockReset().mockResolvedValue({ text: 'Synthetic recording says the appointment is Thursday.', provider: 'synthetic', model: 'synthetic' }); });
afterAll(async () => {
  await waitForMemoryAvatarMediaJobs(); await runSQL('PRAGMA query_only=OFF'); await flushDBOrThrow();
  await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllGlobals();
});

it('stores actual private image and thumbnail without calling a model, authenticates all content and serves ranges', async () => {
  const avatar = await create(); const otherAvatar = await create(); const result = await upload(avatar, png, { caption: 'Owner supplied explanation' });
  expect(result.status, JSON.stringify(result.body)).toBe(201); expect(result.body.media).toMatchObject({ kind: 'image', status: 'stored', hasThumbnail: true, hasPoster: false, hasAudio: false });
  expect(model.vision).not.toHaveBeenCalled(); expect(model.transcription).not.toHaveBeenCalled();
  expect(result.body.media).not.toHaveProperty('path'); expect(result.body.avatar).not.toHaveProperty('payload');
  expect((await status(avatar.id)).media[0].caption).toBe('Owner supplied explanation');
  const mediaId = result.body.media.id; const file = getMemoryAvatarMediaFile(owner, avatar.id, mediaId);
  expect(fs.readFileSync(file.path)).toEqual(png); expect(file.path.startsWith(avatarMediaDirectory(owner, avatar.id))).toBe(true);
  const url = `${base}/api/memory-avatars/${avatar.id}/media/${mediaId}/content`;
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(url, { headers: { Authorization: `Bearer ${token('other-owner')}` } })).status).toBe(404);
  expect((await fetch(url, { headers: { Authorization: `Bearer ${token(owner, 'work-scope')}` } })).status).toBe(403);
  expect(() => getMemoryAvatarMediaFile(owner, otherAvatar.id, mediaId)).toThrow('Media not found');
  const range = await fetch(url, { headers: { Authorization: `Bearer ${token()}`, Range: 'bytes=0-7' } });
  expect(range.status).toBe(206); expect(Buffer.from(await range.arrayBuffer())).toEqual(png.subarray(0, 8)); expect(range.headers.get('cache-control')).toContain('no-store');
  expect((await fetch(url, { headers: { Authorization: `Bearer ${token()}`, Range: 'bytes=9999999-' } })).status).toBe(416);
  const thumbnail = getMemoryAvatarMediaFile(owner, avatar.id, mediaId, 'thumbnail'); expect((await sharp(thumbnail.path).metadata()).format).toBe('jpeg');
});

it('replays same upload before revision validation, rejects changed bytes and keeps intentional new requests independent', async () => {
  const avatar = await create(); const params = { clientRequestId: 'same-upload' };
  const [a, b] = await Promise.all([upload(avatar, png, params), upload(avatar, png, params)]);
  expect([a.status, b.status]).toEqual([201, 201]); expect(a.body.media.id).toBe(b.body.media.id); expect((await status(avatar.id)).media).toHaveLength(1);
  const changed = await (sharp as any)({ create: { width: 24, height: 24, channels: 3, background: '#ff0000' } }).png().toBuffer();
  expect((await upload(avatar, changed, params)).status).toBe(409);
  expect((await upload(a.body.avatar, png)).status).toBe(201); expect((await status(avatar.id)).media).toHaveLength(2);
  expect(fs.readdirSync(avatarMediaDirectory(owner, avatar.id))).toHaveLength(4);
});

it('rejects forged media, foreign uploads and excessive files without retaining temporary files', async () => {
  const avatar = await create(); expect((await upload(avatar, Buffer.from('<svg>not a png</svg>'))).status).toBe(400);
  expect((await upload(avatar, png, {}, 'other-owner')).status).toBe(404);
  expect(fs.readdirSync(avatarMediaDirectory(owner, avatar.id))).toEqual([]);
  const huge = path.join(avatarMediaDirectory(owner, avatar.id), 'oversized'); fs.writeFileSync(huge, png); fs.truncateSync(huge, 21 * 1024 ** 2);
  await expect(probeAvatarMedia(huge)).rejects.toMatchObject({ code: 'media_size_limit' }); fs.unlinkSync(huge);
});

it('does not acknowledge a failed database upload save; original retry and reopen retain one real asset', async () => {
  const avatar = await create(); const params = { clientRequestId: 'save-retry' };
  await runSQL('PRAGMA query_only=ON');
  try { expect((await upload(avatar, png, params)).status).toBe(503); } finally { await runSQL('PRAGMA query_only=OFF'); }
  const retry = await upload(avatar, png, params); expect(retry.status).toBe(201);
  await closeDatabase(); await initDatabase(); expect((await status(avatar.id)).media).toHaveLength(1);
  expect(fs.readFileSync(getMemoryAvatarMediaFile(owner, avatar.id, retry.body.media.id).path)).toEqual(png);
});

it('runs understanding only on explicit process, stores text only for this person, and retries ready without another model call', async () => {
  const avatar = await create(); const other = await create(); const { body } = await upload(avatar); const mediaId = body.media.id;
  const route = `/${avatar.id}/media/${mediaId}/process`;
  expect((await request(route, 'POST', { revision: body.avatar.revision })).status).toBe(202); await waitForMemoryAvatarMediaJobs();
  const saved = await status(avatar.id); expect(saved.media[0].status).toBe('ready'); expect(saved.media[0].materialId).toBeTruthy();
  expect(buildMemoryAvatarContext(owner, avatar.id, 'observatory').join('\n')).toContain('violet observatory'); expect(buildMemoryAvatarContext(owner, other.id, 'observatory')).toEqual([]);
  expect(readDB().memories.filter((m: any) => m.agentId === avatar.id)).toEqual([]);
  expect((await request(route, 'POST', { revision: body.avatar.revision })).status).toBe(200); expect(model.vision).toHaveBeenCalledTimes(1);
  const messages = model.vision.mock.calls[0][0]; expect(messages[1].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  expect(model.vision.mock.calls[0][1]).toEqual([]);
});

it('keeps analysis failures retryable and stores successful source once', async () => {
  const avatar = await create(); const { body } = await upload(avatar); const route = `/${avatar.id}/media/${body.media.id}/process`;
  model.vision.mockRejectedValueOnce(Error('synthetic failure'));
  await request(route, 'POST', { revision: body.avatar.revision }); await waitForMemoryAvatarMediaJobs();
  const failed = await status(avatar.id); expect(failed.media[0].status).toBe('failed'); expect(failed.media[0].hasThumbnail).toBe(true);
  await request(route, 'POST', { revision: failed.revision }); await waitForMemoryAvatarMediaJobs();
  expect((await status(avatar.id)).media[0].status).toBe('ready'); expect((await request(`/${avatar.id}/materials`)).body.materials).toHaveLength(1);
});

it('does not call models before the initial processing save, and retries that same revision after disk recovery', async () => {
  const avatar = await create(); const { body } = await upload(avatar); const route = `/${avatar.id}/media/${body.media.id}/process`;
  const input = { revision: body.avatar.revision };
  await runSQL('PRAGMA query_only=ON');
  try {
    expect((await request(route, 'POST', input)).status).toBe(503);
    expect(model.vision).not.toHaveBeenCalled();
    expect((await status(avatar.id)).media[0].status).toBe('cancelled');
  } finally { await runSQL('PRAGMA query_only=OFF'); }
  expect((await request(route, 'POST', input)).status).toBe(202); await waitForMemoryAvatarMediaJobs();
  expect(model.vision).toHaveBeenCalledTimes(1);
  await closeDatabase(); await initDatabase(); expect((await status(avatar.id)).media[0].status).toBe('ready');
  expect((await request(`/${avatar.id}/materials`)).body.materials).toHaveLength(1);
});

it('deduplicates simultaneous process requests and cancels queued work before it can call a model', async () => {
  const avatar = await create(); const first = (await upload(avatar)).body; const second = (await upload(first.avatar)).body;
  let release!: (value: any) => void; model.vision.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const route = `/${avatar.id}/media/${first.media.id}/process`; const input = { revision: second.avatar.revision };
  const starts = await Promise.all([request(route, 'POST', input), request(route, 'POST', input)]);
  expect(starts.map(result => result.status)).toEqual([202, 202]);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const queued = await request(`/${avatar.id}/media/${second.media.id}/process`, 'POST', { revision: (await status(avatar.id)).revision });
  expect(queued.status).toBe(202); expect(model.vision).toHaveBeenCalledTimes(1);
  expect((await request(`/${avatar.id}/media/${second.media.id}/cancel`, 'POST', { revision: queued.body.avatar.revision })).status).toBe(200);
  release({ text: 'Only the first image was analyzed' }); await waitForMemoryAvatarMediaJobs();
  const saved = await status(avatar.id); expect(saved.media.map((media: any) => media.status)).toEqual(['ready', 'cancelled']);
  expect(model.vision).toHaveBeenCalledTimes(1); expect((await request(`/${avatar.id}/materials`)).body.materials).toHaveLength(1);
});

it('removes already extracted text along with its source and invalidates existing conversation authorization', async () => {
  const avatar = await create(); const { body } = await upload(avatar); const route = `/${avatar.id}/media/${body.media.id}`;
  await request(`${route}/process`, 'POST', { revision: body.avatar.revision }); await waitForMemoryAvatarMediaJobs();
  expect((await request(`/${avatar.id}/materials`)).body.materials).toHaveLength(1);
  const guard = captureMemoryAvatarAuthorization(owner, avatar.id);
  const removed = await request(route, 'DELETE', { revision: (await status(avatar.id)).revision }); expect(removed.status).toBe(200);
  expect(guard.isCurrent()).toBe(false); expect(buildMemoryAvatarContext(owner, avatar.id, 'observatory')).toEqual([]);
  await closeDatabase(); await initDatabase(); expect((await request(`/${avatar.id}/materials`)).body.materials).toEqual([]);
  expect((await upload(removed.body.avatar, png, { clientRequestId: getMemoryAvatar(owner, avatar.id)!.payload.deletedMedia[0].clientRequestId })).status).toBe(409);
  expect(fs.readdirSync(avatarMediaDirectory(owner, avatar.id))).toEqual([]);
});

it.each(['cancel', 'delete', 'archive'])('fences a late model result after %s without resurrecting private text', async action => {
  const avatar = await create(); const { body } = await upload(avatar); const mediaId = body.media.id;
  let release!: (value: any) => void; model.vision.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await request(`/${avatar.id}/media/${mediaId}/process`, 'POST', { revision: body.avatar.revision });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const current = await status(avatar.id); const guard = captureMemoryAvatarAuthorization(owner, avatar.id);
  const route = action === 'archive' ? `/${avatar.id}` : action === 'delete' ? `/${avatar.id}/media/${mediaId}` : `/${avatar.id}/media/${mediaId}/cancel`;
  const changed = await request(route, action === 'cancel' ? 'POST' : 'DELETE', { revision: current.revision }); expect(changed.status).toBe(200);
  if (action !== 'cancel') expect(guard.isCurrent()).toBe(false);
  release({ text: 'Late forbidden source' }); await waitForMemoryAvatarMediaJobs();
  expect(getMemoryAvatar(owner, avatar.id)!.payload.materials).toEqual([]);
  if (action === 'delete') { expect((await status(avatar.id)).media).toEqual([]); expect(fs.readdirSync(avatarMediaDirectory(owner, avatar.id))).toEqual([]); }
  if (action === 'cancel') expect((await status(avatar.id)).media[0].status).toBe('cancelled');
  if (action === 'archive') expect((await status(avatar.id))).toMatchObject({ code: 'memory_avatar_not_found' });
});

it('retries a failed final analysis save without calling the model or adding the source twice', async () => {
  const avatar = await create(); const { body } = await upload(avatar); const route = `/${avatar.id}/media/${body.media.id}/process`;
  let release!: (value: any) => void; model.vision.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  await request(route, 'POST', { revision: body.avatar.revision }); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await runSQL('PRAGMA query_only=ON');
  try { release({ text: 'Only once persisted analysis' }); await waitForMemoryAvatarMediaJobs(); expect((await status(avatar.id)).media[0].status).toBe('failed'); }
  finally { await runSQL('PRAGMA query_only=OFF'); }
  expect((await request(route, 'POST', { revision: body.avatar.revision })).body.media.status).toBe('ready'); expect(model.vision).toHaveBeenCalledTimes(1);
  await closeDatabase(); await initDatabase(); expect((await request(`/${avatar.id}/materials`)).body.materials).toHaveLength(1);
});

it('changes the selected private portrait, invalidates old calls and restores human3d on durable deletion retry', async () => {
  const avatar = await create(); const other = await create(); const { body } = await upload(avatar); const mediaId = body.media.id;
  expect((await request(`/${other.id}`, 'PATCH', { revision: other.revision, presentation: { mode: 'portrait', mediaId } })).status).toBe(400);
  const guard = captureMemoryAvatarAuthorization(owner, avatar.id);
  const selected = await request(`/${avatar.id}`, 'PATCH', { revision: body.avatar.revision, presentation: { mode: 'portrait', mediaId } });
  expect(selected.body.presentation).toEqual({ mode: 'portrait', mediaId }); expect(guard.isCurrent()).toBe(false);
  const input = { revision: selected.body.revision }; await runSQL('PRAGMA query_only=ON');
  try { expect((await request(`/${avatar.id}/media/${mediaId}`, 'DELETE', input)).status).toBe(503); } finally { await runSQL('PRAGMA query_only=OFF'); }
  const removed = await request(`/${avatar.id}/media/${mediaId}`, 'DELETE', input); expect(removed.status).toBe(200); expect(removed.body.avatar.presentation).toEqual({ mode: 'human3d' });
  await closeDatabase(); await initDatabase(); expect((await request(`/${avatar.id}/media/${mediaId}`, 'DELETE', input)).status).toBe(200);
  expect(fs.readdirSync(avatarMediaDirectory(owner, avatar.id))).toEqual([]);
});

it('locally decodes synthetic video and audio, keeps originals and prepares poster/track before any external analysis', async () => {
  const movie = getDataPath('synthetic-media-test.mp4');
  await runMediaProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=64x64:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', movie]);
  const avatar = await create(); const video = await upload(avatar, fs.readFileSync(movie), { filename: 'synthetic.mp4', mime: 'video/mp4' });
  expect(video.status, JSON.stringify(video.body)).toBe(201); expect(video.body.media).toMatchObject({ kind: 'video', status: 'stored', hasPoster: true, hasAudio: true });
  expect(model.vision).not.toHaveBeenCalled(); expect(model.transcription).not.toHaveBeenCalled();
  const track = getMemoryAvatarMediaFile(owner, avatar.id, video.body.media.id, 'audio');
  const recording = await upload(video.body.avatar, fs.readFileSync(track.path), { filename: 'recording.wav', mime: 'audio/wav' });
  expect(recording.status).toBe(201); expect(recording.body.media).toMatchObject({ kind: 'audio', hasAudio: true, hasPoster: false });
  await request(`/${avatar.id}/media/${video.body.media.id}/process`, 'POST', { revision: recording.body.avatar.revision }); await waitForMemoryAvatarMediaJobs();
  const materials = (await request(`/${avatar.id}/materials`)).body.materials; expect(materials[0].text).toContain('Video first frame'); expect(materials[0].text).toContain('appointment is Thursday');
  expect(model.vision).toHaveBeenCalledTimes(1); expect(model.transcription).toHaveBeenCalledTimes(1); fs.unlinkSync(movie);
});
