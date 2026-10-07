import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeGenerationModelPrefs, updateUserGenerationModel } from '../server/llm/generation_preferences';
import { normalizeWorldModelPrefs } from '../server/llm/world_preferences';
import { getUserPreferredVision } from '../server/llm/vision_preferences';
import { cleanModelName, normalizeModelMap } from '../server/llm/model_selection';
import { synthesizeSpeech, getActiveProvider, getFallbackProvider } from '../server/tts/adapter';
import { acquireCircuitCall, getCircuitStatus, recordFailure, resetCircuit, setCircuitBreakerConfig } from '../server/cloud/circuit_breaker';

const state = vi.hoisted(() => ({
  settings: new Map<string, any>(), strict: false, tts: 'auto', ready: false,
  relay: vi.fn(), local: vi.fn(), writes: vi.fn(),
}));
vi.mock('../server/persistence/settings_repository', () => ({
  readSettingJson: (key: string) => state.settings.get(key) ?? null,
}));
vi.mock('../server/llm/model_preference_revision', () => ({
  writeModelPreference: (key: string, value: any, roles: string[]) => {
    state.settings.set(key, value); state.writes(key, roles);
  },
}));
vi.mock('../server/config/keys', () => ({ getKey: () => '' }));
vi.mock('../server/config/privacy', () => ({ isStrictPrivacy: () => state.strict, requireNotStrict: vi.fn() }));
vi.mock('../server/config/voice_preference', () => ({ getVoicePreference: () => ({ tts: state.tts }) }));
vi.mock('../server/relay/config', () => ({ relayConfigured: () => true }));
vi.mock('../server/tts/providers/relay', () => ({ synthesizeSpeech: state.relay, listVoices: () => [] }));
vi.mock('../server/tts/providers/local_cosyvoice', () => ({ isConfigured: () => false, synthesizeSpeech: vi.fn(), listVoices: () => [] }));
vi.mock('../server/tts/providers/gptsovits', () => ({ isConfigured: () => true, isReadyForAutomaticFallback: () => state.ready, synthesizeSpeech: state.local, listVoices: () => [] }));
vi.mock('../server/tts/providers/cosyvoice', () => ({ synthesizeSpeech: vi.fn(), listVoices: () => [] }));
vi.mock('../server/tts/providers/ark', () => ({ hasDoubaoSpeech: () => false, synthesizeSpeech: vi.fn(), listVoices: () => [] }));

beforeEach(() => {
  state.settings.clear(); vi.clearAllMocks(); state.strict = false; state.ready = false; state.tts = 'auto';
  resetCircuit(); setCircuitBreakerConfig({ cooldownMs: 30_000, failureThreshold: 5, halfOpenSuccessThreshold: 2, failureWindowMs: 60_000 });
});

describe('model selection owns one consistent value', () => {
  it.each(['image', 'imageEdit', 'video', 'imageToVideo'] as const)('keeps a legacy %s custom model through read and subsequent save', field => {
    const raw = { [field]: { provider: 'relay', model: 'vendor/custom-selected' } };
    const first = normalizeGenerationModelPrefs(raw);
    expect(first[field].models.relay).toBe('vendor/custom-selected');
    expect(normalizeGenerationModelPrefs(first)[field].model).toBe('vendor/custom-selected');
    state.settings.set('generation_prefs_owner', raw);
    const role = { image: 'image_generation', imageEdit: 'image_edit', video: 'video_generation', imageToVideo: 'image_to_video' } as const;
    expect(updateUserGenerationModel('owner', role[field], {})[field].model).toBe('vendor/custom-selected');
    expect(state.writes).toHaveBeenCalledWith('generation_prefs_owner', [field]);
  });

  it('keeps world inheritance empty and preserves an independent legacy custom model', () => {
    const independent = normalizeWorldModelPrefs({ provider: 'qwen', model: 'custom/world' });
    expect(independent.models.qwen).toBe('custom/world');
    expect(normalizeWorldModelPrefs(independent).model).toBe('custom/world');
    expect(normalizeWorldModelPrefs({ ...independent, provider: 'inherit_vision' }).model).toBe('');
  });

  it('rejects inherited property providers and malformed legacy model values', () => {
    for (const provider of ['__proto__', 'constructor', 'toString']) {
      expect(normalizeGenerationModelPrefs({ video: { provider } }).video.provider).toBe('qwen');
    }
    expect(cleanModelName({ toString: () => 'injected' })).toBe('');
    expect(normalizeModelMap({ relay: 123, openai: '   ', qwen: ' custom ' })).toEqual({ qwen: 'custom' });
    state.settings.set('vision_prefs_owner', { provider: 'qwen', model: { arbitrary: true } });
    expect(getUserPreferredVision('owner').model).toBe('qwen-vl-max');
  });
});

describe('TTS circuit and provider selection ownership', () => {
  it('does not let an old in-flight relay failure reopen a reconfigured circuit', async () => {
    let reject!: (error: Error) => void;
    state.relay.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    const pending = synthesizeSpeech('old request', { provider: 'relay', voiceId: 'default', allowFallback: false });
    const rejected = expect(pending).rejects.toThrow('old credentials failed');
    resetCircuit('relay-tts'); reject(new Error('old credentials failed')); await rejected;
    expect(getCircuitStatus()).toEqual([]);
  });

  it('allows only one real half-open recovery request and releases an aborted permit', async () => {
    const original = acquireCircuitCall('relay-tts')!;
    recordFailure('relay-tts', undefined, new Error('down'), { openImmediately: true, cooldownMs: 0 }, original);
    let resolve!: (value: any) => void;
    state.relay.mockImplementation(() => new Promise(done => { resolve = done; }));
    const abort = new AbortController();
    const first = synthesizeSpeech('probe', { provider: 'relay', voiceId: 'default', signal: abort.signal, allowFallback: false });
    const cancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(synthesizeSpeech('parallel', { provider: 'relay', voiceId: 'default', allowFallback: false })).rejects.toThrow('temporarily unavailable');
    expect(state.relay).toHaveBeenCalledOnce();
    abort.abort(); resolve({ audioBuffer: Buffer.from('ignored'), format: 'audio/wav' }); await cancelled;
    state.relay.mockResolvedValue({ audioBuffer: Buffer.from('probe'), format: 'audio/wav' });
    await expect(synthesizeSpeech('next probe', { provider: 'relay', voiceId: 'default', allowFallback: false })).resolves.toBeTruthy();
  });

  it('keeps relay explicit, cold automatic local fallback constrained, and strict selection local', () => {
    expect(getActiveProvider({ requireWarmLocal: true })).toBeNull();
    state.tts = 'relay'; expect(getActiveProvider()).toBe('relay'); expect(getFallbackProvider('gptsovits')).toBeNull();
    state.strict = true; expect(getActiveProvider()).toBeNull();
    state.tts = 'gptsovits'; expect(getActiveProvider()).toBe('gptsovits');
    state.ready = true; expect(getFallbackProvider('relay', { requireWarmLocal: true })).toBe('gptsovits');
  });
});
