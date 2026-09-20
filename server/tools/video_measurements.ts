import { runMediaProcess } from '../media/process';

export type VideoSettings = { size?: string; duration?: number };
export type VideoMeasurements = { actualSettings?: { size: string; duration: number }; settingsMatch: boolean };

/** Measure the saved file, never echo requested parameters as output evidence. */
export async function measureGeneratedVideo(file: string, requested: VideoSettings, signal?: AbortSignal): Promise<VideoMeasurements> {
  try {
    const probe = JSON.parse(await runMediaProcess('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,duration:format=duration', '-of', 'json', file], signal, 15_000));
    const video = probe.streams?.[0];
    const width = Number(video?.width), height = Number(video?.height);
    const streamDuration = Number(video?.duration);
    const duration = Number.isFinite(streamDuration) && streamDuration > 0 ? streamDuration : Number(probe.format?.duration);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || !Number.isFinite(duration) || duration <= 0) return { settingsMatch: false };
    const actualSettings = { size: `${width}x${height}`, duration };
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
