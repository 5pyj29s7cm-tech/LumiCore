import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import JSZip from 'jszip';
import { z } from 'zod';
import { getDataPath } from '../config/data_path';
import { ensurePrivateRuntimeDirectory } from '../config/runtime_file_security';
import { generatedKnowledgeDirectory } from '../files/knowledge_directory';
import { registerGeneratedKnowledgeFile } from '../files/generated_archive';
import { searchChatSongReactions, chatSongReactionCandidate } from './chat_song_reactions';
import { runSerializedMutation } from '../persistence/durable_scope_mutation';
import { runMediaProcess } from '../media/process';
import { CHAT_SONG_AUDIO_EXTENSIONS, CHAT_SONG_DEFAULT_BRIEF, chatSongLyrics, chatSongSongCurrent, type ChatSongProject, type ChatSongBrief, type ChatSongLine, type ChatSongTiming, type ChatSongRender, type ChatSongAnimation } from '../../shared/chat_song';
import { CHAT_SONG_EXPORT_NAMES as names, CHAT_SONG_RENDER_COPY as copy, chatSongDraftMessages, chatSongImagePrompt, chatSongEditingNotes, chatSongSingingPrompt, chatSongTaskPrompt } from '../regions/packs/cn/chat_song';
import { makeLLMCallStreaming } from '../llm/providers';
import { getUserPreferredLLMConfig } from '../llm/user_preferences';
import { modelRoutingErrorReason } from '../llm/model_routing_receipts';
import { isStrictPrivacy } from '../config/privacy';
import { providerGetterArguments, type ProviderGetters } from '../llm/provider_getters';
import { CHAT_SONG_TEMPLATE, chatSongStripLayout, chatSongMessageIsRight } from '../../shared/chat_song_layout';

export class ChatSongError extends Error { constructor(public status: number, message: string) { super(message); } }
const text = (max: number) => z.string().trim().max(max);
const briefSchema = z.object({ theme: text(500), relationship: text(500), twist: text(800), targetSeconds: z.number().int().min(10).max(300), visualStyle: text(800), musicStyle: text(500), roleA: text(80).min(1), roleB: text(80).min(1), outputStyle: z.enum(['chat', 'animation']).default('chat'), messageLayout: z.enum(['single', 'conversation']).default('single'), displayNameA: text(30).default(''), displayNameB: text(30).default('') }).strict();
const linesSchema = z.array(z.object({ role: z.enum(['A', 'B']), text: text(100).min(1), group: z.number().int().min(1).max(40), reaction: text(180).default('') }).strict()).max(40);
const idSchema = z.string().uuid();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ChatSongError(400, result.error.issues.map(item => `${item.path.join('.')}: ${item.message}`).join('; ').slice(0, 700));
  return result.data;
}
function folder(userId: string): string {
  if (!userId || ['anonymous', 'system'].includes(userId)) throw new ChatSongError(403, 'An account owner is required.');
  const root = ensurePrivateRuntimeDirectory(getDataPath('chat-song-projects'));
  return ensurePrivateRuntimeDirectory(path.join(root, createHash('sha256').update(userId).digest('hex')));
}
function projectFile(userId: string, id: string): string { return path.join(folder(userId), `${parse(idSchema, id)}.json`); }
function noLink(file: string): void {
  for (let current = path.resolve(file);;) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new ChatSongError(400, 'Symbolic links are not supported for project files.');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function atomicWrite(file: string, bytes: string | Buffer): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function getChatSongProject(userId: string, id: string): ChatSongProject {
  const file = projectFile(userId, id);
  if (!fs.existsSync(file)) throw new ChatSongError(404, 'Project not found.');
  noLink(file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function listChatSongProjects(userId: string): ChatSongProject[] {
  return fs.readdirSync(folder(userId)).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))
    .map(name => getChatSongProject(userId, name.slice(0, -5))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function createChatSongRenderWorkspace(userId: string, id: string): string {
  getChatSongProject(userId, id);
  return ensurePrivateRuntimeDirectory(fs.mkdtempSync(path.join(folder(userId), '.render-')));
}
export function removeChatSongRenderWorkspace(userId: string, directory: string): void {
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(folder(userId)) || !/^\.render-[\w-]+$/.test(path.basename(resolved))) throw new ChatSongError(500, 'Unexpected render workspace.');
  fs.rmSync(resolved, { recursive: true, force: true });
}
function readChatSongOutputs(userId: string, id: string): Partial<ChatSongRender> & { animation?: ChatSongAnimation } {
  getChatSongProject(userId, id);
  const file = path.join(folder(userId), `${id}.render.json`);
  if (!fs.existsSync(file)) return {};
  noLink(file);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
export function chatSongRenderInputSha(project: ChatSongProject): string {
  const { outputStyle: _outputStyle, ...brief } = project.brief;
  return createHash('sha256').update(JSON.stringify({ template: CHAT_SONG_TEMPLATE.version, brief, lines: project.lines, assets: project.assets,
    song: project.song && { fileId: project.song.fileId, sha256: project.song.sha256, duration: project.song.duration, scriptRevision: project.song.scriptRevision }, timings: project.timings })).digest('hex');
}
export function getChatSongRender(userId: string, id: string): ChatSongRender | null {
  const { animation: _animation, ...result } = readChatSongOutputs(userId, id);
  if (!result.fileId) return null;
  if (result.fileId !== path.basename(result.fileId)) throw new ChatSongError(400, 'Invalid render receipt.');
  if (!fs.existsSync(path.join(generatedKnowledgeDirectory({ userId, domain: 'personal' }), result.fileId))) return null;
  const project = getChatSongProject(userId, id);
  return { ...result, ...(result.sourceInputsSha256 === chatSongRenderInputSha(project) ? { sourceRevision: project.revision } : {}) } as ChatSongRender;
}
export function getChatSongAnimation(userId: string, id: string): ChatSongAnimation | null {
  const animation = readChatSongOutputs(userId, id).animation;
  if (!animation) return null;
  if (chatSongLibraryFile(userId, animation.fileId, 'video').sha256 !== animation.sha256) throw new ChatSongError(409, 'The bound animation changed. Select it again.');
  return animation;
}
export function saveChatSongRender(userId: string, id: string, result: ChatSongRender): void {
  const { animation } = readChatSongOutputs(userId, id);
  atomicWrite(path.join(folder(userId), `${parse(idSchema, id)}.render.json`), JSON.stringify({ ...result, ...(animation ? { animation } : {}) }));
}
async function bindChatSongAnimation(userId: string, id: string, revision: unknown, input: unknown, signal?: AbortSignal): Promise<ChatSongProject> {
  const value = parse(z.object({ kind: z.literal('animation'), fileId: text(255).min(1) }).strict(), input);
  return runSerializedMutation(`chat-song:${userId}`, async () => {
    signal?.throwIfAborted();
    const project = getChatSongProject(userId, id);
    if (revision !== project.revision) throw new ChatSongError(409, 'Project changed. Reload it before binding a video.');
    if (!chatSongSongCurrent(project)) throw new ChatSongError(409, 'Select a song for the current finalized dialogue before binding a video.');
    if (chatSongLibraryFile(userId, project.song!.fileId, 'audio').sha256 !== project.song!.sha256) throw new ChatSongError(409, 'The selected song changed. Select it again.');
    const file = chatSongLibraryFile(userId, value.fileId, 'video');
    const duration = await probeMedia(file.path, 'video', signal);
    if (Math.abs(duration - project.song!.duration) > 0.15) throw new ChatSongError(400, 'The finished animation must match the selected song duration.');
    signal?.throwIfAborted();
    if (chatSongLibraryFile(userId, value.fileId, 'video').sha256 !== file.sha256) throw new ChatSongError(409, 'The animation changed while binding. Select it again.');
    const animation: ChatSongAnimation = { fileId: file.name, sha256: file.sha256, sourceRevision: project.revision,
      scriptRevision: project.scriptRevision, songSha256: project.song!.sha256, duration, createdAt: new Date().toISOString() };
    atomicWrite(path.join(folder(userId), `${id}.render.json`), JSON.stringify({ ...readChatSongOutputs(userId, id), animation }));
    return project;
  });
}
export async function createChatSongProject(userId: string, input: unknown, signal?: AbortSignal): Promise<ChatSongProject> {
  const value = parse(z.object({ id: idSchema, title: text(100).min(1), templateId: idSchema.optional() }).strict(), input);
  return runSerializedMutation(`chat-song:${userId}`, () => {
    signal?.throwIfAborted();
    const file = projectFile(userId, value.id);
    if (fs.existsSync(file)) return getChatSongProject(userId, value.id); // retry of this creation
    if (listChatSongProjects(userId).length >= 200) throw new ChatSongError(409, 'Project limit reached.');
    const template = value.templateId ? getChatSongProject(userId, value.templateId) : null;
    const project: ChatSongProject = { id: value.id, revision: 1, scriptRevision: 1, title: value.title,
      brief: template ? { ...template.brief } : { ...CHAT_SONG_DEFAULT_BRIEF }, lines: [], scriptLocked: false,
      assets: template ? template.assets.filter(asset => !asset.lineId) : [], song: null, timings: [], updatedAt: new Date().toISOString() };
    atomicWrite(file, JSON.stringify(project)); return project;
  });
}
export function changeChatSongProject(userId: string, id: string, revision: unknown, change: (draft: ChatSongProject) => void | Promise<void>, signal?: AbortSignal): Promise<ChatSongProject> {
  return runSerializedMutation(`chat-song:${userId}`, async () => {
    signal?.throwIfAborted();
    const draft = getChatSongProject(userId, id);
    if (!Number.isSafeInteger(revision) || draft.revision !== revision) throw new ChatSongError(409, 'Project changed. Reload it before saving.');
    await change(draft);
    signal?.throwIfAborted();
    draft.revision++; draft.updatedAt = new Date().toISOString();
    atomicWrite(projectFile(userId, id), JSON.stringify(draft)); return draft;
  });
}
/** Shared by the HTTP editor and model-selected tools; confirmation authority stays with the caller. */
export async function applyChatSongAction(userId: string, id: string, revision: unknown, action: string, value: unknown, signal?: AbortSignal) {
  if (action === 'attach-asset' && (value as { kind?: unknown } | null)?.kind === 'animation') return bindChatSongAnimation(userId, id, revision, value, signal);
  return changeChatSongProject(userId, id, revision, async draft => {
    if (action === 'save') {
      const { reactions, ...project } = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
      editChatSongProject(draft, project);
      if (reactions !== undefined) await adoptChatSongReactions(userId, draft, Number(revision), reactions, signal);
    }
    else if (action === 'lock-script') lockChatSongScript(draft);
    else if (action === 'attach-asset' && (value as any)?.kind === 'reaction' && (value as any)?.candidateId !== undefined) {
      const selected = parse(z.object({ kind: z.literal('reaction'), lineId: text(2).min(1), candidateId: text(64).length(64) }).strict(), value);
      await adoptChatSongReactions(userId, draft, Number(revision), [selected], signal);
    }
    else if (action === 'attach-asset') await attachChatSongAsset(userId, draft, value, signal);
    else if (action === 'select-song') await selectChatSongAudio(userId, draft, value, signal);
    else if (action === 'remove-asset') draft.assets = draft.assets.filter(asset => asset.id !== value);
    else if (action === 'confirm-song') confirmChatSongAudio(draft, value);
    else if (action === 'set-timings') setChatSongTimings(draft, value);
    else throw new ChatSongError(400, 'Unknown project action.');
  }, signal);
}

async function adoptChatSongReactions(userId: string, project: ChatSongProject, revision: number, input: unknown, signal?: AbortSignal) {
  const selections = parse(z.array(z.object({ kind: z.literal('reaction').optional(), lineId: text(2).min(1), candidateId: text(64).length(64) }).strict()).max(40), input);
  if (new Set(selections.map(row => row.lineId)).size !== selections.length) throw new ChatSongError(400, 'Choose one reaction per dialogue line.');
  const prepared = selections.map(row => {
    const line = project.lines.find(item => item.id === row.lineId), cached = line && chatSongReactionCandidate({ userId, projectId: project.id, revision }, row.candidateId, line);
    if (!cached) throw new ChatSongError(409, 'The reaction search expired or its dialogue changed. Search again before saving.');
    return { lineId: row.lineId, ...cached };
  });
  if (project.assets.filter(asset => asset.kind !== 'reaction' || !selections.some(row => row.lineId === asset.lineId)).length + selections.length > 43) throw new ChatSongError(400, 'Use at most 43 visual assets per episode.');
  for (const item of prepared) {
    signal?.throwIfAborted();
    const fileId = `web-reaction-${item.candidate.sha256}.png`, destination = path.join(generatedKnowledgeDirectory({ userId, domain: 'personal' }), fileId);
    if (!fs.existsSync(destination)) {
      fs.writeFileSync(destination, item.bytes, { flag: 'wx', mode: 0o600 });
      await registerGeneratedKnowledgeFile({ userId, domain: 'personal' }, fileId);
    } else if (chatSongLibraryFile(userId, fileId, 'image').sha256 !== item.candidate.sha256) throw new ChatSongError(409, 'The reaction image changed. Search again.');
    await attachChatSongAsset(userId, project, { kind: 'reaction', lineId: item.lineId, fileId }, signal);
    const { query, title, sourceUrl, imageUrl, sha256 } = item.candidate;
    project.assets[project.assets.length - 1].reactionSource = { query, title, sourceUrl, imageUrl, sha256 };
  }
}

export async function searchChatSongProjectReactions(userId: string, id: string, revision: unknown, input?: unknown, signal?: AbortSignal, dataRoutingPolicy?: 'policy_scoped' | 'local_only') {
  const project = getChatSongProject(userId, id);
  if (revision !== project.revision) throw new ChatSongError(409, 'Reload the current project before searching reactions.');
  const lines = input === undefined ? project.lines : normalizeChatSongLines(Array.isArray(input) ? input.map(row => {
    if (!row || typeof row !== 'object') return row;
    const { id: _id, ...line } = row; return line;
  }) : input);
  return { revision: project.revision, reactions: await searchChatSongReactions({ userId, projectId: id, revision: project.revision }, lines,
    { signal, blocked: isStrictPrivacy() || dataRoutingPolicy === 'local_only', skip: project.brief.outputStyle === 'animation' }) };
}

export function chatSongProjectReactionPreview(userId: string, id: string, candidateId: string) {
  const project = getChatSongProject(userId, id), image = chatSongReactionCandidate({ userId, projectId: id, revision: project.revision }, candidateId);
  if (!image) throw new ChatSongError(404, 'The reaction preview expired. Search again.');
  return image;
}

export function chatSongHandoff(project: ChatSongProject) {
  const animation = project.brief.outputStyle === 'animation';
  const prompts = animation ? [] : ['background', 'avatarA', 'avatarB'].map(kind => ({ kind, lineId: '', prompt: chatSongImagePrompt(project, kind) }));
  for (const line of project.lines) {
    if (animation) prompts.push({ kind: 'clip', lineId: line.id, prompt: chatSongImagePrompt(project, 'clip', line.id) });
  }
  return { lyrics: chatSongLyrics(project.lines), singing: chatSongSingingPrompt(project), prompts };
}

export async function draftChatSongDialogue(userId: string, id: string, revision: unknown, getters: ProviderGetters, signal?: AbortSignal, dataRoutingPolicy?: 'policy_scoped' | 'local_only') {
  signal?.throwIfAborted();
  const project = getChatSongProject(userId, id);
  if (revision !== project.revision) throw new ChatSongError(409, 'Save or reload the current project first.');
  const config = getUserPreferredLLMConfig(userId, { maxTokens: 8000, domain: 'personal', source: 'chat-song-draft' });
  if (isStrictPrivacy() || dataRoutingPolicy === 'local_only' || config.provider !== 'relay') throw new ChatSongError(409, 'Choose Lumi Official API in model settings. Cloud creation is unavailable in local-only privacy mode.');
  const response = await makeLLMCallStreaming(chatSongDraftMessages(project), [],
    { ...config, reasoningEffort: 'low', responseFormat: 'json_object', selectionMode: 'pinned', noImplicitFailover: true, attemptTimeouts: { semanticContentMs: 120_000, absoluteMs: 150_000 }, signal, dataRoutingPolicy }, () => {},
    ...providerGetterArguments(getters)).catch(error => {
      signal?.throwIfAborted();
      throw new ChatSongError(modelRoutingErrorReason(error) === 'timeout' ? 504 : 502, copy.draftUnavailable);
    });
  signal?.throwIfAborted();
  if (response.streamIncomplete || response.finishReason !== 'stop') throw new ChatSongError(502, 'The model returned an incomplete draft. Your saved dialogue has not changed.');
  let output: unknown;
  try { output = JSON.parse(String(response.text || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '')); }
  catch { throw new ChatSongError(502, 'The model returned an incomplete draft. Your saved dialogue has not changed.'); }
  const lines = normalizeChatSongLines((output as any)?.lines);
  if (lines.length < 2 || !lines.some(line => line.role === 'A') || !lines.some(line => line.role === 'B')) throw new ChatSongError(502, 'The draft must include both speakers.');
  const reactions = await searchChatSongReactions({ userId, projectId: id, revision: project.revision }, lines,
    { signal, blocked: isStrictPrivacy(), skip: project.brief.outputStyle === 'animation' });
  return { revision: project.revision, lines, reactions };
}

export function normalizeChatSongLines(input: unknown): ChatSongLine[] {
  const lines = parse(linesSchema, input);
  if (lines.some((line, i) => (i === 0 ? line.group !== 1 : line.group < lines[i - 1].group || line.group > lines[i - 1].group + 1))) throw new ChatSongError(400, 'Groups must start at 1 and remain consecutive.');
  return lines.map((line, index) => ({ role: line.role!, text: line.text!, group: line.group!, reaction: line.reaction || '', id: String(index + 1).padStart(2, '0') }));
}
export function editChatSongProject(project: ChatSongProject, input: unknown): void {
  const value = parse(z.object({ title: text(100).min(1), brief: briefSchema, lines: z.array(z.unknown()).max(40) }).strict(), input);
  const lines = normalizeChatSongLines(value.lines);
  const changed = JSON.stringify(project.lines.map(({ role, text }) => [role, text])) !== JSON.stringify(lines.map(({ role, text }) => [role, text]))
    || project.brief.roleA !== value.brief.roleA || project.brief.roleB !== value.brief.roleB || project.brief.musicStyle !== value.brief.musicStyle;
  if (changed) { project.scriptRevision++; project.scriptLocked = false; if (project.song) project.song.confirmed = false; project.timings = []; }
  const previousLines = project.lines;
  project.title = value.title; project.brief = value.brief as ChatSongBrief; project.lines = lines;
  project.assets = project.assets.filter(asset => !asset.lineId || (!changed && lines.some(line => line.id === asset.lineId && line.reaction === previousLines.find(prior => prior.id === line.id)?.reaction)));
}
export function lockChatSongScript(project: ChatSongProject): void {
  if (project.lines.length < 2 || !project.lines.some(line => line.role === 'A') || !project.lines.some(line => line.role === 'B')) throw new ChatSongError(400, 'A script needs at least two lines and both speakers.');
  project.scriptLocked = true;
}
export function chatSongLibraryFile(userId: string, fileId: unknown, kind: 'image' | 'audio' | 'video'): { path: string; name: string; sha256: string } {
  const name = parse(z.string().min(1).max(255), fileId);
  if (/[<>:"/\\|?*\x00-\x1f]/.test(name) || name === '.' || name === '..') throw new ChatSongError(400, 'Invalid library file ID.');
  const ext = path.extname(name).toLowerCase();
  if (!(kind === 'image' ? ['.png', '.jpg', '.jpeg', '.webp'] : kind === 'video' ? ['.mp4', '.webm', '.mov'] : CHAT_SONG_AUDIO_EXTENSIONS).includes(ext)) throw new ChatSongError(400, 'Choose a supported image, video or audio file.');
  const file = path.join(generatedKnowledgeDirectory({ userId, domain: 'personal' }), name);
  if (!fs.existsSync(file)) throw new ChatSongError(404, 'Library file no longer exists.');
  noLink(file); const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 1 || stat.size > (kind === 'image' ? 12 : 80) * 1024 * 1024) throw new ChatSongError(400, 'Image limit is 12 MB; audio/video limit is 80 MB.');
  return { path: file, name, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
}
export async function attachChatSongAsset(userId: string, project: ChatSongProject, input: unknown, signal?: AbortSignal): Promise<void> {
  const value = parse(z.object({ kind: z.enum(['background', 'avatarA', 'avatarB', 'reaction', 'clip']), lineId: text(2).default(''), fileId: text(255).min(1) }).strict(), input);
  const perLine = value.kind === 'reaction' || value.kind === 'clip';
  if (perLine && !project.lines.some(line => line.id === value.lineId)) throw new ChatSongError(400, 'Choose a line for the reaction or clip.');
  const file = chatSongLibraryFile(userId, value.fileId, value.kind === 'clip' ? 'video' : 'image');
  if (value.kind === 'clip') await probeMedia(file.path, 'video', signal);
  else {
    const metadata = await (sharp as any)(file.path, { limitInputPixels: 25_000_000 }).metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format || '')) throw new ChatSongError(400, 'Unsupported image contents.');
  }
  const lineId = perLine ? value.lineId : '';
  project.assets = project.assets.filter(asset => asset.kind !== value.kind || asset.lineId !== lineId);
  if (project.assets.length >= 43) throw new ChatSongError(400, 'Use at most 43 visual assets per episode.');
  project.assets.push({ id: randomUUID(), kind: value.kind, lineId, fileId: file.name, name: file.name, sha256: file.sha256 });
}
async function probeMedia(file: string, kind: 'audio' | 'video', signal?: AbortSignal): Promise<number> {
  const output = await runMediaProcess('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], signal, 15_000, (_code, message, status) => new ChatSongError(status || 400, message));
  const data = JSON.parse(output), duration = Number(data?.format?.duration);
  if (!data.streams?.some((stream: any) => stream.codec_type === kind) || !Number.isFinite(duration) || duration <= 0 || duration > 900) throw new ChatSongError(400, 'Media must contain the expected track and be at most 15 minutes long.');
  return duration;
}
export async function selectChatSongAudio(userId: string, project: ChatSongProject, input: unknown, signal?: AbortSignal): Promise<void> {
  if (!project.scriptLocked) throw new ChatSongError(409, 'Finalize the dialogue before selecting a song.');
  const value = parse(z.object({ fileId: text(255).min(1) }).strict(), input);
  const file = chatSongLibraryFile(userId, value.fileId, 'audio');
  const duration = await probeMedia(file.path, 'audio', signal);
  project.song = { fileId: file.name, name: file.name, sha256: file.sha256, duration, scriptRevision: project.scriptRevision, confirmed: false };
  project.timings = [];
}
export function confirmChatSongAudio(project: ChatSongProject, checks: unknown): void {
  parse(z.object({ noOmissions: z.literal(true), noRewrites: z.literal(true), noRepeats: z.literal(true), correctOrder: z.literal(true) }).strict(), checks);
  if (!project.scriptLocked || !project.song || project.song.scriptRevision !== project.scriptRevision) throw new ChatSongError(409, 'Select a song for the current finalized dialogue.');
  project.song.confirmed = true;
}
export function setChatSongTimings(project: ChatSongProject, input: unknown): void {
  if (!chatSongSongCurrent(project)) throw new ChatSongError(409, 'Select a song for the current finalized dialogue before setting edit times.');
  const timings = parse(z.array(z.object({ lineId: text(2).min(1), start: z.number().finite().min(0), end: z.number().finite().positive() }).strict()).max(40), input);
  if (timings.length !== project.lines.length || timings.some((timing, i) => timing.lineId !== project.lines[i].id || timing.end <= timing.start || timing.end > project.song!.duration || (i > 0 && timing.start < timings[i - 1].end))) throw new ChatSongError(400, 'Supply ordered, non-overlapping start/end times for every line within the selected song.');
  project.timings = timings as ChatSongTiming[];
}
const xml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]!));
export async function renderChatSongStrip(line: ChatSongLine, avatar?: Buffer, displayName = ''): Promise<Buffer> {
  const { height, bubbleWidth, bubbleX, textX, textTop, rows, avatarX, avatarY, screenshot } = chatSongStripLayout(line, displayName);
  const s = CHAT_SONG_TEMPLATE;
  const labels = rows.map((row, index) => `<text x="${textX}" y="${textTop + s.fontSize + index * s.lineHeight}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="${s.fontSize}" fill="#111111" xml:space="preserve">${xml(row)}</text>`).join('');
  const right = chatSongMessageIsRight(line);
  const nameX = right ? bubbleX + bubbleWidth : bubbleX;
  const tail = right ? `${bubbleX + bubbleWidth},72 ${bubbleX + bubbleWidth + 12},84 ${bubbleX + bubbleWidth},96` : `${bubbleX},72 ${bubbleX - 12},84 ${bubbleX},96`;
  const fill = right ? s.outgoingBubble : s.incomingBubble;
  const background = Buffer.from(`<svg width="1080" height="${height}"><rect x="${screenshot.left}" width="${screenshot.width}" height="${height}" fill="${s.screenshotFill}"/><text x="${nameX}" y="30" text-anchor="${right ? 'end' : 'start'}" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="28" fill="${s.nameColor}">${xml(displayName || line.role)}</text><rect x="${bubbleX}" y="44" width="${bubbleWidth}" height="${height - 58}" rx="18" fill="${fill}"/><polygon points="${tail}" fill="${fill}"/><rect x="${avatarX}" y="${avatarY}" width="${s.avatarSize}" height="${s.avatarSize}" rx="16" fill="#46515d"/><text x="${avatarX + 50}" y="${avatarY + 68}" text-anchor="middle" font-family="sans" font-size="46" fill="white">${line.role}</text>${labels}</svg>`);
  const layers: any[] = [];
  if (avatar) {
    const mask = Buffer.from(`<svg width="${s.avatarSize}" height="${s.avatarSize}"><rect width="100%" height="100%" rx="16" fill="white"/></svg>`);
    layers.push({ input: await (sharp as any)(avatar, { limitInputPixels: 25_000_000 }).resize(s.avatarSize, s.avatarSize, { fit: 'cover' }).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer(), left: avatarX, top: avatarY });
  }
  return sharp(background).composite(layers).png().toBuffer();
}
function csvCell(value: unknown): string {
  let content = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(content)) content = `'${content}`;
  return `"${content.replace(/"/g, '""')}"`;
}
export function exportChatSongPackage(userId: string, project: ChatSongProject, signal?: AbortSignal) {
  return runSerializedMutation(`chat-song-export:${userId}`, () => buildPackage(userId, project, signal));
}
async function buildPackage(userId: string, project: ChatSongProject, signal?: AbortSignal): Promise<{ fileId: string; url: string; timed: boolean; warnings: string[]; handoffs: { music: string; edit: string } }> {
  signal?.throwIfAborted();
  if (!project.scriptLocked) throw new ChatSongError(409, 'Finalize the dialogue before exporting.');
  const zip = new JSZip(), warnings: string[] = [], assets = new Map<string, Buffer>();
  const dir = generatedKnowledgeDirectory({ userId, domain: 'personal' });
  const prefix = `chat-song-${project.id}-r${project.revision}-v${CHAT_SONG_TEMPLATE.version}`;
  const published: Array<{ name: string; bytes: Buffer }> = [];
  let totalBytes = 0;
  for (const asset of project.assets) {
    signal?.throwIfAborted();
    const source = chatSongLibraryFile(userId, asset.fileId, asset.kind === 'clip' ? 'video' : 'image');
    if (source.sha256 !== asset.sha256) throw new ChatSongError(409, 'A source image changed; select it again.');
    const bytes = fs.readFileSync(source.path); assets.set(`${asset.kind}:${asset.lineId}`, bytes);
    totalBytes += bytes.length;
    if (totalBytes > 200 * 1024 * 1024) throw new ChatSongError(400, 'Visual assets exceed the 200 MB package limit.');
    zip.file(`${names.images}/${asset.kind}${asset.lineId ? `_${asset.lineId}` : ''}${path.extname(source.name)}`, bytes);
  }
  if (['background', 'avatarA', 'avatarB'].some(kind => !assets.has(`${kind}:`))) warnings.push(names.missing);
  const songCurrent = chatSongSongCurrent(project);
  if (!songCurrent) warnings.push(copy.needSong); else if (!project.song?.confirmed) warnings.push(names.songPending);
  if (project.song && songCurrent) {
    const source = chatSongLibraryFile(userId, project.song.fileId, 'audio');
    if (source.sha256 !== project.song.sha256) throw new ChatSongError(409, 'The selected song changed; select it again and redo its timing.');
    zip.file(`${names.song}${path.extname(source.name)}`, fs.readFileSync(source.path));
  }
  const timed = songCurrent && project.timings.length === project.lines.length;
  zip.file(names.lyrics, chatSongLyrics(project.lines));
  zip.file(names.singing, chatSongSingingPrompt(project));
  zip.file(names.dialogue, project.lines.map(line => `${line.id}\t${line.role === 'A' ? project.brief.roleA : project.brief.roleB}\t${line.text}`).join('\n'));
  const rows: unknown[][] = [['line', 'role', 'text', 'group', 'strip', 'reaction', 'start_seconds', 'end_seconds']];
  for (const line of project.lines) {
    const filename = `${names.strips}_${line.id}.png`;
    const displayName = line.role === 'A' ? project.brief.displayNameA || project.brief.roleA : project.brief.displayNameB || project.brief.roleB;
    const strip = chatSongStripLayout(line, displayName);
    const image = project.brief.outputStyle === 'animation' ? null : await sharp(await renderChatSongStrip(line, assets.get(`avatar${line.role}:`), displayName))
      .extract({ left: strip.screenshot.left, top: 0, width: strip.screenshot.width, height: strip.height }).png().toBuffer();
    signal?.throwIfAborted();
    if (image) zip.file(`${names.images}/${filename}`, image);
    const libraryId = `${prefix}-${line.id}.png`;
    if (image) published.push({ name: libraryId, bytes: image });
    const timing = timed ? project.timings.find(item => item.lineId === line.id) : null;
    rows.push([line.id, line.role, line.text, line.group, image ? filename : '', line.reaction, timing?.start ?? '', timing?.end ?? '']);
  }
  zip.file(names.order, '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'));
  zip.file(names.notes, chatSongEditingNotes(project, timed, warnings));
  zip.file('project.json', JSON.stringify({ ...project, format: 'chat-song-materials-v1', frame: { width: 1080, height: 1440 }, timed, warnings }, null, 2));
  const fileId = `${prefix}.zip`;
  const bundle = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 3 } });
  for (const output of [...published, { name: fileId, bytes: bundle }]) {
    signal?.throwIfAborted();
    atomicWrite(path.join(dir, output.name), output.bytes);
    await registerGeneratedKnowledgeFile({ userId, domain: 'personal' }, output.name);
  }
  return { fileId, url: `/api/files/download/${encodeURIComponent(fileId)}?domain=personal`, timed, warnings,
    handoffs: { music: chatSongTaskPrompt(project, path.join(dir, fileId), 'music'), edit: timed ? chatSongTaskPrompt(project, path.join(dir, fileId), 'edit') : '' } };
}
