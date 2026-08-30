import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { STTResult, StreamingSTTSession } from '../types';
import {
  officialApiHeaders,
  officialApiModel,
  officialApiPath,
  officialApiWebSocketUrl,
} from '../../llm/official_api';
import { classifyCloudError } from '../../cloud/core';
import { recordFailure, recordSuccess } from '../../cloud/circuit_breaker';
import { logger } from '../../../logger';
import { shouldEmitStreamingPartial } from '../partial_transcript';
import { clampEndpointSilenceMs } from '../adaptive_endpointing';
import { normalizeLumiOfficialModel } from '../../../shared/model_provider_capabilities';

export interface OfficialAudioFileOptions {
  fileName?: string;
  mimeType?: string;
  signal?: AbortSignal;
  model?: string;
  /** Raw 16-bit mono PCM from the desktop microphone, rather than an encoded file. */
  rawPcm?: boolean;
  sampleRate?: number;
  /** Retained for backwards-compatible callers; the official STT route is WebSocket-only. */
  fetchImpl?: typeof fetch;
  /** Injectable socket implementation for deterministic adapter tests. */
  WebSocketImpl?: typeof WebSocket;
}

export interface OfficialStreamingOptions {
  model?: string;
  format?: OfficialAudioFormat;
  sampleRate?: number;
  WebSocketImpl?: typeof WebSocket;
}

type OfficialAudioFormat = 'pcm' | 'wav' | 'mp3' | 'opus' | 'speex' | 'aac' | 'amr';

const PROVIDER = 'relay-stt';
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_PENDING_AUDIO_BYTES = 4 * 1024 * 1024;
const DEFAULT_MODEL = 'aliyun/qwen-audio-3.0-asr-flash-streaming';
const SUPPORTED_FORMATS = new Set<OfficialAudioFormat>(['pcm', 'wav', 'mp3', 'opus', 'speex', 'aac', 'amr']);

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function safeErrorMessage(value: unknown): string {
  return String(value || 'Official streaming STT failed')
    .replace(/(?:Bearer\s+|sk-[A-Za-z0-9_-]{6,})[^\s]*/gi, '[redacted]')
    .slice(0, 400);
}

function languageHints(language?: string): string[] | undefined {
  const normalized = String(language || '').trim().toLowerCase().replace('_', '-');
  if (!normalized || normalized === 'auto') return undefined;
  const primary = normalized.split('-')[0];
  return /^[a-z]{2}$/.test(primary) ? [primary] : undefined;
}

function audioFormat(options: OfficialAudioFileOptions): OfficialAudioFormat {
  if (options.rawPcm) return 'pcm';
  const extension = path.extname(String(options.fileName || '')).slice(1).toLowerCase();
  const mimeSubtype = String(options.mimeType || '').toLowerCase().split('/')[1]?.split(';')[0] || '';
  const rawCandidate = extension === 'wave' ? 'wav' : extension || mimeSubtype;
  // Browsers commonly report MP3 as audio/mpeg and WAV as audio/x-wav. Keep
  // those aliases on the documented wire-format enum rather than rejecting
  // an otherwise valid upload just because it omitted a filename.
  const candidate = rawCandidate === 'mpeg' ? 'mp3' : rawCandidate === 'x-wav' ? 'wav' : rawCandidate;
  if (SUPPORTED_FORMATS.has(candidate as OfficialAudioFormat)) return candidate as OfficialAudioFormat;
  throw new Error('Lumi Official API streaming STT accepts PCM, WAV, MP3, Opus, Speex, AAC, or AMR audio.');
}

/**
 * Read the source sample rate for encoded files before opening a duplex task.
 * The official gateway requires the declared rate to match the encoded audio;
 * blindly sending 16 kHz for an MP3 recorded at 24/44.1/48 kHz produces a
 * server-side decode error.  Keep this parser dependency-free so desktop and
 * macOS builds do not require ffprobe or another system binary.
 */
export function detectOfficialAudioSampleRate(
  audio: Buffer,
  format?: string,
): number | undefined {
  if (!Buffer.isBuffer(audio) || audio.length < 4) return undefined;
  const kind = String(format || '').trim().toLowerCase() || undefined;

  if (kind === 'wav' || (!kind && audio.toString('ascii', 0, 4) === 'RIFF')) {
    if (audio.length < 12 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') return undefined;
    let offset = 12;
    while (offset + 8 <= audio.length) {
      const chunkSize = audio.readUInt32LE(offset + 4);
      const chunkStart = offset + 8;
      if (audio.toString('ascii', offset, offset + 4) === 'fmt ' && chunkSize >= 8 && chunkStart + 8 <= audio.length) {
        const rate = audio.readUInt32LE(chunkStart + 4);
        return rate >= 8_000 && rate <= 384_000 ? rate : undefined;
      }
      offset = chunkStart + chunkSize + (chunkSize % 2);
    }
    return undefined;
  }

  if (kind === 'flac' || (!kind && audio.toString('ascii', 0, 4) === 'fLaC')) {
    if (audio.toString('ascii', 0, 4) !== 'fLaC') return undefined;
    let offset = 4;
    while (offset + 4 <= audio.length) {
      const header = audio[offset];
      const blockType = header & 0x7f;
      const blockSize = audio.readUIntBE(offset + 1, 3);
      const blockStart = offset + 4;
      if (blockType === 0 && blockSize >= 18 && blockStart + 18 <= audio.length) {
        // STREAMINFO packs sample rate (20 bits), channels (3 bits), and
        // sample size (5 bits) into bytes 10..14.
        const rate = (audio[blockStart + 10] * 4096)
          + (audio[blockStart + 11] * 16)
          + ((audio[blockStart + 12] & 0xf0) >> 4);
        return rate >= 8_000 && rate <= 384_000 ? rate : undefined;
      }
      offset = blockStart + blockSize;
      if (header & 0x80) break;
    }
    return undefined;
  }

  // Opus is decoded at 48 kHz by the reference decoder, regardless of the
  // input packet rate.  Vorbis stores its rate in the identification header.
  if (kind === 'opus' || (!kind && audio.includes(Buffer.from('OpusHead')))) return 48_000;
  if (kind === 'ogg' || kind === 'oga' || (!kind && audio.toString('ascii', 0, 4) === 'OggS')) {
    const vorbis = audio.indexOf(Buffer.from('vorbis'));
    if (vorbis >= 0 && vorbis + 14 <= audio.length) {
      // vorbis signature (6) -> version (4) -> channels (1) -> rate (4).
      const rate = audio.readUInt32LE(vorbis + 11);
      return rate >= 8_000 && rate <= 384_000 ? rate : undefined;
    }
    return undefined;
  }

  // ID3 tags can precede an MP3 frame. Scan a bounded prefix for a valid
  // MPEG audio header and map its version/sample-rate index.
  if (kind === 'mp3' || kind === 'mpeg' || (!kind && audio.toString('ascii', 0, 3) === 'ID3')) {
    let offset = 0;
    if (audio.toString('ascii', 0, 3) === 'ID3' && audio.length >= 10) {
      const tagSize = ((audio[6] & 0x7f) << 21) | ((audio[7] & 0x7f) << 14)
        | ((audio[8] & 0x7f) << 7) | (audio[9] & 0x7f);
      offset = 10 + tagSize + (audio[5] & 0x10 ? 10 : 0);
    }
    const limit = Math.min(audio.length - 4, offset + 128 * 1024);
    const rates: Record<number, number[]> = {
      3: [44_100, 48_000, 32_000], // MPEG-1
      2: [22_050, 24_000, 16_000], // MPEG-2
      0: [11_025, 12_000, 8_000], // MPEG-2.5
    };
    for (; offset <= limit; offset += 1) {
      if (audio[offset] !== 0xff || (audio[offset + 1] & 0xe0) !== 0xe0) continue;
      const version = (audio[offset + 1] >> 3) & 0x03;
      const layer = (audio[offset + 1] >> 1) & 0x03;
      const rateIndex = (audio[offset + 2] >> 2) & 0x03;
      const bitrateIndex = (audio[offset + 2] >> 4) & 0x0f;
      const rate = rates[version]?.[rateIndex];
      if (layer === 0 || rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15 || !rate) continue;
      return rate;
    }
    return undefined;
  }

  // AAC ADTS stores the frequency index in each frame header.
  if (kind === 'aac') {
    const rates = [96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350];
    for (let offset = 0; offset + 4 <= audio.length && offset < 128 * 1024; offset += 1) {
      if (audio[offset] !== 0xff || (audio[offset + 1] & 0xf6) !== 0xf0) continue;
      const rate = rates[(audio[offset + 2] >> 2) & 0x0f];
      if (rate) return rate;
    }
  }

  // WebM/Opus is also normally decoded at 48 kHz. WMA/AMR and container
  // formats without a small self-describing header require an explicit rate.
  if (kind === 'webm') return 48_000;
  return undefined;
}

export function buildOfficialSttRunTask(
  taskId: string,
  model: string,
  language = 'zh',
  format: OfficialAudioFormat = 'pcm',
  sampleRate = 16_000,
  maxSentenceSilence = 850,
): Record<string, unknown> {
  const hints = languageHints(language);
  return {
    header: {
      action: 'run-task',
      task_id: taskId,
      streaming: 'duplex',
    },
    payload: {
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model,
      parameters: {
        format,
        sample_rate: Math.min(384_000, Math.max(8_000, Math.trunc(Number(sampleRate) || 16_000))),
        max_sentence_silence: clampEndpointSilenceMs(maxSentenceSilence),
        heartbeat: true,
        ...(hints ? { language_hints: hints } : {}),
      },
      input: {},
    },
  };
}

export function buildOfficialSttFinishTask(taskId: string): Record<string, unknown> {
  return {
    header: {
      action: 'finish-task',
      task_id: taskId,
      streaming: 'duplex',
    },
    payload: { input: {} },
  };
}

export function parseOfficialSttMessage(value: unknown, model = DEFAULT_MODEL, expectedTaskId?: string): {
  event: string;
  result?: STTResult;
  error?: Error;
} {
  const message = value && typeof value === 'object' ? value as any : {};
  const event = String(message?.header?.event || '');
  if (message?.type === 'error' || (message?.error && typeof message.error === 'object')) {
    return {
      event: 'error',
      error: new Error(safeErrorMessage(
        message?.error?.message || message?.error?.code || message?.message || 'Official streaming STT gateway error',
      )),
    };
  }
  const responseTaskId = String(message?.header?.task_id || '');
  if (expectedTaskId && event && responseTaskId !== expectedTaskId) {
    return { event, error: new Error('Lumi Official API STT returned an event for a different task.') };
  }
  if (event === 'task-failed') {
    return {
      event,
      error: new Error(safeErrorMessage(
        message?.header?.error_message || message?.header?.error_code || 'Official streaming STT task failed',
      )),
    };
  }
  if (event !== 'result-generated') return { event };
  const sentence = message?.payload?.output?.sentence;
  if (!sentence || sentence.heartbeat === true) return { event };
  const text = String(sentence.text || '').trim();
  const isFinal = sentence.sentence_end === true;
  const speechStarted = sentence.sentence_begin === true;
  if (!text && !speechStarted) return { event };
  const beginMs = Number(sentence.begin_time);
  const endMs = Number(sentence.end_time);
  return {
    event,
    result: {
      text,
      isFinal,
      speechStarted,
      speechFinal: isFinal,
      model,
      ...(text ? {
        segments: [{
          text,
          ...(Number.isFinite(beginMs) ? { beginMs } : {}),
          ...(Number.isFinite(endMs) ? { endMs } : {}),
        }],
      } : {}),
      ...(message?.header?.task_id ? { taskId: String(message.header.task_id) } : {}),
    },
  };
}

/** Real-time PCM transcription through Lumi's documented official WebSocket route. */
export function createStream(
  language = 'zh',
  interimResults = true,
  options: OfficialStreamingOptions = {},
): StreamingSTTSession {
  // A role-specific model selected in Settings is an explicit snapshot for
  // this session. Deployment-level env configuration remains the fallback for
  // older databases that have no persisted selection.
  const model = normalizeLumiOfficialModel(
    'speech_recognition',
    String(options.model || officialApiModel('RELAY_STT_MODEL', DEFAULT_MODEL)).trim() || DEFAULT_MODEL,
  );
  const endpoint = officialApiPath('RELAY_STT_STREAM_PATH', '/audio/transcriptions/stream');
  const url = officialApiWebSocketUrl(endpoint, model);
  const WebSocketImpl = options.WebSocketImpl || WebSocket;
  const ws = new WebSocketImpl(url, {
    headers: officialApiHeaders(),
  });
  const taskId = randomUUID();
  const resultCallbacks: Array<(result: STTResult) => void> = [];
  const errorCallbacks: Array<(error: Error) => void> = [];
  const pendingAudio: Buffer[] = [];
  let pendingBytes = 0;
  let sessionReady = false;
  let endRequested = false;
  let finishSent = false;
  let closed = false;
  let errorNotified = false;
  let lastPartial = '';
  let finalEmitted = false;
  let endpointSilenceMs = clampEndpointSilenceMs(Number(process.env.RELAY_STT_SILENCE_MS || 850));

  const notifyError = (input: unknown) => {
    if (errorNotified || closed) return;
    errorNotified = true;
    const error = asError(input);
    const classified = classifyCloudError(error, PROVIDER);
    recordFailure(PROVIDER, model, error, {
      openImmediately: classified.category === 'auth' || classified.category === 'quota',
    });
    errorCallbacks.forEach(callback => callback(error));
  };

  const sendFinish = () => {
    if (finishSent || closed || !sessionReady || ws.readyState !== WebSocketImpl.OPEN) return;
    finishSent = true;
    ws.send(JSON.stringify(buildOfficialSttFinishTask(taskId)));
  };

  const sendAudio = (chunk: Buffer) => {
    if (closed || ws.readyState !== WebSocketImpl.OPEN) return;
    ws.send(chunk, { binary: true });
  };

  ws.on('open', () => {
    ws.send(JSON.stringify(buildOfficialSttRunTask(
      taskId,
      model,
      language,
      options.format || 'pcm',
      options.sampleRate || 16_000,
      endpointSilenceMs,
    )));
  });

  ws.on('message', (raw: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) return;
    try {
      const parsed = parseOfficialSttMessage(JSON.parse(String(raw)), model, taskId);
      if (parsed.event === 'task-started') {
        sessionReady = true;
        recordSuccess(PROVIDER, model);
        for (const chunk of pendingAudio.splice(0)) sendAudio(chunk);
        pendingBytes = 0;
        if (endRequested) sendFinish();
        return;
      }
      if (parsed.error) {
        notifyError(parsed.error);
        try { ws.close(); } catch {}
        return;
      }
      if (parsed.result) {
        const previousPartial = lastPartial;
        if (parsed.result.isFinal) {
          finalEmitted = true;
          lastPartial = '';
        } else if (parsed.result.text) {
          lastPartial = parsed.result.text;
        }
        if (parsed.result.isFinal || parsed.result.speechStarted
          || (interimResults && shouldEmitStreamingPartial(previousPartial, parsed.result.text))) {
          resultCallbacks.forEach(callback => callback(parsed.result!));
        }
      }
      if (parsed.event === 'task-finished') {
        if (!finalEmitted) {
          finalEmitted = true;
          resultCallbacks.forEach(callback => callback({
            text: lastPartial,
            isFinal: true,
            speechFinal: true,
            model,
            taskId,
          }));
          lastPartial = '';
        }
        closed = true;
        try { ws.close(1000, 'task finished'); } catch {}
      }
    } catch (error) {
      notifyError(new Error(`Lumi Official API STT returned an invalid event: ${safeErrorMessage(asError(error).message)}`));
    }
  });

  ws.on('error', (error: Error) => {
    notifyError(new Error(`Lumi Official API STT WebSocket error: ${safeErrorMessage(error.message)}`));
  });

  ws.on('close', (code: number, reason: Buffer) => {
    const expected = closed || (finishSent && code === 1000);
    pendingAudio.length = 0;
    pendingBytes = 0;
    if (!expected) {
      notifyError(new Error(`Lumi Official API STT closed before completion (code=${code}, reason=${safeErrorMessage(reason?.toString())})`));
    }
    closed = true;
  });

  return {
    sendAudio(chunk: Buffer) {
      if (closed || endRequested || !chunk?.length) return;
      const buffer = Buffer.from(chunk);
      if (sessionReady && ws.readyState === WebSocketImpl.OPEN) {
        sendAudio(buffer);
        return;
      }
      if (pendingBytes + buffer.length > MAX_PENDING_AUDIO_BYTES) {
        notifyError(new Error(`Lumi Official API STT handshake audio exceeded ${MAX_PENDING_AUDIO_BYTES} bytes.`));
        return;
      }
      pendingAudio.push(buffer);
      pendingBytes += buffer.length;
    },
    end() {
      if (closed || endRequested) return;
      endRequested = true;
      sendFinish();
    },
    flush() {
      if (closed || endRequested) return;
      endRequested = true;
      sendFinish();
    },
    updateEndpointing(silenceDurationMs: number) {
      endpointSilenceMs = clampEndpointSilenceMs(silenceDurationMs);
    },
    onResult(callback) { resultCallbacks.push(callback); },
    onError(callback) { errorCallbacks.push(callback); },
  };
}

/**
 * Backwards-compatible name kept for integrations compiled against the
 * previous buffered adapter.  The official route is now a real duplex stream;
 * retaining the export avoids a hard runtime break while giving callers the
 * corrected protocol and endpoint behavior.
 */
export function createBufferedSession(
  language = 'zh',
  interimResults = false,
  model?: string,
  _fetchImpl?: typeof fetch,
): StreamingSTTSession {
  return createStream(language, interimResults, { model });
}

/**
 * One-utterance compatibility wrapper for callers that still submit an audio
 * buffer. The official service only documents streaming STT, so this uses the
 * same production WebSocket path instead of the removed REST fallback.
 */
export async function transcribe(
  audioBuffer: Buffer,
  language = 'zh',
  options: OfficialAudioFileOptions = {},
): Promise<STTResult> {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    throw new Error('Lumi Official API STT received no audio data.');
  }
  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    throw new Error(`Audio input exceeds the ${MAX_AUDIO_BYTES} byte limit.`);
  }
  void options.fetchImpl;
  const format = audioFormat(options);
  const sampleRate = options.sampleRate
    || (format === 'pcm' ? 16_000 : detectOfficialAudioSampleRate(audioBuffer, format));
  if (!sampleRate) {
    throw new Error(
      `Lumi Official API STT could not determine the ${format.toUpperCase()} source sample rate. `
      + 'Provide sampleRate or use a self-describing WAV/MP3/Opus/AAC file.',
    );
  }
  const session = createStream(language, false, {
    model: options.model,
    format,
    sampleRate,
    WebSocketImpl: options.WebSocketImpl,
  });
  return new Promise<STTResult>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { session.end(); } catch {}
      reject(new Error('Lumi Official API STT timed out after 90 seconds.'));
    }, 90_000);
    const finish = (result?: STTResult, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ ...result!, isFinal: true });
    };
    session.onResult(result => {
      if (result.isFinal) finish(result);
    });
    session.onError(error => finish(undefined, error));
    options.signal?.addEventListener('abort', () => finish(undefined, asError(options.signal?.reason || 'STT aborted')), { once: true });
    session.sendAudio(audioBuffer);
    session.end();
  }).finally(() => {
    logger.debug('[Official-STT] one-utterance transcription finished');
  });
}
