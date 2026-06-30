import path from 'path';
import { getKey } from '../config/keys';
import { isCircuitClosed, recordFailure, recordSuccess } from '../cloud/circuit_breaker';
import { recordLatency } from '../monitor/latency_store';
import type { STTProvider } from './types';
import * as localWhisper from './providers/local-whisper';
import * as whisper from './providers/whisper';
import * as ark from './providers/ark';

export type AudioFileProvider = STTProvider;

export interface AudioFileTranscriptionOptions {
  fileName?: string;
  language?: string;
  preferredProvider?: STTProvider | 'auto';
  allowLocal?: boolean;
  fetchImpl?: typeof fetch;
  providerAvailability?: Partial<Record<AudioFileProvider, boolean>>;
}

export interface AudioFileTranscriptionResult {
  text: string;
  provider: AudioFileProvider;
  model: string;
  language: string;
  mimeType: string;
  durationMs: number;
  warnings?: string[];
}

export const AUDIO_FILE_EXTS = /\.(mp3|mpeg|wav|m4a|ogg|oga|flac|aac|wma|webm)$/i;

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.mpeg': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.wma': 'audio/x-ms-wma',
  '.webm': 'audio/webm',
};

const PROVIDER_MODELS: Record<AudioFileProvider, string> = {
  deepgram: 'nova-2',
  whisper: 'whisper-1',
  qwen: 'sensevoice-v1',
  ark: 'doubao-stt-1.0',
  'local-whisper': 'faster-whisper-small',
};

const DEFAULT_AUTO_ORDER: AudioFileProvider[] = ['qwen', 'deepgram', 'whisper', 'ark', 'local-whisper'];

function getConfiguredKey(provider: AudioFileProvider, availability?: Partial<Record<AudioFileProvider, boolean>>): string {
  if (availability && Object.prototype.hasOwnProperty.call(availability, provider)) {
    return availability[provider] ? 'configured' : '';
  }
  switch (provider) {
    case 'deepgram':
      return process.env.DEEPGRAM_API_KEY || getKey('DEEPGRAM_API_KEY') || '';
    case 'whisper':
      return process.env.OPENAI_API_KEY || getKey('OPENAI_API_KEY') || '';
    case 'qwen':
      return process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY
        || getKey('DASHSCOPE_API_KEY') || getKey('QWEN_API_KEY') || '';
    case 'ark': {
      const raw = process.env.DOUBAO_SPEECH_KEY || getKey('DOUBAO_SPEECH_KEY') || '';
      return raw.includes(':') ? raw : '';
    }
    case 'local-whisper':
      return localWhisper.isLocalWhisperAvailable() ? 'local' : '';
    default:
      return '';
  }
}

function circuitProvider(provider: AudioFileProvider): string {
  return provider === 'whisper' ? 'openai' : provider;
}

function errorCode(code: string, message: string): Error {
  const err: any = new Error(message);
  err.code = code;
  return err;
}

function sanitizeUploadName(fileName?: string): string {
  const safe = path.basename(String(fileName || '').trim());
  return safe || 'audio.mp3';
}

export function getAudioMimeType(fileName?: string, fallback = 'audio/mpeg'): string {
  const ext = path.extname(String(fileName || '')).toLowerCase();
  return AUDIO_MIME_BY_EXT[ext] || fallback;
}

export function isSupportedAudioFileName(fileName?: string): boolean {
  return AUDIO_FILE_EXTS.test(String(fileName || ''));
}

export function getAudioFileProviderPlan(options: AudioFileTranscriptionOptions = {}): AudioFileProvider[] {
  const allowLocal = options.allowLocal !== false;
  const preferred = options.preferredProvider || 'auto';
  const baseOrder: AudioFileProvider[] = preferred && preferred !== 'auto'
    ? [preferred as AudioFileProvider, ...DEFAULT_AUTO_ORDER]
    : DEFAULT_AUTO_ORDER;

  const providers: AudioFileProvider[] = [];
  for (const provider of baseOrder) {
    if (providers.includes(provider)) continue;
    if (provider === 'local-whisper' && !allowLocal) continue;
    if (!getConfiguredKey(provider, options.providerAvailability)) continue;
    if (preferred !== provider && !isCircuitClosed(circuitProvider(provider), PROVIDER_MODELS[provider])) continue;
    providers.push(provider);
  }
  return providers;
}

async function getPreferredAudioFileProvider(options: AudioFileTranscriptionOptions): Promise<STTProvider | 'auto'> {
  if (options.preferredProvider) return options.preferredProvider;
  if (options.providerAvailability) return 'auto';
  try {
    const { getVoicePreference } = await import('../config/voice_preference');
    return getVoicePreference().stt || 'auto';
  } catch {
    return 'auto';
  }
}

function extractQwenText(data: any): string {
  const output = data?.output || data || {};
  const sentence = output?.sentence;
  const candidates = [
    sentence?.text,
    output?.text,
    output?.transcript,
    output?.transcription,
    data?.text,
  ];
  if (Array.isArray(sentence)) {
    candidates.push(sentence.map((item: any) => item?.text || item?.sentence || '').join(' '));
  }
  if (Array.isArray(output?.sentences)) {
    candidates.push(output.sentences.map((item: any) => item?.text || item?.sentence || '').join(' '));
  }
  return candidates.map(value => String(value || '').trim()).find(Boolean) || '';
}

async function transcribeDeepgramFile(
  audioBuffer: Buffer,
  fileName: string,
  language: string,
  mimeType: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const apiKey = getConfiguredKey('deepgram');
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY is not configured');
  const url = `https://api.deepgram.com/v1/listen?model=nova-2&language=${encodeURIComponent(language)}&punctuate=true`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': mimeType || getAudioMimeType(fileName),
    },
    body: audioBuffer as any,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Deepgram error (${res.status}): ${detail || res.statusText}`);
  }
  const data = await res.json() as any;
  return String(data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim();
}

async function transcribeQwenFile(
  audioBuffer: Buffer,
  fileName: string,
  language: string,
  mimeType: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const apiKey = getConfiguredKey('qwen');
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY or QWEN_API_KEY is not configured');
  const form = new FormData();
  form.append('model', 'sensevoice-v1');
  form.append('file', new Blob([audioBuffer as any], { type: mimeType }), fileName);
  if (language) form.append('language', language);
  const res = await fetchImpl('https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`DashScope SenseVoice error (${res.status}): ${detail || res.statusText}`);
  }
  const data = await res.json() as any;
  return extractQwenText(data);
}

async function transcribeWithProvider(
  provider: AudioFileProvider,
  audioBuffer: Buffer,
  options: Required<Pick<AudioFileTranscriptionOptions, 'language' | 'fetchImpl'>> & { fileName: string; mimeType: string },
): Promise<string> {
  switch (provider) {
    case 'deepgram':
      return transcribeDeepgramFile(audioBuffer, options.fileName, options.language, options.mimeType, options.fetchImpl);
    case 'qwen':
      return transcribeQwenFile(audioBuffer, options.fileName, options.language, options.mimeType, options.fetchImpl);
    case 'whisper': {
      const result = await whisper.transcribe(audioBuffer, options.language, {
        fileName: options.fileName,
        mimeType: options.mimeType,
      });
      return result.text;
    }
    case 'ark': {
      const result = await ark.transcribe(audioBuffer, options.language, {
        fileName: options.fileName,
        mimeType: options.mimeType,
      });
      return result.text;
    }
    case 'local-whisper': {
      const result = await localWhisper.transcribe(audioBuffer, options.language, {
        fileName: options.fileName,
      });
      return result.text;
    }
    default:
      throw new Error(`Unsupported audio transcription provider: ${provider}`);
  }
}

export function isAudioTranscriptionUnavailable(err: unknown): boolean {
  return (err as any)?.code === 'NO_AUDIO_TRANSCRIPTION_PROVIDER';
}

export async function transcribeAudioFile(
  audioBuffer: Buffer,
  options: AudioFileTranscriptionOptions = {},
): Promise<AudioFileTranscriptionResult> {
  const start = Date.now();
  const fileName = sanitizeUploadName(options.fileName);
  const language = options.language || 'zh';
  const mimeType = getAudioMimeType(fileName);
  const fetchImpl = options.fetchImpl || fetch;
  const preferredProvider = await getPreferredAudioFileProvider(options);
  const plan = getAudioFileProviderPlan({ ...options, preferredProvider });

  if (plan.length === 0) {
    throw errorCode(
      'NO_AUDIO_TRANSCRIPTION_PROVIDER',
      'No audio transcription provider is configured. Configure OpenAI Whisper, Deepgram, DashScope SenseVoice, Doubao Speech, or local Whisper.',
    );
  }

  const failures: string[] = [];
  for (const provider of plan) {
    const model = PROVIDER_MODELS[provider];
    const providerStart = Date.now();
    try {
      const text = (await transcribeWithProvider(provider, audioBuffer, { fileName, language, mimeType, fetchImpl })).trim();
      if (!text) {
        failures.push(`${provider}: empty transcript`);
        continue;
      }
      recordLatency('stt', Date.now() - providerStart);
      recordSuccess(circuitProvider(provider), model);
      return {
        text,
        provider,
        model,
        language,
        mimeType,
        durationMs: Date.now() - start,
        warnings: failures.length > 0 ? failures : undefined,
      };
    } catch (err: any) {
      recordFailure(circuitProvider(provider), model, err instanceof Error ? err : new Error(String(err)));
      failures.push(`${provider}: ${err?.message || String(err)}`);
    }
  }

  const failureText = failures.join('; ') || 'no transcript returned';
  const err: any = new Error(`Audio transcription failed: ${failureText}`);
  err.code = 'AUDIO_TRANSCRIPTION_FAILED';
  err.failures = failures;
  throw err;
}
