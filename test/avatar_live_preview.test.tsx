// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
const fixture = vi.hoisted(() => ({ create: vi.fn(), enable: vi.fn(), close: vi.fn(), stop: vi.fn(), play: vi.fn(), reply: vi.fn(), scan: vi.fn(), capture: vi.fn(), crop: vi.fn(), mount: vi.fn(), unmount: vi.fn() }));
vi.mock('../src/lib/avatarLivePlayback', () => ({ AvatarLivePlayback: class {
  constructor(...args: unknown[]) { fixture.create(...args); }
  enable = fixture.enable; closeAndWait = fixture.close; stop = fixture.stop; play = fixture.play;
} }));
vi.mock('../src/services/avatarLiveService', () => ({ avatarLiveService: { reply: fixture.reply, scan: fixture.scan } }));
vi.mock('../src/lib/avatarLiveScreen', () => ({ captureLiveScreen: fixture.capture, cropLiveScreen: fixture.crop, validateLiveRegion: vi.fn() }));
vi.mock('../src/hooks/useAliyunAvatarConfig', () => ({ useAliyunAvatarConfig: () => null }));
vi.mock('../src/components/MemoryAvatarPortraitStage', () => ({ MemoryAvatarPortraitStage: () => null }));
vi.mock('../src/components/MemoryAvatarStage', () => ({ MemoryAvatarStage: function Stage() {
  useEffect(() => { fixture.mount(); return fixture.unmount; }, []);
  return <div data-testid="avatar-stage">Avatar</div>;
} }));
import { useAvatarLivePreview } from '../src/hooks/useAvatarLivePreview';
import { AvatarLiveWorkbench } from '../src/components/AvatarLiveWorkbench';
import { DEFAULT_MEMORY_AVATAR_APPEARANCE } from '../shared/memory_avatar';
const config = { avatarId: 'avatar', ownerId: 'owner', name: 'Host', appearance: DEFAULT_MEMORY_AVATAR_APPEARANCE, locale: 'en' as const };
const reply = { text: 'Public answer', audioBase64: 'YXVkaW8=', format: 'mp3' };
const region = { x: 0, y: 0, width: 100, height: 100, screenX: 0, screenY: 0, screenWidth: 100, screenHeight: 100 };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function ready(result: ReturnType<typeof renderHook<ReturnType<typeof useAvatarLivePreview>, unknown>>['result']) {
  await act(async () => { await result.current.enable(); });
}
beforeEach(() => {
  vi.resetAllMocks(); fixture.enable.mockResolvedValue(undefined); fixture.close.mockResolvedValue(undefined);
  fixture.reply.mockResolvedValue(reply); fixture.play.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('live preview in the current Lumi window', () => {
  it('waits for cloud cleanup before allowing another audio session', async () => {
    const closing = deferred(); fixture.close.mockReturnValueOnce(closing.promise);
    const { result } = renderHook(() => useAvatarLivePreview(config)); await ready(result);
    act(() => { void result.current.close(); });
    expect(result.current.audioReady).toBe(false); expect(result.current.audioPending).toBe(true);
    await ready(result); expect(fixture.create).toHaveBeenCalledOnce();
    await act(async () => { closing.resolve(); });
    expect(result.current.audioPending).toBe(false);
    await ready(result); expect(fixture.create).toHaveBeenCalledTimes(2);
  });
  it('records completed playback and reuses public session context', async () => {
    const playing = deferred(); fixture.play.mockReturnValueOnce(playing.promise);
    const { result } = renderHook(() => useAvatarLivePreview(config)); await ready(result);
    act(() => result.current.test('Question one', 'Viewer', 'Public brief'));
    await waitFor(() => expect(fixture.play).toHaveBeenCalledOnce());
    expect(result.current.history).toEqual([]); expect(result.current.busy).toBe(true);
    act(() => fixture.create.mock.calls[0][1].speaking(true));
    expect(result.current.subtitle).toBe(reply.text);
    await act(async () => { playing.resolve(); });
    expect(result.current.history).toEqual([{ nickname: 'Viewer', comment: 'Question one', reply: reply.text }]);
    act(() => result.current.test('Question two', 'Viewer', 'Public brief'));
    await waitFor(() => expect(fixture.reply).toHaveBeenCalledTimes(2));
    expect(fixture.reply.mock.calls[1][1].history[0].comment).toBe('Question one');
  });
  it('does not play a late model completion after pause', async () => {
    const model = deferred<unknown>(); fixture.reply.mockReturnValueOnce(model.promise);
    const { result } = renderHook(() => useAvatarLivePreview(config)); await ready(result);
    act(() => result.current.test('Question', 'Viewer', 'Public brief'));
    const signal = fixture.reply.mock.calls[0][2] as AbortSignal;
    act(() => result.current.pause()); expect(signal.aborted).toBe(true);
    await act(async () => { model.resolve(reply); });
    expect(fixture.play).not.toHaveBeenCalled(); expect(result.current.history).toEqual([]); expect(result.current.busy).toBe(false);
  });
  it('pauses on playback failure without reporting success or replaying', async () => {
    fixture.play.mockRejectedValueOnce(new Error('live_service_unavailable'));
    const { result } = renderHook(() => useAvatarLivePreview(config)); await ready(result);
    act(() => result.current.test('Question', 'Viewer', 'Public brief'));
    await waitFor(() => expect(result.current.error).toBe('live_service_unavailable'));
    expect(result.current.history).toEqual([]); expect(fixture.reply).toHaveBeenCalledOnce(); expect(fixture.stop).toHaveBeenCalled();
  });
  it('disposes pending audio when leaving and ignores its late resume', async () => {
    const audio = deferred(); fixture.enable.mockReturnValueOnce(audio.promise);
    const { result, unmount } = renderHook(() => useAvatarLivePreview(config));
    act(() => { void result.current.enable(); }); unmount();
    await act(async () => { audio.resolve(); });
    expect(fixture.close).toHaveBeenCalledOnce(); expect(result.current.audioReady).toBe(false);
  });
  it('never uploads a capture completed after pause', async () => {
    const capture = deferred<unknown>(); fixture.capture.mockReturnValueOnce(capture.promise);
    const { result } = renderHook(() => useAvatarLivePreview(config)); await ready(result);
    act(() => result.current.start(region, 'Public brief', true)); act(() => result.current.pause());
    await act(async () => { capture.resolve({ image_base64: 'PRIVATE-FULL-DESKTOP' }); });
    expect(fixture.crop).not.toHaveBeenCalled(); expect(fixture.scan).not.toHaveBeenCalled();
  });
  it('blocks a fresh billed session when cleanup failed', async () => {
    fixture.close.mockRejectedValueOnce(new Error('Cleanup unconfirmed'));
    const { result } = renderHook(() => useAvatarLivePreview(config)); await ready(result);
    await act(async () => { await result.current.close(); });
    await ready(result);
    expect(result.current.error).toBe('live_cleanup_unconfirmed'); expect(fixture.create).toHaveBeenCalledOnce();
  });
  it('allows retrying a blocked audio activation', async () => {
    fixture.enable.mockRejectedValueOnce(new Error('Not allowed'));
    const { result } = renderHook(() => useAvatarLivePreview(config)); await ready(result);
    await waitFor(() => expect(result.current.audioPending).toBe(false));
    expect(result.current.error).toBe('live_audio_blocked'); expect(result.current.audioReady).toBe(false);
    await ready(result); expect(result.current.audioReady).toBe(true);
  });
  it('keeps the same avatar and active reply when hiding and restoring controls', async () => {
    const popup = vi.spyOn(window, 'open'); const playing = deferred(); fixture.play.mockReturnValueOnce(playing.promise);
    render(<AvatarLiveWorkbench avatar={{ id: config.avatarId, name: config.name, appearance: config.appearance } as any} ownerId="owner" locale="en" onClose={vi.fn()} />);
    const stage = screen.getByTestId('avatar-stage');
    fireEvent.click(screen.getByRole('button', { name: 'Enable audio' }));
    await screen.findByRole('button', { name: 'Disable audio' });
    fireEvent.change(screen.getByLabelText('Session topic and additional facts'), { target: { value: 'Public brief' } });
    fireEvent.change(screen.getByPlaceholderText('Enter a simulated viewer question'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test speech' }));
    await waitFor(() => expect(fixture.play).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: 'Show avatar only' }));
    expect(screen.queryByRole('button', { name: 'Back to Memory Territory' })).toBeNull();
    expect(screen.getByTestId('avatar-stage')).toBe(stage); expect(fixture.close).not.toHaveBeenCalled(); expect(fixture.stop).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Back to Memory Territory' })).toBeTruthy();
    expect(screen.getByTestId('avatar-stage')).toBe(stage); expect(fixture.mount).toHaveBeenCalledOnce(); expect(popup).not.toHaveBeenCalled();
    await act(async () => { playing.resolve(); });
    expect(screen.getByText('Public answer')).toBeTruthy();
    popup.mockRestore();
  });
  it('can reply using saved public identity while the optional session topic is empty', async () => {
    render(<AvatarLiveWorkbench avatar={{ id: config.avatarId, name: config.name, appearance: config.appearance, publicBrief: 'Approved company identity' } as any} ownerId="owner" locale="en" onClose={vi.fn()} />);
    expect(screen.getByText('Saved public identity loaded')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Enable audio' }));
    await screen.findByRole('button', { name: 'Disable audio' });
    fireEvent.change(screen.getByPlaceholderText('Enter a simulated viewer question'), { target: { value: 'Who are you?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test speech' }));
    await waitFor(() => expect(fixture.reply).toHaveBeenCalledOnce());
    expect(fixture.reply.mock.calls[0][1].brief).toBe('');
  });
});
