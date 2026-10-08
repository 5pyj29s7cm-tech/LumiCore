import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const media = vi.hoisted(() => ({ run: vi.fn(), measurements: new Map<string, any>(), png: Buffer.alloc(0), unavailable: false, failComposition: false, durationOffset: 0, hasAudio: false, dropComposedAudio: false }));
vi.mock('../server/media/process', () => ({ runMediaProcess: media.run }));
import { initDatabase } from '../db_layer';
import { saveKeys } from '../server/config/keys';
import { getGeneratedOutputDir } from '../server/config/data_path';
import { upsertUserPreferredGenerationModels } from '../server/llm/generation_preferences';
import { registerVideoTools } from '../server/tools/definitions/video_tools';
import { ToolRegistry, getToolExecutionTimeoutMs } from '../server/tools/registry';
import { VALID_MP4 } from './fixtures/synthetic_video';
const realRename = fs.renameSync.bind(fs);
const originals = Object.fromEntries(['RELAY_VIDEO_MODEL', 'RELAY_IMAGE_TO_VIDEO_MODEL', 'RELAY_VIDEO_REQUEST_FORMAT'].map(key => [key, process.env[key]]));
let user: string; let source: string; let before: Set<string>; let posts: any[]; let failPost = 0;
const directory = getGeneratedOutputDir();
beforeAll(async () => {
  await initDatabase();
  media.png = await sharp(Buffer.from('<svg width="4" height="4"><rect width="4" height="4" fill="#dd5522"/></svg>')).png().toBuffer();
});
beforeEach(() => {
  user = 'video-sequence-' + crypto.randomUUID(); source = path.join(process.env.LUMI_DATA_DIR!, user + '.png');
  fs.writeFileSync(source, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  before = new Set(fs.existsSync(directory) ? fs.readdirSync(directory) : []); posts = []; failPost = 0;
  vi.spyOn(fs, 'renameSync').mockImplementation((sourcePath, targetPath) => { realRename(sourcePath, targetPath); const measured = media.measurements.get(String(sourcePath)); if (measured) { media.measurements.set(String(targetPath), measured); media.measurements.delete(String(sourcePath)); } });
  media.unavailable = media.failComposition = media.hasAudio = media.dropComposedAudio = false; media.durationOffset = 0; media.measurements.clear(); media.run.mockReset();
  media.run.mockImplementation(async (binary: string, args: string[]) => {
    if (args.includes('-version')) { if (media.unavailable) throw new Error('ffmpeg unavailable'); return 'media tool ready'; }
    const output = args.at(-1)!;
    if (binary === 'ffprobe') { const m = media.measurements.get(output) || { width: 832, height: 480, duration: 5 }; return JSON.stringify({ streams: [{ codec_type: 'video', ...m }, ...(media.hasAudio && !(media.dropComposedAudio && output.endsWith('composed.partial.mp4')) ? [{ codec_type: 'audio' }] : [])] }); }
    if (args.includes('-frames:v')) { fs.writeFileSync(output, media.png); return ''; }
    const concat = args.includes('concat');
    if (concat && media.failComposition) { fs.writeFileSync(output, 'partial'); throw new Error('injected composition failure'); }
    fs.writeFileSync(output, VALID_MP4);
    const size = (args[args.indexOf('-vf') + 1] || '').match(/scale=(\d+):(\d+)/);
    media.measurements.set(output, { width: Number(size?.[1] || 832), height: Number(size?.[2] || 480), duration: concat ? Number(args[args.indexOf('-t') + 1]) + media.durationOffset : 5 });
    return '';
  });
  process.env.RELAY_VIDEO_MODEL = 'aliyun/Wan2.2-T2V-A14B'; process.env.RELAY_IMAGE_TO_VIDEO_MODEL = 'aliyun/Wan2.2-I2V-A14B'; process.env.RELAY_VIDEO_REQUEST_FORMAT = 'json';
  saveKeys({ RELAY_API_KEY: 'video-test-key', RELAY_BASE_URL: 'https://official.example.test/v1' });
  upsertUserPreferredGenerationModels(user, { video: { provider: 'relay', model: 'aliyun/Wan2.2-T2V-A14B' }, imageToVideo: { provider: 'relay', model: 'aliyun/Wan2.2-I2V-A14B' } });
  vi.stubGlobal('fetch', vi.fn(async (_url: any, init?: RequestInit) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(String(init.body))); if (posts.length === failPost) throw new Error('injected provider failure'); return new Response(JSON.stringify({ id: 'clip-' + posts.length, status: 'queued' })); }
    return new Response(JSON.stringify({ status: 'completed', video_base64: VALID_MP4.toString('base64') }));
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } saveKeys({ RELAY_API_KEY: '', RELAY_BASE_URL: '' }); });
async function generate(duration = 30, image = true, context: any = {}) {
  const registry = new ToolRegistry(); registerVideoTools(registry);
  return JSON.parse(await registry.execute('generate_video', { prompt: 'Show the product with slow camera motion', size: '832x480', duration, ...(image ? { first_frame_image: source } : {}) }, { userId: user, ...context }));
}
function manifest() {
  const folder = fs.readdirSync(directory).find(name => !before.has(name) && name.startsWith('.video-assembly-'));
  const location = path.join(directory, folder!);
  return { location, value: JSON.parse(fs.readFileSync(path.join(location, 'progress.json'), 'utf8')) };
}
describe('automatic long video generation', () => {
  it('generates six real provider tasks with end-frame continuation and returns one measured 30-second artifact', async () => {
    const result = await generate();
    expect(posts).toHaveLength(6); expect(posts.every(post => post.duration === 5)).toBe(true);
    expect(posts[0].image).toBe('data:image/png;base64,' + fs.readFileSync(source).toString('base64'));
    expect(posts.slice(1).every(post => post.image === 'data:image/png;base64,' + media.png.toString('base64'))).toBe(true);
    expect(posts[5].prompt).toContain('segment 6 of 6');
    expect(result).toMatchObject({ ok: true, requestedSettings: { duration: 30, size: '832x480' }, actualSettings: { duration: 30, size: '832x480' }, settingsMatch: true, generationMode: 'image_to_video', composition: { clipCount: 6, sourceTaskIds: ['clip-1','clip-2','clip-3','clip-4','clip-5','clip-6'] } });
    expect(result.artifacts).toEqual([{ type: 'video', path: result.outputPath }]);
    expect(manifest().value).toMatchObject({ state: 'completed', userId: user, outputPath: result.outputPath });
    expect(fs.readdirSync(manifest().location)).toEqual(['progress.json']);
  });
  it('starts text-to-video with T2V then uses I2V for continuous subsequent segments', async () => {
    const result = await generate(10, false);
    expect(posts[0]).toMatchObject({ model: 'aliyun/Wan2.2-T2V-A14B' }); expect(posts[0]).not.toHaveProperty('image');
    expect(posts[1]).toMatchObject({ model: 'aliyun/Wan2.2-I2V-A14B', image: 'data:image/png;base64,' + media.png.toString('base64') });
    expect(result).toMatchObject({ generationMode: 'text_to_video', inputReferenceAccepted: false, actualSettings: { duration: 10 } });
  });
  it('trims the final composition to an exact requested duration that is not a multiple of five', async () => {
    expect(await generate(13)).toMatchObject({ actualSettings: { duration: 13 }, settingsMatch: true, composition: { clipCount: 3 } });
    expect(posts).toHaveLength(3);
  });
  it('fails before paying for any clip if the local media tools are unavailable', async () => {
    media.unavailable = true; await expect(generate()).rejects.toThrow(/unavailable/); expect(posts).toHaveLength(0);
    expect(fs.readdirSync(directory).filter(name => !before.has(name))).toHaveLength(0);
  });
  it('preserves completed clips and stops without retrying or submitting later clips on provider failure', async () => {
    failPost = 2; await expect(generate()).rejects.toThrow(/1\/6/); expect(posts).toHaveLength(2);
    expect(manifest().value).toMatchObject({ state: 'failed', currentClip: 2, clips: [{ taskId: 'clip-1' }] });
    expect(fs.existsSync(manifest().value.clips[0].path)).toBe(true); expect(fs.readdirSync(manifest().location)).toEqual(['progress.json']);
  });
  it('cancels between clips without submitting the next paid request', async () => {
    const controller = new AbortController();
    await expect(generate(30, true, { executionSignal: controller.signal, onProgress: (message: string) => { if (message === '长视频第 1/6 段已保存。') controller.abort(); } })).rejects.toThrow();
    expect(posts).toHaveLength(1); expect(manifest().value).toMatchObject({ state: 'cancelled', clips: [{ taskId: 'clip-1' }] });
  });
  it('retains all paid clips and removes temporary files if local composition fails', async () => {
    media.failComposition = true; await expect(generate()).rejects.toThrow(/composition failure/); expect(posts).toHaveLength(6);
    expect(manifest().value).toMatchObject({ state: 'failed', clips: expect.any(Array) }); expect(manifest().value.clips).toHaveLength(6);
    expect(fs.readdirSync(manifest().location)).toEqual(['progress.json']);
  });
  it('rejects an incorrectly measured final duration instead of manufacturing a 30-second success', async () => {
    media.durationOffset = -1; await expect(generate()).rejects.toThrow(/do not match/); expect(manifest().value.state).toBe('failed');
    expect(fs.readdirSync(manifest().location)).toEqual(['progress.json']);
  });
  it('allows a bounded generation deadline for longer sequences', () => {
    expect(getToolExecutionTimeoutMs('generate_video')).toBe(15 * 60_000);
    expect(getToolExecutionTimeoutMs('generate_video', { duration: 30 })).toBe(17 * 60_000);
    expect(getToolExecutionTimeoutMs('generate_video', { duration: 120 })).toBe(45 * 60_000);
  });
});

it('rejects a composition that lost source audio and preserves paid source clips without retry', async () => {
  media.hasAudio = media.dropComposedAudio = true;
  await expect(generate()).rejects.toThrow(/audio does not match/);
  expect(posts).toHaveLength(6); expect(manifest().value.state).toBe('failed');
  expect(manifest().value.clips.every((clip: { path: string }) => fs.existsSync(clip.path))).toBe(true);
  expect(fs.readdirSync(manifest().location)).toEqual(['progress.json']);
});
