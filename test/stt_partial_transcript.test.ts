import { describe, expect, it } from 'vitest';
import { normalizeStreamingTranscript, shouldEmitStreamingPartial } from '../server/stt/partial_transcript';

describe('streaming transcript stability', () => {
  it('normalizes provider whitespace before comparison', () => {
    expect(normalizeStreamingTranscript('  hello   world  ')).toBe('hello world');
  });

  it('suppresses exact duplicates and temporary shorter regressions', () => {
    expect(shouldEmitStreamingPartial('帮我打开微信', '帮我打开微信')).toBe(false);
    expect(shouldEmitStreamingPartial('帮我打开微信', '帮我打开')).toBe(false);
    expect(shouldEmitStreamingPartial('帮我打开', '帮我打开微信')).toBe(true);
  });

  it('allows a provider correction instead of freezing stale text', () => {
    expect(shouldEmitStreamingPartial('打开企业微信', '打开个人微信')).toBe(true);
  });
});
