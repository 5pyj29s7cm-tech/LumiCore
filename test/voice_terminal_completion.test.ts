import { describe, expect, it, vi } from 'vitest';
import { createVoiceTerminalCompletion } from '../server/socket/voice/terminal_completion';

describe('voice playback terminal ownership', () => {
  it('waits for durable publication and playback before learning', async () => {
    let publish!: (ok: boolean) => void, played!: () => void;
    const events: string[] = [];
    const finish = createVoiceTerminalCompletion({ commit: () => new Promise<boolean>(resolve => { publish = resolve; }),
      drainSpeech: () => new Promise<void>(resolve => { events.push('playback'); played = resolve; }), isCurrent: () => true });
    const work = finish({ blocked: false }, { onCommitted: () => { events.push('learn'); } });
    expect(events).toEqual([]); publish(true); await Promise.resolve();
    expect(events).toEqual(['playback']); played(); await expect(work).resolves.toBe(true);
    expect(events).toEqual(['playback', 'learn']);
  });
  it('suppresses learning and presentation changes after cancellation during playback', async () => {
    let current = true;
    const afterPlayback = vi.fn(), onCommitted = vi.fn();
    const finish = createVoiceTerminalCompletion({ commit: async () => true, drainSpeech: async () => { current = false; }, isCurrent: () => current });
    await expect(finish({ blocked: false }, { afterPlayback, onCommitted })).resolves.toBe(false);
    expect(afterPlayback).not.toHaveBeenCalled(); expect(onCommitted).not.toHaveBeenCalled();
  });
  it.each([[false, false], [true, true]])('cannot learn from unknown persistence or blocked output (%s, %s)', async (committed, blocked) => {
    const onCommitted = vi.fn();
    const finish = createVoiceTerminalCompletion({ commit: async () => committed, drainSpeech: async () => {}, isCurrent: () => true });
    await finish({ blocked }, { onCommitted }); expect(onCommitted).not.toHaveBeenCalled();
  });
  it.each(['commit', 'playback', 'learning'])('propagates a %s failure to the turn owner instead of releasing from a competing path', async stage => {
    const fail = () => { throw new Error(stage); };
    const finish = createVoiceTerminalCompletion({ commit: async () => stage === 'commit' ? fail() : true,
      drainSpeech: async () => { if (stage === 'playback') fail(); }, isCurrent: () => true });
    await expect(finish({ blocked: false }, { onCommitted: () => { if (stage === 'learning') fail(); } })).rejects.toThrow(stage);
  });
});
