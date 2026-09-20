// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ connect: vi.fn(), close: vi.fn(), speak: vi.fn(), options: null as any }));
vi.mock('../src/lib/memoryAvatarPortraitConnection', () => ({ createMemoryAvatarPortraitConnection: (options: any) => { fixture.options = options; return { connect: fixture.connect, close: fixture.close, closeAndWait: fixture.close }; } }));
vi.mock('../src/services/avatarLiveService', () => ({ avatarLiveService: { speakPortrait: fixture.speak } }));
import { AvatarLivePlayback } from '../src/lib/avatarLivePlayback';
import { DEFAULT_MEMORY_AVATAR_APPEARANCE } from '../shared/memory_avatar';
class Context {
  state = 'running'; resume = vi.fn(async () => {}); close = vi.fn(async () => {});
}
const config = { avatarId: 'avatar', ownerId: 'owner', name: 'Host', appearance: DEFAULT_MEMORY_AVATAR_APPEARANCE, locale: 'en' as const, portraitMediaId: 'photo' };
const reply = { text: 'Hello', audioBase64: 'YXVkaW8=', format: 'mp3' };
const callbacks = () => ({ level: { current: 0 }, stream: vi.fn(), speaking: vi.fn() });
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('AudioContext', Context); fixture.connect.mockResolvedValue(undefined); fixture.close.mockResolvedValue(undefined); fixture.speak.mockResolvedValue(undefined); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('portrait playback completion', () => {
  it('waits for a real start and done event, not just provider acceptance', async () => {
    const player = new AvatarLivePlayback(config, callbacks()); await player.enable();
    const done = vi.fn(); const pending = player.play(reply, 'speech-1').then(done);
    await vi.waitFor(() => expect(fixture.speak).toHaveBeenCalledOnce());
    fixture.options.onPlayback(false); await Promise.resolve(); expect(done).not.toHaveBeenCalled();
    fixture.options.onPlayback(true); fixture.options.onPlayback(false); await pending; expect(done).toHaveBeenCalledOnce(); player.dispose();
  });
  it('stops immediately and never replays an accepted but interrupted utterance', async () => {
    const player = new AvatarLivePlayback(config, callbacks()); await player.enable();
    const pending = player.play(reply, 'speech-2'); void pending.catch(() => {});
    await vi.waitFor(() => expect(fixture.speak).toHaveBeenCalledOnce());
    player.stop(); await expect(pending).rejects.toThrow(); expect(fixture.close).toHaveBeenCalled(); expect(fixture.speak).toHaveBeenCalledOnce(); player.dispose();
  });
  it('renews the five-minute renderer lease only between utterances', async () => {
    vi.useFakeTimers(); const player = new AvatarLivePlayback(config, callbacks()); await player.enable();
    const first = player.play(reply, 'first'); await vi.advanceTimersByTimeAsync(1);
    fixture.options.onPlayback(true); fixture.options.onPlayback(false); await first;
    await vi.advanceTimersByTimeAsync(181_000);
    const second = player.play(reply, 'second'); await vi.advanceTimersByTimeAsync(1);
    expect(fixture.connect).toHaveBeenCalledTimes(2); expect(fixture.close).toHaveBeenCalledOnce();
    fixture.options.onPlayback(true); fixture.options.onPlayback(false); await second; player.dispose();
  });
  it('does not create another billed session if renderer cleanup was not confirmed', async () => {
    const player = new AvatarLivePlayback(config, callbacks()); await player.enable();
    const first = player.play(reply, 'first'); await vi.waitFor(() => expect(fixture.speak).toHaveBeenCalledOnce());
    fixture.options.onPlayback(true); fixture.options.onPlayback(false); await first;
    fixture.close.mockRejectedValueOnce(new Error('Cleanup unconfirmed')); player.stop();
    await expect(player.play(reply, 'second')).rejects.toThrow('Cleanup unconfirmed');
    expect(fixture.connect).toHaveBeenCalledOnce(); expect(fixture.speak).toHaveBeenCalledOnce(); player.dispose();
  });
});
