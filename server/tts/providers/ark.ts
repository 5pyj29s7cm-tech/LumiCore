import { randomUUID } from 'crypto';
import { TTSResult, VoiceListItem } from '../types';
import { withCloudResilience } from '../../cloud/resilience';
import {
  getDoubaoSpeechCredentials,
  getDoubaoTtsResourceId,
  hasDoubaoSpeechCredentials,
  normalizeDoubaoVoiceId,
  ratioToDoubaoRate,
  requireDoubaoSpeechCredentials,
  type DoubaoSpeechCredentials,
} from '../../config/doubao_speech';

const API_KEY_BASE_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

export function hasDoubaoSpeech(): boolean {
  return hasDoubaoSpeechCredentials();
}

const PRESET_VOICES: VoiceListItem[] = [
  { voiceId: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0', category: 'premade', language: 'zh', model: 'seed-tts-2.0' },
  { voiceId: 'zh_male_dayi_uranus_bigtts', name: 'Dayi 2.0', category: 'premade', language: 'zh', model: 'seed-tts-2.0' },
  { voiceId: 'BV001_streaming', name: 'General female', category: 'premade', language: 'zh', model: 'seed-tts-1.0' },
  { voiceId: 'BV002_streaming', name: 'General male', category: 'premade', language: 'zh', model: 'seed-tts-1.0' },
  { voiceId: 'BV003_streaming', name: 'Gentle female', category: 'premade', language: 'zh', model: 'seed-tts-1.0' },
  { voiceId: 'BV004_streaming', name: 'Intellectual female', category: 'premade', language: 'zh', model: 'seed-tts-1.0' },
  { voiceId: 'BV005_streaming', name: 'Fresh female', category: 'premade', language: 'zh', model: 'seed-tts-1.0' },
  { voiceId: 'BV006_streaming', name: 'Steady male', category: 'premade', language: 'zh', model: 'seed-tts-1.0' },
];

function pitchRatioToRate(value: number | undefined): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.round(Math.max(-12, Math.min(12, (Number(value) - 1) * 12)));
}

function extractJsonObjects(text: string): any[] {
  const objects: any[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start < 0) {
      if (char === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    if (depth === 0) {
      objects.push(JSON.parse(text.slice(start, index + 1)));
      start = -1;
    }
  }

  if (start >= 0) throw new Error('Doubao TTS returned an incomplete JSON stream');
  return objects;
}

function responseError(prefix: string, response: Response, payload?: any): Error {
  const code = payload?.code ?? response.status;
  const message = response.headers.get('X-Api-Message')
    || payload?.message
    || payload?.error
    || response.statusText
    || 'Unknown error';
  const logId = response.headers.get('X-Tt-Logid');
  return new Error(`${prefix} (${code}): ${message}${logId ? ` [logid=${logId}]` : ''}`);
}

async function synthesizeWithApiKey(
  text: string,
  credentials: DoubaoSpeechCredentials,
  voiceId: string,
  signal: AbortSignal | undefined,
  speechRate: number | undefined,
  pitch: number | undefined,
  volume: number | undefined,
  fetchImpl: typeof fetch,
): Promise<TTSResult> {
  const speaker = normalizeDoubaoVoiceId(voiceId);
  const resourceId = getDoubaoTtsResourceId(speaker);
  const audioParams: Record<string, unknown> = {
    format: 'mp3',
    sample_rate: 24_000,
  };
  const normalizedSpeechRate = ratioToDoubaoRate(speechRate);
  const normalizedPitch = pitchRatioToRate(pitch);
  const normalizedVolume = ratioToDoubaoRate(volume);
  if (normalizedSpeechRate !== undefined) audioParams.speech_rate = normalizedSpeechRate;
  if (normalizedPitch !== undefined) audioParams.pitch_rate = normalizedPitch;
  if (normalizedVolume !== undefined) audioParams.loudness_rate = normalizedVolume;

  const response = await fetchImpl(process.env.DOUBAO_TTS_V3_URL || API_KEY_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': credentials.apiKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': randomUUID(),
      'X-Control-Require-Usage-Tokens-Return': 'text_words',
    },
    body: JSON.stringify({
      user: { uid: 'lumi_user' },
      req_params: {
        text,
        speaker,
        audio_params: audioParams,
      },
    }),
    signal,
  });

  const contentType = response.headers.get('content-type') || '';
  if (contentType.startsWith('audio/')) {
    if (!response.ok) throw responseError('Doubao TTS error', response);
    const audioBuffer = Buffer.from(await response.arrayBuffer());
    if (audioBuffer.length === 0) throw new Error('Doubao TTS returned an empty audio stream');
    return { audioBuffer, format: contentType.split(';')[0] || 'audio/mp3' };
  }

  const responseText = await response.text();
  let events: any[];
  try {
    events = extractJsonObjects(responseText);
  } catch (error: any) {
    if (!response.ok) throw responseError('Doubao TTS error', response);
    throw new Error(`Doubao TTS response could not be parsed: ${error?.message || error}`);
  }
  const failure = events.find(event => event?.code !== undefined && ![0, 20000000].includes(Number(event.code)));
  if (!response.ok || failure) throw responseError('Doubao TTS error', response, failure);
  const chunks = events
    .map(event => typeof event?.data === 'string' && event.data ? Buffer.from(event.data, 'base64') : null)
    .filter((chunk): chunk is Buffer => Boolean(chunk?.length));
  if (chunks.length === 0) throw new Error('Doubao TTS response did not contain audio data');
  return { audioBuffer: Buffer.concat(chunks), format: 'audio/mp3' };
}

export async function synthesizeSpeech(
  text: string,
  voiceId: string = '',
  signal?: AbortSignal,
  speechRate?: number,
  pitch?: number,
  volume?: number,
  fetchImpl: typeof fetch = fetch,
): Promise<TTSResult> {
  const credentials = requireDoubaoSpeechCredentials();
  return withCloudResilience(
    () => synthesizeWithApiKey(text, credentials, voiceId, signal, speechRate, pitch, volume, fetchImpl),
    { provider: 'doubao-tts', maxRetries: 1 },
  );
}

export async function listVoices(): Promise<VoiceListItem[]> {
  return PRESET_VOICES;
}

export function getConfiguredDoubaoTtsDetails(): {
  credentialMode: 'api-key' | null;
  voiceId: string | null;
  resourceId: string | null;
  endpoint: string | null;
} {
  const credentials = getDoubaoSpeechCredentials();
  if (!credentials) return { credentialMode: null, voiceId: null, resourceId: null, endpoint: null };
  const voiceId = normalizeDoubaoVoiceId('');
  return {
    credentialMode: credentials.mode,
    voiceId,
    resourceId: getDoubaoTtsResourceId(voiceId),
    endpoint: process.env.DOUBAO_TTS_V3_URL || API_KEY_BASE_URL,
  };
}
