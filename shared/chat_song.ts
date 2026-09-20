export type ChatSongLine = { id: string; role: 'A' | 'B'; text: string; group: number; reaction: string };
export type ChatSongBrief = { theme: string; relationship: string; twist: string; targetSeconds: number; visualStyle: string; musicStyle: string; roleA: string; roleB: string };
export type ChatSongAssetKind = 'background' | 'avatarA' | 'avatarB' | 'reaction' | 'clip';
export type ChatSongAsset = { id: string; kind: ChatSongAssetKind; lineId: string; fileId: string; name: string; sha256: string };
export type ChatSongTiming = { lineId: string; start: number; end: number };
export type ChatSongRender = {
  templateVersion?: number;
  fileId: string; sha256: string; sourceRevision: number; duration: number;
  width: number; height: number; createdAt: string; warnings: string[];
};
export type ChatSongProject = {
  id: string; revision: number; scriptRevision: number; title: string; brief: ChatSongBrief;
  lines: ChatSongLine[]; scriptLocked: boolean; assets: ChatSongAsset[];
  song: null | { fileId: string; name: string; sha256: string; duration: number; scriptRevision: number; confirmed: boolean };
  timings: ChatSongTiming[]; updatedAt: string;
};
export const CHAT_SONG_DEFAULT_BRIEF: ChatSongBrief = {
  theme: '', relationship: '', twist: '', targetSeconds: 40, visualStyle: '', musicStyle: '', roleA: 'A', roleB: 'B',
};
export function chatSongLyrics(lines: ChatSongLine[]): string { return lines.map(line => line.text).join('\n'); }
export function chatSongSongCurrent(project: ChatSongProject): boolean {
  return Boolean(project.scriptLocked && project.song?.confirmed && project.song.scriptRevision === project.scriptRevision);
}
/** A line is revealed only when its real singing onset has been supplied. */
export function visibleChatSongLines(project: ChatSongProject, seconds: number): ChatSongLine[] {
  if (!chatSongSongCurrent(project)) return [];
  const latest = [...project.timings].reverse().find(timing => timing.start <= seconds);
  const active = project.lines.find(line => line.id === latest?.lineId);
  if (!active) return [];
  return project.lines.filter(line => line.group === active.group && project.timings.some(timing => timing.lineId === line.id && timing.start <= seconds));
}
