import { describe, expect, it } from 'vitest';
import { hasMediaPlaybackEvidence } from '../server/cognition/action_contract';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import type { ToolExecutionRecord } from '../server/tools/types';

function record(name: string, result: unknown, args: Record<string, unknown> = {}): ToolExecutionRecord {
  return { name, arguments: args, result: typeof result === 'string' ? result : JSON.stringify(result), terminalVerification: { status: 'verified', strategy: 'state_diff', reason: 'Synthetic observed playback state.' } };
}
const songTask = '用网易云放一首秋天不回来';
const prepare = () => [
  record('desktop_active_window', { process_name: 'cloudmusic.exe', title: '网易云音乐' }),
  record('keyboard_press', { ok: true, targetMatched: true }, { key: 'space' }),
];
const playing = (patch = {}) => record('desktop_ui_snapshot', { player: '网易云音乐', playerState: 'playing', currentTrack: { title: '秋天不回来' }, ...patch });

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
