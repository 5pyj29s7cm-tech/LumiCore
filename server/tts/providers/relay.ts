import type { TTSResult, VoiceListItem } from '../types';
import {
  officialApiBinary,
  officialApiModel,
  officialApiPath,
  readOfficialApiBytes,
} from '../../llm/official_api';
import { normalizeLumiOfficialModel } from '../../../shared/model_provider_capabilities';
import { listVoices as listCosyVoiceVoices } from './cosyvoice';

const MAX_TTS_AUDIO_BYTES = 20 * 1024 * 1024;
const DEFAULT_RELAY_TTS_VOICE = 'longxiaochun_v3';

/**
 * The official gateway maps several TTS model families onto one endpoint,
 * but they do not all accept the OpenAI `voice` field.  Keep the known
 * voice-less models explicit so a newly-added model continues to receive the
 * legacy voice behavior until its request contract is verified.
 */
const RELAY_TTS_MODELS_WITHOUT_VOICE = new Set([
  'cosyvoice-v3-plus',
  'qwen-audio-3.0-tts-plus',
]);

/** Return whether the relay TTS request should include its optional voice. */
export function shouldSendRelayTtsVoice(model: string): boolean {
  const modelName = String(model || '').trim().toLowerCase().split('/').pop() || '';
  return !RELAY_TTS_MODELS_WITHOUT_VOICE.has(modelName);
}

/**
 * CosyVoice reports an unsupported/stale voice as HTTP 400 with engine code
 * 418.  Voice ids are persisted in the client and can outlive a provider
 * switch (for example an old OpenAI `alloy` id), so a single stale selection
 * must not turn the whole official TTS circuit into an outage.  Keep this
 * predicate deliberately narrow: model/auth/rate-limit failures should still
 * reach the normal circuit breaker unchanged.
 */
export function isRelayVoiceCompatibilityError(error: unknown): boolean {
  const message = String((error as any)?.message || error || '');
  // The official CosyVoice gateway currently uses engine code 418 for an
  // unknown/stale speaker id. Keep the fallback narrow: a generic error that
  // happens to mention “voice” must not be retried with another speaker, since
  // auth, model, quota, and network failures need to reach the normal breaker.
  if (/(?:engine\s+return\s+error\s+code\s*:\s*418|error\s+code\s*:?\s*418)/i.test(message)) return true;
  return /(?:unsupported|invalid|unknown|not\s+found|does\s+not\s+exist)[^\n]{0,48}(?:voice|speaker)/i.test(message)
    || /(?:voice|speaker)[^\n]{0,48}(?:unsupported|invalid|unknown|not\s+found|does\s+not\s+exist)/i.test(message);
}

function safeVoiceForLog(value: string): string {
  return String(value || '').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80) || 'unknown';
}

export async function synthesizeSpeech(
  text: string,
  voiceId?: string,
  signal?: AbortSignal,
  speechRate?: number,
  _pitch?: number,
  _volume?: number,
  model?: string,
): Promise<TTSResult> {
  // An explicit role selection is snapshotted by the adapter; env config is
  // only the fallback for legacy installs without a persisted model choice.
  const resolvedModel = normalizeLumiOfficialModel(
    'speech_synthesis',
    String(model || officialApiModel('RELAY_TTS_MODEL', 'aliyun/cosyvoice-v3-flash')).trim()
      || 'aliyun/cosyvoice-v3-flash',
  );
  const requestedFormat = String(process.env.RELAY_TTS_FORMAT || 'mp3').trim().toLowerCase();
  const format = ['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm'].includes(requestedFormat) ? requestedFormat : 'mp3';
  const resolvedVoice = voiceId && voiceId !== 'default'
    ? voiceId
    : process.env.RELAY_TTS_VOICE || DEFAULT_RELAY_TTS_VOICE;
  const endpoint = officialApiPath('RELAY_TTS_PATH', '/audio/speech');
  const send = (voiceOverride: string, includeSpeed: boolean) => {
    const voice = shouldSendRelayTtsVoice(resolvedModel) ? { voice: voiceOverride } : {};
    return officialApiBinary(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: resolvedModel,
        input: String(text || ''),
        ...voice,
        response_format: format,
        ...(includeSpeed && speechRate !== undefined ? { speed: speechRate } : {}),
      }),
      signal,
      timeoutMs: 90_000,
    });
  };

  let response: Response;
  try {
    response = await send(resolvedVoice, true);
  } catch (error) {
    // Retry one time with a known compatible voice. This is intentionally
    // inside the provider adapter, before the shared circuit records a
    // failure, so a stale client selection cannot silence later turns.
    if (
      shouldSendRelayTtsVoice(resolvedModel)
      && resolvedVoice !== DEFAULT_RELAY_TTS_VOICE
      && !signal?.aborted
      && isRelayVoiceCompatibilityError(error)
    ) {
      console.warn(
        `[Lumi Official TTS] rejected voice ${safeVoiceForLog(resolvedVoice)}; retrying ${DEFAULT_RELAY_TTS_VOICE}`,
      );
      response = await send(DEFAULT_RELAY_TTS_VOICE, false);
    } else {
      throw error;
    }
  }
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (contentType.includes('application/json') || contentType.includes('text/')) {
    throw new Error('Lumi Official API TTS returned a non-audio response.');
  }
  const audioBuffer = await readOfficialApiBytes(response, MAX_TTS_AUDIO_BYTES);
  if (audioBuffer.length === 0) throw new Error('Lumi Official API TTS returned an empty audio response.');
  const prefix = audioBuffer.subarray(0, 16).toString('ascii');
  if (/^\s*[\[{]/.test(prefix)) throw new Error('Lumi Official API TTS returned JSON instead of audio.');
  return { audioBuffer, format: `audio/${format}` };
}

export async function listVoices(): Promise<VoiceListItem[]> {
  return listCosyVoiceVoices();
}
