import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ create: vi.fn(), ttsPlaying: false }));
vi.mock('../server/stt/wake_detector', () => ({ createWakeDetector: fixture.create, isWakeWord: vi.fn() }));
vi.mock('../server/socket/voice', () => ({ isEchoText: () => false, isTtsPlaying: () => fixture.ttsPlaying }));
import { registerWakeHandlers } from '../server/socket/wake';

function socket(id: string) {
  const callbacks = new Map<string, (...args: any[]) => void>();
  return { id, on: (name: string, callback: (...args: any[]) => void) => callbacks.set(name, callback),
    emit: vi.fn(), receive: (name: string, ...args: any[]) => callbacks.get(name)?.(...args) };
}
function detector() {
  const callbacks: { ready?: () => void; wake?: (word: string) => void; error?: (error: Error) => void } = {};
  return { callbacks, sendAudio: vi.fn(), stop: vi.fn(), onReady: (callback: () => void) => { callbacks.ready = callback; },
    onWake: (callback: (word: string) => void) => { callbacks.wake = callback; },
    onError: (callback: (error: Error) => void) => { callbacks.error = callback; } };
}
beforeEach(() => { vi.clearAllMocks(); fixture.ttsPlaying = false; });

describe('wake socket truthful readiness and ownership', () => {
  it('does not acknowledge initial or duplicate starts until the provider is ready', async () => {
    const peer = socket('wake-ready'); const stream = detector(); fixture.create.mockReturnValue(stream);
    registerWakeHandlers(peer as any, () => 'wake-ready-user');
    await peer.receive('wake:start'); await peer.receive('wake:start');
    expect(fixture.create).toHaveBeenCalledOnce(); expect(peer.emit).not.toHaveBeenCalledWith('wake:started');
    stream.callbacks.ready?.(); expect(peer.emit).toHaveBeenCalledWith('wake:started');
    peer.receive('wake:stop'); stream.callbacks.ready?.();
    expect(peer.emit.mock.calls.filter(call => call[0] === 'wake:started')).toHaveLength(1);
    expect(stream.stop).toHaveBeenCalledOnce();
  });

  it('ignores a superseded detector and preserves the echo/audio gate', async () => {
    const first = socket('wake-owner-old'); const second = socket('wake-owner-new');
    const oldStream = detector(); const newStream = detector(); fixture.create.mockReturnValueOnce(oldStream).mockReturnValueOnce(newStream);
    registerWakeHandlers(first as any, () => 'wake-owner-user'); registerWakeHandlers(second as any, () => 'wake-owner-user');
    await first.receive('wake:start'); await second.receive('wake:start');
    expect(oldStream.stop).toHaveBeenCalledOnce();
    oldStream.callbacks.ready?.(); oldStream.callbacks.wake?.('Lumi');
    expect(first.emit).not.toHaveBeenCalled();
    newStream.callbacks.ready?.(); newStream.callbacks.wake?.('Lumi');
    expect(second.emit).toHaveBeenCalledWith('wake:detected', expect.objectContaining({ keyword: 'Lumi' }));
    fixture.ttsPlaying = true; second.receive('wake:audio', Buffer.from([1, 2])); expect(newStream.sendAudio).not.toHaveBeenCalled();
    fixture.ttsPlaying = false; second.receive('wake:audio', Buffer.from([1, 2])); expect(newStream.sendAudio).toHaveBeenCalledOnce();
    first.receive('disconnect'); second.receive('disconnect');
    expect(newStream.stop).toHaveBeenCalledOnce();
  });

  it('closes a failed detector once and never emits a late ready acknowledgement', async () => {
    const peer = socket('wake-failed'); const stream = detector(); fixture.create.mockReturnValue(stream);
    registerWakeHandlers(peer as any, () => 'wake-failed-user'); await peer.receive('wake:start');
    stream.callbacks.error?.(new Error('synthetic provider unavailable')); stream.callbacks.ready?.();
    expect(peer.emit).toHaveBeenCalledWith('wake:error', { message: 'synthetic provider unavailable' });
    expect(peer.emit.mock.calls.some(call => call[0] === 'wake:started')).toBe(false);
    peer.receive('disconnect'); expect(stream.stop).toHaveBeenCalledOnce();
  });
});
