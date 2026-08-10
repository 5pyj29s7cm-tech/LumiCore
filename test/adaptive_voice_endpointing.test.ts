import { describe, expect, it } from 'vitest';
import { clampEndpointSilenceMs, computeAdaptiveEndpointSilenceMs } from '../server/stt/adaptive_endpointing';

describe('adaptive voice endpointing', () => {
  it('shortens the next pause after a compact command', () => {
    expect(computeAdaptiveEndpointSilenceMs({
      transcript: '打开微信',
      speechDurationMs: 1_100,
      previousSilenceMs: 850,
    })).toBeLessThan(850);
  });

  it('keeps more room after a long or continuing instruction', () => {
    expect(computeAdaptiveEndpointSilenceMs({
      transcript: '首先打开设计文件，然后检查所有图层，另外把发现的问题整理成报告',
      speechDurationMs: 8_200,
      previousSilenceMs: 750,
    })).toBeGreaterThan(850);
  });

  it('always stays inside the safe endpoint window', () => {
    expect(clampEndpointSilenceMs(-100)).toBe(650);
    expect(clampEndpointSilenceMs(99_000)).toBe(1_100);
    expect(clampEndpointSilenceMs(Number.NaN)).toBe(850);
  });
});
