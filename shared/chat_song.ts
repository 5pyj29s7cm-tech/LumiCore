/** Accepted song containers still require a measured audio stream. */
export const CHAT_SONG_AUDIO_EXTENSIONS: readonly string[] = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.aac', '.mp4', '.webm', '.mov'];
export type ChatSongLine = { id: string; role: 'A' | 'B'; text: string; group: number; reaction: string };
export type ChatSongBrief = { theme: string; relationship: string; twist: string; targetSeconds: number; visualStyle: string; musicStyle: string; roleA: string; roleB: string; outputStyle?: 'chat' | 'animation'; messageLayout?: 'single' | 'conversation'; displayNameA?: string; displayNameB?: string };
export type ChatSongAssetKind = 'background' | 'avatarA' | 'avatarB' | 'reaction' | 'clip';
export type ChatSongReactionCandidate = { id: string; lineId: string; title: string; query: string; sourceUrl: string; imageUrl: string; previewUrl: string; width: number; height: number; sha256: string };
export type ChatSongReactionSearch = { lineId: string; query: string; status: 'matched' | 'no_match' | 'unavailable' | 'empty' | 'skipped' | 'privacy_blocked'; candidates: ChatSongReactionCandidate[] };
export type ChatSongAsset = { id: string; kind: ChatSongAssetKind; lineId: string; fileId: string; name: string; sha256: string;
  reactionSource?: { query: string; title: string; sourceUrl: string; imageUrl: string; sha256: string } };
export type ChatSongTiming = { lineId: string; start: number; end: number };
export type ChatSongRender = {
  templateVersion?: number;
  sourceInputsSha256?: string;
  fileId: string; sha256: string; sourceRevision: number; duration: number;
  width: number; height: number; createdAt: string; warnings: string[];
};
export type ChatSongAnimation = Pick<ChatSongRender, 'fileId' | 'sha256' | 'sourceRevision' | 'duration' | 'createdAt'> & { scriptRevision: number; songSha256: string };
export type ChatSongVideoVersions = { render: ChatSongRender | null; animation: ChatSongAnimation | null; animationError?: string };
export type ChatSongProject = {
  id: string; revision: number; scriptRevision: number; title: string; brief: ChatSongBrief;
  lines: ChatSongLine[]; scriptLocked: boolean; assets: ChatSongAsset[];
  song: null | { fileId: string; name: string; sha256: string; duration: number; scriptRevision: number; confirmed: boolean };
  timings: ChatSongTiming[]; updatedAt: string;
};
export const CHAT_SONG_DEFAULT_BRIEF: ChatSongBrief = {
  theme: '', relationship: '', twist: '', targetSeconds: 40, visualStyle: '', musicStyle: '', roleA: 'A', roleB: 'B', outputStyle: 'chat', messageLayout: 'single', displayNameA: '', displayNameB: '',
};
export function chatSongLyrics(lines: ChatSongLine[]): string { return lines.map(line => line.text).join('\n'); }
export function chatSongSongCurrent(project: ChatSongProject): boolean {
  return Boolean(project.scriptLocked && project.song && project.song.scriptRevision === project.scriptRevision);
}
/** A line is revealed only when its real singing onset has been supplied. */
export function visibleChatSongLines(project: ChatSongProject, seconds: number): ChatSongLine[] {
  if (!chatSongSongCurrent(project)) return [];
  const latest = [...project.timings].reverse().find(timing => timing.start <= seconds);
  const active = project.lines.find(line => line.id === latest?.lineId);
  if (!active) return [];
  if (project.brief.messageLayout !== 'conversation') return [active];
  return project.lines.filter(line => line.group === active.group && project.timings.some(timing => timing.lineId === line.id && timing.start <= seconds));
}
