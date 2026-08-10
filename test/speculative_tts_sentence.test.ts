import { describe, expect, it } from 'vitest';
import { extractFirstCompleteSpeechSentence } from '../server/tts/speculative_sentence';

describe('safe speculative TTS sentence extraction', () => {
  it('returns only a complete first sentence', () => {
    expect(extractFirstCompleteSpeechSentence('好的，我来说明。后面还有第二句。')).toBe('好的，我来说明。');
    expect(extractFirstCompleteSpeechSentence('Still generating')).toBeNull();
  });

  it('ignores punctuation-only content', () => {
    expect(extractFirstCompleteSpeechSentence('……\n')).toBeNull();
  });
});
