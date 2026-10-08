import './helpers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VALID_MP4 } from './fixtures/synthetic_video';
import { beforeEach, expect, it, vi } from 'vitest';
const media = vi.hoisted(() => vi.fn());
vi.mock('../server/media/process', () => ({ runMediaProcess: media }));
import { measureGeneratedVideo, fitGeneratedVideoSize } from '../server/tools/video_measurements';
import { buildMediaArtifactReceipt } from '../server/socket/media_artifact_receipt';
import { extractMediaGenerationArtifacts, mediaGenerationReceiptSettingsMatch } from '../src/lib/mediaGenerationArtifacts';
beforeEach(() => { media.mockReset().mockResolvedValue(JSON.stringify({ streams: [{ codec_type: 'video', width: 1080, height: 1920, duration: '5' }], format: { duration: '5' } })); });
it('compares the actual saved video instead of echoing requested duration and size', async () => {
  const requested = { size: '720x1280', duration: 6 };
  const measured = await measureGeneratedVideo('D:/generated/video.mp4', requested);
  expect(measured).toEqual({ actualSettings: { size: '1080x1920', duration: 5, hasAudio: false }, settingsMatch: false });
  const receipt = buildMediaArtifactReceipt('generate_video', requested, { ok: true, verified: true, verificationStatus: 'verified',
    outputPath: 'D:/generated/video.mp4', ...measured });
  expect(receipt).toMatchObject({ settings: { size: '1080x1920', duration: 5, hasAudio: false }, settingsMatch: false });
  expect(mediaGenerationReceiptSettingsMatch({ ...requested, mode: 'video' }, receipt)).toBe(false);
  expect((await measureGeneratedVideo('D:/generated/video.mp4', { size: '1080x1920', duration: 5 })).settingsMatch).toBe(true);
});
it('preserves an unmeasured artifact without manufacturing requested settings and respects cancellation', async () => {
  media.mockRejectedValue(new Error('ffprobe unavailable'));
  const measured = await measureGeneratedVideo('D:/generated/video.mp4', { duration: 6 });
  expect(measured).toEqual({ settingsMatch: false });
  const receipt = buildMediaArtifactReceipt('generate_video', { size: '720x1280', duration: 6 }, { ok: true, verified: true,
    verificationStatus: 'verified', outputPath: 'D:/generated/video.mp4', ...measured });
  expect(receipt?.settings).not.toHaveProperty('duration');
  expect(receipt?.settings).not.toHaveProperty('size');
  await expect(measureGeneratedVideo('D:/generated/video.mp4', {}, AbortSignal.abort())).rejects.toThrow();
});

it('publishes a fitted canvas only after measuring the conversion and removes its temporary file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-fit-')); const file = path.join(dir, 'video.mp4');
  fs.writeFileSync(file, VALID_MP4);
  const requested = { size: '832x480', duration: 5 };
  const original = { actualSettings: { size: '1440x1440', duration: 5, hasAudio: false }, settingsMatch: false };
  media.mockImplementation(async (binary: string, args: string[]) => {
    if (binary === 'ffmpeg') { fs.writeFileSync(args.at(-1)!, VALID_MP4); return ''; }
    return JSON.stringify({ streams: [{ codec_type: 'video', width: 832, height: 480, duration: '5' }] });
  });
  try {
    expect(await fitGeneratedVideoSize(file, requested, original)).toEqual({ actualSettings: { size: '832x480', duration: 5, hasAudio: false }, settingsMatch: true, sizeAdaptation: 'fit_with_padding' });
    expect(media.mock.calls[0][1]).toContain('scale=832:480:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=832:480:(ow-iw)/2:(oh-ih)/2,setsar=1');
    expect(fs.readdirSync(dir)).toEqual(['video.mp4']);
    media.mockClear();
    expect(await fitGeneratedVideoSize(file, { ...requested, duration: 30 }, original)).toBe(original);
    expect(media).not.toHaveBeenCalled();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
it('preserves the source and cleans up a failed or cancelled canvas conversion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-fit-failed-')); const file = path.join(dir, 'video.mp4');
  fs.writeFileSync(file, VALID_MP4);
  const original = { actualSettings: { size: '1440x1440', duration: 5, hasAudio: false }, settingsMatch: false };
  const control = new AbortController();
  media.mockImplementation(async (_binary: string, args: string[]) => { fs.writeFileSync(args.at(-1)!, 'invalid video'); throw new Error('decode failed'); });
  try {
    expect(await fitGeneratedVideoSize(file, { size: '832x480', duration: 5 }, original)).toBe(original);
    expect(fs.readFileSync(file)).toEqual(VALID_MP4);
    expect(fs.readdirSync(dir)).toEqual(['video.mp4']);
    media.mockImplementation(async (_binary: string, args: string[]) => { fs.writeFileSync(args.at(-1)!, 'partial'); control.abort(); throw control.signal.reason; });
    await expect(fitGeneratedVideoSize(file, { size: '832x480', duration: 5 }, original, control.signal)).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual(['video.mp4']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it('measures audio independently of video stream order and carries it through both receipt parsers', async () => {
  for (const hasAudio of [false, true]) {
    media.mockResolvedValue(JSON.stringify({ streams: [
      ...(hasAudio ? [{ codec_type: 'audio', duration: '5' }] : []),
      { codec_type: 'video', width: 832, height: 480, duration: '5' },
    ] }));
    const measured = await measureGeneratedVideo('D:/generated/video.mp4', { size: '832x480', duration: 5 });
    expect(measured).toMatchObject({ settingsMatch: true, actualSettings: { hasAudio } });
    const result = { ok: true, verified: true, verificationStatus: 'verified', outputPath: 'D:/generated/video.mp4', ...measured };
    const receipt = buildMediaArtifactReceipt('generate_video', { duration: 5, hasAudio: !hasAudio }, result)!;
    expect(receipt.settings.hasAudio).toBe(hasAudio);
    expect(extractMediaGenerationArtifacts(receipt)[0].hasAudio).toBe(hasAudio);
    expect(extractMediaGenerationArtifacts(result, 'video')[0].hasAudio).toBe(hasAudio);
  }
});
it('does not replace a source with a fitted conversion that lost its audio', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-fit-audio-')); const file = path.join(dir, 'video.mp4');
  fs.writeFileSync(file, VALID_MP4);
  const original = { actualSettings: { size: '1440x1440', duration: 5, hasAudio: true }, settingsMatch: false };
  media.mockImplementation(async (binary: string, args: string[]) => {
    if (binary === 'ffmpeg') { fs.writeFileSync(args.at(-1)!, VALID_MP4); return ''; }
    return JSON.stringify({ streams: [{ codec_type: 'video', width: 832, height: 480, duration: '5' }] });
  });
  try {
    expect(await fitGeneratedVideoSize(file, { size: '832x480', duration: 5 }, original)).toBe(original);
    expect(fs.readFileSync(file)).toEqual(VALID_MP4);
    expect(fs.readdirSync(dir)).toEqual(['video.mp4']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  ['制作一个30秒英文宣传视频，要有声音', true], ['生成带英文配音的视频', true], ['做一个有声视频', true],
  ['Make a video with English voiceover', true], ['Generate video with native audio', true],
  ['生成视频，不要声音', false], ['生成无声视频，不要英文配音', false], ['Make a silent video without audio', false],
  ['Make a video with no background music', false], ['生成视频，不要音乐但要英文旁白', true],
])('checks explicit audio requirements without treating a veto as a requirement: %s', async (text, required) => {
  const { requestedVideoAudio } = await import('../shared/video_generation_options');
  expect(requestedVideoAudio(text)).toBe(required);
});
