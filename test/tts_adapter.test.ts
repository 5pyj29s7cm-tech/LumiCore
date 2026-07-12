import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetCircuit } from '../server/cloud/circuit_breaker';

describe('TTS adapter fallback', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    resetCircuit();
  });

  it('retries an ordinary utterance through the next healthy provider', async () => {
    const localResult = { audioBuffer: Buffer.from('local-audio'), format: 'audio/wav' };
    const cloudSynthesize = vi.fn().mockRejectedValue(new Error('Access denied: overdue-payment'));
    const localSynthesize = vi.fn().mockResolvedValue(localResult);

    vi.doMock('../server/tts/providers/local_cosyvoice', () => ({
      isConfigured: () => false,
      synthesizeSpeech: vi.fn(),
      listVoices: () => [],
    }));
    vi.doMock('../server/tts/providers/gptsovits', () => ({
      isConfigured: () => true,
      synthesizeSpeech: localSynthesize,
      listVoices: () => [],
    }));
    vi.doMock('../server/tts/providers/cosyvoice', () => ({
      synthesizeSpeech: cloudSynthesize,
      cloneVoice: vi.fn(),
      designVoice: vi.fn(),
      listVoices: () => [],
    }));
    vi.doMock('../server/tts/providers/ark', () => ({
      hasDoubaoSpeech: () => false,
      synthesizeSpeech: vi.fn(),
      listVoices: () => [],
    }));
    vi.doMock('../server/config/keys', () => ({
      getKey: (name: string) => name === 'DASHSCOPE_API_KEY' ? 'test-key' : '',
    }));
    vi.doMock('../server/config/voice_preference', () => ({
      getVoicePreference: () => ({ stt: 'auto', tts: 'cosyvoice' }),
    }));

    const adapter = await import('../server/tts/adapter');
    const result = await adapter.synthesizeSpeech('hello', {
      provider: 'cosyvoice',
      voiceId: 'default',
      allowFallback: true,
    });

    expect(result).toEqual(localResult);
    expect(cloudSynthesize).toHaveBeenCalledOnce();
    expect(localSynthesize).toHaveBeenCalledOnce();
  });
});
