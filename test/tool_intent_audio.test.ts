import { describe, expect, it } from 'vitest';
import { shouldAllowToolUseForTurn } from '../server/cognition/tool_intent';

describe('audio transcription tool intent', () => {
  it('allows transcript file requests from chat mode', () => {
    const text = 'Please transcribe this audio recording and save it as a text file.';
    expect(shouldAllowToolUseForTurn(text, undefined, 'chat')).toBe(true);
  });
});
