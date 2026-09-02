import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isCircuitClosed, resetCircuit } from '../server/cloud/circuit_breaker';

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
      isReadyForAutomaticFallback: () => true,
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
    expect(localSynthesize).toHaveBeenCalledWith('hello', 'default', undefined);
  });

  it('does not disable all Doubao voices after one voice-specific failure', async () => {
    vi.doMock('../server/tts/providers/local_cosyvoice', () => ({
      isConfigured: () => false,
      synthesizeSpeech: vi.fn(),
      listVoices: () => [],
    }));
    vi.doMock('../server/tts/providers/gptsovits', () => ({
      isConfigured: () => false,
      isReadyForAutomaticFallback: () => false,
      synthesizeSpeech: vi.fn(),
      listVoices: () => [],
    }));
    vi.doMock('../server/tts/providers/cosyvoice', () => ({
      synthesizeSpeech: vi.fn(),
      cloneVoice: vi.fn(),
      designVoice: vi.fn(),
      listVoices: () => [],
    }));
    vi.doMock('../server/tts/providers/ark', () => ({
      hasDoubaoSpeech: () => true,
      synthesizeSpeech: vi.fn().mockRejectedValue(new Error('resource ID is mismatched with speaker related resource')),
      listVoices: () => [],
    }));
    vi.doMock('../server/config/keys', () => ({ getKey: () => '' }));
    vi.doMock('../server/config/voice_preference', () => ({
      getVoicePreference: () => ({ stt: 'ark', tts: 'ark' }),
    }));

    const adapter = await import('../server/tts/adapter');
    await expect(adapter.synthesizeSpeech('hello', {
      provider: 'ark',
      voiceId: 'invalid-for-resource',
      allowFallback: false,
    })).rejects.toThrow('resource ID is mismatched');
    expect(isCircuitClosed('doubao-tts')).toBe(true);
  });

  it('treats a user abort as transport control without opening the provider circuit or falling back', async () => {
    const controller = new AbortController();
    const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const relaySynthesize = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw aborted;
    });
    const fallbackSynthesize = vi.fn().mockResolvedValue({
      audioBuffer: Buffer.from('must-not-play'),
      format: 'audio/wav',
    });

    vi.doMock('../server/tts/providers/local_cosyvoice', () => ({
      isConfigured: () => false,
      synthesizeSpeech: vi.fn(),
      listVoices: () => [],
    }));
    vi.doMock('../server/tts/providers/gptsovits', () => ({
      isConfigured: () => true,
      isReadyForAutomaticFallback: () => true,
      synthesizeSpeech: fallbackSynthesize,
      listVoices: () => [{ voiceId: 'gptsovits:voice-a' }],
    }));
    vi.doMock('../server/tts/providers/cosyvoice', () => ({
      synthesizeSpeech: vi.fn(),
      cloneVoice: vi.fn(),
      designVoice: vi.fn(),
      listVoices: () => [],
    }));
    vi.doMock('../server/tts/providers/ark', () => ({
      hasDoubaoSpeech: () => false,
      synthesizeSpeech: vi.fn(),
      listVoices: () => [],
    }));
    vi.doMock('../server/tts/providers/relay', () => ({
      synthesizeSpeech: relaySynthesize,
      listVoices: () => [{ voiceId: 'longxiaochun_v3' }],
    }));
    vi.doMock('../server/relay/config', () => ({ relayConfigured: () => true }));
    vi.doMock('../server/config/keys', () => ({ getKey: () => '' }));
    vi.doMock('../server/config/voice_preference', () => ({
      getVoicePreference: () => ({ stt: 'relay', tts: 'relay' }),
    }));

    const adapter = await import('../server/tts/adapter');
    await expect(adapter.synthesizeSpeech('stop now', {
      provider: 'relay',
      voiceId: 'longxiaochun_v3',
      signal: controller.signal,
      allowFallback: true,
    })).rejects.toBe(aborted);

    expect(relaySynthesize).toHaveBeenCalledOnce();
    expect(fallbackSynthesize).not.toHaveBeenCalled();
    expect(isCircuitClosed('relay-tts')).toBe(true);
  });
});
