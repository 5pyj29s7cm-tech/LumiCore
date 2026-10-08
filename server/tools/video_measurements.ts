import fs from 'node:fs';
import crypto from 'node:crypto';
import { validateVideoContainer } from './video_container';
import { runMediaProcess } from '../media/process';

export type VideoSettings = { size?: string; duration?: number };
export type VideoMeasurements = { actualSettings?: { size: string; duration: number; hasAudio: boolean }; settingsMatch: boolean; sizeAdaptation?: 'fit_with_padding' };

/** Measure the saved file, never echo requested parameters as output evidence. */
export async function measureGeneratedVideo(file: string, requested: VideoSettings, signal?: AbortSignal): Promise<VideoMeasurements> {
  try {
    const probe = JSON.parse(await runMediaProcess('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file',
      '-show_entries', 'stream=codec_type,width,height,duration:format=duration', '-of', 'json', file], signal, 15_000));
    const video = probe.streams?.find((stream: { codec_type?: string }) => stream.codec_type === 'video');
    const width = Number(video?.width), height = Number(video?.height);
    const streamDuration = Number(video?.duration);
    const duration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : Number(probe.format?.duration);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || !Number.isFinite(duration) || duration <= 0) return { settingsMatch: false };
    const hasAudio = probe.streams.some((stream: { codec_type?: string }) => stream.codec_type === 'audio');
    const actualSettings = { size: `${width}x${height}`, duration, hasAudio };
    const settingsMatch = (!requested.size || requested.size.toLowerCase().replace('*', 'x') === actualSettings.size)
      && (!requested.duration || Math.abs(requested.duration - duration) <= 0.15);
    return { actualSettings, settingsMatch };
  } catch {
    signal?.throwIfAborted();
    // Preserve the real artifact even if ffprobe is unavailable. Its container
    // validation is separate from the unverified output settings.
    return { settingsMatch: false };
  }
}

/** Preserve the whole first frame when an I2V provider follows its source aspect ratio.
 * Publish only a measured, decodable conversion; a failed conversion retains the original. */
export async function fitGeneratedVideoSize(file: string, requested: VideoSettings, measured: VideoMeasurements, signal?: AbortSignal): Promise<VideoMeasurements> {
  signal?.throwIfAborted();
  const dimensions = requested.size?.match(/^(\d{3,4})x(\d{3,4})$/i);
  if (measured.settingsMatch || !measured.actualSettings || !dimensions || !/\.mp4$/i.test(file)
    || (requested.duration && Math.abs(requested.duration - measured.actualSettings.duration) > 0.15)) return measured;
  const [width, height] = dimensions.slice(1).map(Number);
  if ([width, height].some(value => value < 100 || value > 4096 || value % 2)) return measured;
  const temporary = file + '.fit-' + crypto.randomUUID() + '.partial.mp4';
  try {
    await runMediaProcess('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-i', file,
      '-map', '0:v:0', '-map', '0:a?', '-vf',
      'scale=' + width + ':' + height + ':force_original_aspect_ratio=decrease:force_divisible_by=2,pad=' + width + ':' + height + ':(ow-iw)/2:(oh-ih)/2,setsar=1',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', '-n', temporary], signal);
    signal?.throwIfAborted();
    if (fs.statSync(temporary).size > 100 * 1024 * 1024) return measured;
    validateVideoContainer(fs.readFileSync(temporary));
    const converted = await measureGeneratedVideo(temporary, { ...requested, duration: requested.duration || measured.actualSettings.duration }, signal);
    if (!converted.settingsMatch || converted.actualSettings?.hasAudio !== measured.actualSettings.hasAudio) return measured;
    signal?.throwIfAborted();
    fs.renameSync(temporary, file);
    return { ...converted, sizeAdaptation: 'fit_with_padding' };
  } catch {
    signal?.throwIfAborted();
    return measured;
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* Renamed or never created. */ }
  }
}
