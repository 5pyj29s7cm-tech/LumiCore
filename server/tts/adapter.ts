import { TTSConfig, TTSResult, TTSProvider, VoiceCloneRequest, VoiceCloneResult, VoiceListItem } from './types';
import * as localCosyvoice from './providers/local_cosyvoice';
import * as gptsovits from './providers/gptsovits';
import * as cosyvoice from './providers/cosyvoice';
import * as ark from './providers/ark';
import * as relay from './providers/relay';
import { getKey } from '../config/keys';
import { hasDoubaoSpeech } from './providers/ark';
import { getVoicePreference } from '../config/voice_preference';
import { acquireCircuitCall, releaseCircuitCall, isCircuitClosed, isCircuitHealthy, recordFailure, recordSuccess, type CircuitCall } from '../cloud/circuit_breaker';
import { relayConfigured } from '../relay/config';
import { isStrictPrivacy, requireNotStrict } from '../config/privacy';

/**
 * A user barge-in, call stop, or request supersession is transport control,
 * not evidence that a TTS provider is unhealthy.  Fetch implementations do
 * not always surface cancellation as the same concrete error class, so keep
 * the predicate deliberately small but accept the common wrapped variants.
 */
export function isTtsCancellationError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  let current: any = error;
  for (let depth = 0; current && depth < 4; depth++) {
    if (String(current?.name || '') === 'AbortError') return true;
    if (String(current?.code || '').toUpperCase() === 'ABORT_ERR') return true;
    current = current?.cause;
  }
  return false;
}

function circuitProvider(provider: TTSProvider): string {
  if (provider === 'ark') return 'doubao-tts';
  if (provider === 'relay') return 'relay-tts';
  return provider;
}

export async function synthesizeSpeech(text: string, config: TTSConfig): Promise<TTSResult> {
  if (config.provider !== 'local-cosyvoice' && config.provider !== 'gptsovits') {
    requireNotStrict('Cloud speech synthesis');
  }
  config.signal?.throwIfAborted();
  const circuit = circuitProvider(config.provider);
  // SDK-backed providers acquire their own lease inside withCloudResilience.
  const supervised = config.provider === 'local-cosyvoice' || config.provider === 'relay';
  let call: CircuitCall | null = null;
  try {
    if (supervised && !(call = acquireCircuitCall(circuit))) {
      throw new Error(`TTS provider ${config.provider} is temporarily unavailable`);
    }
    let result: TTSResult;
    switch (config.provider) {
      case 'local-cosyvoice':
        result = await localCosyvoice.synthesizeSpeech(text, config.voiceId, config.signal, config.speechRate, config.pitch, config.volume, config.model);
        break;
      case 'gptsovits':
        result = await gptsovits.synthesizeSpeech(text, config.voiceId, config.signal);
        break;
      case 'cosyvoice':
        result = await cosyvoice.synthesizeSpeech(text, config.voiceId, config.signal, config.speechRate, config.pitch, config.volume, config.model);
        break;
      case 'ark':
        result = await ark.synthesizeSpeech(text, config.voiceId, config.signal, config.speechRate, config.pitch, config.volume);
        break;
      case 'relay':
        result = await relay.synthesizeSpeech(
          text,
          config.voiceId,
          config.signal,
          config.speechRate,
          config.pitch,
          config.volume,
          config.model || getVoicePreference().ttsModel,
        );
        break;
      default:
        throw new Error(`Unknown TTS provider: ${config.provider}`);
    }
    config.signal?.throwIfAborted();
    if (call) recordSuccess(circuit, undefined, call);
    return result;
  } catch (error: any) {
    if (isTtsCancellationError(error, config.signal)) throw error;
    if (call) recordFailure(circuit, undefined, error, { openImmediately: true }, call);
    if (config.allowFallback !== false) {
      const fallbackProvider = getFallbackProvider(config.provider, { requireWarmLocal: true });
      if (fallbackProvider) {
        const fallbackVoiceId = await resolveProviderCompatibleFallbackVoice(
          fallbackProvider,
          config.voiceId,
        );
        return synthesizeSpeech(text, {
          ...config,
          provider: fallbackProvider,
          voiceId: fallbackVoiceId,
          model: undefined,
          allowFallback: false,
        });
      }
    }
    throw error;
  } finally {
    if (call) releaseCircuitCall(call);
  }
}

async function resolveProviderCompatibleFallbackVoice(
  provider: TTSProvider,
  requestedVoiceId: string,
): Promise<string> {
  try {
    const voices = await listVoices(provider);
    const ids = voices.map(voice => String(voice.voiceId || '').trim()).filter(Boolean);
    if (requestedVoiceId && ids.includes(requestedVoiceId)) return requestedVoiceId;
    if (ids[0]) return ids[0];
  } catch {}
  // Every provider adapter treats `default` as its own safe local default;
  // never forward a provider-qualified speaker from the failed route.
  return 'default';
}

const AUTOMATIC_TTS_PROVIDERS: readonly TTSProvider[] = ['local-cosyvoice', 'gptsovits', 'ark', 'cosyvoice'];

function isProviderAvailable(
  provider: TTSProvider,
  options: { requireHealthy?: boolean; requireWarmLocal?: boolean } = {},
): boolean {
  if (isStrictPrivacy() && provider !== 'local-cosyvoice' && provider !== 'gptsovits') return false;
  const available = options.requireHealthy ? isCircuitHealthy : isCircuitClosed;
  return isTTSProviderConfigured(provider) && available(circuitProvider(provider))
    && (provider !== 'gptsovits' || !options.requireWarmLocal || gptsovits.isReadyForAutomaticFallback());
}

export function getFallbackProvider(
  excluded: TTSProvider,
  options: { requireWarmLocal?: boolean } = {},
): TTSProvider | null {
  return AUTOMATIC_TTS_PROVIDERS.find(provider => provider !== excluded
    && isProviderAvailable(provider, { requireWarmLocal: options.requireWarmLocal || isStrictPrivacy() })) || null;
}

export async function cloneVoice(request: VoiceCloneRequest, provider: TTSProvider): Promise<VoiceCloneResult> {
  requireNotStrict('Cloud voice cloning');
  switch (provider) {
    case 'cosyvoice':
      return {
        voiceId: await cosyvoice.cloneVoice(request.sampleUrls, request.name),
        status: 'ready',
      };
    case 'ark':
      return ark.cloneVoice(request);
    default:
      throw new Error(`Voice cloning not supported for provider: ${provider}`);
  }
}

export async function getVoiceCloneStatus(
  voiceId: string,
  provider: TTSProvider,
  billingMode?: 'prepaid' | 'postpaid',
): Promise<VoiceCloneResult> {
  requireNotStrict('Cloud voice clone status');
  switch (provider) {
    case 'ark':
      return ark.getVoiceCloneStatus(voiceId, billingMode);
    default:
      return { voiceId, status: 'ready' };
  }
}

export async function designVoice(prompt: string, name: string, provider: TTSProvider = 'cosyvoice'): Promise<string> {
  requireNotStrict('Cloud voice design');
  switch (provider) {
    case 'cosyvoice':
      return cosyvoice.designVoice(prompt, name);
    default:
      throw new Error(`Voice design not supported for provider: ${provider}`);
  }
}

export async function listVoices(provider: TTSProvider): Promise<VoiceListItem[]> {
  switch (provider) {
    case 'local-cosyvoice':
      return localCosyvoice.listVoices();
    case 'cosyvoice':
      return cosyvoice.listVoices();
    case 'gptsovits':
      return gptsovits.listVoices();
    case 'ark':
      return ark.listVoices();
    case 'relay':
      return relay.listVoices();
    default:
      throw new Error(`Unknown TTS provider: ${provider}`);
  }
}

function hasDashScopeKey(): boolean {
  return Boolean(process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || getKey('DASHSCOPE_API_KEY') || getKey('QWEN_API_KEY'));
}

export function isTTSProviderConfigured(provider: TTSProvider): boolean {
  switch (provider) {
    case 'local-cosyvoice':
      return localCosyvoice.isConfigured();
    case 'gptsovits':
      return gptsovits.isConfigured();
    case 'cosyvoice':
      return hasDashScopeKey();
    case 'ark':
      return hasDoubaoSpeech();
    case 'relay':
      return relayConfigured();
    default:
      return false;
  }
}

export function getActiveProvider(options: { requireHealthy?: boolean; requireWarmLocal?: boolean } = {}): TTSProvider | null {
  const preferred = getVoicePreference().tts;
  if (preferred !== 'auto' && isProviderAvailable(preferred, options)) return preferred;
  // The official gateway remains an explicit selection, never an auto fallback.
  return AUTOMATIC_TTS_PROVIDERS.find(provider => isProviderAvailable(provider, {
    ...options, requireWarmLocal: options.requireWarmLocal || isStrictPrivacy(),
  })) || null;
}

/**
 * Map emotional state to speech parameters (speed/pitch/volume) while
 * preserving the user's chosen voiceId. Emotion should change HOW the
 * voice speaks, not WHO is speaking.
 */
export function resolveEmotionVoice(defaultVoiceId: string, emotionalState?: {
  dominantMood?: string;
  arousal?: number;
  valence?: number;
  energy?: number;
}): { voiceId: string; speechRate?: number; pitch?: number; volume?: number } {
  if (!emotionalState) return { voiceId: defaultVoiceId };

  const { dominantMood, arousal = 0.5, valence = 0 } = emotionalState;

  // Mood → speech parameters only (voiceId stays as user selected)
  if (dominantMood) {
    switch (dominantMood) {
      case 'excited':  return { voiceId: defaultVoiceId, speechRate: 1.15, pitch: 1.05 };
      case 'playful':  return { voiceId: defaultVoiceId, speechRate: 1.10, pitch: 1.03 };
      case 'tired':    return { voiceId: defaultVoiceId, speechRate: 0.85, pitch: 0.95 };
      case 'sad':      return { voiceId: defaultVoiceId, speechRate: 0.90, pitch: 0.90, volume: 0.85 };
      case 'calm':     return { voiceId: defaultVoiceId, speechRate: 0.95 };
      case 'focused':  return { voiceId: defaultVoiceId, speechRate: 1.05 };
      case 'warm':
      case 'affectionate':
      case 'contemplative':
      case 'curious':
        return { voiceId: defaultVoiceId };
    }
  }

  // Fallback: arousal + valence → speech parameters
  if (arousal > 0.7 && valence > 0.3)  return { voiceId: defaultVoiceId, speechRate: 1.10, pitch: 1.03 };
  if (arousal > 0.7 && valence < -0.2) return { voiceId: defaultVoiceId, speechRate: 1.12, pitch: 1.05 };
  if (arousal < 0.3 && valence > 0.2)  return { voiceId: defaultVoiceId, speechRate: 0.92 };
  if (arousal < 0.3 && valence < -0.2) return { voiceId: defaultVoiceId, speechRate: 0.88, volume: 0.85 };

  return { voiceId: defaultVoiceId };
}
