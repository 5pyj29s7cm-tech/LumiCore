import { describe, expect, it } from 'vitest';
import { buildPlaybackVerification, parsePlaybackGoal, parseVisualPlaybackObservation, validatePlaybackVerification,
  type PlaybackSample } from '../server/cognition/playback_verification';

const task = '用爱奇艺播放《蜡笔小新》第八季第一集';
const sample = (patch: Partial<PlaybackSample> = {}): PlaybackSample => ({
  phase: 'content', player: '爱奇艺', title: '蜡笔小新', season: '8', episode: '1', positionSeconds: 31,
  capturedAt: 1_800_000_000_000, windowId: 'window-100', pid: 100, frameDigest: 'a'.repeat(64), ...patch,
});
const pair = (): PlaybackSample[] => [sample(), sample({ positionSeconds: 34, capturedAt: 1_800_000_003_000, frameDigest: 'b'.repeat(64) })];

describe('playback goal and visible-fact parsing', () => {
  it.each([
    [task, '爱奇艺', '蜡笔小新', '8', '1'],
    ['用爱奇艺播放蜡笔小新第8季第1集。', '爱奇艺', '蜡笔小新', '8', '1'],
    ['用爱奇艺播放蜡笔小新第一百零八集吧', '爱奇艺', '蜡笔小新', '', '108'],
    ['Play Shin Chan season eight episode one on YouTube.', 'YouTube', 'Shin Chan', '8', '1'],
    ['Play music on Spotify', 'Spotify', '', '', ''],
    ['打开网易云并播放音乐', '网易云音乐', '', '', ''],
    ['用Spotify播放YouTube', 'Spotify', 'YouTube', '', ''],
    ['用爱奇艺播放《第二十条》', '爱奇艺', '第二十条', '', ''],
    ['用爱奇艺播放《蜡笔小新！》第8季', '爱奇艺', '蜡笔小新!', '8', ''],
    ['用爱奇艺播放蜡笔小新\n## Recent action continuation context\n旧任务第2季第3集', '爱奇艺', '蜡笔小新', '', ''],
  ])('separates player/title/season/episode without inventing metadata: %s', (input, player, title, season, episode) => {
    expect(parsePlaybackGoal(input)).toEqual({ player, title, season, episode });
  });
  it('keeps missing visible facts unknown and normalizes actual numeric metadata', () => {
    expect(parseVisualPlaybackObservation({ phase: 'buffering', player: '', title: '', season: '', episode: '', positionSeconds: null }))
      .toEqual({ phase: 'buffering', player: '', title: '', season: '', episode: '', positionSeconds: null });
    expect(parseVisualPlaybackObservation({ ...sample(), season: '八', episode: '001', verified: true }))
      .toEqual({ phase: 'content', player: '爱奇艺', title: '蜡笔小新', season: '8', episode: '1', positionSeconds: 31 });
  });
  it.each([
    null, [], 'done', { verified: true }, { ...sample(), phase: 'playing' }, { ...sample(), player: 123 },
    { ...sample(), title: undefined }, { ...sample(), season: 8 }, { ...sample(), episode: 'first' },
    { ...sample(), positionSeconds: '00:31' }, { ...sample(), positionSeconds: Infinity }, { ...sample(), positionSeconds: NaN },
    { ...sample(), positionSeconds: -1 }, { ...sample(), positionSeconds: 86401 }, { ...sample(), title: 'a'.repeat(161) },
    { ...sample(), title: 'Programme\nInjected status' },
  ])('rejects malformed visible facts without coercion: %j', value => expect(parseVisualPlaybackObservation(value)).toBeNull());
});

describe('runtime recomputes completion from two capture-bound progress samples', () => {
  it('verifies a requested song and singer independently of the programme-title field', () => {
    const request = '在网易云音乐里播放陈奕迅的孤勇者。';
    const samples = pair().map(row => ({ ...row, player: '网易云音乐', title: '孤勇者', artist: '陈奕迅', season: '', episode: '' }));
    expect(parsePlaybackGoal(request)).toMatchObject({ title: '孤勇者', artist: '陈奕迅' });
    expect(buildPlaybackVerification(request, samples)?.verified).toBe(true);
    expect(buildPlaybackVerification(request, samples.map(row => ({ ...row, artist: '其他歌手' })))).toBeNull();
    expect(buildPlaybackVerification(request, samples.map(({ artist, ...row }) => row))).toBeNull();
  });
  it('builds and validates the requested content, including serialization and player aliases', () => {
    const samples = pair(); samples[1].player = 'iqiyi.exe';
    const proof = buildPlaybackVerification(task, samples);
    expect(proof).toMatchObject({ version: 1, source: 'visual_progress', verified: true,
      target: { player: '爱奇艺', title: '蜡笔小新', season: '8', episode: '1' } });
    expect(validatePlaybackVerification(JSON.parse(JSON.stringify(proof)), task)).toBe(true);
  });
  it('accepts a slow but bounded actual observation and never fills unspecified season/episode into the target', () => {
    const samples = pair(); samples[1].capturedAt += 42_000; samples[1].positionSeconds! += 42;
    const proof = buildPlaybackVerification('用爱奇艺播放蜡笔小新', samples);
    expect(proof?.target).toEqual({ player: '爱奇艺', title: '蜡笔小新', season: '', episode: '' });
    expect(validatePlaybackVerification(proof, '用爱奇艺播放蜡笔小新')).toBe(true);
  });
  it.each<Partial<PlaybackSample>>([
    { phase: 'advertisement' }, { phase: 'buffering' }, { phase: 'paused' }, { phase: 'blocked' }, { phase: 'unknown' },
    { player: '优酷' }, { title: '旧节目' }, { season: '1' }, { episode: '2' }, { season: '' }, { episode: '' },
    { windowId: 'another-window' }, { pid: 200 }, { windowId: '' }, { pid: 0 }, { pid: NaN },
    { capturedAt: 1_800_000_000_500 }, { capturedAt: 1_800_000_000_000 }, { capturedAt: 1_800_000_061_000 },
    { positionSeconds: 31 }, { positionSeconds: 30 }, { positionSeconds: 80 }, { positionSeconds: null },
    { frameDigest: 'a'.repeat(64) }, { frameDigest: '' }, { frameDigest: 'not-a-real-digest' },
  ])('rejects a non-confirming latest sample: %j', patch => {
    const samples = pair(); samples[1] = { ...samples[1], ...patch };
    expect(buildPlaybackVerification(task, samples)).toBeNull();
    expect(validatePlaybackVerification({ version: 1, source: 'visual_progress', target: parsePlaybackGoal(task), samples, verified: true }, task)).toBe(false);
  });
  it('requires both samples to be content and does not search back past an ad or a cancelled observation', () => {
    const samples = pair(); samples[0].phase = 'advertisement';
    expect(buildPlaybackVerification(task, samples)).toBeNull();
    expect(buildPlaybackVerification(task, [...pair(), sample({ phase: 'unknown' })])).toBeNull();
  });
  it('requires stable identity even when the user asked for generic music', () => {
    const samples = pair(); samples[1].title = 'New Track';
    expect(buildPlaybackVerification('播放音乐', samples)).toBeNull();
    samples[0].title = samples[1].title = '';
    expect(buildPlaybackVerification('播放音乐', samples)).toBeNull();
    expect(buildPlaybackVerification('打开爱奇艺', pair())).toBeNull();
    expect(buildPlaybackVerification('不要播放蜡笔小新', pair())).toBeNull();
  });
  it('does not treat a model completion flag, tampered target, wrong schema or removed samples as proof', () => {
    const proof = buildPlaybackVerification(task, pair())!;
    expect(validatePlaybackVerification({ ...proof, samples: [] }, task)).toBe(false);
    expect(validatePlaybackVerification({ ...proof, samples: [...proof.samples, proof.samples[1]] }, task)).toBe(false);
    expect(validatePlaybackVerification({ ...proof, source: 'model_done' }, task)).toBe(false);
    expect(validatePlaybackVerification({ ...proof, version: 2 }, task)).toBe(false);
    expect(validatePlaybackVerification({ ...proof, target: { ...proof.target, season: '1' } }, task)).toBe(false);
    expect(validatePlaybackVerification(proof, '用爱奇艺播放《蜡笔小新》第1季第1集')).toBe(false);
    const altered = JSON.parse(JSON.stringify(proof)); altered.samples[1].positionSeconds = 31;
    expect(validatePlaybackVerification(altered, task)).toBe(false);
  });
});
