import { describe, expect, it } from 'vitest';
import {
  getConfiguredVoiceModel,
  normalizeVoiceModelId,
} from '../server/config/voice_preference';

describe('official voice model preference contract', () => {
  it('accepts only provider-qualified, bounded model ids', () => {
    expect(normalizeVoiceModelId('aliyun/qwen-audio-3.0-asr-flash-streaming')).toBe(
      'aliyun/qwen-audio-3.0-asr-flash-streaming',
    );
    expect(normalizeVoiceModelId('qwen-audio')).toBeUndefined();
    expect(normalizeVoiceModelId('aliyun/qwen\n-audio')).toBeUndefined();
    expect(normalizeVoiceModelId('')).toBeUndefined();
  });

  it('returns the selected official model and a stable legacy default', () => {
    expect(getConfiguredVoiceModel('stt', {
      stt: 'relay',
      tts: 'auto',
      sttModel: 'aliyun/custom-asr',
    })).toBe('aliyun/custom-asr');
    expect(getConfiguredVoiceModel('tts', {
      stt: 'auto',
      tts: 'relay',
    })).toBe('aliyun/cosyvoice-v3-flash');
    expect(getConfiguredVoiceModel('stt', {
      stt: 'auto',
      tts: 'auto',
      sttModel: 'aliyun/custom-asr',
    })).toBeUndefined();
  });
});
