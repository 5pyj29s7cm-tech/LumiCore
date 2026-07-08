import { TTSResult, VoiceListItem } from '../types';

const DEFAULT_BASE_URL = 'http://127.0.0.1:50000';
const DEFAULT_SFT_PATH = '/inference_sft';
const DEFAULT_SPEAKER = '\u4e2d\u6587\u5973';

function cleanBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function cleanPath(pathname: string): string {
  if (!pathname) return DEFAULT_SFT_PATH;
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

function getBaseUrl(): string {
  return cleanBaseUrl(process.env.LOCAL_COSYVOICE_API_URL || process.env.COSYVOICE_LOCAL_API_URL || DEFAULT_BASE_URL);
}

function getTtsPath(): string {
  return cleanPath(process.env.LOCAL_COSYVOICE_TTS_PATH || process.env.COSYVOICE_LOCAL_TTS_PATH || DEFAULT_SFT_PATH);
}

function getDefaultSpeaker(): string {
  return process.env.LOCAL_COSYVOICE_VOICE || process.env.COSYVOICE_LOCAL_VOICE || DEFAULT_SPEAKER;
}

export function isConfigured(): boolean {
  return Boolean(
    process.env.LOCAL_COSYVOICE_ENABLED === 'true'
    || process.env.LOCAL_COSYVOICE_API_URL
    || process.env.COSYVOICE_LOCAL_API_URL,
  );
}

function endpointUrl(): string {
  return `${getBaseUrl()}${getTtsPath()}`;
}

function buildRequestBody(
  text: string,
  voiceId?: string,
  speechRate?: number,
  pitch?: number,
  volume?: number,
  model?: string,
): Record<string, unknown> {
  const path = getTtsPath();
  const speaker = voiceId && voiceId !== 'default' ? voiceId : getDefaultSpeaker();

  if (path.includes('inference_')) {
    const body: Record<string, unknown> = {
      tts_text: text,
      spk_id: speaker,
    };
    if (speechRate !== undefined) body.speed = speechRate;
    if (pitch !== undefined) body.pitch = pitch;
    if (volume !== undefined) body.volume = volume;
    if (model) body.model = model;
    return body;
  }

  const body: Record<string, unknown> = {
    text,
    voice: speaker,
    speaker,
    format: 'wav',
    stream: false,
    streaming: false,
  };
  if (speechRate !== undefined) body.speech_rate = speechRate;
  if (pitch !== undefined) body.pitch = pitch;
  if (volume !== undefined) body.volume = volume;
  if (model) body.model = model;
  return body;
}

function buildOfficialFormBody(
  text: string,
  voiceId?: string,
  speechRate?: number,
  pitch?: number,
  volume?: number,
  model?: string,
): FormData {
  const path = getTtsPath();
  const speaker = voiceId && voiceId !== 'default' ? voiceId : getDefaultSpeaker();
  const form = new FormData();
  form.append('tts_text', text);

  if (path.includes('inference_sft')) {
    form.append('spk_id', speaker);
  } else if (path.includes('inference_instruct')) {
    form.append('spk_id', speaker);
    form.append('instruct_text', process.env.LOCAL_COSYVOICE_INSTRUCT_TEXT || 'Speak naturally and clearly.');
  } else {
    form.append('spk_id', speaker);
  }

  if (speechRate !== undefined) form.append('speed', String(speechRate));
  if (pitch !== undefined) form.append('pitch', String(pitch));
  if (volume !== undefined) form.append('volume', String(volume));
  if (model) form.append('model', model);
  return form;
}

function getSampleRate(): number {
  const parsed = Number(process.env.LOCAL_COSYVOICE_SAMPLE_RATE || process.env.COSYVOICE_LOCAL_SAMPLE_RATE || 22050);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 22050;
}

function isWav(buffer: Buffer): boolean {
  return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE';
}

function pcm16ToWav(pcm: Buffer, sampleRate = getSampleRate(), channels = 1): Buffer {
  if (isWav(pcm)) return pcm;
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function normalizeBase64(raw: string): string | null {
  const trimmed = raw.trim();
  const match = trimmed.match(/^data:audio\/[^;]+;base64,(.+)$/i);
  if (match) return match[1];
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) && trimmed.length > 100) return trimmed;
  return null;
}

function findAudioValue(value: any): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return null;

  for (const key of ['audio', 'audio_url', 'audioUrl', 'url', 'wav', 'mp3', 'data', 'base64']) {
    const found = findAudioValue(value[key]);
    if (found) return found;
  }
  if (value.output) return findAudioValue(value.output);
  if (value.result) return findAudioValue(value.result);
  return null;
}

async function resolveJsonAudio(json: any, signal?: AbortSignal): Promise<TTSResult> {
  const audio = findAudioValue(json);
  if (!audio) {
    throw new Error(`Local CosyVoice response missing audio data: ${JSON.stringify(json).slice(0, 300)}`);
  }

  if (/^https?:\/\//i.test(audio)) {
    const audioRes = await fetch(audio, { signal });
    if (!audioRes.ok) {
      throw new Error(`Local CosyVoice audio download failed (${audioRes.status})`);
    }
    const contentType = audioRes.headers.get('content-type') || 'audio/wav';
    return {
      audioBuffer: Buffer.from(await audioRes.arrayBuffer()),
      format: contentType,
    };
  }

  const base64 = normalizeBase64(audio);
  if (!base64) {
    throw new Error('Local CosyVoice returned JSON, but the audio field is not a URL or base64 payload.');
  }
  return {
    audioBuffer: Buffer.from(base64, 'base64'),
    format: audio.startsWith('data:audio/mp3') || audio.startsWith('data:audio/mpeg') ? 'audio/mp3' : 'audio/wav',
  };
}

export async function synthesizeSpeech(
  text: string,
  voiceId?: string,
  signal?: AbortSignal,
  speechRate?: number,
  pitch?: number,
  volume?: number,
  model?: string,
): Promise<TTSResult> {
  if (!isConfigured()) {
    throw new Error(
      'Local CosyVoice is not configured. Set LOCAL_COSYVOICE_ENABLED=true and run a local CosyVoice server, or set LOCAL_COSYVOICE_API_URL.',
    );
  }

  const officialFastApi = getTtsPath().includes('inference_');
  const res = await fetch(endpointUrl(), officialFastApi
    ? {
      method: 'POST',
      body: buildOfficialFormBody(text, voiceId, speechRate, pitch, volume, model),
      signal,
    }
    : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildRequestBody(text, voiceId, speechRate, pitch, volume, model)),
      signal,
    });

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Local CosyVoice TTS error (${res.status}): ${detail.slice(0, 300)}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.startsWith('audio/')) {
    return {
      audioBuffer: Buffer.from(await res.arrayBuffer()),
      format: contentType,
    };
  }

  if (officialFastApi || contentType.includes('octet-stream')) {
    return {
      audioBuffer: pcm16ToWav(Buffer.from(await res.arrayBuffer())),
      format: 'audio/wav',
    };
  }

  const json = await res.json().catch(async () => {
    const textBody = await res.text().catch(() => '');
    throw new Error(`Local CosyVoice returned non-audio response: ${textBody.slice(0, 300)}`);
  });
  return resolveJsonAudio(json, signal);
}

export function listVoices(): VoiceListItem[] {
  const voices = (process.env.LOCAL_COSYVOICE_VOICES || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);

  const voiceIds = voices.length > 0 ? voices : [getDefaultSpeaker()];
  return voiceIds.map((voiceId, index) => ({
    voiceId,
    name: index === 0 ? 'Local CosyVoice default' : `Local CosyVoice ${index + 1}`,
    category: 'premade' as const,
    language: 'zh',
  }));
}
