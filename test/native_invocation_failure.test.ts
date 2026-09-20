import { describe, expect, it } from 'vitest';
import { nativeInvocationFailure } from '../src/lib/nativeInvocationFailure';

describe('native keyboard preflight versus uncertain transport', () => {
  it('does not quarantine the desktop for a proven not-started key validation failure', () => {
    expect(nativeInvocationFailure('keyboard_press', '[not_started] Unknown key: bad').message).not.toContain('outcome_unknown');
  });
  it('keeps disconnects, ambiguous native errors and unrelated commands fenced', () => {
    for (const [command, error] of [['keyboard_press', new Error('connection lost')], ['keyboard_press', 'key press failed'], ['run_command', '[not_started] arbitrary output']]) {
      expect(nativeInvocationFailure(String(command), error).message).toContain('outcome_unknown');
    }
  });
});
