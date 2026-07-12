import { TTSConfig, TTSResult, TTSProvider, VoiceCloneRequest, VoiceListItem } from './types';
import * as localCosyvoice from './providers/local_cosyvoice';
import * as gptsovits from './providers/gptsovits';
import * as cosyvoice from './providers/cosyvoice';
import * as ark from './providers/ark';
import { getKey } from '../config/keys';
import { hasDoubaoSpeech } from './providers/ark';
import { getVoicePreference } from '../config/voice_preference';
import { isCircuitClosed, isCircuitHealthy, recordFailure, recordSuccess } from '../cloud/circuit_breaker';

function circuitProvider(provider: TTSProvider): string {
  return provider === 'ark' ? 'doubao-tts' : provider;
}

export async function synthesizeSpeech(text: string, config: TTSConfig): Promise<TTSResult> {
  const circuit = circuitProvider(config.provider);
  try {
    if (!isCircuitClosed(circuit)) {
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
      default:
        throw new Error(`Unknown TTS provider: ${config.provider}`);
    }
    if (config.provider === 'local-cosyvoice') recordSuccess(circuit);
    return result;
  } catch (error: any) {
    recordFailure(circuit, undefined, error instanceof Error ? error : new Error(String(error)), { openImmediately: true });
    if (config.allowFallback !== false) {
      const fallbackProvider = getActiveProvider();
      if (fallbackProvider && fallbackProvider !== config.provider) {
        return synthesizeSpeech(text, {
          ...config,
          provider: fallbackProvider,
          allowFallback: false,
        });
      }
    }
    throw error;
  }
}

export async function cloneVoice(request: VoiceCloneRequest, provider: TTSProvider): Promise<string> {
  switch (provider) {
    case 'cosyvoice':
      return cosyvoice.cloneVoice(request.sampleUrls, request.name);
    default:
      throw new Error(`Voice cloning not supported for provider: ${provider}`);
  }
}

export async function designVoice(prompt: string, name: string, provider: TTSProvider = 'cosyvoice'): Promise<string> {
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
    default:
      return false;
  }
}

export function getActiveProvider(options: { requireHealthy?: boolean } = {}): TTSProvider | null {
  const pref = getVoicePreference();
  const available = options.requireHealthy ? isCircuitHealthy : isCircuitClosed;
  if (pref.tts === 'local-cosyvoice' && localCosyvoice.isConfigured() && available('local-cosyvoice')) return 'local-cosyvoice';
  if (pref.tts === 'gptsovits' && gptsovits.isConfigured() && available('gptsovits')) return 'gptsovits';
  if (pref.tts === 'cosyvoice' && hasDashScopeKey() && available('cosyvoice')) return 'cosyvoice';
  if (pref.tts === 'ark' && hasDoubaoSpeech() && available('doubao-tts')) return 'ark';
  // Auto mode and unavailable explicit selections — prefer local, then healthy cloud.
  if (localCosyvoice.isConfigured() && available('local-cosyvoice')) return 'local-cosyvoice';
  if (gptsovits.isConfigured() && available('gptsovits')) return 'gptsovits';
  if (hasDoubaoSpeech() && available('doubao-tts')) return 'ark';
  const dashscopeKey = hasDashScopeKey();
  if (dashscopeKey && available('cosyvoice')) return 'cosyvoice';
  return null;
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

  const { dominantMood, arousal = 0.5, valence = 0, energy = 0.5 } = emotionalState;

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
