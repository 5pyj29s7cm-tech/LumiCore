import type { MemoryAvatarAppearance } from './memory_avatar';

/** A source-neutral event. An official connector can later supply its own stable id. */
export interface AvatarLiveComment { id: string; nickname: string; text: string; receivedAt: number; source: 'screen' | 'test' }
export interface VisibleLiveComment { nickname: string; text: string }
export interface AvatarLiveTurn { nickname: string; comment: string; reply: string }
export interface AvatarLiveReply { text: string; audioBase64: string; format: string }
export function liveAudioEncoding(format: unknown): string | undefined {
  if (typeof format !== 'string') return undefined;
  const value = format.trim().toLowerCase().split(';')[0];
  const aliases: Record<string, string> = { 'audio/mp3': 'mp3', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/opus': 'opus', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac' };
  return Object.hasOwn(aliases, value) ? aliases[value] : ['mp3', 'wav', 'ogg', 'opus', 'm4a', 'aac', 'flac'].includes(value) ? value : undefined;
}
export interface AvatarLiveStageConfig {
  portraitProvider?: 'did' | 'aliyun';
  avatarId: string; ownerId: string; name: string; appearance: MemoryAvatarAppearance;
  locale: 'zh' | 'en'; portraitMediaId?: string;
}
const clean = (text: string) => text.normalize('NFKC').replace(/\s+/g, ' ').trim();
/** Conservative OCR deduplication: identical visible messages cannot prove a new send. */
export class AvatarLiveInbox {
  private seen = new Map<string, number>();
  private visible = new Set<string>();
  private baseline = false;
  private serial = 0;
  private pending: AvatarLiveComment[] = [];
  skipped = 0;
  constructor(private readonly now: () => number = Date.now) {}
  ingest(rows: VisibleLiveComment[]): AvatarLiveComment[] {
    const now = this.now();
    for (const [key, at] of this.seen) if (now - at > 300_000) this.seen.delete(key);
    const fresh: AvatarLiveComment[] = [];
    const visible = new Set<string>();
    for (const row of rows.slice(-30)) {
      const nickname = clean(row.nickname).slice(0, 80), text = clean(row.text).slice(0, 500);
      if (!nickname || !text) continue;
      const key = JSON.stringify([nickname, text]);
      if (!this.seen.has(key) && !this.visible.has(key) && this.baseline) fresh.push({ id: `screen-${now}-${++this.serial}`, nickname, text, receivedAt: now, source: 'screen' });
      this.seen.set(key, now);
      visible.add(key);
    }
    while (this.seen.size > 600) this.seen.delete(this.seen.keys().next().value!);
    this.baseline = true;
    this.visible = visible;
    this.pending.push(...fresh);
    while (this.pending.length > 5) { this.pending.shift(); this.skipped++; }
    return fresh;
  }
  take(): AvatarLiveComment | undefined {
    while (this.pending.length) {
      const row = this.pending.shift()!;
      if (this.now() - row.receivedAt <= 60_000) return row;
      this.skipped++;
    }
  }
  get queued() { return this.pending.length; }
  reset() { this.pending = []; this.seen.clear(); this.visible.clear(); this.baseline = false; this.skipped = 0; }
}

/** Reject malformed model output instead of treating free prose as a viewer message. */
export function parseVisibleLiveComments(value: string): VisibleLiveComment[] {
  const raw = value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const object = JSON.parse(raw);
  if (!object || !Array.isArray(object.comments) || object.comments.length > 30) throw new Error('live_scan_invalid');
  return object.comments.map((row: unknown) => {
    if (!row || typeof row !== 'object' || !('nickname' in row) || !('text' in row)
      || typeof row.nickname !== 'string' || typeof row.text !== 'string'
      || !row.nickname.trim() || !row.text.trim() || row.nickname.length > 80 || row.text.length > 500) throw new Error('live_scan_invalid');
    return { nickname: row.nickname.trim(), text: row.text.trim() };
  });
}
