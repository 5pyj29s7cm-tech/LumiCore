import { parsePlaybackGoal, validatePlaybackVerification } from './playback_verification';
import type { ToolExecutionRecord } from '../tools/types';
import type { ActionIntentAnalysis } from './normalized_action_intent';
import { parseRecordJson, terminalPayloadText, compact, expandSuccessfulRecords } from "./action_contract_support";
import { requestedDesktopTargetAliases, normalizeDesktopTarget, matchesRequestedDesktopTarget } from "./desktop_action_target";
import { requestedMediaPlayerTarget, requiresMediaPlaybackAction } from "./action_request";

function playbackEpisode(value: unknown): string {
  const text = String(value ?? '').trim().toLowerCase();
  const raw = text.match(/第\s*([\d一二三四五六七八九十百零〇两]+)\s*集|\bepisode\s+([\d]+|one|two|three|four|five|six|seven|eight|nine|ten)\b/iu)?.slice(1).find(Boolean) || text; // i18n-allow: Episode identity recognition.
  if (/^\d+$/.test(raw)) return String(Number(raw));
  const english = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  if (english.includes(raw)) return String(english.indexOf(raw) + 1);
  const digits = '零一二三四五六七八九'; // i18n-allow: Numeric input normalization.
  const normalized = raw.replace(/〇/g, '零').replace(/两/g, '二'); // i18n-allow: Numeric input normalization.
  if (normalized.length === 1 && digits.includes(normalized)) return String(digits.indexOf(normalized));
  const tens = normalized.match(/^([一二三四五六七八九]?)十([一二三四五六七八九]?)$/u); // i18n-allow: Episode number recognition.
  return tens ? String((tens[1] ? digits.indexOf(tens[1]) : 1) * 10 + (tens[2] ? digits.indexOf(tens[2]) : 0)) : '';
}

interface ObservedPlaybackState { playing: boolean; title: string; season: string; episode: string }

// i18n-allow: Recognize observations of the playing content, never a play button or search result.
const PLAYING_OBSERVATION_RE = /正在播放|播放中|(?:已经|已)开始播放|已打开并开始播放|\b(?:now\s+playing|playback\s+(?:started|is\s+playing))\b/iu;
// i18n-allow: These labels describe candidate results, not the current media.
const PLAYBACK_SEARCH_RE = /搜索|联想|推荐|search|suggestion/iu;

export function playbackObservationText(record: ToolExecutionRecord): string {
  const payload = parseRecordJson(record);
  if (!payload) return terminalPayloadText(record).replace(/[*`]/g, '');
  if (record.name === 'computer_use') {
    return payload.ok === true && payload.status === 'verified'
      && payload.completionVerified === true && payload.observations === 2
      && payload.applicationMatched === true && typeof payload.message === 'string'
      ? payload.message.replace(/[*`]/g, '') : '';
  }
  // OCR can return a JSON-formatted model description. Do not treat a raw
  // screenshot, arbitrary accessibility tree or tool arguments as analysis.
  if (!/^(?:ocr_screen|ocr_region|computer_vision)$/i.test(record.name)
    || payload.format === 'screenshot_base64' || payload.error) return '';
  return [payload.description, payload.text, payload.analysis]
    .find(value => typeof value === 'string')?.replace(/[*`]/g, '') || '';
}

function playbackObservationClauses(record: ToolExecutionRecord): string[] {
  return playbackObservationText(record).split(/[。！？!?\n]/u).map(value => value.trim()).filter(Boolean);
}

function observedPlaybackState(record: ToolExecutionRecord): ObservedPlaybackState | null {
  const payload = parseRecordJson(record);
  if (payload) {
    const state = payload.playback && typeof payload.playback === 'object' ? payload.playback : payload;
    const flags = [state.isPlaying, state.playing, state.playbackStarted];
    const statuses = [state.playbackState, state.playerState, state.state, state.status].map(value => String(value || '').toLowerCase());
    const negative = flags.includes(false) || state.isAd === true || state.isAdvertisement === true
      || /^(?:ad|advertisement|preroll|pre-roll)$/i.test(String(state.phase || state.contentType || ''))
      || statuses.some(value => /^(?:paused|stopped|idle|not_playing|not_started|failed|error|cancelled|blocked)$/.test(value));
    const positive = flags.includes(true) || statuses.some(value => /^(?:playing|started)$/.test(value));
    if (negative || positive) {
      const current = state.currentTrack || state.nowPlaying || state.currentMedia;
      // Only current-media fields paired with a playing state qualify. A
      // searchQuery, result list, arbitrary window tree, or tool args do not.
      const directMediaAction = /(?:^|_)(?:media|music|audio)(?:_|.*_)(?:play|resume|control)(?:_|$)/i.test(record.name);
      const title = compact(typeof current === 'string' ? current : current?.title || current?.name
        || state.currentTitle || state.trackTitle || state.songTitle || (directMediaAction ? state.title : ''));
      return { playing: positive && !negative, title,
        season: playbackEpisode(current?.season ?? state.season ?? state.seasonNumber) || parsePlaybackGoal(title).season,
        episode: playbackEpisode(current?.episode ?? state.episode ?? state.episodeNumber) || playbackEpisode(title) };
    }
  }
  // i18n-allow: A finished advertisement is historical context, not a current ad phase.
  const text = playbackObservationText(record).replace(/(?:片前|贴片)?广告(?:已经|已)(?:结束|播放完毕)/gu, '');
  // i18n-allow: Negative/current playback state, not a play/pause button label.
  const negative = /(?:尚未|并未|没有|还没|未|不是|并非).{0,10}(?:开始|正在|已经)?播放|(?:当前|现在|目前|处于|已经|已).{0,12}(?:暂停|停止播放)|(?:尚未|并未|没有|未).{0,8}切换|\b(?:not\s+(?:yet\s+)?playing|not\s+started|has\s+not\s+(?:started|switched)|is\s+paused|playback\s+(?:paused|stopped))\b/iu.test(text)
    // i18n-allow: An advertisement or a prediction is not observed programme playback.
    || /(?:片前|贴片)广告|(?:当前|现在|正在|仍在).{0,12}广告|广告.{0,12}(?:播放中|剩余|倒计时)|\b(?:pre[- ]?roll|playing\s+(?:an?\s+)?ad(?:vertisement)?|ad\s+break)\b|(?:可能|似乎|应该|即将|将会|等待).{0,8}(?:正在)?播放|\b(?:may|might|will|should)\s+(?:be\s+)?play/iu.test(text);
  // i18n-allow: A playing-state assertion, not a question or a search match.
  const positive = PLAYING_OBSERVATION_RE.test(text);
  if (!negative && !positive) return null;
  // Keep the title bound to the current playback statement. Merely finding
  // the requested title in a search result elsewhere is never enough.
  // i18n-allow: Current-title statement extraction.
  const currentClause = playbackObservationClauses(record).filter(value => PLAYING_OBSERVATION_RE.test(value)).at(-1) || '';
  if (PLAYBACK_SEARCH_RE.test(currentClause)) return negative ? { playing: false, title: '', season: '', episode: '' } : null;
  const currentContent = currentClause.match(/(?:正在播放|播放中|(?:已经|已)开始播放|\bnow\s+playing)[：:是为\s-]*(?:(?:歌曲|曲目|视频|正片)[：:是为\s]*)?(.+)/iu)?.[1] || ''; // i18n-allow: Current-content label recognition.
  const precedingTitle = !currentContent || /^[，,；;（(]/u.test(currentContent)
    ? currentClause.split(PLAYING_OBSERVATION_RE)[0].match(/[《“"]([^》”"\n]+)[》”"]/u)?.[1] || '' : '';
  const title = PLAYBACK_SEARCH_RE.test(currentClause) ? ''
    : precedingTitle || currentContent.match(/^[《“"]([^》”"\n]+)[》”"]/u)?.[1]
      || currentContent.split(/[，,；;（(]/u)[0].trim();
  const episode = currentClause.match(/第\s*[\d一二三四五六七八九十百零〇两]+\s*集|\bepisode\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/iu)?.[0]; // i18n-allow: Episode tied to active playback.
  return { playing: positive && !negative, title, season: parsePlaybackGoal(currentClause).season,
    episode: playbackEpisode(episode) || playbackEpisode(title) };
}

function playbackPlayerMatch(record: ToolExecutionRecord, target: string): boolean | null {
  if (!target) return true;
  const aliases = requestedDesktopTargetAliases(target);
  const matches = (value: unknown) => {
    const normalized = normalizeDesktopTarget(String(value || ''));
    return aliases.some(alias => alias.length >= 2 && (normalized === alias || normalized.includes(alias)));
  };
  const payload = parseRecordJson(record);
  if (payload) {
    const current = payload.actualTarget || payload.observedTarget || payload.postState || payload;
    const sources = [current, current.tree, payload.playback].filter(value => value && typeof value === 'object');
    const names = sources.flatMap(value => [value.player, value.application, value.app, value.appName, value.applicationName]).filter(value => typeof value === 'string' && value.trim());
    const processes = sources.flatMap(value => [value.processName, value.process_name]).filter(value => typeof value === 'string' && value.trim());
    const identities = names.length ? names : processes;
    if (identities.length) return identities.every(matches);
    if (sources.some(value => matches(value.windowTitle || value.title))) return true;
  }
  if (!payload || playbackObservationText(record)) {
    // A textual observation can identify the player in the same current-state
    // sentence. A separate mention of the target app elsewhere cannot do so.
    const clauses = playbackObservationClauses(record);
    let index = clauses.length - 1;
    while (index >= 0 && !PLAYING_OBSERVATION_RE.test(clauses[index])) index--;
    if (index < 0 || PLAYBACK_SEARCH_RE.test(clauses[index])) return null;
    const current = clauses[index];
    // A neighbouring identity statement belongs to the same screenshot, but
    // an explicit different player in the playing statement takes priority.
    // i18n-allow: Known player identity, not arbitrary mentions of a song.
    const namedPlayer = /(?:爱奇艺|优酷|腾讯视频|哔哩哔哩|芒果TV|网易云(?:音乐)?|QQ\s*音乐|酷狗(?:音乐)?)|\b(?:iqiyi|youku|youtube|netflix|bilibili|Spotify|Apple\s+Music|NetEase(?:\s+Cloud\s+Music)?|CloudMusic)\b/giu;
    const currentNames = current.match(namedPlayer) || [];
    if (currentNames.length) return currentNames.every(matches);
    const adjacent = clauses.slice(Math.max(0, index - 1), index + 2).filter(value => !PLAYBACK_SEARCH_RE.test(value));
    const names = adjacent.flatMap(value => value.match(namedPlayer) || []);
    if (names.length) return names.every(matches);
    if (matches(current)) return true;
  }
  return null;
}

function playbackTitleMatches(observed: string, requested: string): boolean {
  if (!requested) return true;
  // Permit a separately delimited artist/episode suffix, never another title
  // containing the requested string (for example the DJ remix/search result).
  const title = observed.split(/\s+[-–—|]\s+|\s*第\s*[\d一二三四五六七八九十百]+\s*[季集]|\s+(?:season|episode)\s+/iu)[0]; // i18n-allow: Artist/episode metadata delimiter.
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[\s《》“”"'.,，。!！?？:：]/gu, '');
  return Boolean(title) && normalize(title) === normalize(requested);
}

function isPlaybackActuation(record: ToolExecutionRecord): boolean {
  const name = String(record.name || '');
  if (/^(?:desktop_keyboard_press|keyboard_press)$/i.test(name)) {
    return /^(?:space|media_?play_?pause|mediaplaypause|play)$/i.test(compact(record.arguments?.key));
  }
  if (/^(?:desktop_ui_invoke|desktop_ui_click|computer_use)$/i.test(name)) {
    return /(?:\u64ad\u653e|\u7ee7\u7eed|\bplay\b|\bresume\b)/iu.test(JSON.stringify(record.arguments || {}));
  }
  return /(?:^|_)(?:media|music|audio)(?:_|.*_)(?:play|resume|control)(?:_|$)/i.test(name);
}

function scopedMediaEvidence(
  records: ToolExecutionRecord[] = [],
  currentTurn?: { requestId?: string; taskId?: string },
): ToolExecutionRecord[] {
  const scoped = Boolean(currentTurn?.requestId || currentTurn?.taskId);
  return records.filter(record => {
    if (scoped) {
      if ((record as ToolExecutionRecord & { receiptScopeConflict?: boolean }).receiptScopeConflict === true) return false;
      const requestIds = [record.requestId, record.envelope?.requestId].filter(Boolean);
      const turnIds = [record.turnId, record.envelope?.turnId].filter(Boolean);
      const taskIds = [record.taskId, record.envelope?.taskId].filter(Boolean);
      // Scope the entire state machine, including its legacy actuation path.
      // A previous request's playing state cannot settle this request's
      // uncertain completion candidate or supply its player/input evidence.
      if (currentTurn?.requestId && (requestIds.length === 0
        || [...requestIds, ...turnIds].some(value => value !== currentTurn.requestId))) return false;
      if (currentTurn?.taskId && (taskIds.length === 0
        || taskIds.some(value => value !== currentTurn.taskId))) return false;
    }
    const payload = record.name === 'computer_use' ? parseRecordJson(record) : null;
    return expandSuccessfulRecords([record]).length > 0
      || Boolean(payload && Object.prototype.hasOwnProperty.call(payload, 'playbackVerification'));
  });
}

export function hasMediaPauseEvidence(records: ToolExecutionRecord[], taskText: string, currentTurn?: { requestId?: string; taskId?: string }, analysis?: ActionIntentAnalysis): boolean {
  const target = requestedMediaPlayerTarget(taskText, analysis);
  let paused = false;
  for (const record of scopedMediaEvidence(records, currentTurn)) {
    if (!/^(?:desktop_ui_snapshot|ocr_screen|ocr_region|computer_vision|computer_use)$/i.test(record.name) || record.error) continue;
    if (target && playbackPlayerMatch(record, target) !== true) continue;
    const payload = parseRecordJson(record);
    if (payload?.ok === false) continue;
    const state = payload?.playback || payload;
    const status = String(state?.playbackState || state?.playerState || '').toLowerCase();
    if (status) { paused = status === 'paused' && state?.isPlaying !== true && state?.playing !== true; continue; }
    const observed = playbackObservationText(record);
    // i18n-allow: Observe an actual paused state, not a button label, plan, or negated state.
    if (/(?:没有|尚未|还没|未能).{0,12}暂停|正在播放|播放中|\b(?:is playing|not paused)\b/iu.test(observed)) { paused = false; continue; }
    if (/(?:当前|现在|已经|已).{0,12}(?:暂停|停止播放)|\b(?:is paused|playback (?:is )?paused)\b/iu.test(observed)) paused = true;
  }
  return paused;
}

export function hasMediaPlaybackEvidence(records: ToolExecutionRecord[] = [], taskText = '', currentTurn?: { requestId?: string; taskId?: string }, analysis?: ActionIntentAnalysis): boolean {
  const successful = scopedMediaEvidence(records, currentTurn);
  const requested = parsePlaybackGoal(taskText);
  let target = requestedMediaPlayerTarget(taskText, analysis);
  if (/^(?:音乐|歌曲?|播放器|视频|music|song|player|video)$/iu.test(target)) target = ''; // i18n-allow: Generic player labels.
  let playerMatched = !target;
  let actuated = false;
  let verified = false;
  for (const record of successful) {
    const payload = parseRecordJson(record);
    if (record.name === 'computer_use' && payload && Object.prototype.hasOwnProperty.call(payload, 'playbackVerification')) {
      // A structured attempt owns its outcome. Invalid evidence cannot fall
      // back to a model's free-text "done" claim or a previous success.
      const executedTask = String(record.arguments?.task || record.arguments?.prompt || '');
      verified = Boolean(expandSuccessfulRecords([record]).length > 0
        && currentTurn?.requestId && currentTurn?.taskId && requiresMediaPlaybackAction(executedTask)
        && payload.ok === true && payload.status === 'verified' && payload.completionVerified === true
        && payload.observations === 2 && payload.applicationMatched === true
        && validatePlaybackVerification(payload.playbackVerification, taskText)
        && validatePlaybackVerification(payload.playbackVerification, executedTask));
      if (!verified) { playerMatched = false; actuated = false; }
      continue;
    }
    const observation = /^(?:desktop_open|browser_open_task|desktop_ui_snapshot|ocr_screen|ocr_region|desktop_capture_screen|computer_vision|desktop_active_window|get_active_window_info|computer_use)$/i.test(record.name);
    const action = isPlaybackActuation(record);
    if (!observation && !action) continue;
    const currentObservation = observation && Boolean(currentTurn?.requestId);
    if (record.name === 'computer_use') {
      const executedTask = String(record.arguments?.task || record.arguments?.prompt || '');
      const executedContent = parsePlaybackGoal(executedTask);
      const executedPlayer = requestedMediaPlayerTarget(executedTask, analysis);
      const applicationIdentity = String(parseRecordJson(record)?.applicationIdentity || '').trim();
      const matchesTarget = (value: string) => matchesRequestedDesktopTarget(value, requestedDesktopTargetAliases(target));
      if (!currentObservation || !playbackObservationText(record) || !requiresMediaPlaybackAction(executedTask)
        || !playbackTitleMatches(executedContent.title, requested.title)
        || (requested.season && requested.season !== executedContent.season)
        || (requested.episode && requested.episode !== executedContent.episode)
        || (target && executedPlayer && !matchesTarget(executedPlayer))
        || (target && applicationIdentity && !/^(?:chrome-browser|edge-browser|firefox-browser|desktop-browser)$/.test(applicationIdentity)
          && !matchesTarget(applicationIdentity))) continue;
    }
    const match = playbackPlayerMatch(record, target);
    // Looking at another window cannot disprove playback in the verified
    // player. Only a later observation of that player can supersede it.
    if (match === false) continue;
    if (match !== null) {
      playerMatched = match;
    }
    if (action && playerMatched) { actuated = true; verified = false; }
    const state = observedPlaybackState(record);
    if (!state) continue;
    // A failed later observation does not erase a verified action; a successful
    // later observation explicitly showing another title/paused state does.
    if (!state.playing) { verified = false; continue; }
    verified = false;
    // Current, target-bound observation may confirm autoplay/Enter/coordinate
    // selection. Requiring another play/pause action could stop valid playback.
    if ((!actuated && !currentObservation) || !playerMatched) continue;
    if (!actuated && match !== true) continue;
    // A bare root=active state may inherit the immediately established player
    // identity for generic playback, but a named song/episode needs a current
    // player identity in the same receipt, not an old open result.
    if ((requested.title || requested.episode) && match !== true) continue;
    verified = playbackTitleMatches(state.title, requested.title)
      && (!requested.season || state.season === requested.season)
      && (!requested.episode || state.episode === requested.episode);
  }
  return verified;
}
