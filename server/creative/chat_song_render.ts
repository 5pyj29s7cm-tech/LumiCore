import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { chatSongSongCurrent, visibleChatSongLines, type ChatSongProject, type ChatSongRender } from '../../shared/chat_song';
import { CHAT_SONG_TEMPLATE, chatSongGroupLayout } from '../../shared/chat_song_layout';
import { runMediaProcess } from '../media/process';
import { generatedKnowledgeDirectory } from '../files/knowledge_directory';
import { registerGeneratedKnowledgeFile } from '../files/generated_archive';
import { runSerializedMutation } from '../persistence/durable_scope_mutation';
import { CHAT_SONG_RENDER_COPY as copy } from '../regions/packs/cn/chat_song';
import {
  ChatSongError, chatSongLibraryFile, createChatSongRenderWorkspace, getChatSongProject,
  getChatSongRender, removeChatSongRenderWorkspace, renderChatSongStrip, saveChatSongRender, setChatSongTimings,
} from './chat_song';

const WIDTH = 1080, HEIGHT = 1440, FPS = 25;
const active = new Set<string>();
const error = (_code: string, message: string, status?: number) => new ChatSongError(status || 400, message);

/** Frame boundaries round up so a future lyric is never revealed early. */
export function chatSongRenderTimeline(project: ChatSongProject) {
  if (!chatSongSongCurrent(project)) throw new ChatSongError(409, copy.needSong);
  setChatSongTimings(structuredClone(project), project.timings);
  const duration = project.song!.duration;
  if (duration > 300) throw new ChatSongError(400, copy.tooLong);
  const frameCount = Math.ceil(duration * FPS);
  const frames = [...new Set([0, ...project.timings.map(t => Math.ceil(t.start * FPS))])].filter(n => n < frameCount).sort((a, b) => a - b);
  return frames.map((frame, i) => ({ frame, seconds: frame / FPS, duration: ((frames[i + 1] ?? frameCount) - frame) / FPS }));
}

async function snapshot(userId: string, fileId: string, kind: 'image' | 'audio' | 'video', hash: string, target: string) {
  const source = chatSongLibraryFile(userId, fileId, kind);
  const bytes = fs.readFileSync(source.path);
  if (source.sha256 !== hash || createHash('sha256').update(bytes).digest('hex') !== hash) throw new ChatSongError(409, copy.changedFile);
  fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  return bytes;
}

async function renderFrames(project: ChatSongProject, images: Map<string, Buffer>, work: string, signal?: AbortSignal) {
  const timeline = chatSongRenderTimeline(project);
  const strips = new Map<string, { bytes: Buffer; width: number; height: number }>();
  for (const line of project.lines) {
    signal?.throwIfAborted();
    const bytes = await renderChatSongStrip(line, images.get(`avatar${line.role}:`));
    const info = await sharp(bytes).metadata();
    strips.set(line.id, { bytes, width: info.width!, height: info.height! });
  }
  const concat = ['ffconcat version 1.0'];
  for (let index = 0; index < timeline.length; index++) {
    signal?.throwIfAborted();
    const interval = timeline[index], visible = visibleChatSongLines(project, interval.seconds);
    const group = project.lines.filter(line => line.group === visible[0]?.group);
    const hasReaction = group.some(line => images.has(`reaction:${line.id}`));
    const layout = chatSongGroupLayout(group, hasReaction);
    if (visible.length && layout.scale < 0.5) throw new ChatSongError(400, copy.crowdedGroup);
    const layers: { input: Buffer; left: number; top: number }[] = [];
    for (const line of visible) {
      const strip = strips.get(line.id)!;
      const { width, height: h, left, top } = layout.strips.find(row => row.lineId === line.id)!;
      layers.push({ input: await sharp(strip.bytes).resize(width, h).png().toBuffer(), left, top });
    }
    const reaction = [...visible].reverse().map(line => images.get(`reaction:${line.id}`)).find(Boolean);
    if (reaction) layers.push({ input: await (sharp as any)(reaction, { limitInputPixels: 25_000_000 }).resize(layout.reaction.width, layout.reaction.height, { fit: 'contain', background: '#00000000' }).png().toBuffer(), left: layout.reaction.left, top: layout.reaction.top });
    const name = `frame-${index}.png`;
    await (sharp as any)({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: '#00000000' } }).composite(layers).png().toFile(path.join(work, name));
    concat.push(`file '${name}'`, 'option framerate 25', `duration ${interval.duration.toFixed(8)}`);
  }
  concat.push(`file 'frame-${timeline.length - 1}.png'`, 'option framerate 25');
  fs.writeFileSync(path.join(work, 'timeline.ffconcat'), concat.join('\n'));
}

/** Local composition uses the selected song and immutable file snapshots only. */
export async function renderChatSongVideo(userId: string, id: string, revision: unknown, signal?: AbortSignal): Promise<ChatSongRender> {
  signal?.throwIfAborted();
  const project = getChatSongProject(userId, id);
  if (revision !== project.revision) throw new ChatSongError(409, copy.changedProject);
  chatSongRenderTimeline(project);
  if (active.has(userId) || active.size >= 2) throw new ChatSongError(409, copy.busy);
  active.add(userId);
  let work = '', destination = '', committed = false;
  try {
    const song = project.song!;
    work = createChatSongRenderWorkspace(userId, id);
    const audio = path.join(work, `song${path.extname(song.fileId)}`);
    await snapshot(userId, song.fileId, 'audio', song.sha256, audio);
    const images = new Map<string, Buffer>(), clips: { path: string; start: number; end: number }[] = [];
    let totalBytes = 0;
    for (const [i, asset] of project.assets.entries()) {
      signal?.throwIfAborted();
      const file = path.join(work, `asset-${i}${path.extname(asset.fileId)}`);
      const bytes = await snapshot(userId, asset.fileId, asset.kind === 'clip' ? 'video' : 'image', asset.sha256, file);
      totalBytes += bytes.length;
      if (totalBytes > 200 * 1024 * 1024) throw new ChatSongError(400, copy.assetsTooLarge);
      if (asset.kind === 'clip') {
        const timing = project.timings.find(t => t.lineId === asset.lineId);
        if (!timing) throw new ChatSongError(409, copy.missingClipTiming);
        clips.push({ path: file, start: timing.start, end: timing.end });
      } else images.set(`${asset.kind}:${asset.lineId}`, bytes);
    }
    // Validate every input even for a cached result, so replaced files cannot be silently reused.
    const previous = getChatSongRender(userId, id);
    if (previous?.sourceRevision === project.revision && previous.templateVersion === CHAT_SONG_TEMPLATE.version) {
      const existing = path.join(generatedKnowledgeDirectory({ userId, domain: 'personal' }), previous.fileId);
      if (createHash('sha256').update(fs.readFileSync(existing)).digest('hex') === previous.sha256) return previous;
    }
    await renderFrames(project, images, work, signal);
    const background = images.get('background:');
    const base = background ? (sharp as any)(background, { limitInputPixels: 25_000_000 }).resize(WIDTH, HEIGHT, { fit: 'cover' }).blur(12).modulate({ brightness: 0.55 })
      : (sharp as any)({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: '#263338' } });
    await base.png().toFile(path.join(work, 'background.png'));
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '2', '-loop', '1', '-framerate', String(FPS), '-protocol_whitelist', 'file', '-i', path.join(work, 'background.png'),
      '-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file', '-i', path.join(work, 'timeline.ffconcat'), '-protocol_whitelist', 'file', '-i', audio];
    const filters = ['[0:v]setsar=1,format=yuv420p[base]'];
    let bottom = 'base';
    clips.forEach((clip, index) => {
      args.push('-protocol_whitelist', 'file', '-i', clip.path);
      const duration = (clip.end - clip.start).toFixed(6), next = `layer${index}`;
      filters.push(`[${index + 3}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1,fps=${FPS},trim=duration=${duration},tpad=stop_mode=clone:stop_duration=${duration},trim=duration=${duration},setpts=PTS-STARTPTS+${clip.start.toFixed(6)}/TB[clip${index}]`);
      filters.push(`[${bottom}][clip${index}]overlay=eof_action=pass:repeatlast=0:enable='gte(t,${clip.start})*lt(t,${clip.end})'[${next}]`);
      bottom = next;
    });
    filters.push(`[1:v]fps=${FPS},format=rgba[strips]`, `[${bottom}][strips]overlay=eof_action=repeat:format=auto,format=yuv420p[video]`);
    const filter = path.join(work, 'compose.filter'); fs.writeFileSync(filter, filters.join(';\n'));
    const output = path.join(work, 'result.mp4');
    args.push('-filter_complex_threads', '2', '-filter_complex_script', filter, '-map', '[video]', '-map', '2:a:0', '-af', 'apad', '-t', song.duration.toFixed(6), '-r', String(FPS),
      '-c:v', 'libx264', '-threads', '2', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-fs', String(256 * 1024 * 1024), output);
    await runMediaProcess('ffmpeg', args, signal, 600_000, error);
    signal?.throwIfAborted();
    const probe = JSON.parse(await runMediaProcess('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', output], signal, 15_000, error));
    const video = probe.streams?.find((s: any) => s.codec_type === 'video');
    if (video?.width !== WIDTH || video?.height !== HEIGHT || !probe.streams?.some((s: any) => s.codec_type === 'audio') || !Number.isFinite(Number(probe.format?.duration)) || Math.abs(Number(probe.format.duration) - song.duration) > 0.15) throw new ChatSongError(500, copy.invalidOutput);
    const bytes = fs.readFileSync(output);
    if (!bytes.length || bytes.length >= 256 * 1024 * 1024) throw new ChatSongError(400, copy.outputTooLarge);
    const result: ChatSongRender = { fileId: `chat-song-${id}-r${project.revision}-${randomUUID().slice(0, 8)}.mp4`, sha256: createHash('sha256').update(bytes).digest('hex'), sourceRevision: project.revision,
      templateVersion: CHAT_SONG_TEMPLATE.version, duration: Number(probe.format.duration), width: WIDTH, height: HEIGHT, createdAt: new Date().toISOString(), warnings: [!background && !clips.length ? copy.plainBackground : '', !images.has('avatarA:') || !images.has('avatarB:') ? copy.letterAvatars : ''].filter(Boolean) };
    await runSerializedMutation(`chat-song:${userId}`, async () => {
      signal?.throwIfAborted();
      if (getChatSongProject(userId, id).revision !== project.revision) throw new ChatSongError(409, copy.changedProject);
      destination = path.join(generatedKnowledgeDirectory({ userId, domain: 'personal' }), result.fileId);
      fs.copyFileSync(output, destination, fs.constants.COPYFILE_EXCL);
      await registerGeneratedKnowledgeFile({ userId, domain: 'personal' }, result.fileId);
      saveChatSongRender(userId, id, result); committed = true;
    });
    return result;
  } finally {
    // Only delete files created by this render; the work directory comes from mkdtemp.
    try {
      if (destination && !committed) fs.rmSync(destination, { force: true });
      if (work) removeChatSongRenderWorkspace(userId, work);
    } finally { active.delete(userId); }
  }
}
