import './helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ model: vi.fn() }));
vi.mock('../server/llm/providers', () => ({ makeLLMCall: mocks.model }));
vi.mock('../server/llm/adapter', () => ({ parseScreenshotBase64: (value: string) => ({ base64: JSON.parse(value).image_base64, mime: 'image/png' }) }));
vi.mock('../server/llm/world_preferences', () => ({ getUserPreferredWorldModel: () => ({ provider: 'openai', model: 'vision-test' }) }));
vi.mock('../server/llm/token_tracker', () => ({ recordTokenUsage: vi.fn() }));
// These frames are deliberately synthetic strings, not PNG data. Real sharp
// work races the fake clock under suite load and can finish in the next test.
// Pixel cropping has its own real-image coverage in playback_crop.test.ts.
vi.mock('../server/desktop/playback_crop', () => ({
  cropPlaybackWindow: async (image: object, screen: object) => ({ ...image, screen }),
  playbackControlDetail: async () => null,
}));
import { computerUseLoop } from '../server/agents/computer_use';
import { validatePlaybackVerification } from '../server/cognition/playback_verification';

const task = '用爱奇艺播放《蜡笔小新》第8季第1集';
const visibleWindow = { window_id: 'iqiyi-window', pid: 712, process_name: 'iqiyi.exe', title: '蜡笔小新 - 爱奇艺' };
const observation = (phase = 'content', positionSeconds: number | null = 10, extra = {}) => ({
  phase, player: '爱奇艺', title: '蜡笔小新', season: '8', episode: '1', positionSeconds, ...extra,
});
const reply = (value: unknown) => ({ text: JSON.stringify(value), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });

beforeEach(() => {
  mocks.model.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-07T00:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); });

function setup(options: { maxAttempts?: number; isCancelled?: () => boolean; onProgress?: (text: string) => void; window?: (captures: number) => unknown } = {}) {
  let captures = 0;
  const relay = vi.fn(async (name: string) => {
    if (name === 'desktop_active_window') return JSON.stringify(options.window?.(captures) || visibleWindow);
    if (name === 'desktop_capture_screen') return JSON.stringify({ image_base64: Buffer.from(`independent-frame-${++captures}`).toString('base64'), width: 1920, height: 1080 });
    return '';
  });
  const run = () => computerUseLoop(task, { desktopRelay: relay, llmGetters: { getOpenAI: () => ({}) }, maxIterations: 1,
    playbackVerification: { maxAttempts: options.maxAttempts || 6, timeoutMs: 30_000, intervalMs: 1_000 },
    isCancelled: options.isCancelled, onProgress: options.onProgress });
  return { relay, run };
}

async function settle(pending: Promise<string>) {
  await vi.runAllTimersAsync();
  return JSON.parse(await pending);
}

describe('autonomous playback confirmation after desktop control', () => {
  it('checks the result of a final-budget Play click even when the control model never returns done', async () => {
    mocks.model.mockResolvedValueOnce(reply({ action: 'click', x: 100, y: 100, reason: 'Press the visible Play control' }))
      .mockResolvedValueOnce(reply(observation('content', 10)))
      .mockResolvedValueOnce(reply(observation('content', 11)));
    const fixture = setup();
    const result = await settle(fixture.run());
    expect(result).toMatchObject({ status: 'verified', completionVerified: true, observations: 2, steps: 1 });
    expect(fixture.relay.mock.calls.filter(([name]) => name === 'desktop_mouse_click_at')).toHaveLength(1);
    expect(mocks.model).toHaveBeenCalledTimes(3);
  });

  it('waits through ads and loading, then confirms advancing programme playback without any user message', async () => {
    mocks.model
      .mockResolvedValueOnce(reply({ action: 'done', message: '视频页面已打开，当前正在播放片前广告。' }))
      .mockResolvedValueOnce(reply(observation('advertisement', null)))
      .mockResolvedValueOnce(reply(observation('buffering', null)))
      .mockResolvedValueOnce(reply(observation('content', 10)))
      .mockResolvedValueOnce(reply(observation('content', 11)));
    const progress: string[] = [];
    const fixture = setup({ onProgress: text => progress.push(text) });
    const result = await settle(fixture.run());
    expect(result).toMatchObject({ status: 'verified', completionVerified: true, observations: 2, observationAttempts: 4 });
    expect(validatePlaybackVerification(result.playbackVerification, task)).toBe(true);
    expect(progress).toContain('广告还在播放，正在等待正片。');
    expect(progress).toContain('视频还在加载，正在等待播放。');
    expect(progress.at(-1)).toBe('正在核对节目和播放进度。');
    expect(fixture.relay.mock.calls.filter(([name]) => /desktop_(?:mouse|keyboard)/u.test(name))).toHaveLength(0);
    expect(mocks.model).toHaveBeenCalledTimes(5);
    expect(mocks.model.mock.calls[1][0][1].content[0].text).not.toContain('DONE_CANDIDATE');
    expect(mocks.model.mock.calls[1][0][1].content[0].text).not.toContain(`Task: ${task}`);
    expect(result.playbackVerification.samples).toHaveLength(2);
    expect(JSON.stringify(result.playbackVerification)).not.toContain('image_base64');
  });

  it('reports an advertisement when the bounded observation period ends instead of calling it programme playback', async () => {
    mocks.model.mockResolvedValueOnce(reply({ action: 'done', message: 'Player page opened.' }))
      .mockResolvedValue(reply(observation('advertisement', null)));
    const fixture = setup({ maxAttempts: 3 });
    const result = await settle(fixture.run());
    expect(result).toMatchObject({ status: 'unverified', completionVerified: false, resumeStrategy: 'observe_only',
      verificationReason: 'observation_timeout', observationAttempts: 3, playbackObservation: { phase: 'advertisement' } });
    expect(fixture.relay.mock.calls.some(([name]) => /desktop_(?:mouse|keyboard)/u.test(name))).toBe(false);
  });

  it.each([null, 10])('does not accept changing screenshots when elapsed playback time is absent or stationary: %s', position => {
    mocks.model.mockResolvedValueOnce(reply({ action: 'done', message: '播放成功。' }))
      .mockResolvedValue(reply(observation('content', position)));
    return settle(setup({ maxAttempts: 3 }).run()).then(result => {
      expect(result.completionVerified).toBe(false);
      expect(result.playbackVerification?.verified).toBe(false);
    });
  });

  it('does not turn a visual model action proposal into another click during observation', async () => {
    mocks.model.mockResolvedValueOnce(reply({ action: 'done', message: 'Player page opened.' }))
      .mockResolvedValue(reply({ action: 'click', x: 250, y: 350 }));
    const fixture = setup();
    const result = await settle(fixture.run());
    expect(result).toMatchObject({ completionVerified: false, verificationReason: 'observation_unavailable' });
    expect(fixture.relay.mock.calls.some(([name]) => /desktop_(?:mouse|keyboard)/u.test(name))).toBe(false);
  });

  it('honours cancellation during the wait without declaring completion or asking for user confirmation', async () => {
    let cancelled = false;
    mocks.model.mockResolvedValueOnce(reply({ action: 'done', message: 'Player page opened.' }))
      .mockResolvedValue(reply(observation('advertisement', null)));
    const fixture = setup({ isCancelled: () => cancelled, onProgress: text => { if (text.includes('广告还在播放')) cancelled = true; } });
    const result = await settle(fixture.run());
    expect(result.status).toBe('cancelled');
    expect(result.completionVerified).not.toBe(true);
    expect(mocks.model).toHaveBeenCalledTimes(2);
  });

  it('stops when the foreground changes while a playback sample is being captured', async () => {
    mocks.model.mockResolvedValueOnce(reply({ action: 'done', message: 'Player page opened.' }));
    const fixture = setup({ window: captures => captures >= 2 ? { ...visibleWindow, window_id: 'another-window', pid: 812 } : visibleWindow });
    const result = await settle(fixture.run());
    expect(result).toMatchObject({ status: 'unverified', verificationReason: 'target_changed' });
    expect(mocks.model).toHaveBeenCalledTimes(1);
  });

  it('rejects an OS window handle reused by a different player process', async () => {
    mocks.model.mockResolvedValueOnce(reply({ action: 'done', message: 'Player page opened.' }));
    const fixture = setup({ window: captures => captures >= 2 ? { ...visibleWindow, pid: 812 } : visibleWindow });
    const result = await settle(fixture.run());
    expect(result).toMatchObject({ status: 'unverified', verificationReason: 'target_changed' });
    expect(mocks.model).toHaveBeenCalledTimes(1);
  });

  it('aborts a stuck observer at its deadline and cleans up its cancellation timer', async () => {
    mocks.model.mockResolvedValueOnce(reply({ action: 'done', message: 'Player page opened.' }))
      .mockImplementationOnce(() => new Promise(() => {}));
    const result = await settle(setup().run());
    expect(result).toMatchObject({ status: 'unverified', verificationReason: 'observation_timeout' });
    expect(mocks.model.mock.calls[1][2].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds the first window read after the final control action as part of observation', async () => {
    mocks.model.mockResolvedValueOnce(reply({ action: 'click', x: 100, y: 100 }));
    let clicked = false;
    const relay = vi.fn(async (name: string): Promise<string> => {
      if (name === 'desktop_active_window') return clicked ? new Promise(() => {}) : JSON.stringify(visibleWindow);
      if (name === 'desktop_capture_screen') return JSON.stringify({ image_base64: 'Y29udHJvbC1mcmFtZQ==', width: 1920, height: 1080 });
      if (name === 'desktop_mouse_click_at') clicked = true;
      return '';
    });
    const result = await settle(computerUseLoop(task, { desktopRelay: relay, llmGetters: { getOpenAI: () => ({}) },
      maxIterations: 1, playbackVerification: { timeoutMs: 2000 } }));
    expect(result).toMatchObject({ status: 'unverified', verificationReason: 'observation_timeout', observationAttempts: 0 });
    expect(mocks.model).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
