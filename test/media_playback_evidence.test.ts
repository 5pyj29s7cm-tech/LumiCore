import { describe, expect, it } from 'vitest';
import { buildActionEvidenceContract, hasCoreActionEvidence, hasMediaPlaybackEvidence } from '../server/cognition/action_contract';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import type { ToolExecutionRecord } from '../server/tools/types';
import { mergeTaskReceipts, normalizeConversationTaskReceipt, recordsToTaskReceipts, taskCompletionFromReceipts, taskReceiptsToRecords } from '../server/cognition/task_execution_ledger';
import { DESKTOP_COMPLETION_REVIEW_REASON } from '../server/cognition/desktop_completion_review';
import { buildPlaybackVerification, type PlaybackSample } from '../server/cognition/playback_verification';

function record(name: string, result: unknown, args: Record<string, unknown> = {}): ToolExecutionRecord {
  return { name, arguments: args, result: typeof result === 'string' ? result : JSON.stringify(result), terminalVerification: { status: 'verified', strategy: 'state_diff', reason: 'Synthetic observed playback state.' } };
}
const songTask = '用网易云放一首秋天不回来';
const prepare = () => [
  record('desktop_active_window', { process_name: 'cloudmusic.exe', title: '网易云音乐' }),
  record('keyboard_press', { ok: true, targetMatched: true }, { key: 'space' }),
];
const playing = (patch = {}) => record('desktop_ui_snapshot', { player: '网易云音乐', playerState: 'playing', currentTrack: { title: '秋天不回来' }, ...patch });

describe('captured progress reaches media finalization and the durable task ledger', () => {
  const task = '用爱奇艺播放《蜡笔小新》第八季第一集';
  const scope = { requestId: 'verified-progress-request', taskId: 'verified-progress-task' };
  const samples = (): [PlaybackSample, PlaybackSample] => [
    { phase: 'content', player: '爱奇艺', title: '蜡笔小新', season: '8', episode: '1', positionSeconds: 31,
      capturedAt: 1_800_000_000_000, windowId: '100', pid: 100, frameDigest: 'a'.repeat(64) },
    { phase: 'content', player: '爱奇艺', title: '蜡笔小新', season: '8', episode: '1', positionSeconds: 34,
      capturedAt: 1_800_000_003_000, windowId: '100', pid: 100, frameDigest: 'b'.repeat(64) },
  ];
  const receipt = (requestedTask = task, patch = {}): ToolExecutionRecord => ({
    ...record('computer_use', { ok: true, status: 'verified', completionVerified: true, observations: 2, observationAttempts: 6,
      applicationMatched: true, applicationIdentity: 'desktop-browser', message: 'Captured two progressing content samples.',
      playbackVerification: buildPlaybackVerification(requestedTask, samples()), ...patch }, { task: requestedTask }), ...scope,
  });

  it('accepts current runtime-verified progress without needing a model done message or another control input', () => {
    const actual = receipt();
    expect(hasMediaPlaybackEvidence([actual], task, scope)).toBe(true);
    const final = finalizeLumiResponse({ taskText: task, responseText: '', source: 'chat', toolRecords: [actual], ...scope });
    expect(final).toMatchObject({ blocked: false, reason: 'verified_playback_progress' });
    expect(final.text).toContain('已确认爱奇艺正在播放《蜡笔小新》第8季第1集');
    expect(taskCompletionFromReceipts(task, JSON.parse(JSON.stringify(recordsToTaskReceipts([actual]))), undefined, scope).complete).toBe(true);
    const normalized = JSON.parse(JSON.stringify(recordsToTaskReceipts([actual]))).map(normalizeConversationTaskReceipt);
    expect(JSON.parse(taskReceiptsToRecords(normalized)[0].result).playbackVerification).toEqual(buildPlaybackVerification(task, samples()));
    expect(taskCompletionFromReceipts(task, normalized, undefined, scope).complete).toBe(true);
  });
  it.each(['chat', 'voice'])('does not preserve invented model season/episode or a denial in %s', source => {
    for (const responseText of ['已开始播放第一季第9集。', '刚才没能完成播放。']) {
      const final = finalizeLumiResponse({ taskText: task, responseText, source, toolRecords: [receipt()], ...scope });
      expect(final.blocked).toBe(false);
      expect(final.text).toContain('第8季第1集');
      expect(final.text).not.toContain('第9集');
      expect(final.text).not.toContain('没能');
    }
  });
  it('does not insert observed but unrequested season/episode into the proactive confirmation', () => {
    const generic = '用爱奇艺播放蜡笔小新';
    const final = finalizeLumiResponse({ taskText: generic, responseText: '蜡笔小新第8季第1集正在播放。', source: 'chat', toolRecords: [receipt(generic)], ...scope });
    expect(final.blocked).toBe(false);
    expect(final.text).toContain('《蜡笔小新》');
    expect(final.text).not.toMatch(/第\d+[季集]/u);
  });
  it('refuses invalid structured progress despite an otherwise convincing legacy done message', () => {
    const good = buildPlaybackVerification(task, samples())!;
    const invalid = JSON.parse(JSON.stringify(good)); invalid.samples[1].positionSeconds = 31;
    const bad = receipt(task, { playbackVerification: invalid, message: '爱奇艺正在播放《蜡笔小新》第8季第1集，正片已开始。' });
    expect(hasMediaPlaybackEvidence([bad], task, scope)).toBe(false);
    expect(hasMediaPlaybackEvidence([receipt(), bad], task, scope)).toBe(false);
    expect(finalizeLumiResponse({ taskText: task, responseText: '播放成功。', source: 'chat', toolRecords: [bad], ...scope }).blocked).toBe(true);
    expect(hasMediaPlaybackEvidence([receipt(task, { playbackVerification: null, message: '爱奇艺正在播放《蜡笔小新》第8季第1集。' })], task, scope)).toBe(false);
  });
  it('retains a new unverified observation instead of an earlier successful sample pair', () => {
    const pending = { ...receipt(task, { ok: false, status: 'unverified', completionVerified: false,
      playbackVerification: { version: 1, source: 'visual_progress', verified: false }, resumeStrategy: 'observe_only', completionCandidate: 'The requested player has opened.' }),
      terminalVerification: { status: 'failed' as const, strategy: 'visual' as const, reason: 'No progressing samples.' } };
    expect(hasMediaPlaybackEvidence([receipt(), pending], task, scope)).toBe(false);
    expect(finalizeLumiResponse({ taskText: task, responseText: '', source: 'chat', toolRecords: [receipt(), pending], ...scope }).reason)
      .toBe(DESKTOP_COMPLETION_REVIEW_REASON);
    const persisted = JSON.parse(JSON.stringify(recordsToTaskReceipts([receipt(), pending]))).map(normalizeConversationTaskReceipt);
    expect(persisted).toHaveLength(2);
    expect(taskCompletionFromReceipts(task, persisted, undefined, scope).complete).toBe(false);
    const oldFailure = { ...pending, requestId: 'previous-request' };
    expect(finalizeLumiResponse({ taskText: task, responseText: '', source: 'chat', toolRecords: [receipt(), oldFailure], ...scope }).blocked).toBe(false);
    expect(taskCompletionFromReceipts(task, recordsToTaskReceipts([receipt(), oldFailure]), undefined, scope).complete).toBe(true);
  });
  it('merges actual task receipts without losing a later observation, and deduplicates re-delivery of that call', () => {
    const original = { ...receipt(), id: 'original-observation' };
    const pending = { ...receipt(task, { ok: false, status: 'unverified', completionVerified: false,
      playbackVerification: { version: 1, source: 'visual_progress', verified: false } }), id: 'later-observation',
      terminalVerification: { status: 'unverified' as const, strategy: 'visual' as const, reason: 'No readable progress.' } };
    const previous = recordsToTaskReceipts([original]);
    const merged = mergeTaskReceipts(previous, [pending]);
    expect(merged).toHaveLength(2);
    const recovered = JSON.parse(JSON.stringify(merged)).map(normalizeConversationTaskReceipt);
    expect(taskCompletionFromReceipts(task, recovered, undefined, scope).complete).toBe(false);
    expect(mergeTaskReceipts(recovered, [pending])).toHaveLength(2);
    const nextScope = { requestId: 'next-request', taskId: scope.taskId };
    const next = { ...receipt(), id: 'later-observation', ...nextScope };
    const nextMerged = mergeTaskReceipts(recovered, [next]);
    expect(nextMerged).toHaveLength(3);
    expect(taskCompletionFromReceipts(task, nextMerged, undefined, nextScope).complete).toBe(true);
    expect(taskCompletionFromReceipts(task, nextMerged, undefined, scope).complete).toBe(false);
  });
  it.each([
    { requestId: 'old-request' }, { taskId: 'old-task' }, { taskId: undefined }, { turnId: 'conflicting-turn' },
    { envelope: { requestId: 'conflicting-envelope' } as any },
  ])('keeps the complete request/task fence for structured progress: %j', patch => {
    expect(hasMediaPlaybackEvidence([{ ...receipt(), ...patch }], task, scope)).toBe(false);
  });
  it('rejects wrong original computer_use task and false application or capability verification', () => {
    expect(hasMediaPlaybackEvidence([{ ...receipt(), arguments: { task: '用爱奇艺播放《蜡笔小新》第1季第1集' } }], task, scope)).toBe(false);
    expect(hasMediaPlaybackEvidence([receipt(task, { applicationMatched: false })], task, scope)).toBe(false);
    expect(hasMediaPlaybackEvidence([{ ...receipt(), terminalVerification: { status: 'failed', strategy: 'visual', reason: 'No terminal receipt' } }], task, scope)).toBe(false);
    expect(hasMediaPlaybackEvidence([receipt()], task)).toBe(false);
  });
  it('enforces requested seasons in the compatible legacy observations too', () => {
    const frame = (season?: number) => ({ ...record('desktop_ui_snapshot', { player: '爱奇艺', isPlaying: true,
      currentMedia: { title: '蜡笔小新', season, episode: 1 } }), ...scope });
    expect(hasMediaPlaybackEvidence([frame(8)], task, scope)).toBe(true);
    expect(hasMediaPlaybackEvidence([frame(1)], task, scope)).toBe(false);
    expect(hasMediaPlaybackEvidence([frame()], task, scope)).toBe(false);
  });
});

describe('playback evidence binds the current player and requested content', () => {
  it('accepts the requested track in the correct playing player and preserves generic playback', () => {
    expect(hasMediaPlaybackEvidence([...prepare(), playing()], songTask)).toBe(true);
    expect(hasMediaPlaybackEvidence([...prepare(), record('desktop_ui_snapshot', { playerState: 'playing' })], '打开网易云并播放音乐')).toBe(true);
    expect(hasMediaPlaybackEvidence([...prepare(), playing({ currentTrack: { title: '秋天不回来 - 王强' } })], songTask)).toBe(true);
  });
  it.each([
    { currentTrack: { title: '旧歌曲' }, searchQuery: '秋天不回来' },
    { currentTrack: { title: '秋天不回来 DJ版' } },
    { currentTrack: undefined, searchQuery: '秋天不回来', searchResults: [{ title: '秋天不回来' }] },
    { currentTrack: undefined, title: '秋天不回来', searchQuery: '秋天不回来' },
    { playerState: 'paused' },
    { isPlaying: false },
    { player: 'Spotify' },
    { player: undefined, process_name: 'spotify.exe' },
    { player: '云' },
  ])('rejects another track/search-only/paused/conflicting/wrong-player state: %j', patch => {
    const records = [...prepare(), playing(patch)];
    expect(hasMediaPlaybackEvidence(records, songTask)).toBe(false);
    expect(finalizeLumiResponse({ taskText: songTask, responseText: '音乐已经开始播放。', toolRecords: records, source: 'chat' }).blocked).toBe(true);
  });
  it.each([
    '网易云当前正在播放《旧歌曲》，尚未切换到《秋天不回来》。',
    '网易云没有正在播放《秋天不回来》。',
    '网易云当前正在播放《旧歌曲》。搜索结果里有《秋天不回来》。',
    '网易云搜索框显示正在播放《秋天不回来》。',
    'NetEase playback is not playing. Search result: 秋天不回来.',
  ])('does not convert negative or search-result OCR into requested playback: %s', text => {
    expect(hasMediaPlaybackEvidence([...prepare(), record('ocr_screen', text)], songTask)).toBe(false);
  });
  it('accepts a positive current-track OCR statement and rejects an unfenced player', () => {
    expect(hasMediaPlaybackEvidence([...prepare(), record('ocr_screen', '网易云当前正在播放《秋天不回来》。')], songTask)).toBe(true);
    expect(hasMediaPlaybackEvidence([...prepare(), record('ocr_screen', '当前正在播放《秋天不回来》。')], songTask)).toBe(false);
  });
  it('checks direct playback tools against the current player instead of trusting their name', () => {
    expect(hasMediaPlaybackEvidence([record('music_play', { player: 'Spotify', playing: true, currentTrack: { title: '秋天不回来' } })], songTask)).toBe(false);
    expect(hasMediaPlaybackEvidence([record('music_play', { player: '网易云音乐', playing: true, currentTrack: { title: '秋天不回来' } })], songTask)).toBe(true);
  });
  it('uses the later confirmed state rather than retaining an earlier playing state after pause', () => {
    expect(hasMediaPlaybackEvidence([...prepare(), playing(), playing({ playerState: 'paused' })], songTask)).toBe(false);
    expect(hasMediaPlaybackEvidence([...prepare(), playing(), { ...record('ocr_screen', ''), error: 'Synthetic unavailable observer' }], songTask)).toBe(true);
  });
  it('matches a requested episode and series, never an episode in a search result', () => {
    const prefix = [record('desktop_active_window', { appName: '爱奇艺' }), record('keyboard_press', { ok: true }, { key: 'space' })];
    const frame = (episode: number) => record('desktop_ui_snapshot', { player: '爱奇艺', isPlaying: true, currentMedia: { title: '庆余年', episode } });
    expect(hasMediaPlaybackEvidence([...prefix, frame(1)], '帮我用爱奇艺播放《庆余年》第1集')).toBe(true);
    expect(hasMediaPlaybackEvidence([...prefix, frame(2)], '帮我用爱奇艺播放《庆余年》第一集')).toBe(false);
    expect(hasMediaPlaybackEvidence([...prefix, record('desktop_ui_snapshot', { player: '爱奇艺', isPlaying: true, currentMedia: { title: '庆余年' }, searchQuery: '第一集' })], '帮我用爱奇艺放吧，我要看第1集')).toBe(false);
  });
  it('keeps generic English playback while enforcing a named English track', () => {
    const actual = record('music_play', { player: 'Spotify', playing: true, currentTrack: { title: 'Bohemian Rhapsody' } });
    expect(hasMediaPlaybackEvidence([actual], 'Play music on Spotify')).toBe(true);
    expect(hasMediaPlaybackEvidence([actual], 'Play Bohemian Rhapsody on Spotify')).toBe(true);
    expect(hasMediaPlaybackEvidence([actual], 'Play Another Song on Spotify')).toBe(false);
  });
  it.each([
    ['用爱奇艺播放蜡笔小新第一集', '爱奇艺', '蜡笔小新'],
    ['用爱奇艺播放蜡笔小新 第一集', '爱奇艺', '蜡笔小新'],
    ['用爱奇艺播放蜡笔小新 第 1 集吧', '爱奇艺', '蜡笔小新'],
    ['Play Shin Chan episode one on YouTube', 'YouTube', 'Shin Chan'],
    ['Play Shin Chan episode 1 on YouTube', 'YouTube', 'Shin Chan'],
  ])('separates an unquoted programme name from the requested episode: %s', (task, player, title) => {
    const records = (name: string, episode: number) => [
      record('desktop_active_window', { appName: player }),
      record('keyboard_press', { ok: true }, { key: 'space' }),
      record('desktop_ui_snapshot', { player, isPlaying: true, currentMedia: { title: name, episode } }),
    ];
    expect(hasMediaPlaybackEvidence(records(title, 1), task)).toBe(true);
    expect(hasMediaPlaybackEvidence(records(title, 2), task)).toBe(false);
    expect(hasMediaPlaybackEvidence(records('Another Programme', 1), task)).toBe(false);
  });
});

describe('production playback observations confirm the goal without toggling playback again', () => {
  const task = '用爱奇艺播放蜡笔小新第一集';
  const scope = { requestId: 'playback-current-request', taskId: 'playback-current-task' };
  const fresh = (name: string, result: unknown, args: Record<string, unknown> = {}): ToolExecutionRecord => ({
    ...record(name, result, args), ...scope,
  });
  const goodText = '当前窗口是爱奇艺播放器。正在播放蜡笔小新第一集，正片进度 00:37 / 23:58。';

  it.each([
    goodText,
    '爱奇艺正在播放《蜡笔小新》第一集，正片进度 00:37 / 23:58。',
    '爱奇艺。当前正在播放蜡笔小新第1集（正片），画面为小新家中。',
    '当前正在播放《蜡笔小新》第1集。播放器是爱奇艺。',
    '爱奇艺中《蜡笔小新》第一集正在播放，正片进度 00:37。',
    '爱奇艺中《蜡笔小新》第一集，视频页面已打开并开始播放。',
    '爱奇艺正在播放蜡笔小新第一集，片前广告已结束，正片进度00:37。',
  ])('accepts normal fresh OCR description with quoted/unquoted title and neighbouring player: %s', text => {
    const records = [fresh('ocr_screen', text)];
    expect(hasMediaPlaybackEvidence(records, task, scope)).toBe(true);
    expect(hasCoreActionEvidence(buildActionEvidenceContract(task), records, task, undefined, scope)).toBe(true);
    expect(finalizeLumiResponse({ taskText: task, responseText: '正在播放蜡笔小新第一集。', toolRecords: records, source: 'chat', ...scope }).blocked).toBe(false);
  });

  it.each([
    ['keyboard_press', { key: 'enter' }],
    ['desktop_mouse_click', { x: 640, y: 420, expectedProcessId: 1234 }],
    ['desktop_ui_click', { name: '第1集', processId: 1234 }],
  ])('accepts observed playback after %s, without requiring a play/pause shortcut', (name, args) => {
    expect(hasMediaPlaybackEvidence([fresh(name, { ok: true }, args), fresh('ocr_screen', goodText)], task, scope)).toBe(true);
  });

  it('accepts a JSON-formatted OCR description while refusing screenshot bytes and a normal UIA tree', () => {
    expect(hasMediaPlaybackEvidence([fresh('ocr_screen', { description: goodText })], task, scope)).toBe(true);
    const uiTree = { status: 'ok', platform: 'win32', root: 'active', count: 3, truncated: false,
      tree: { name: '爱奇艺', processId: 1234, controlType: 'Window', children: [
        { name: '蜡笔小新 第1集', controlType: 'Text' }, { name: '暂停', controlType: 'Button' },
      ] } };
    expect(hasMediaPlaybackEvidence([fresh('desktop_ui_snapshot', uiTree)], task, scope)).toBe(false);
    expect(hasMediaPlaybackEvidence([fresh('desktop_capture_screen', { image_base64: 'synthetic-image', text: goodText })], task, scope)).toBe(false);
    expect(hasMediaPlaybackEvidence([fresh('ocr_screen', { format: 'screenshot_base64', data: 'synthetic-image', note: goodText })], task, scope)).toBe(false);
  });

  it.each([
    '当前窗口是爱奇艺。正在播放《旧节目》第一集。搜索结果有《蜡笔小新》第一集。',
    '爱奇艺搜索结果显示正在播放《蜡笔小新》第一集。',
    '当前窗口是爱奇艺。正在播放蜡笔小新第二集。',
    '爱奇艺正在播放蜡笔小新第一集，当前片前广告，剩余30秒。',
    '爱奇艺正在播放蜡笔小新第一集，当前播放的是广告。',
    '爱奇艺正在播放蜡笔小新第一集，但当前已经暂停。',
    '爱奇艺尚未开始播放蜡笔小新第一集。',
    '爱奇艺可能正在播放蜡笔小新第一集。',
    '爱奇艺搜索页已打开。优酷正在播放蜡笔小新第一集。',
    '正在播放蜡笔小新第一集。',
  ])('does not promote candidate/ad/paused/other-player/other-episode observations: %s', text => {
    expect(hasMediaPlaybackEvidence([fresh('ocr_screen', text)], task, scope)).toBe(false);
  });

  it('requires current request identity, rejects conflicting envelope scope, and preserves the no-ID legacy boundary', () => {
    const current = fresh('ocr_screen', goodText);
    expect(hasMediaPlaybackEvidence([{ ...current, requestId: 'old-request' }], task, scope)).toBe(false);
    expect(hasMediaPlaybackEvidence([{ ...current, taskId: 'other-task' }], task, scope)).toBe(false);
    expect(hasMediaPlaybackEvidence([{ ...current, taskId: undefined }], task, scope)).toBe(false);
    expect(hasMediaPlaybackEvidence([{ ...current, envelope: { requestId: 'old-request', taskId: scope.taskId } as any }], task, scope)).toBe(false);
    expect(hasMediaPlaybackEvidence([record('ocr_screen', goodText)], task, scope)).toBe(false);
    expect(hasMediaPlaybackEvidence([current], task)).toBe(false);
    expect(hasCoreActionEvidence(buildActionEvidenceContract(task), [current], task)).toBe(false);
  });

  it('uses a later paused observation and does not erase success on a later unavailable OCR request', () => {
    const current = fresh('ocr_screen', goodText);
    expect(hasMediaPlaybackEvidence([current, fresh('ocr_screen', '爱奇艺当前已经暂停播放蜡笔小新第一集。')], task, scope)).toBe(false);
    expect(hasMediaPlaybackEvidence([current, { ...fresh('ocr_screen', ''), error: 'Synthetic OCR unavailable' }], task, scope)).toBe(true);
  });

  const legacyPlayback = () => [
    record('desktop_active_window', { appName: '爱奇艺' }),
    record('keyboard_press', { ok: true }, { key: 'space' }),
    record('desktop_ui_snapshot', { player: '爱奇艺', isPlaying: true, currentMedia: { title: '蜡笔小新', episode: 1 } }),
  ];
  it('does not let old legacy playback hide the current production observe-only completion candidate in finalizer', () => {
    const old = legacyPlayback().map(record => ({ ...record, requestId: 'previous-request', taskId: scope.taskId }));
    const candidate = { ...fresh('computer_use', {
      ok: false, status: 'unverified', completionVerified: false, observations: 1,
      resumeStrategy: 'observe_only', completionCandidate: 'The current programme page has opened.',
      message: 'A fresh observation is still required.',
    }, { task }), terminalVerification: { status: 'failed' as const, strategy: 'visual' as const, reason: 'Unverified completion' } };
    expect(hasMediaPlaybackEvidence(old, task)).toBe(true);
    expect(hasMediaPlaybackEvidence(old, task, scope)).toBe(false);
    const final = finalizeLumiResponse({ taskText: task, responseText: '已经播放成功。', source: 'chat',
      toolRecords: [...old, candidate], ...scope });
    expect(final.blocked).toBe(true);
    expect(final.reason).toBe(DESKTOP_COMPLETION_REVIEW_REASON);
    expect(final.text).toContain('已保留当前进度');
  });

  it.each([
    { requestId: undefined },
    { taskId: undefined },
    { requestId: 'previous-request' },
    { taskId: 'another-task' },
    { turnId: 'previous-request' },
    { envelope: { requestId: 'previous-request', taskId: scope.taskId } },
    { envelope: { requestId: scope.requestId, turnId: 'previous-request', taskId: scope.taskId } },
    { envelope: { requestId: scope.requestId, taskId: 'another-task' } },
  ])('rejects missing/conflicting scope throughout the legacy observation and actuation path: %j', patch => {
    const records = legacyPlayback().map(record => ({ ...record, ...scope, ...patch } as ToolExecutionRecord));
    expect(hasMediaPlaybackEvidence(records, task, scope)).toBe(false);
  });

  it('retains current scoped legacy evidence and the explicit no-scope compatibility path', () => {
    expect(hasMediaPlaybackEvidence(legacyPlayback(), task)).toBe(true);
    expect(hasMediaPlaybackEvidence(legacyPlayback(), task, scope)).toBe(false);
    expect(hasMediaPlaybackEvidence(legacyPlayback().map(record => ({ ...record, ...scope, turnId: scope.requestId })), task, scope)).toBe(true);
  });

  it('preserves original request identity across persisted task receipts without laundering a conflicting envelope', () => {
    const current = fresh('ocr_screen', goodText);
    const roundTrip = (records: ToolExecutionRecord[]) => JSON.parse(JSON.stringify(recordsToTaskReceipts(records)));
    const receipts = roundTrip([current]);
    expect(taskReceiptsToRecords(receipts)[0]).toMatchObject(scope);
    expect(taskCompletionFromReceipts(task, receipts, undefined, scope).complete).toBe(true);
    expect(taskCompletionFromReceipts(task, receipts, undefined, { ...scope, requestId: 'another-request' }).complete).toBe(false);
    expect(taskCompletionFromReceipts(task, receipts).complete).toBe(false);
    const conflict = roundTrip([{ ...current, envelope: { requestId: 'other-request', taskId: scope.taskId } as any }]);
    expect(conflict[0].scopeConflict).toBe(true);
    expect(taskCompletionFromReceipts(task, conflict, undefined, scope).complete).toBe(false);
    const legacy = roundTrip([record('ocr_screen', goodText)]);
    expect(taskReceiptsToRecords(legacy)[0].requestId).toBeUndefined();
    expect(taskCompletionFromReceipts(task, legacy, undefined, scope).complete).toBe(false);
  });

  const computerReceipt = (patch = {}) => ({ ok: true, status: 'verified', completionVerified: true,
    observations: 2, applicationIdentity: '', applicationMatched: true, message: goodText, ...patch });
  it('accepts the production computer_use two-observation receipt only for this playback task', () => {
    const current = fresh('computer_use', computerReceipt(), { task });
    expect(hasMediaPlaybackEvidence([current], task, scope)).toBe(true);
    expect(finalizeLumiResponse({ taskText: task, responseText: '已播放。', toolRecords: [current], source: 'chat', ...scope }).blocked).toBe(false);
    expect(hasMediaPlaybackEvidence([fresh('computer_use', computerReceipt(), { task: '打开爱奇艺' })], task, scope)).toBe(false);
    expect(hasMediaPlaybackEvidence([fresh('computer_use', computerReceipt(), { task: '用爱奇艺播放其他节目第一集' })], task, scope)).toBe(false);
    expect(hasMediaPlaybackEvidence([fresh('computer_use', computerReceipt(), { task: '用优酷播放蜡笔小新第一集' })], task, scope)).toBe(false);
    expect(hasMediaPlaybackEvidence([{ ...current, requestId: 'old-request' }], task, scope)).toBe(false);
  });
  it.each([
    { ok: false, status: 'unverified', completionVerified: false, observations: 1 },
    { observations: 1 },
    { applicationMatched: false },
    { applicationIdentity: 'netease-cloud-music' },
    { message: '爱奇艺正在播放蜡笔小新第一集，当前片前广告。' },
    { message: '已完成打开页面。' },
    { message: '爱奇艺正在播放蜡笔小新第二集。' },
  ])('refuses an incomplete, mismatched or non-programme computer_use receipt: %j', patch => {
    expect(hasMediaPlaybackEvidence([fresh('computer_use', computerReceipt(patch), { task })], task, scope)).toBe(false);
  });
});
