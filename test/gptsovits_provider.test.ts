import { describe, expect, it } from 'vitest';
import { parseVoiceTrainingFileList } from '../server/tts/providers/gptsovits';

describe('GPT-SoVITS reference metadata', () => {
  it('maps each reference audio filename to its actual transcript', () => {
    const parsed = parseVoiceTrainingFileList([
      'segment_0000.wav|speaker0|ZH|各位朋友大家好',
      'segment_0001.wav|speaker0|ZH|包含|分隔符的文本',
      'invalid-row',
    ].join('\n'));

    expect(parsed['segment_0000.wav']).toBe('各位朋友大家好');
    expect(parsed['segment_0001.wav']).toBe('包含|分隔符的文本');
    expect(parsed['invalid-row']).toBeUndefined();
  });
});
