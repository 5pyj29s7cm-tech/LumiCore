import type { TTSResult, VoiceListItem } from '../types';
import {
  officialApiBinary,
  officialApiModel,
  officialApiPath,
  readOfficialApiBytes,
} from '../../llm/official_api';

const MAX_TTS_AUDIO_BYTES = 20 * 1024 * 1024;

export async function synthesizeSpeech(
  text: string,
  voiceId?: string,
  signal?: AbortSignal,
  speechRate?: number,
  _pitch?: number,
  _volume?: number,
  model?: string,
): Promise<TTSResult> {
  const resolvedModel = officialApiModel('RELAY_TTS_MODEL', model || 'tts-1');
  const requestedFormat = String(process.env.RELAY_TTS_FORMAT || 'mp3').trim().toLowerCase();
  const format = ['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm'].includes(requestedFormat) ? requestedFormat : 'mp3';
  const resolvedVoice = voiceId || process.env.RELAY_TTS_VOICE || 'alloy';
  const response = await officialApiBinary(
    officialApiPath('RELAY_TTS_PATH', '/audio/speech'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: resolvedModel,
        input: String(text || ''),
        voice: resolvedVoice,
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

export function listVoices(): VoiceListItem[] {
  return ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'].map(voiceId => ({
    voiceId,
    name: voiceId,
    category: 'premade' as const,
  }));
}
