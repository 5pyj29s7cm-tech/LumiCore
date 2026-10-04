import { describe, expect, it, vi } from 'vitest';
import { createVoiceTerminalCompletion } from '../server/socket/voice/terminal_completion';
const reasons = { completedReason: 'completed', interruptedReason: 'interrupted' };

describe('voice playback terminal ownership', () => {
  it('waits for durable publication and playback before learning and releasing', async () => {
    let publish!: (ok: boolean) => void, played!: () => void;
    const events: string[] = [];
    const finish = createVoiceTerminalCompletion({ commit: () => new Promise<boolean>(resolve => { publish = resolve; }),
      drainSpeech: () => new Promise<void>(resolve => { events.push('playback'); played = resolve; }),
      isCurrent: () => true, release: async reason => { events.push(reason); } });
    const work = finish({ blocked: false }, { ...reasons, onCommitted: () => { events.push('learn'); } });
    expect(events).toEqual([]); publish(true); await Promise.resolve();
    expect(events).toEqual(['playback']); played(); await expect(work).resolves.toBe(true);
    expect(events).toEqual(['playback', 'learn', 'completed']);
  });
  it('suppresses learning and presentation changes after cancellation during playback', async () => {
    let current = true;
    const afterPlayback = vi.fn(), onCommitted = vi.fn(), release = vi.fn(async () => {});
    const finish = createVoiceTerminalCompletion({ commit: async () => true, drainSpeech: async () => { current = false; }, isCurrent: () => current, release });
    await expect(finish({ blocked: false }, { ...reasons, afterPlayback, onCommitted })).resolves.toBe(false);
    expect(afterPlayback).not.toHaveBeenCalled(); expect(onCommitted).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledExactlyOnceWith('interrupted');
  });
  it.each([[false, false], [true, true]])('cannot learn from unknown persistence or blocked output (%s, %s)', async (committed, blocked) => {
    const onCommitted = vi.fn(), release = vi.fn(async () => {});
    const finish = createVoiceTerminalCompletion({ commit: async () => committed, drainSpeech: async () => {}, isCurrent: () => true, release });
    await finish({ blocked }, { ...reasons, onCommitted });
    expect(onCommitted).not.toHaveBeenCalled(); expect(release).toHaveBeenCalledExactlyOnceWith('completed');
  });
});
