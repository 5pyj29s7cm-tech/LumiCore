import fs from 'fs';
import { TTSResult, VoiceListItem } from '../types';
import { getKey } from '../../config/keys';
import { withCloudResilience } from '../../cloud/resilience';
import { readDB } from '../../../db_layer';

const BASE_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
const CUSTOMIZATION_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization';
const DEFAULT_COSYVOICE_TTS_MODEL = 'cosyvoice-v3-flash';
const DEFAULT_COSYVOICE_CLONE_TARGET_MODEL = 'cosyvoice-v3-flash';
const DEFAULT_QWEN_CLONE_TARGET_MODEL = 'qwen3-tts-vc-2026-01-22';
const DEFAULT_QWEN_DESIGN_TARGET_MODEL = 'qwen3-tts-vd-realtime-2026-01-22';

function getCosyVoiceModel(): string {
  return process.env.COSYVOICE_MODEL || DEFAULT_COSYVOICE_TTS_MODEL;
}

export function getCosyVoiceCloneTargetModel(): string {
  return process.env.COSYVOICE_TARGET_MODEL || process.env.COSYVOICE_CLONE_TARGET_MODEL || DEFAULT_COSYVOICE_CLONE_TARGET_MODEL;
}

export function getQwenCloneTargetModel(): string {
  return process.env.QWEN_VOICE_CLONE_TARGET_MODEL || DEFAULT_QWEN_CLONE_TARGET_MODEL;
}

export function getQwenDesignTargetModel(): string {
  return process.env.QWEN_VOICE_DESIGN_TARGET_MODEL || DEFAULT_QWEN_DESIGN_TARGET_MODEL;
}

export function defaultInstalledCloneMode(): 'data-url' {
  return 'data-url';
}

function getApiKey(): string {
  const key = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || getKey('DASHSCOPE_API_KEY') || getKey('QWEN_API_KEY');
  if (!key) throw new Error('DASHSCOPE_API_KEY is not configured. Add it in Settings > Voice Services.');
  return key;
}

const PRESET_VOICES: VoiceListItem[] = [
  { voiceId: 'longxiaochun_v3', name: 'Long Xiaochun - bright female', category: 'premade', language: 'zh' },
  { voiceId: 'longxiaoxia_v3', name: 'Long Xiaoxia - calm female', category: 'premade', language: 'zh' },
  { voiceId: 'longyumi_v3', name: 'YUMI - youthful female', category: 'premade', language: 'zh' },
  { voiceId: 'longanyun_v3', name: 'Long Anyun - warm male', category: 'premade', language: 'zh' },
  { voiceId: 'longanwen_v3', name: 'Long Anwen - elegant female', category: 'premade', language: 'zh' },
  { voiceId: 'longanli_v3', name: 'Long Anli - composed female', category: 'premade', language: 'zh' },
  { voiceId: 'longanlang_v3', name: 'Long Anlang - clear male', category: 'premade', language: 'zh' },
  { voiceId: 'longyingmu_v3', name: 'Long Yingmu - refined female', category: 'premade', language: 'zh' },
  { voiceId: 'longanyang', name: 'Long Anyang - sunny male', category: 'premade', language: 'zh' },
  { voiceId: 'longanhuan', name: 'Long Anhuan - upbeat female', category: 'premade', language: 'zh' },
  { voiceId: 'longhua_v3', name: 'Long Hua - sweet female', category: 'premade', language: 'zh' },
  { voiceId: 'longcheng_v3', name: 'Long Cheng - smart male', category: 'premade', language: 'zh' },
  { voiceId: 'longze_v3', name: 'Long Ze - warm male', category: 'premade', language: 'zh' },
  { voiceId: 'longxing_v3', name: 'Long Xing - gentle female', category: 'premade', language: 'zh' },
  { voiceId: 'longtian_v3', name: 'Long Tian - rational male', category: 'premade', language: 'zh' },
  { voiceId: 'longwan_v3', name: 'Long Wan - soft female', category: 'premade', language: 'zh' },
  { voiceId: 'longanya_v3', name: 'Long Anya - graceful female', category: 'premade', language: 'zh' },
  { voiceId: 'longanqin_v3', name: 'Long Anqin - friendly female', category: 'premade', language: 'zh' },
  { voiceId: 'longanrou_v3', name: 'Long Anrou - tender female', category: 'premade', language: 'zh' },
  { voiceId: 'longhan_v3', name: 'Long Han - affectionate male', category: 'premade', language: 'zh' },
  { voiceId: 'loongkyong_v3', name: 'Kyong - Korean female', category: 'premade', language: 'ko' },
  { voiceId: 'loongriko_v3', name: 'Riko - Japanese female', category: 'premade', language: 'ja' },
  { voiceId: 'loongtomoka_v3', name: 'Tomoka - Japanese female', category: 'premade', language: 'ja' },
  { voiceId: 'longjiaxin_v3', name: 'Long Jiaxin - Cantonese female', category: 'premade', language: 'yue' },
  { voiceId: 'longlaotie_v3', name: 'Long Laotie - Northeastern male', category: 'premade', language: 'zh' },
];

export async function synthesizeSpeech(
  text: string,
  voiceId: string = 'longxiaochun_v3',
  signal?: AbortSignal,
  speechRate?: number,
  pitch?: number,
  volume?: number,
  model?: string,
): Promise<TTSResult> {
  const apiKey = getApiKey();
  const resolvedModel = model || resolveVoiceModel(voiceId) || getCosyVoiceModel();

  const input: Record<string, any> = {
    text,
    voice: voiceId,
    format: 'mp3',
    sample_rate: 22050,
  };
  if (speechRate !== undefined) input.speech_rate = speechRate;
  if (pitch !== undefined) input.pitch = pitch;
  if (volume !== undefined) input.volume = volume;

  const body = { model: resolvedModel, input };

  const res = await withCloudResilience(
    () => fetch(BASE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    }),
    { provider: 'cosyvoice', maxRetries: 1 },
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(`CosyVoice TTS error (${res.status}): ${err.message || err.code || 'Unknown'}`);
  }

  const json = await res.json();
  const audioUrl = json.output?.audio?.url;
  if (!audioUrl) {
    throw new Error(`CosyVoice response missing audio URL: ${JSON.stringify(json)}`);
  }

  const audioRes = await fetch(audioUrl, { signal });
  if (!audioRes.ok) {
    throw new Error(`CosyVoice audio download failed (${audioRes.status})`);
  }

  const arrayBuffer = await audioRes.arrayBuffer();
  return {
    audioBuffer: Buffer.from(arrayBuffer),
    format: 'audio/mp3',
  };
}

export async function listVoices(): Promise<VoiceListItem[]> {
  return PRESET_VOICES;
}

function getVoiceIdFromResponse(json: any): string | null {
  return json.output?.voice_id || json.output?.voiceId || (typeof json.output?.voice === 'string' ? json.output.voice : null);
}

function sanitizePrefix(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 10) || 'voice';
}

function resolveCloneAudioUrl(sampleSource: string): string {
  if (/^data:audio\//i.test(sampleSource)) return sampleSource;
  if (/^https?:\/\//i.test(sampleSource)) return sampleSource;
  if (fs.existsSync(sampleSource)) {
    const buf = fs.readFileSync(sampleSource);
    return `data:audio/wav;base64,${buf.toString('base64')}`;
  }
  throw new Error(`Invalid clone sample source: ${sampleSource}`);
}

function resolveVoiceModel(voiceId: string): string | undefined {
  try {
    const db = readDB();
    for (const profiles of Object.values(db.voiceProfiles || {}) as any[]) {
      const match = (profiles || []).find((voice: any) => voice?.voiceId === voiceId && voice?.model);
      if (match?.model) return String(match.model);
    }
  } catch {}
  return undefined;
}

async function postVoiceEnrollment(model: string, input: Record<string, any>, operation: 'clone' | 'design'): Promise<string> {
  const apiKey = getApiKey();
  const res = await fetch(CUSTOMIZATION_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(`CosyVoice ${operation} error (${res.status}): ${err.message || err.code || 'Unknown'}`);
  }

  const json = await res.json();
  const voiceId = getVoiceIdFromResponse(json);
  if (!voiceId) {
    throw new Error(`CosyVoice ${operation} response missing voice_id: ${JSON.stringify(json)}`);
  }
  return voiceId;
}

/** Clone a voice from a prepared public audio URL, or local WAV in data-url mode. */
export async function cloneVoice(sampleUrls: string[], name: string): Promise<string> {
  const firstSource = sampleUrls[0];
  if (!firstSource) throw new Error('At least one prepared audio sample is required');
  const audioData = resolveCloneAudioUrl(firstSource);

  if (/^https?:\/\//i.test(audioData)) {
    return postVoiceEnrollment('voice-enrollment', {
      action: 'create_voice',
      target_model: getCosyVoiceCloneTargetModel(),
      url: audioData,
      prefix: sanitizePrefix(name),
    }, 'clone');
  }

  return postVoiceEnrollment('qwen-voice-enrollment', {
    action: 'create_voice',
    target_model: getQwenCloneTargetModel(),
    audio: { data: audioData },
    prefix: sanitizePrefix(name),
  }, 'clone');
}

/** Design a new voice from a text description using CosyVoice voice enrollment. */
export async function designVoice(voicePrompt: string, name: string): Promise<string> {
  return postVoiceEnrollment('qwen-voice-design', {
    action: 'create_voice',
    target_model: getQwenDesignTargetModel(),
    voice_prompt: voicePrompt,
    preview_text: 'Hello, this is my voice.',
    prefix: sanitizePrefix(name),
  }, 'design');
}
