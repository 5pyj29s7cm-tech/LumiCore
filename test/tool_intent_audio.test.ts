import { describe, expect, it } from 'vitest';
import { shouldAllowToolUseForTurn } from '../server/cognition/tool_intent';

describe('audio transcription tool intent', () => {
  it('keeps transcript file requests out of pure chat and enables them in assistant mode', () => {
    const text = 'Please transcribe this audio recording and save it as a text file.';
    expect(shouldAllowToolUseForTurn(text, undefined, 'chat')).toBe(false);
    expect(shouldAllowToolUseForTurn(text, undefined, 'assistant')).toBe(true);
  });
});
