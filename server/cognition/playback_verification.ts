/** Pure playback evidence: runtime-owned captures, not a model's completion vote. */
export interface PlaybackGoal { player: string; title: string; season: string; episode: string; artist?: string }
export interface VisualPlaybackObservation extends PlaybackGoal {
  phase: 'content' | 'advertisement' | 'buffering' | 'paused' | 'blocked' | 'unknown';
  positionSeconds: number | null;
}
export interface PlaybackSample extends VisualPlaybackObservation {
  capturedAt: number;
  windowId: string;
  pid: number;
  frameDigest: string;
}
export interface PlaybackVerification {
  version: 1;
  source: 'visual_progress';
  target: PlaybackGoal;
  samples: [PlaybackSample, PlaybackSample];
  verified: true;
}

const GOAL_FIELDS = ['player', 'title', 'season', 'episode'] as const;
const PHASES = new Set(['content', 'advertisement', 'buffering', 'paused', 'blocked', 'unknown']);
const ORDINAL = '[\\d一二三四五六七八九十百千零〇两]+|one|two|three|four|five|six|seven|eight|nine|ten'; // i18n-allow: Numeric input grammar.
const SEASON = new RegExp(`第\\s*(${ORDINAL})\\s*季|\\bseason\\s+(${ORDINAL})\\b`, 'iu'); // i18n-allow: Media metadata input grammar.
const EPISODE = new RegExp(`第\\s*(${ORDINAL})\\s*集|\\bepisode\\s+(${ORDINAL})\\b`, 'iu'); // i18n-allow: Media metadata input grammar.
const PLAYERS = [
  ['爱奇艺', 'iqiyi', 'iqiyiplayer'], ['优酷', 'youku'], ['腾讯视频', 'qqlive', 'tencentvideo'], // i18n-allow: Application identity aliases.
  ['哔哩哔哩', 'bilibili'], ['芒果TV', 'mgtv'], ['YouTube', 'youtube'], ['Netflix', 'netflix'], // i18n-allow: Application identity aliases.
  ['网易云音乐', '网易云', 'netease', 'neteasecloudmusic', 'cloudmusic'], // i18n-allow: Application identity aliases.
  ['QQ音乐', 'qqmusic'], ['酷狗音乐', '酷狗', 'kugou'], ['Spotify', 'spotify'], ['Apple Music', 'applemusic'], // i18n-allow: Application identity aliases.
] as const;

function primaryText(task: string): string {
  return String(task || '').split(/(?:^|\r?\n)\s*##\s+(?:Current Turn Attachments|Recent action continuation context|Internal client-surface continuation context)\b/i)[0]
    .normalize('NFKC').replace(/\s+/g, ' ').trim().replace(/[。.!！]+$/u, '').trim();
}

function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s《》“”"'.,，。!！?？:：]/gu, '');
}

function playerIdentity(text: string): string {
  const normalized = normalizeText(text.replace(/\.exe$/i, ''));
  const aliases = PLAYERS.find(names => names.some(name => normalizeText(name) === normalized));
  return aliases ? normalizeText(aliases[0]) : normalized;
}

function ordinal(raw: string): string | null {
  const text = raw.normalize('NFKC').trim().toLowerCase();
  if (!text) return '';
  if (/^\d{1,4}$/.test(text)) return String(Number(text));
  const english = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  if (english.includes(text)) return String(english.indexOf(text) + 1);
  const digits = '零一二三四五六七八九'; // i18n-allow: Numeric input normalization.
  const value = text.replace(/〇/g, '零').replace(/两/g, '二'); // i18n-allow: Numeric input normalization.
  if (/^[零一二三四五六七八九]{1,4}$/u.test(value)) return String(Number([...value].map(char => digits.indexOf(char)).join(''))); // i18n-allow: Numeric input normalization.
  if (!/^(?:[一二三四五六七八九]千)?(?:零)?(?:[一二三四五六七八九]百)?(?:零)?(?:[一二三四五六七八九]?十)?[一二三四五六七八九]?$/u.test(value)) return null; // i18n-allow: Numeric input normalization.
  let number = 0; let pending = 0;
  for (const char of value) {
    const unit = char === '千' ? 1000 : char === '百' ? 100 : char === '十' ? 10 : 0; // i18n-allow: Numeric input normalization.
    if (unit) { number += (pending || 1) * unit; pending = 0; }
    else pending = digits.indexOf(char);
  }
  return number + pending > 0 ? String(number + pending) : null;
}

function metadata(text: string, pattern: RegExp): string {
  const match = text.match(pattern);
  if (!match) return '';
  return ordinal(match[1] || match[2]) ?? `unresolved:${match[0]}`;
}

function hasPlaybackVerb(text: string): boolean {
  // i18n-allow: Explicit media command recognition, not authorization of arbitrary actions.
  return !/(?:不要|别|不用|无需|禁止).{0,12}(?:放|播|看)|^(?:解释|介绍|为什么|怎么|如何)|\b(?:do not|don't|explain|why|how)\b/iu.test(text)
    && /(?:播放|放一?首|听一?首|(?:我要|我想|帮我|给我)看|放吧)|\b(?:play|resume|listen\s+to|put\s+on|start\s+playing)\b/iu.test(text);
}

export function parsePlaybackGoal(task: string): PlaybackGoal {
  const text = primaryText(task);
  let player = '';
  const withoutTitle = text.replace(/[《“"]([^》”"\n]+)[》”"]/gu, '');
  // A service name in the requested song title is not the selected player.
  const playerContext = withoutTitle.split(/(?:播放|放一?首|听一?首)|\b(?:play|resume|listen\s+to|put\s+on)\b/iu)[0] // i18n-allow: Command grammar.
    + ' ' + (withoutTitle.match(/(?:\b(?:on|in|using)\s+|[,，]\s*用)([^,，。]+)$/iu)?.[1] || ''); // i18n-allow: Explicit player suffix.
  for (const aliases of PLAYERS) {
    if (aliases.some(alias => /[^\x00-\x7f]/u.test(alias)
      ? normalizeText(playerContext).includes(normalizeText(alias))
      : new RegExp(`\\b${alias.replace(/\s+/g, '\\s*')}\\b`, 'iu').test(playerContext))) { player = aliases[0]; break; }
  }
  const season = metadata(text, SEASON);
  const episode = metadata(text, EPISODE);
  const quoted = text.match(/[《“"]([^》”"\n]{1,160})[》”"]/u)?.[1];
  // i18n-allow: Natural-language media object, independently of season/episode.
  let title = quoted || text.match(/(?:播放|放一?首|听一?首|(?:我要|我想|帮我|给我)看)\s*(?:歌曲|音乐)?\s*([^，。！？!?\n]{1,160})/u)?.[1]
    || text.match(/\b(?:play|listen\s+to|put\s+on)\s+(?:the\s+)?(.{1,160}?)(?:\s+(?:on|in|using)\s+|[.!?]|$)/iu)?.[1] || '';
  // Strip only trailing metadata, so a title containing unrelated numbers survives.
  title = title.replace(/(?:吧|就行|就可以了|这首歌|这首歌曲)$/u, '').trim(); // i18n-allow: Command suffixes.
  for (let i = 0; i < 2; i++) {
    for (const pattern of [EPISODE, SEASON]) {
      const suffix = title.match(pattern);
      if (suffix && title.endsWith(suffix[0])) title = title.slice(0, -suffix[0].length).trim();
    }
  }
  // i18n-allow: Generic/current-media commands do not require a newly named work.
  if (/^(?:(?:当前|现在|这首|这个|这部|一首|一个|一集|随机|随便)(?:的)?)*(?:音乐|歌曲?|视频|电影|电视剧|它|music|songs?|videos?|movies?|current\s+(?:track|song|music|video))?$|^episode\b|^第[\d一二三四五六七八九十百零〇两]+集/iu.test(title)) title = '';
  let artist = '';
  if (PLAYERS.slice(6).some(names => names[0] === player)) {
    const performer = text.match(/(?:播放|放一?首|听一?首)\s*([^的《》\n]{1,40})的(?:《([^》]+)》|([^，。！？!?\n]+))/u); // i18n-allow: Singer/title request grammar.
    if (performer) { artist = performer[1].trim(); title = (performer[2] || performer[3]).replace(/(?:吧|就行|这首歌)$/u, '').trim(); } // i18n-allow: Spoken command suffixes.
  }
  return { player, title, season, episode, ...(artist ? { artist } : {}) };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The model may report visible facts only. No completion/confidence flag is consumed. */
export function parseVisualPlaybackObservation(value: unknown): VisualPlaybackObservation | null {
  const row = object(value);
  if (!row || typeof row.phase !== 'string' || !PHASES.has(row.phase)
    || GOAL_FIELDS.some(field => typeof row[field] !== 'string' || (row[field] as string).length > 160
      || /[\u0000-\u001f\u007f]/u.test(row[field] as string))
    || !(row.positionSeconds === null || (typeof row.positionSeconds === 'number'
      && Number.isFinite(row.positionSeconds) && row.positionSeconds >= 0 && row.positionSeconds <= 86_400))) return null;
  const season = ordinal(row.season as string); const episode = ordinal(row.episode as string);
  if (season === null || episode === null) return null;
  if (row.artist !== undefined && (typeof row.artist !== 'string' || row.artist.length > 160 || /[\u0000-\u001f\u007f]/u.test(row.artist))) return null;
  return { phase: row.phase as VisualPlaybackObservation['phase'], player: (row.player as string).trim(),
    title: (row.title as string).trim(), season, episode, positionSeconds: row.positionSeconds as number | null, ...(row.artist ? { artist: (row.artist as string).trim() } : {}) };
}

function sample(value: unknown): PlaybackSample | null {
  const row = object(value); const observed = parseVisualPlaybackObservation(value);
  if (!row || !observed || !Number.isSafeInteger(row.capturedAt) || Number(row.capturedAt) <= 0
    || typeof row.windowId !== 'string' || !row.windowId.trim() || row.windowId.length > 160
    || /[\u0000-\u001f\u007f]/u.test(row.windowId)
    || !Number.isSafeInteger(row.pid) || Number(row.pid) <= 0
    || typeof row.frameDigest !== 'string' || !/^[a-f\d]{64}$/i.test(row.frameDigest)) return null;
  return { ...observed, capturedAt: row.capturedAt as number, windowId: row.windowId.trim(), pid: row.pid as number,
    frameDigest: row.frameDigest.toLowerCase() };
}

function sameGoal(left: PlaybackGoal, right: PlaybackGoal): boolean {
  return playerIdentity(left.player) === playerIdentity(right.player) && normalizeText(left.title) === normalizeText(right.title)
    && left.season === right.season && left.episode === right.episode && normalizeText(left.artist || '') === normalizeText(right.artist || '');
}

function matchesGoal(observed: PlaybackGoal, goal: PlaybackGoal): boolean {
  return (!goal.player || playerIdentity(observed.player) === playerIdentity(goal.player))
    && (!goal.title || normalizeText(observed.title) === normalizeText(goal.title))
    && (!goal.season || observed.season === goal.season) && (!goal.episode || observed.episode === goal.episode)
    && (!goal.artist || normalizeText(observed.artist || '') === normalizeText(goal.artist));
}

export function buildPlaybackVerification(task: string, samples: PlaybackSample[]): PlaybackVerification | null {
  if (!hasPlaybackVerb(primaryText(task)) || !Array.isArray(samples) || samples.length < 2) return null;
  // Never reach backwards past a new ad, pause, unknown frame or identity change.
  const before = sample(samples.at(-2)); const after = sample(samples.at(-1));
  if (!before || !after || before.phase !== 'content' || after.phase !== 'content'
    || !before.player || !before.title || before.positionSeconds === null || after.positionSeconds === null
    || before.windowId !== after.windowId || before.pid !== after.pid || before.frameDigest === after.frameDigest
    || !sameGoal(before, after)) return null;
  const elapsed = (after.capturedAt - before.capturedAt) / 1000;
  const progress = after.positionSeconds - before.positionSeconds;
  if (elapsed < 1 || elapsed > 60 || progress < 1 || progress > elapsed + 2) return null;
  const target = parsePlaybackGoal(task);
  if (!matchesGoal(before, target) || !matchesGoal(after, target)) return null;
  return { version: 1, source: 'visual_progress', target, samples: [before, after], verified: true };
}

/** Recompute from the two captured facts; the serialized verified flag is not proof. */
export function validatePlaybackVerification(value: unknown, task: string): value is PlaybackVerification {
  const row = object(value); const target = object(row?.target);
  if (!row || row.version !== 1 || row.source !== 'visual_progress' || row.verified !== true || !target
    || GOAL_FIELDS.some(field => typeof target[field] !== 'string')
    || !Array.isArray(row.samples) || row.samples.length !== 2) return false;
  const recomputed = buildPlaybackVerification(task, row.samples as PlaybackSample[]);
  return Boolean(recomputed && GOAL_FIELDS.every(field => target[field] === recomputed.target[field]) && (target.artist || '') === (recomputed.target.artist || ''));
}
