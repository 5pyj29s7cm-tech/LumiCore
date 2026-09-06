import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { getDataPath } from '../config/data_path';
import { ensurePrivateRuntimeDirectory, restrictOwnerAccess } from '../config/runtime_file_security';
import { MemoryAvatarError } from './store';

// The repository's bundled-skills declaration narrows sharp to one argument.
// This local call signature retains the installed library's input-pixel guard.
const boundedSharp = sharp as unknown as (input: string, options: { limitInputPixels: number }) => ReturnType<typeof sharp>;

export type AvatarMediaKind = 'image' | 'video' | 'audio';
export const AVATAR_MEDIA_MAX_BYTES = { image: 20 * 1024 ** 2, audio: 30 * 1024 ** 2, video: 200 * 1024 ** 2 };
export interface MediaProbe { kind: AvatarMediaKind; mimeType: string; extension: string; width?: number; height?: number; durationSeconds?: number; audio: boolean }
// Bounded opaque components keep decoder/Windows ACL paths below MAX_PATH in
// normal data roots while retaining 128 bits of collision resistance.
const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
export function avatarMediaDirectory(userId: string, avatarId: string): string {
  const root = ensurePrivateRuntimeDirectory(getDataPath('memory_avatar_media'));
  const owner = ensurePrivateRuntimeDirectory(path.join(root, digest(userId)));
  return ensurePrivateRuntimeDirectory(path.join(owner, digest(avatarId)));
}
export function avatarMediaPath(userId: string, avatarId: string, mediaId: string, variant: string, extension: string): string {
  if (!['original', 'thumbnail', 'poster', 'audio'].includes(variant) || !/^[a-z0-9]{2,5}$/.test(extension)) throw new Error('Invalid private media path');
  return path.join(avatarMediaDirectory(userId, avatarId), `${digest(mediaId)}.${variant}.${extension}`);
}
export function assertPrivateMediaFile(filename: string): void {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new MemoryAvatarError(400, 'invalid_media_file', 'Media must be a regular private file.');
}
export async function syncMediaFile(filename: string): Promise<void> {
  assertPrivateMediaFile(filename);
  restrictOwnerAccess(filename);
  const handle = await fs.promises.open(filename, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}
export function mediaError(code: string, message: string, status = 400): MemoryAvatarError { return new MemoryAvatarError(status, code, message); }

/** Fixed argument arrays only; cancellation waits for the owned process to exit. */
export function runMediaProcess(binary: 'ffmpeg' | 'ffprobe', args: string[], signal?: AbortSignal, timeoutMs = 120_000): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const output: Buffer[] = []; let size = 0; let failure: Error | undefined; let cleanup: Promise<void> | undefined;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        cleanup = new Promise<void>(done => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          const fallback = () => { try { child.kill('SIGKILL'); } catch { /* Already stopped. */ } };
          const deadline = setTimeout(() => { killer.kill(); fallback(); }, 5000);
          killer.once('error', () => { clearTimeout(deadline); fallback(); done(); });
          killer.once('close', code => { clearTimeout(deadline); if (code !== 0) fallback(); done(); });
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* Already stopped. */ } }
      }
    };
    const abort = () => stop(new DOMException('Media processing cancelled.', 'AbortError'));
    const timer = setTimeout(() => stop(mediaError('media_processing_timeout', 'Media processing timed out. Retry a shorter recording.', 503)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) stop(mediaError('media_processing_output_limit', 'Media processing exceeded its output limit.')); else output.push(Buffer.from(chunk)); });
    child.stderr.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1024 * 1024) stop(mediaError('media_processing_output_limit', 'Media processing exceeded its output limit.')); });
    child.once('error', () => { failure ||= mediaError('media_tool_unavailable', `${binary} is unavailable. Install/configure the existing media tools and retry.`, 503); });
    child.once('close', async code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); await cleanup;
      if (failure) reject(failure);
      else if (code !== 0) reject(mediaError('media_decode_failed', 'The media could not be decoded. Check the format and try another file.'));
      else resolve(Buffer.concat(output).toString('utf8'));
    });
  });
}

export async function probeAvatarMedia(filename: string, signal?: AbortSignal): Promise<MediaProbe> {
  assertPrivateMediaFile(filename);
  const size = (await fs.promises.stat(filename)).size;
  if (!size || size > AVATAR_MEDIA_MAX_BYTES.video) throw mediaError('media_size_limit', 'Media is empty or exceeds the upload limit.', 413);
  const handle = await fs.promises.open(filename, 'r'); const header = Buffer.alloc(64);
  try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  const png = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const webp = header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
  if (png || jpeg || webp) {
    if (size > AVATAR_MEDIA_MAX_BYTES.image) throw mediaError('media_size_limit', 'Images must be at most 20 MiB.', 413);
    let meta: { width?: number; height?: number; pages?: number };
    try { meta = await boundedSharp(filename, { limitInputPixels: 40_000_000 }).metadata(); }
    catch { throw mediaError('media_decode_failed', 'This image could not be decoded.'); }
    signal?.throwIfAborted();
    if (!meta.width || !meta.height || meta.width * meta.height > 40_000_000 || (meta.pages || 1) > 1) throw mediaError('media_image_limit', 'Use a still image with at most 40 million pixels.');
    return { kind: 'image', mimeType: png ? 'image/png' : jpeg ? 'image/jpeg' : 'image/webp', extension: png ? 'png' : jpeg ? 'jpg' : 'webp', width: meta.width, height: meta.height, audio: false };
  }
  const iso = header.toString('ascii', 4, 8) === 'ftyp';
  const ebml = header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  const wav = header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE';
  const flac = header.toString('ascii', 0, 4) === 'fLaC'; const ogg = header.toString('ascii', 0, 4) === 'OggS';
  const mp3 = header.toString('ascii', 0, 3) === 'ID3' || (header[0] === 0xff && (header[1] & 0xe0) === 0xe0);
  if (!(iso || ebml || wav || flac || ogg || mp3)) throw mediaError('media_format_unsupported', 'Use JPEG, PNG, WebP, MP4/MOV/WebM, or WAV/MP3/FLAC/OGG/M4A audio.');
  const raw = await runMediaProcess('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_streams', '-show_format', '-of', 'json', filename], signal, 20_000);
  let info: any; try { info = JSON.parse(raw); } catch { throw mediaError('media_decode_failed', 'Invalid media probe result.'); }
  const video = info.streams?.find((stream: any) => stream.codec_type === 'video' && !stream.disposition?.attached_pic);
  const audio = info.streams?.some((stream: any) => stream.codec_type === 'audio') === true;
  const durationSeconds = Number(info.format?.duration);
  const kind: AvatarMediaKind = video ? 'video' : 'audio';
  if ((!video && !audio) || (video && !(iso || ebml)) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw mediaError('media_decode_failed', 'A finite audio or video recording is required.');
  if (size > AVATAR_MEDIA_MAX_BYTES[kind] || durationSeconds > (video ? 600 : 1800)) throw mediaError('media_size_limit', 'Video is limited to 200 MiB/10 minutes; audio to 30 MiB/30 minutes.', 413);
  if (video && (!video.width || !video.height || video.width * video.height > 40_000_000)) throw mediaError('media_video_limit', 'Video dimensions exceed the supported limit.');
  const extension = video ? (ebml ? 'webm' : 'mp4') : iso ? 'm4a' : ebml ? 'webm' : wav ? 'wav' : flac ? 'flac' : ogg ? 'ogg' : 'mp3';
  const mimeType = video ? (ebml ? 'video/webm' : 'video/mp4') : ({ wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm' })[extension]!;
  return { kind, mimeType, extension, durationSeconds, audio, ...(video ? { width: Number(video.width), height: Number(video.height) } : {}) };
}

export async function createMediaDerivatives(userId: string, avatarId: string, mediaId: string, probe: MediaProbe, signal: AbortSignal): Promise<{ thumbnail?: string; poster?: string; audio?: string }> {
  const original = avatarMediaPath(userId, avatarId, mediaId, 'original', probe.extension);
  const output: { thumbnail?: string; poster?: string; audio?: string } = {};
  if (probe.kind === 'image') {
    output.thumbnail = avatarMediaPath(userId, avatarId, mediaId, 'thumbnail', 'jpg');
    await boundedSharp(original, { limitInputPixels: 40_000_000 }).rotate().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(output.thumbnail);
  } else {
    if (probe.kind === 'video') {
      output.poster = avatarMediaPath(userId, avatarId, mediaId, 'poster', 'jpg');
      await runMediaProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', original, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease', output.poster], signal);
    }
    if (probe.audio) {
      output.audio = avatarMediaPath(userId, avatarId, mediaId, 'audio', 'wav');
      await runMediaProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', original, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-t', String(probe.kind === 'video' ? 600 : 1800), '-f', 'wav', output.audio], signal);
    }
  }
  signal.throwIfAborted();
  for (const filename of Object.values(output)) await syncMediaFile(filename);
  signal.throwIfAborted();
  return output;
}
