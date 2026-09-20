import { JWT_SECRET, LLM_GETTERS, makeApp } from './helpers';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import sharp from 'sharp';
import { generatedKnowledgeDirectory } from '../server/files/knowledge_directory';
import { changeChatSongProject, getChatSongProject, renderChatSongStrip, saveChatSongRender } from '../server/creative/chat_song';
import { chatSongRenderTimeline, renderChatSongVideo } from '../server/creative/chat_song_render';
import { mountChatSongRoutes } from '../server/routes/chat_song_routes';
import { chatSongSongCurrent, visibleChatSongLines, type ChatSongProject } from '../shared/chat_song';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { upsertUserPreferredGenerationModels } from '../server/llm/generation_preferences';
const mock = vi.hoisted(() => ({ llm: vi.fn(), media: vi.fn() }));
vi.mock('../server/llm/providers', () => ({ makeLLMCall: (...args: any[]) => mock.llm(...args) }));
vi.mock('../server/media/process', () => ({ runMediaProcess: (...args: any[]) => mock.media(...args) }));

let app: Awaited<ReturnType<typeof makeApp>>, dir: string;
const owner = 'chat-song-owner';
const lines = [
  { role: 'A', text: '你怎么还没回家？', group: 1, reaction: '' },
  { role: 'B', text: '钥匙在你手里。', group: 1, reaction: '惊讶' },
  { role: 'A', text: '=原来如此', group: 2, reaction: '' },
];
function token(uid = owner, orgId?: string) { return jwt.sign({ uid, username: uid, role: 'user', ...(orgId ? { orgId } : {}) }, JWT_SECRET); }
async function request(url = '', method = 'GET', body?: any, uid = owner, orgId?: string) {
  const response = await fetch(`${app.url}/api/creative/chat-songs${url}`, { method, headers: { Authorization: `Bearer ${token(uid, orgId)}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function create(): Promise<ChatSongProject> { const result = await request('', 'POST', { id: randomUUID(), title: 'Synthetic episode' }); expect(result.status).toBe(201); return result.body; }
async function edit(p: ChatSongProject, patch: any = {}) { return request(`/${p.id}`, 'PATCH', { revision: p.revision, project: { title: p.title, brief: p.brief, lines: p.lines.map(({ id: _id, ...line }) => line), ...patch } }); }
async function action(p: ChatSongProject, action: string, value?: any) { return request(`/${p.id}/action`, 'POST', { revision: p.revision, action, value }); }
async function locked() { const p = (await edit(await create(), { lines })).body; return (await action(p, 'lock-script')).body as ChatSongProject; }
async function withSong() {
  let p = await locked();
  p = (await action(p, 'select-song', { fileId: 'song.wav' })).body;
  p = (await action(p, 'confirm-song', { noOmissions: true, noRewrites: true, noRepeats: true, correctOrder: true })).body;
  return p;
}
const timeRows = [{ lineId: '01', start: 1, end: 3 }, { lineId: '02', start: 4, end: 6 }, { lineId: '03', start: 8, end: 10 }];
beforeAll(async () => {
  app = await makeApp(); mountChatSongRoutes(app.apiRouter, LLM_GETTERS);
  dir = generatedKnowledgeDirectory({ userId: owner, domain: 'personal' });
  fs.writeFileSync(path.join(dir, 'song.wav'), 'test fixture; ffprobe mocked in this suite');
  fs.writeFileSync(path.join(dir, 'avatar.png'), await (sharp as any)({ create: { width: 40, height: 40, channels: 3, background: '#987654' } }).png().toBuffer());
});
beforeEach(() => {
  mock.llm.mockReset().mockResolvedValue({ text: JSON.stringify({ lines }) });
  mock.media.mockReset().mockResolvedValue(JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: '12.5' } }));
});
afterAll(() => { app.cleanup(); });

it('requires authentication and isolates account and work access', async () => {
  const p = await create();
  expect((await fetch(`${app.url}/api/creative/chat-songs`)).status).toBe(401);
  expect((await request(`/${p.id}`, 'GET', undefined, 'other-owner')).status).toBe(404);
  expect((await request('', 'GET', undefined, owner, 'some-org')).status).toBe(403);
  expect((await request('?domain=work')).status).toBe(403);
  expect((await request('', 'GET', undefined, 'other-owner')).body.projects).toEqual([]);
});
it('persists across reloads, deduplicates creation and rejects stale concurrent edits', async () => {
  const p = await create();
  expect((await request('', 'POST', { id: p.id, title: p.title })).body).toEqual(p);
  const changes = await Promise.all([edit(p, { title: 'one' }), edit(p, { title: 'two' })]);
  expect(changes.map(result => result.status).sort()).toEqual([200, 409]);
  const saved = getChatSongProject(owner, p.id);
  expect(saved.revision).toBe(2); expect((await request(`/${p.id}`)).body).toEqual(saved);
});
it('requires a valid two-speaker script and ordered groups', async () => {
  const p = await create();
  expect((await action(p, 'lock-script')).status).toBe(400);
  expect((await edit(p, { lines: [{ ...lines[0], group: 2 }] })).status).toBe(400);
  expect((await edit(p, { lines: [{ ...lines[0], text: '' }] })).status).toBe(400);
  expect((await action(p, 'select-song', { fileId: 'song.wav' })).status).toBe(409);
});
it('uses measured duration and requires all lyric checks before timing', async () => {
  let p = await locked();
  expect((await action(p, 'select-song', { fileId: '../song.wav' })).status).toBe(400);
  expect((await action(p, 'select-song', { fileId: 'song.wav', duration: 999 })).status).toBe(400);
  p = (await action(p, 'select-song', { fileId: 'song.wav' })).body;
  expect(p.song?.duration).toBe(12.5);
  expect(mock.media.mock.calls[0][1]).toContain('-protocol_whitelist');
  expect((await action(p, 'confirm-song', { noOmissions: true })).status).toBe(400);
  expect((await action(p, 'set-timings', timeRows)).status).toBe(409);
  mock.media.mockResolvedValueOnce(JSON.stringify({ streams: [{ codec_type: 'video' }], format: { duration: 12 } }));
  expect((await action(p, 'select-song', { fileId: 'song.wav' })).status).toBe(400);
});
it('rejects overlapping/partial/out-of-duration timing and reveals no later punchline', async () => {
  let p = await withSong();
  expect((await action(p, 'set-timings', timeRows.slice(0, 2))).status).toBe(400);
  expect((await action(p, 'set-timings', [{ ...timeRows[0], end: 5 }, ...timeRows.slice(1)])).status).toBe(400);
  expect((await action(p, 'set-timings', [...timeRows.slice(0, 2), { ...timeRows[2], end: 20 }])).status).toBe(400);
  p = (await action(p, 'set-timings', timeRows)).body;
  expect(visibleChatSongLines(p, 0)).toEqual([]);
  expect(visibleChatSongLines(p, 3.99).map(line => line.id)).toEqual(['01']);
  expect(visibleChatSongLines(p, 4).map(line => line.id)).toEqual(['01', '02']);
  expect(visibleChatSongLines(p, 8).map(line => line.id)).toEqual(['03']);
});
it('invalidates downstream song/timing only when their source changes', async () => {
  let p = await withSong(); p = (await action(p, 'set-timings', timeRows)).body;
  const renamed = (await edit(p, { title: 'New title' })).body;
  expect(chatSongSongCurrent(renamed)).toBe(true); expect(renamed.timings).toEqual(timeRows);
  const changed = (await edit(renamed, { lines: [{ ...lines[0], text: '换一句。' }, ...lines.slice(1)] })).body;
  expect(changed.scriptLocked).toBe(false); expect(changed.song.confirmed).toBe(false); expect(changed.timings).toEqual([]);
  expect(visibleChatSongLines(changed, 8)).toEqual([]);
  const replaced = (await action(renamed, 'select-song', { fileId: 'song.wav' }));
  expect(replaced.status).toBe(409); // stale version must not overwrite the newer dialogue
});
it('reuses characters/settings without carrying the previous song or story into a new episode', async () => {
  let p = await withSong(); p = (await action(p, 'attach-asset', { kind: 'avatarA', fileId: 'avatar.png' })).body;
  p = (await action(p, 'attach-asset', { kind: 'reaction', lineId: '02', fileId: 'avatar.png' })).body;
  const next = (await request('', 'POST', { id: randomUUID(), title: 'Episode two', templateId: p.id })).body;
  expect(next.lines).toEqual([]); expect(next.song).toBeNull(); expect(next.timings).toEqual([]);
  expect(next.assets.map((asset: any) => asset.kind)).toEqual(['avatarA']);
  expect((await action(next, 'attach-asset', { kind: 'background', fileId: '../../avatar.png' })).status).toBe(400);
});
it('exports exact lyrics and real PNG strips with no invented timing or native project claim', async () => {
  const p = await locked();
  const output = await request(`/${p.id}/export`, 'POST', { revision: p.revision }); expect(output.status).toBe(200);
  expect(output.body.timed).toBe(false); expect(output.body.handoffs.edit).toBe('');
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, output.body.fileId)));
  expect(await zip.file('01_对白与唱词/纯唱词.txt')!.async('string')).toBe(lines.map(line => line.text).join('\n'));
  expect(await zip.file('04_剪辑/画面顺序表.csv')!.async('string')).toContain("'=原来如此");
  expect((await zip.file('project.json')!.async('string'))).toContain('chat-song-materials-v1');
  expect(await sharp(await zip.file('02_画面素材/聊天_01.png')!.async('nodebuffer')).metadata()).toMatchObject({ format: 'png', width: 1080 });
  expect(Object.keys(zip.files).some(name => name.endsWith('.wav'))).toBe(false);
  expect(fs.existsSync(path.join(dir, output.body.fileId.replace('.zip', '-01.png')))).toBe(true);
});
it('exports confirmed audio and measured timing and rejects replaced asset contents', async () => {
  let p = await withSong(); p = (await action(p, 'set-timings', timeRows)).body;
  p = (await action(p, 'attach-asset', { kind: 'background', fileId: 'avatar.png' })).body;
  const result = await request(`/${p.id}/export`, 'POST', { revision: p.revision }); expect(result.status).toBe(200); expect(result.body.timed).toBe(true); expect(result.body.handoffs.edit).toContain(p.id);
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(dir, result.body.fileId)));
  expect(zip.file('03_歌曲/选定歌曲.wav')).toBeTruthy();
  const original = fs.readFileSync(path.join(dir, 'avatar.png'));
  try { fs.writeFileSync(path.join(dir, 'avatar.png'), Buffer.concat([original, Buffer.from('modified')])); expect((await request(`/${p.id}/export`, 'POST', { revision: p.revision })).status).toBe(409); }
  finally { fs.writeFileSync(path.join(dir, 'avatar.png'), original); }
});
it('keeps AI drafts separate from saved dialogue and pins calls to the official provider', async () => {
  const p = await locked();
  upsertUserPreferredLLM(owner, { provider: 'relay', selectionMode: 'ordered_fallback', fallbackCandidates: [{ provider: 'qwen', model: 'qwen-plus' }] });
  const result = await request(`/${p.id}/draft`, 'POST', { revision: p.revision });
  expect(result.status).toBe(200); expect(mock.llm.mock.calls[0][2]).toMatchObject({ provider: 'relay', thinkingMode: 'disabled', responseFormat: 'json_object', selectionMode: 'pinned', fallbackCandidates: [], allowCloudFallback: false });
  expect(getChatSongProject(owner, p.id)).toEqual(p);
  mock.llm.mockResolvedValueOnce({ text: '{"lines":[' });
  expect((await request(`/${p.id}/draft`, 'POST', { revision: p.revision })).status).toBe(502);
  mock.llm.mockRejectedValueOnce(new Error('Cloud operation timed out after 60000ms'));
  expect((await request(`/${p.id}/draft`, 'POST', { revision: p.revision })).status).toBe(504);
  expect(getChatSongProject(owner, p.id)).toEqual(p);
  upsertUserPreferredLLM(owner, { provider: 'qwen' });
  expect((await request(`/${p.id}/draft`, 'POST', { revision: p.revision })).status).toBe(409);
});
it('preflights official media selections without rewriting user settings', async () => {
  const p = await create();
  upsertUserPreferredGenerationModels(owner, { image: { provider: 'auto' }, video: { provider: 'qwen' } });
  expect((await request(`/${p.id}/media-preflight`, 'POST', { mode: 'video' })).status).toBe(409);
  upsertUserPreferredGenerationModels(owner, { image: { provider: 'relay' }, video: { provider: 'relay' } });
  expect((await request(`/${p.id}/media-preflight`, 'POST', { mode: 'image' })).status).toBe(200);
  expect((await request(`/${p.id}/media-preflight`, 'POST', { mode: 'video' })).status).toBe(409);
  const confirmed = await withSong();
  expect((await request(`/${confirmed.id}/media-preflight`, 'POST', { mode: 'video', revision: confirmed.revision })).status).toBe(200);
  expect((await request(`/${confirmed.id}/media-preflight`, 'POST', { mode: 'video', revision: confirmed.revision - 1 })).status).toBe(409);
  const handoff = await request(`/${confirmed.id}/handoff`);
  expect(handoff.body.prompts.filter((p: any) => p.kind === 'clip')).toHaveLength(confirmed.lines.length);
});

it('repairs singleton model groups into cumulative pairs without changing lyrics or saved user groups', async () => {
  const p = await locked();
  upsertUserPreferredLLM(owner, { provider: 'relay' });
  const draft = Array.from({ length: 7 }, (_, index) => ({ ...lines[index % 3], group: index + 1 }));
  mock.llm.mockResolvedValueOnce({ text: JSON.stringify({ lines: draft }), finishReason: 'stop' });
  const result = await request(`/${p.id}/draft`, 'POST', { revision: p.revision });
  expect(result.status).toBe(200);
  expect(result.body.lines.map((line: any) => line.group)).toEqual([1, 1, 2, 2, 3, 3, 4]);
  expect(result.body.lines.map((line: any) => line.text)).toEqual(draft.map(line => line.text));
  expect(getChatSongProject(owner, p.id)).toEqual(p);
  mock.llm.mockResolvedValueOnce({ text: JSON.stringify({ lines }), finishReason: 'length' });
  expect((await request(`/${p.id}/draft`, 'POST', { revision: p.revision })).status).toBe(502);
});
it('requires confirmed music, complete timing and a current revision before composition', async () => {
  const p = await locked();
  expect((await request(`/${p.id}/render`, 'POST', { revision: p.revision })).status).toBe(409);
  const confirmed = await withSong();
  expect((await request(`/${confirmed.id}/render`, 'POST', { revision: confirmed.revision })).status).toBe(400);
  expect((await request(`/${confirmed.id}/render`, 'POST', { revision: confirmed.revision - 1 })).status).toBe(409);
  expect((await request(`/${confirmed.id}/render`, 'GET', undefined, 'other-owner')).status).toBe(404);
  expect((await request(`/${confirmed.id}/render`)).body.render).toBeNull();
});
it('publishes only a verified render, reuses its receipt and rejects changed source files', async () => {
  const p = (await action(await withSong(), 'set-timings', timeRows)).body;
  mock.media.mockImplementation(async (binary, args) => {
    if (binary === 'ffmpeg') { fs.writeFileSync(args.at(-1), 'mock encoder output; real encoding covered by UI smoke'); return ''; }
    return JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1440 }, { codec_type: 'audio' }], format: { duration: 12.5 } });
  });
  const result = await request(`/${p.id}/render`, 'POST', { revision: p.revision });
  expect(result.status).toBe(200); expect(fs.existsSync(path.join(dir, result.body.render.fileId))).toBe(true);
  expect((await request(`/${p.id}/render`)).body).toEqual(result.body);
  expect((await request(`/${p.id}/render`, 'POST', { revision: p.revision })).body).toEqual(result.body);
  expect(mock.media.mock.calls.filter(([binary]) => binary === 'ffmpeg')).toHaveLength(1);
  saveChatSongRender(owner, p.id, { ...result.body.render, templateVersion: undefined });
  const refreshed = await request(`/${p.id}/render`, 'POST', { revision: p.revision });
  expect(refreshed.body.render.fileId).not.toBe(result.body.render.fileId);
  expect(refreshed.body.render.templateVersion).toBe(2);
  expect(mock.media.mock.calls.filter(([binary]) => binary === 'ffmpeg')).toHaveLength(2);
  const source = fs.readFileSync(path.join(dir, 'song.wav'));
  try { fs.writeFileSync(path.join(dir, 'song.wav'), 'replaced'); expect((await request(`/${p.id}/render`, 'POST', { revision: p.revision })).status).toBe(409); }
  finally { fs.writeFileSync(path.join(dir, 'song.wav'), source); }
});
it('does not publish cancelled renders or an output made while the project changed', async () => {
  let p = (await action(await withSong(), 'set-timings', timeRows)).body;
  const controller = new AbortController();
  mock.media.mockImplementation(async (_binary, _args, signal) => { controller.abort(); signal.throwIfAborted(); });
  await expect(renderChatSongVideo(owner, p.id, p.revision, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect((await request(`/${p.id}/render`)).body.render).toBeNull();
  mock.media.mockImplementation(async (binary, args) => {
    if (binary === 'ffmpeg') {
      fs.writeFileSync(args.at(-1), 'mock encoder output');
      await changeChatSongProject(owner, p.id, p.revision, draft => { draft.title = 'Changed during render'; }); return '';
    }
    return JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1440 }, { codec_type: 'audio' }], format: { duration: 12.5 } });
  });
  expect((await request(`/${p.id}/render`, 'POST', { revision: p.revision })).status).toBe(409);
  expect((await request(`/${p.id}/render`)).body.render).toBeNull();
});
it('rounds lyric reveals forward to frame boundaries', async () => {
  const p = (await action(await withSong(), 'set-timings', [{ ...timeRows[0], start: 1.01 }, ...timeRows.slice(1)])).body;
  expect(chatSongRenderTimeline(p)[1].seconds).toBe(1.04);
});
it('renders long Chinese and escaped markup without cropping or parsing it as instructions', async () => {
  const bytes = await renderChatSongStrip({ id: '01', role: 'B', group: 1, reaction: '', text: '这是一句中文对白。<b>原样排版 & 不执行标记</b>。'.repeat(3) });
  const info = await sharp(bytes).metadata(); expect(info.width).toBe(1080); expect(info.height).toBeGreaterThan(128);
});
