import { afterEach, describe, expect, it } from 'vitest';
import {
  createRealtimeVoicePrioritySignal,
  isRealtimeUserActive,
  resetRealtimeUserActivityForTests,
  setRealtimeVoiceSessionActive,
} from '../server/autonomy/foreground_activity';

describe('foreground voice priority', () => {
  afterEach(() => resetRealtimeUserActivityForTests());

  it('tracks multiple live sockets idempotently and releases after the call', () => {
    setRealtimeVoiceSessionActive('u1', 'socket-a', true);
    setRealtimeVoiceSessionActive('u1', 'socket-a', true);
    setRealtimeVoiceSessionActive('u1', 'socket-b', true);
    expect(isRealtimeUserActive('u1', 0)).toBe(true);

    setRealtimeVoiceSessionActive('u1', 'socket-a', false);
    expect(isRealtimeUserActive('u1', 0)).toBe(true);

    setRealtimeVoiceSessionActive('u1', 'socket-b', false);
    expect(isRealtimeUserActive('u1', 0)).toBe(false);
  });

  it('interrupts registered background work as soon as live voice starts', () => {
    const priority = createRealtimeVoicePrioritySignal('u2');
    expect(priority.signal.aborted).toBe(false);

    setRealtimeVoiceSessionActive('u2', 'socket-live', true);
    expect(priority.signal.aborted).toBe(true);
    expect(String(priority.signal.reason)).toContain('Live user voice session has priority');
    priority.dispose();
  });

  it('does not interrupt a disposed background registration', () => {
    const priority = createRealtimeVoicePrioritySignal('u3');
    priority.dispose();
    setRealtimeVoiceSessionActive('u3', 'socket-live', true);
    expect(priority.signal.aborted).toBe(false);
  });
});
