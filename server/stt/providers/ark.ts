import { randomUUID } from 'crypto';
import path from 'path';
import { STTResult } from '../types';
import {
  buildDoubaoApiHeaders,
  getDoubaoFileAsrResourceId,
  hasDoubaoSpeechCredentials,
  requireDoubaoSpeechCredentials,
} from '../../config/doubao_speech';

const DEFAULT_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';

interface AudioFileOptions {
  fileName?: string;
  mimeType?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export function hasDoubaoSpeech(): boolean {
  return hasDoubaoSpeechCredentials();
}

function audioFormat(options: AudioFileOptions): string | undefined {
  const extension = path.extname(String(options.fileName || '')).toLowerCase().replace(/^\./, '');
  if (extension === 'mpeg') return 'mp3';
  if (extension === 'oga') return 'ogg';
  if (extension) return extension;
  const mime = String(options.mimeType || '').toLowerCase();
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('webm')) return 'webm';
  return undefined;
}

function responseError(response: Response, payload: any): Error {
  const statusCode = response.headers.get('X-Api-Status-Code') || response.status;
  const message = response.headers.get('X-Api-Message')
    || payload?.message
    || payload?.error
    || response.statusText
    || 'Unknown error';
  const logId = response.headers.get('X-Tt-Logid');
  return new Error(`Doubao ASR error (${statusCode}): ${message}${logId ? ` [logid=${logId}]` : ''}`);
}

export async function transcribe(
  audioBuffer: Buffer,
  language: string = 'zh',
  options: AudioFileOptions = {},
): Promise<STTResult> {
  const credentials = requireDoubaoSpeechCredentials();
  const fetchImpl = options.fetchImpl || fetch;
  const requestId = randomUUID();
  const format = audioFormat(options);
  const audio: Record<string, unknown> = { data: audioBuffer.toString('base64') };
  if (format) audio.format = format;

  const response = await fetchImpl(process.env.DOUBAO_FILE_ASR_URL || DEFAULT_URL, {
    method: 'POST',
    headers: {
      ...buildDoubaoApiHeaders(credentials),
      'X-Api-Resource-Id': getDoubaoFileAsrResourceId(),
      'X-Api-Request-Id': requestId,
      'X-Api-Sequence': '-1',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user: { uid: 'lumi_user' },
      audio,
      request: {
        model_name: process.env.DOUBAO_FILE_ASR_MODEL || 'bigmodel',
        language,
        enable_itn: true,
        enable_punc: true,
        show_utterances: true,
      },
    }),
    signal: options.signal,
  });

  const payload = await response.json().catch(() => ({})) as any;
  const statusCode = response.headers.get('X-Api-Status-Code');
  if (!response.ok || (statusCode && statusCode !== '20000000')) {
    throw responseError(response, payload);
  }

  const result = payload?.result || payload?.data?.result || payload;
  const text = String(result?.text || payload?.text || '').trim();
  return {
    text,
    isFinal: true,
    model: process.env.DOUBAO_FILE_ASR_MODEL || 'doubao-bigmodel-auc-turbo',
    taskId: requestId,
  };
}
