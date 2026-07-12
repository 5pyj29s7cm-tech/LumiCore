import { TTSResult, VoiceListItem } from '../types';
import { getKey } from '../../config/keys';
import { withCloudResilience } from '../../cloud/resilience';

const BASE_URL = 'https://openspeech.bytedance.com/api/v1/tts';

function getCredentials(): { appId: string; token: string } {
  const raw = process.env.DOUBAO_SPEECH_KEY || getKey('DOUBAO_SPEECH_KEY') || '';
  const colonIdx = raw.indexOf(':');
  if (colonIdx === -1) throw new Error('Doubao Speech not configured. Enter AppID:AccessToken in Settings → Voice Services.');
  return { appId: raw.slice(0, colonIdx).trim(), token: raw.slice(colonIdx + 1).trim() };
}

export function hasDoubaoSpeech(): boolean {
  const raw = process.env.DOUBAO_SPEECH_KEY || getKey('DOUBAO_SPEECH_KEY') || '';
  return raw.includes(':');
}

const PRESET_VOICES: VoiceListItem[] = [
  { voiceId: 'BV001_streaming', name: '通用女声', category: 'premade', language: 'zh' },
  { voiceId: 'BV002_streaming', name: '通用男声', category: 'premade', language: 'zh' },
  { voiceId: 'BV003_streaming', name: '温柔女声', category: 'premade', language: 'zh' },
  { voiceId: 'BV004_streaming', name: '知性女声', category: 'premade', language: 'zh' },
  { voiceId: 'BV005_streaming', name: '清新女声', category: 'premade', language: 'zh' },
  { voiceId: 'BV006_streaming', name: '沉稳男声', category: 'premade', language: 'zh' },
];

export async function synthesizeSpeech(
  text: string,
  voiceId: string = 'BV001_streaming',
  signal?: AbortSignal,
  speechRate?: number,
  pitch?: number,
  volume?: number,
): Promise<TTSResult> {
  const { appId, token } = getCredentials();

  const body: Record<string, any> = {
    app: { appid: appId, cluster: 'volcano_tts' },
    user: { uid: 'lumi_user' },
    audio: {
      voice_type: voiceId,
      encoding: 'mp3',
      rate: 24000,
    },
    request: {
      reqid: `lumi_${Date.now()}`,
      text,
      text_type: 'plain',
      operation: 'query',
    },
  };
  if (speechRate !== undefined) body.audio.speed_ratio = speechRate;
  if (pitch !== undefined) body.audio.pitch_ratio = pitch;
  if (volume !== undefined) body.audio.volume_ratio = volume;

  const json = await withCloudResilience(
    async () => {
      const res = await fetch(BASE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer;${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(`Doubao TTS error (${res.status}): ${err.message || err.code || 'Unknown'}`);
      }
      const payload = await res.json() as any;
      if (payload.code !== 3000) {
        throw new Error(`Doubao TTS error: ${payload.message || JSON.stringify(payload)}`);
      }
      if (!(payload.data || payload.audio?.data)) {
        throw new Error(`Doubao TTS response missing audio data: ${JSON.stringify(payload)}`);
      }
      return payload;
    },
    { provider: 'doubao-tts', maxRetries: 1 },
  );

  const audioData = json.data || json.audio?.data;

  return {
    audioBuffer: Buffer.from(audioData, 'base64'),
    format: 'audio/mp3',
  };
}

export async function listVoices(): Promise<VoiceListItem[]> {
  return PRESET_VOICES;
}
