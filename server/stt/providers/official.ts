import path from 'path';
import type { STTResult, StreamingSTTSession } from '../types';
import { officialApiModel, officialApiPath, officialApiRequest } from '../../llm/official_api';

export interface OfficialAudioFileOptions {
  fileName?: string;
  mimeType?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  model?: string;
  /** Raw 16-bit mono PCM from the desktop microphone, rather than an encoded file. */
  rawPcm?: boolean;
  sampleRate?: number;
}

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

function pcm16ToWav(pcm: Buffer, sampleRate = 16_000, channels = 1): Buffer {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function safeFileName(fileName?: string): string {
  return path.basename(String(fileName || '').trim()) || 'audio.webm';
}

function parseResult(body: any, model: string): STTResult {
  const payload = body?.data && typeof body.data === 'object' ? body.data : body;
  const text = String(payload?.text || body?.text || payload?.transcript || '').trim();
  const segments = Array.isArray(payload?.segments) ? payload.segments : undefined;
  return {
    text,
    isFinal: true,
    model: String(payload?.model || body?.model || model),
    ...(segments ? { segments } : {}),
    ...(payload?.task_id || body?.task_id ? { taskId: String(payload?.task_id || body?.task_id) } : {}),
  };
}

/** OpenAI-compatible file transcription through Lumi's official API. */
export async function transcribe(
  audioBuffer: Buffer,
  language = 'zh',
  options: OfficialAudioFileOptions = {},
): Promise<STTResult> {
  const model = options.model || officialApiModel('RELAY_STT_MODEL', 'whisper-1');
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw new Error('Lumi Official API STT received no audio data.');
  }
  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    throw new Error(`Audio input exceeds the ${MAX_AUDIO_BYTES} byte limit.`);
  }
  const payload = options.rawPcm ? pcm16ToWav(audioBuffer, options.sampleRate || 16_000) : audioBuffer;
  if (payload.length > MAX_AUDIO_BYTES) {
    throw new Error(`Audio input exceeds the ${MAX_AUDIO_BYTES} byte limit.`);
  }
  const form = new FormData();
  const mimeType = options.rawPcm ? 'audio/wav' : (options.mimeType || 'audio/webm');
  const fileName = options.rawPcm ? 'lumi-microphone.wav' : safeFileName(options.fileName);
  form.append('file', new Blob([payload as any], { type: mimeType }), fileName);
  form.append('model', model);
  if (language) form.append('language', language);
  const { body } = await officialApiRequest<any>(officialApiPath('RELAY_STT_PATH', '/audio/transcriptions'), {
    method: 'POST',
    body: form,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
    timeoutMs: 90_000,
  });
  return parseResult(body, model);
}

/**
 * The official REST contract is batch transcription. Buffer a realtime voice
 * utterance and submit it when the socket marks the utterance as ended. This
 * keeps provider selection continuous without pretending that a REST call is
 * a websocket stream; qwen/ark remain available for true interim results.
 */
export function createBufferedSession(
  language = 'zh',
  interimResults = false,
  model?: string,
  fetchImpl?: typeof fetch,
): StreamingSTTSession {
  const chunks: Buffer[] = [];
  const resultCallbacks: Array<(result: STTResult) => void> = [];
  const errorCallbacks: Array<(error: Error) => void> = [];
  let ended = false;
  let bufferedBytes = 0;
  let overflowed = false;
  let submitting = false;
  let endpointingMs = 0;
  const submit = () => {
    if (submitting) return;
    const audio = Buffer.concat(chunks);
    chunks.length = 0;
    bufferedBytes = 0;
    if (audio.length === 0) return;
    submitting = true;
    void transcribe(audio, language, { model, fetchImpl, rawPcm: true })
      .then(result => resultCallbacks.forEach(callback => callback({ ...result, isFinal: true })))
      .catch(error => errorCallbacks.forEach(callback => callback(error instanceof Error ? error : new Error(String(error)))))
      .finally(() => { submitting = false; });
  };
  return {
    sendAudio(chunk: Buffer) {
      if (ended || !chunk?.length || overflowed) return;
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bufferedBytes + next.length > MAX_AUDIO_BYTES) {
        overflowed = true;
        errorCallbacks.forEach(callback => callback(new Error(`Realtime audio exceeded the ${MAX_AUDIO_BYTES} byte limit.`)));
        return;
      }
      chunks.push(Buffer.from(next));
      bufferedBytes += next.length;
    },
    end() {
      if (ended) return;
      ended = true;
      if (overflowed) return;
      if (bufferedBytes === 0) {
        errorCallbacks.forEach(callback => callback(new Error('Lumi Official API STT received no audio data.')));
        return;
      }
      submit();
    },
    flush() {
      if (!ended && !overflowed) submit();
    },
    updateEndpointing(silenceDurationMs: number) {
      endpointingMs = Number(silenceDurationMs) || 0;
      void endpointingMs;
      void interimResults;
    },
    onResult(callback) { resultCallbacks.push(callback); },
    onError(callback) { errorCallbacks.push(callback); },
  };
}
