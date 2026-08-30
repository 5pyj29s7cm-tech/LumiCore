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
    : process.env.RELAY_TTS_VOICE || 'longxiaochun_v3';
  const voice = shouldSendRelayTtsVoice(resolvedModel) ? { voice: resolvedVoice } : {};
  const response = await officialApiBinary(
    officialApiPath('RELAY_TTS_PATH', '/audio/speech'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: resolvedModel,
        input: String(text || ''),
        ...voice,
        response_format: format,
        ...(speechRate !== undefined ? { speed: speechRate } : {}),
      }),
      signal,
      timeoutMs: 90_000,
    },
  );
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
