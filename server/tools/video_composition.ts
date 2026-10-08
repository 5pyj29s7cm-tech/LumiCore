import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runMediaProcess } from '../media/process';
import { measureGeneratedVideo } from './video_measurements';
import { validateVideoContainer } from './video_container';
import { CN_MEDIA_PROGRESS } from '../regions/packs/cn/media_progress';

export type VideoSequenceClip = { path: string; taskId: string; model: string };
/** One admitted generation owns the sequence. Never retry a paid clip automatically. */
export async function generateVideoSequence(input: {
  duration: number; size: string; clipDuration: number; outputDirectory: string;
  owner: { userId?: string; domain?: string; orgId?: string; taskId?: string };
  generateClip: (index: number, count: number, previousEndFrame?: string) => Promise<VideoSequenceClip>;
  signal?: AbortSignal; onProgress?: (message: string) => void;
}): Promise<{ outputPath: string; clips: VideoSequenceClip[] }> {
  const check = () => input.signal?.throwIfAborted();
  const progress = (message: string) => { try { input.onProgress?.(message); } catch { /* Observation only. */ } };
  check();
  if (!Number.isInteger(input.duration) || input.duration < 1 || input.duration > 120
    || !Number.isInteger(input.clipDuration) || input.clipDuration < 1 || !/^\d{3,4}x\d{3,4}$/.test(input.size)) throw new Error('Invalid video sequence settings.');
  const [width, height] = input.size.split('x').map(Number);
  if ([width, height].some(value => value < 256 || value > 4096 || value % 2)) throw new Error('Invalid video sequence dimensions.');
  // Fail before the first paid request when local composition is unavailable.
  await runMediaProcess('ffmpeg', ['-version'], input.signal, 5000);
  await runMediaProcess('ffprobe', ['-version'], input.signal, 5000);
  const count = Math.ceil(input.duration / input.clipDuration);
  const id = crypto.randomUUID();
  const directory = path.join(input.outputDirectory, '.video-assembly-' + id);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const manifest = path.join(directory, 'progress.json');
  const clips: VideoSequenceClip[] = [];
  const clipSettings: Array<{ duration: number; hasAudio: boolean }> = [];
  const temporaryFiles: string[] = [];
  const outputPath = path.join(input.outputDirectory, 'official_video_' + Date.now() + '_' + id + '.mp4');
  const temporaryOutput = path.join(directory, 'composed.partial.mp4');
  temporaryFiles.push(temporaryOutput);
  const save = (state: string, currentClip: number, error?: string) => {
    const temp = manifest + '.tmp';
    let descriptor: number | undefined;
    try { descriptor = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(descriptor, JSON.stringify({ version: 1, ...input.owner, duration: input.duration, size: input.size, clipDuration: input.clipDuration, count, currentClip, state, clips, outputPath: state === 'completed' ? outputPath : undefined, error, updatedAt: new Date().toISOString() })); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined; fs.renameSync(temp, manifest); }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); try { fs.unlinkSync(temp); } catch {} }
  };
  let currentClip = 0;
  try {
    save('preparing', 0);
    for (let index = 0; index < count; index++) {
      check(); currentClip = index + 1;
      let previousEndFrame: string | undefined;
      if (index > 0) {
        previousEndFrame = path.join(directory, 'frame-' + index + '.png'); temporaryFiles.push(previousEndFrame);
        await runMediaProcess('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-sseof', '-0.08', '-i', clips[index - 1].path, '-frames:v', '1', '-n', previousEndFrame], input.signal);
        check();
        if (!fs.existsSync(previousEndFrame) || !fs.statSync(previousEndFrame).size) throw new Error('Could not extract the preceding clip end frame.');
      }
      save('generating', currentClip);
      progress(CN_MEDIA_PROGRESS.videoSequenceClip(currentClip, count));
      const clip = await input.generateClip(index, count, previousEndFrame);
      // The callback owns this file. Preserve it even if verification rejects it.
      clips.push(clip); save('verifying', currentClip); check();
      const measured = await measureGeneratedVideo(clip.path, { duration: input.clipDuration }, input.signal);
      if (!measured.settingsMatch || !measured.actualSettings) throw new Error('A generated clip has an unverified or unexpected duration.');
      clipSettings.push(measured.actualSettings);
      progress(CN_MEDIA_PROGRESS.videoSequenceClipSaved(currentClip, count)); check();
    }
    save('composing', count); progress(CN_MEDIA_PROGRESS.videoSequenceComposing);
    const filenames: string[] = [];
    const hasAudio = clipSettings.some(clip => clip.hasAudio);
    for (const [index, clip] of clips.entries()) {
      check();
      const name = 'clip-' + index + '.mkv'; const normalized = path.join(directory, name);
      temporaryFiles.push(normalized); filenames.push(name);
      // Use lossless PCM between clips to avoid accumulating AAC encoder delay.
      // A silent gap keeps later native audio at its original position; no audio
      // track is created when every source clip is silent.
      const audio = hasAudio ? [
        ...(clipSettings[index].hasAudio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']),
        '-map', '0:v:0', '-map', clipSettings[index].hasAudio ? '0:a:0' : '1:a:0',
        '-af', 'aresample=48000:async=1:first_pts=0,apad', '-c:a', 'pcm_s16le', '-ac', '2', '-ar', '48000',
      ] : ['-map', '0:v:0'];
      await runMediaProcess('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-threads', '1', '-i', clip.path, ...audio, '-vf',
        'scale=' + width + ':' + height + ':force_original_aspect_ratio=decrease:force_divisible_by=2,pad=' + width + ':' + height + ':(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25,setpts=PTS-STARTPTS',
        '-t', String(clipSettings[index].duration), '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-n', normalized], input.signal);
    }
    const list = path.join(directory, 'clips.ffconcat'); temporaryFiles.push(list);
    fs.writeFileSync(list, 'ffconcat version 1.0\n' + filenames.map(name => 'file ' + name).join('\n') + '\n');
    await runMediaProcess('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-f', 'concat', '-safe', '1', '-i', list, '-t', String(input.duration), '-map', '0:v:0', '-c:v', 'copy',
      ...(hasAudio ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k'] : []), '-movflags', '+faststart', '-n', temporaryOutput], input.signal);
    check();
    if (fs.statSync(temporaryOutput).size > 100 * 1024 * 1024) throw new Error('Composed video exceeds the output size limit.');
    validateVideoContainer(fs.readFileSync(temporaryOutput));
    const measured = await measureGeneratedVideo(temporaryOutput, { size: input.size, duration: input.duration }, input.signal);
    if (!measured.settingsMatch) throw new Error('Composed video settings do not match the requested duration or size.');
    if (measured.actualSettings?.hasAudio !== hasAudio) throw new Error('Composed video audio does not match its source clips.');
    check(); fs.renameSync(temporaryOutput, outputPath); save('completed', count);
    return { outputPath, clips };
  } catch (error: any) {
    try { save(input.signal?.aborted ? 'cancelled' : 'failed', currentClip, String(error?.message || error).slice(0, 400)); } catch {}
    check();
    throw new Error(CN_MEDIA_PROGRESS.videoSequenceFailed(clips.length, count) + ' ' + String(error?.message || error).slice(0, 400), { cause: error });
  } finally {
    // Only explicitly created transient files are removed; paid clips and the manifest remain recoverable.
    for (const file of temporaryFiles) { try { fs.unlinkSync(file); } catch {} }
  }
}
