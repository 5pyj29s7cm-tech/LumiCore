import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { TTSResult, VoiceCloneRequest, VoiceCloneResult, VoiceCloneStatus, VoiceListItem } from '../types';
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
const VOICE_CLONE_URL = 'https://openspeech.bytedance.com/api/v3/tts/voice_clone';
const VOICE_CLONE_STATUS_URL = 'https://openspeech.bytedance.com/api/v3/tts/get_voice';

export function hasDoubaoSpeech(): boolean {
  return hasDoubaoSpeechCredentials();
}

const PRESET_VOICES: VoiceListItem[] = [
  { voiceId: 'zh_female_vv_uranus_bigtts', name: 'Vivi 2.0 · 灵动女声', category: 'premade', language: 'zh', model: 'seed-tts-2.0' },
  { voiceId: 'zh_male_dayi_uranus_bigtts', name: '大壹 2.0 · 清晰男声', category: 'premade', language: 'zh', model: 'seed-tts-2.0' },
  { voiceId: 'zh_male_dayi_saturn_bigtts', name: '大壹 · 视频配音', category: 'premade', language: 'zh', model: 'seed-tts-2.0' },
  { voiceId: 'zh_female_mizai_saturn_bigtts', name: '咪仔 · 活泼女声', category: 'premade', language: 'zh', model: 'seed-tts-2.0' },
  { voiceId: 'zh_female_jitangnv_saturn_bigtts', name: '鸡汤女 · 温暖叙述', category: 'premade', language: 'zh', model: 'seed-tts-2.0' },
  { voiceId: 'zh_female_meilinvyou_saturn_bigtts', name: '魅力女友 · 亲切女声', category: 'premade', language: 'zh', model: 'seed-tts-2.0' },
  { voiceId: 'zh_female_santongyongns_saturn_bigtts', name: '流畅女声 · 通用播报', category: 'premade', language: 'zh', model: 'seed-tts-2.0' },
  { voiceId: 'zh_male_ruyayichen_saturn_bigtts', name: '儒雅逸辰 · 沉稳男声', category: 'premade', language: 'zh', model: 'seed-tts-2.0' },
  { voiceId: 'ICL_zh_female_keainvsheng_tob', name: '可爱女生 · 角色音色', category: 'premade', language: 'zh', model: 'seed-tts-2.0' },
  { voiceId: 'ICL_zh_female_tiaopigongzhu_tob', name: '调皮公主 · 角色音色', category: 'premade', language: 'zh', model: 'seed-tts-2.0' },
  { voiceId: 'zh_female_xueayi_saturn_bigtts', name: '儿童绘本 · 有声阅读', category: 'premade', language: 'zh', model: 'seed-tts-2.0' },
  { voiceId: 'zh_female_tianmeitaozi_mars_bigtts', name: '甜美桃子 · 甜美女声', category: 'premade', language: 'zh', model: 'seed-tts-2.0' },
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

function doubaoCloneStatus(value: unknown): VoiceCloneStatus {
  switch (Number(value)) {
    case 0: return 'not_found';
    case 1: return 'training';
    case 2:
    case 4: return 'ready';
    case 3: return 'failed';
    default: return 'training';
  }
}

function cloneError(prefix: string, response: Response, payload?: any): Error {
  const code = payload?.code ?? response.status;
  const message = response.headers.get('X-Api-Message')
    || payload?.message
    || response.statusText
    || 'Unknown error';
  const logId = response.headers.get('X-Tt-Logid');
  return new Error(`${prefix} (${code}): ${message}${logId ? ` [logid=${logId}]` : ''}`);
}

function normalizeClonePayload(
  payload: any,
  requestedVoiceId: string,
  billingMode: 'prepaid' | 'postpaid',
): VoiceCloneResult {
  const speakerStatus = Array.isArray(payload?.speaker_status) ? payload.speaker_status : [];
  const clone2 = speakerStatus.find((entry: any) => Number(entry?.model_type) === 5) || speakerStatus[0];
  return {
    voiceId: String(payload?.speaker_id || requestedVoiceId),
    status: doubaoCloneStatus(payload?.status),
    model: 'seed-icl-2.0',
    demoAudio: typeof clone2?.demo_audio === 'string' ? clone2.demo_audio : undefined,
    availableTrainingTimes: Number.isFinite(Number(payload?.available_training_times))
      ? Number(payload.available_training_times)
      : undefined,
    createdAt: Number.isFinite(Number(payload?.create_time)) ? Number(payload.create_time) : undefined,
    message: typeof payload?.message === 'string' ? payload.message : undefined,
    billingMode,
  };
}

function customSpeakerId(): string {
  return `lumi_voice_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

function cloneSpeakerBody(voiceId: string, billingMode: 'prepaid' | 'postpaid'): Record<string, string> {
  return billingMode === 'postpaid'
    ? { speaker_id: 'custom_speaker_id', custom_speaker_id: voiceId }
    : { speaker_id: voiceId };
}

async function postCloneApi(
  endpoint: string,
  body: Record<string, unknown>,
  credentials: DoubaoSpeechCredentials,
  fetchImpl: typeof fetch,
): Promise<{ response: Response; payload: any }> {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': credentials.apiKey,
      'X-Api-Request-Id': randomUUID(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const payload = await response.json().catch(() => null);
  const businessCode = Number(payload?.code ?? 0);
  if (!response.ok || (businessCode !== 0 && businessCode !== 20_000_000)) {
    throw cloneError('Doubao voice clone error', response, payload);
  }
  return { response, payload };
}

export async function getVoiceCloneStatus(
  voiceId: string,
  billingMode: 'prepaid' | 'postpaid' = /^S_/i.test(voiceId) ? 'prepaid' : 'postpaid',
  fetchImpl: typeof fetch = fetch,
): Promise<VoiceCloneResult> {
  const credentials = requireDoubaoSpeechCredentials();
  const { payload } = await postCloneApi(
    process.env.DOUBAO_VOICE_CLONE_STATUS_URL || VOICE_CLONE_STATUS_URL,
    cloneSpeakerBody(voiceId, billingMode),
    credentials,
    fetchImpl,
  );
  return normalizeClonePayload(payload, voiceId, billingMode);
}

export async function cloneVoice(
  request: VoiceCloneRequest,
  fetchImpl: typeof fetch = fetch,
  polling: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<VoiceCloneResult> {
  const credentials = requireDoubaoSpeechCredentials();
  const samplePath = String(request.sampleUrls?.[0] || '').trim();
  if (!samplePath || !fs.existsSync(samplePath)) {
    throw new Error('Doubao voice cloning requires a prepared local audio sample');
  }

  const existingSpeakerId = String(request.speakerId || '').trim();
  const billingMode: 'prepaid' | 'postpaid' = existingSpeakerId ? 'prepaid' : 'postpaid';
  const voiceId = existingSpeakerId || String(request.customSpeakerId || customSpeakerId()).trim();
  const format = path.extname(samplePath).replace(/^\./, '').toLowerCase() || 'wav';
  const body: Record<string, unknown> = {
    ...cloneSpeakerBody(voiceId, billingMode),
    audio: {
      data: fs.readFileSync(samplePath).toString('base64'),
      format,
    },
    language: Number.isFinite(Number(request.language)) ? Number(request.language) : 0,
  };
  if (request.sampleText?.trim()) body.text = request.sampleText.trim();
  const extraParams: Record<string, unknown> = {};
  if (request.demoText?.trim()) extraParams.demo_text = request.demoText.trim();
  if (typeof request.enableAudioDenoise === 'boolean') extraParams.enable_audio_denoise = request.enableAudioDenoise;
  if (typeof request.disableVolumeNormalization === 'boolean') {
    extraParams.disable_volume_normalization = request.disableVolumeNormalization;
  }
  if (Object.keys(extraParams).length > 0) body.extra_params = extraParams;

  let uploaded: VoiceCloneResult;
  try {
    const { payload } = await postCloneApi(
      process.env.DOUBAO_VOICE_CLONE_URL || VOICE_CLONE_URL,
      body,
      credentials,
      fetchImpl,
    );
    uploaded = normalizeClonePayload(payload, voiceId, billingMode);
  } catch (error) {
    // Mutating requests are never resent blindly. Query the immutable speaker ID once instead.
    try {
      const recovered = await getVoiceCloneStatus(voiceId, billingMode, fetchImpl);
      if (recovered.status !== 'not_found') return recovered;
    } catch {}
    throw error;
  }

  if (uploaded.status === 'ready' || uploaded.status === 'failed') return uploaded;
  const intervalMs = Math.max(0, polling.intervalMs ?? Number(process.env.DOUBAO_VOICE_CLONE_POLL_MS || 1500));
  const timeoutMs = Math.max(0, polling.timeoutMs ?? Number(process.env.DOUBAO_VOICE_CLONE_TIMEOUT_MS || 30_000));
  const deadline = Date.now() + timeoutMs;
  let latest = uploaded;
  while (Date.now() < deadline) {
    if (intervalMs > 0) await new Promise(resolve => setTimeout(resolve, intervalMs));
    latest = await getVoiceCloneStatus(voiceId, billingMode, fetchImpl);
    if (latest.status === 'ready' || latest.status === 'failed') return latest;
  }
  return latest;
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
