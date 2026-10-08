import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMediaProcess } from '../server/media/process';
import { generateVideoSequence } from '../server/tools/video_composition';
import { measureGeneratedVideo } from '../server/tools/video_measurements';

const available = ['ffmpeg', 'ffprobe'].every(binary => spawnSync(binary, ['-version'], { windowsHide: true, timeout: 5000, stdio: 'ignore' }).status === 0);
describe.skipIf(!available)('real video composition audio', () => {
  let directory: string; let silent: string; let tone: string; let shortTone: string; let longPulse: string;
  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(process.env.LUMI_TEST_TMPDIR || os.tmpdir(), 'video-audio-'));
    silent = path.join(directory, 'silent.mp4'); tone = path.join(directory, 'tone.mp4'); shortTone = path.join(directory, 'short-tone.mp4'); longPulse = path.join(directory, 'long-pulse.mp4');
    for (const [file, audio, rate] of [[silent, 0, 48000], [tone, 1, 48000], [shortTone, 0.4, 44100], [longPulse, 0.4, 44100]] as const) {
      await runMediaProcess('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x320:r=25:d=' + (file === longPulse ? 5 : 1),
        ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=' + rate + ':duration=' + audio] : []),
        '-map', '0:v:0', ...(audio ? ['-map', '1:a:0', '-c:a', 'aac', '-ac', rate === 44100 ? '1' : '2'] : []),
        '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-n', file]);
    }
  }, 20000);
  afterAll(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
  async function compose(paths: string[], clipDuration = 1) {
    const output = fs.mkdtempSync(path.join(directory, 'assembled-'));
    const result = await generateVideoSequence({ duration: paths.length * clipDuration, size: '320x320', clipDuration, outputDirectory: output, owner: {},
      generateClip: async index => ({ path: paths[index], taskId: String(index), model: 'local-test-fixture' }) });
    expect(fs.readdirSync(fs.readdirSync(output).map(name => path.join(output, name)).find(name => fs.statSync(name).isDirectory())!)).toEqual(['progress.json']);
    expect(paths.every(file => fs.existsSync(file))).toBe(true);
    return result.outputPath;
  }
  function rms(file: string, start: number): Promise<number> {
    return new Promise((resolve, reject) => execFile('ffmpeg', ['-v', 'error', '-ss', String(start), '-i', file, '-t', '0.15', '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'],
      { encoding: 'buffer', windowsHide: true, timeout: 10000 }, (error, samples) => {
        if (error) { reject(error); return; }
        let energy = 0; for (let offset = 0; offset + 4 <= samples.length; offset += 4) energy += samples.readFloatLE(offset) ** 2;
        resolve(Math.sqrt(energy / (samples.length / 4)));
      }));
  }
  it('preserves sound from every clip and produces a decodable AAC track', async () => {
    const file = await compose([tone, tone]);
    expect(await measureGeneratedVideo(file, { size: '320x320', duration: 2 })).toMatchObject({ settingsMatch: true, actualSettings: { hasAudio: true } });
    expect(await rms(file, 0.25)).toBeGreaterThan(0.03); expect(await rms(file, 1.25)).toBeGreaterThan(0.03);
    const streams = JSON.parse(await runMediaProcess('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', file])).streams;
    expect(streams).toContainEqual({ codec_type: 'audio', codec_name: 'aac' });
  }, 20000);
  it('pads short audio and silent clips without shifting later sound or dropping a late audio track', async () => {
    const file = await compose([shortTone, silent, tone]);
    expect(await rms(file, 0.1)).toBeGreaterThan(0.03); expect(await rms(file, 0.65)).toBeLessThan(0.002);
    expect(await rms(file, 1.25)).toBeLessThan(0.002); expect(await rms(file, 2.25)).toBeGreaterThan(0.03);
    const late = await compose([silent, tone]);
    expect(await rms(late, 0.25)).toBeLessThan(0.002); expect(await rms(late, 1.25)).toBeGreaterThan(0.03);
  }, 30000);
  it('keeps sound at the correct boundary throughout a real six-segment 30-second video', async () => {
    const file = await compose(Array(6).fill(longPulse), 5);
    expect(await measureGeneratedVideo(file, { duration: 30 })).toMatchObject({ settingsMatch: true, actualSettings: { hasAudio: true } });
    expect(await rms(file, 24.75)).toBeLessThan(0.002); expect(await rms(file, 25.1)).toBeGreaterThan(0.03); expect(await rms(file, 25.65)).toBeLessThan(0.002);
  }, 30000);
  it('keeps a completely silent sequence free of manufactured audio tracks', async () => {
    const file = await compose([silent, silent]);
    expect(await measureGeneratedVideo(file, { duration: 2 })).toMatchObject({ settingsMatch: true, actualSettings: { hasAudio: false } });
  }, 20000);
});
