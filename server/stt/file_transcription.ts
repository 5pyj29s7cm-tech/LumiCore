import path from 'path';
import { getKey } from '../config/keys';
import { isCircuitClosed, recordFailure, recordSuccess } from '../cloud/circuit_breaker';
import { classifyCloudError } from '../cloud/core';
import { recordLatency } from '../monitor/latency_store';
import type { STTProvider, STTSegment } from './types';
import * as dashscopeFile from './providers/dashscope-file';
import * as localWhisper from './providers/local-whisper';
import * as whisper from './providers/whisper';
import * as ark from './providers/ark';

export type AudioFileProvider = STTProvider;

export interface AudioFileTranscriptionOptions {
  fileName?: string;
  language?: string;
  preferredProvider?: STTProvider | 'auto';
  allowLocal?: boolean;
  allowQwenFileStt?: boolean;
  fetchImpl?: typeof fetch;
  providerAvailability?: Partial<Record<AudioFileProvider, boolean>>;
  onProgress?: (message: string) => void;
}

export interface AudioFileTranscriptionResult {
  text: string;
  provider: AudioFileProvider;
  model: string;
  language: string;
  mimeType: string;
  durationMs: number;
  warnings?: string[];
  segments?: STTSegment[];
  speakerCount?: number;
  taskId?: string;
}

type ProviderTranscript = {
  text: string;
  model?: string;
  segments?: STTSegment[];
  speakerCount?: number;
  taskId?: string;
};

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
  whisper: 'whisper-1',
  qwen: 'fun-asr',
  ark: 'doubao-stt-1.0',
  'local-whisper': 'faster-whisper-large-v3,medium,small',
};

function getProviderModelLabel(provider: AudioFileProvider): string {
  if (provider === 'local-whisper') {
    return `faster-whisper-${String(process.env.LUMI_WHISPER_MODEL || 'large-v3,medium,small')}`;
  }
  if (provider === 'qwen') {
    return String(process.env.DASHSCOPE_FILE_ASR_MODEL || PROVIDER_MODELS.qwen);
  }
  return PROVIDER_MODELS[provider];
}

const DEFAULT_AUTO_ORDER: AudioFileProvider[] = ['qwen', 'local-whisper', 'whisper', 'ark'];

function getConfiguredKey(provider: AudioFileProvider, availability?: Partial<Record<AudioFileProvider, boolean>>): string {
  if (availability && Object.prototype.hasOwnProperty.call(availability, provider)) {
    return availability[provider] ? 'configured' : '';
  }
  switch (provider) {
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

function isQwenFileSttAllowed(options: AudioFileTranscriptionOptions = {}): boolean {
  return options.allowQwenFileStt !== false && process.env.LUMI_DISABLE_QWEN_FILE_STT !== '1';
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
    if (provider === 'qwen' && !isQwenFileSttAllowed(options)) continue;
    if (provider === 'local-whisper' && !allowLocal) continue;
    if (!getConfiguredKey(provider, options.providerAvailability)) continue;
    if (preferred !== provider && !isCircuitClosed(circuitProvider(provider), getProviderModelLabel(provider))) continue;
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

async function transcribeWithProvider(
  provider: AudioFileProvider,
  audioBuffer: Buffer,
  options: Required<Pick<AudioFileTranscriptionOptions, 'language' | 'fetchImpl'>> & {
    fileName: string;
    mimeType: string;
    onProgress?: (message: string) => void;
  },
): Promise<ProviderTranscript> {
  switch (provider) {
    case 'qwen': {
      const result = await dashscopeFile.transcribe(audioBuffer, options.language, {
        fileName: options.fileName,
        mimeType: options.mimeType,
        fetchImpl: options.fetchImpl,
        onProgress: options.onProgress,
      });
      return {
        text: result.text,
        model: result.model,
        segments: result.segments,
        speakerCount: result.speakerCount,
        taskId: result.taskId,
      };
    }
    case 'whisper': {
      const result = await whisper.transcribe(audioBuffer, options.language, {
        fileName: options.fileName,
        mimeType: options.mimeType,
      });
      return { text: result.text, model: result.model };
    }
    case 'ark': {
      const result = await ark.transcribe(audioBuffer, options.language, {
        fileName: options.fileName,
        mimeType: options.mimeType,
      });
      return { text: result.text, model: result.model };
    }
    case 'local-whisper': {
      const result = await localWhisper.transcribe(audioBuffer, options.language, {
        fileName: options.fileName,
        onProgress: options.onProgress,
      });
      return { text: result.text, model: result.model };
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
  options.onProgress?.(`准备转写音频：${fileName}`);
  options.onProgress?.(`转写引擎顺序：${plan.join(' -> ') || 'none'}`);

  if (plan.length === 0) {
    const qwenConfigured = !!getConfiguredKey('qwen', options.providerAvailability);
    const qwenDisabled = qwenConfigured && !isQwenFileSttAllowed(options);
    throw errorCode(
      'NO_AUDIO_TRANSCRIPTION_PROVIDER',
      qwenDisabled
        ? 'No usable audio transcription provider is configured. DashScope file STT is disabled by local policy; enable it or configure local Whisper/OpenAI/Doubao.'
        : 'No audio transcription provider is configured. Configure DashScope Fun-ASR, local Whisper, OpenAI Whisper, or Doubao Speech.',
    );
  }

  const failures: string[] = [];
  for (const provider of plan) {
    const plannedModel = getProviderModelLabel(provider);
    const providerStart = Date.now();
    try {
      options.onProgress?.(`正在使用 ${provider}/${plannedModel} 转写，较长录音可能需要几分钟`);
      const transcript = await transcribeWithProvider(provider, audioBuffer, {
        fileName,
        language,
        mimeType,
        fetchImpl,
        onProgress: options.onProgress,
      });
      const text = transcript.text.trim();
      const actualModel = transcript.model || plannedModel;
      if (!text) {
        failures.push(`${provider}: empty transcript`);
        continue;
      }
      recordLatency('stt', Date.now() - providerStart);
      recordSuccess(circuitProvider(provider), actualModel);
      options.onProgress?.(`转写完成：${provider}/${actualModel}，共 ${text.length} 字`);
      return {
        text,
        provider,
        model: actualModel,
        language,
        mimeType,
        durationMs: Date.now() - start,
        warnings: failures.length > 0 ? failures : undefined,
        segments: transcript.segments,
        speakerCount: transcript.speakerCount,
        taskId: transcript.taskId,
      };
    } catch (err: any) {
      const failure = err instanceof Error ? err : new Error(String(err));
      const classified = classifyCloudError(failure, provider);
      const accountUnavailable = classified.category === 'auth' || classified.category === 'quota';
      recordFailure(circuitProvider(provider), plannedModel, failure, { openImmediately: accountUnavailable });
      if (accountUnavailable && provider === 'qwen') {
        recordFailure('qwen-stt', undefined, failure, { openImmediately: true });
      }
      failures.push(`${provider}: ${err?.message || String(err)}`);
      options.onProgress?.(`${provider} 转写失败，准备尝试下一个引擎`);
    }
  }

  const failureText = failures.join('; ') || 'no transcript returned';
  const err: any = new Error(`Audio transcription failed: ${failureText}`);
  err.code = 'AUDIO_TRANSCRIPTION_FAILED';
  err.failures = failures;
  throw err;
}
