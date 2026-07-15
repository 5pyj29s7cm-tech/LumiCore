import { afterEach, describe, expect, it } from 'vitest';
import {
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
});
