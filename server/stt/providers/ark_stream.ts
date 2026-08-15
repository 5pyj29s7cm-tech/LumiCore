import { randomUUID } from 'crypto';
import { gzipSync, gunzipSync } from 'zlib';
import { WebSocket } from 'ws';
import { STTResult, StreamingSTTSession } from '../types';
import { isCircuitClosed, recordFailure, recordSuccess } from '../../cloud/circuit_breaker';
import { logger } from '../../../logger';
import { shouldEmitStreamingPartial } from '../partial_transcript';
import {
  buildDoubaoApiHeaders,
  getDoubaoSpeechCredentialMode,
  getDoubaoStreamingAsrResourceId,
  hasDoubaoSpeechCredentials,
  requireDoubaoSpeechCredentials,
} from '../../config/doubao_speech';

const PROVIDER = 'doubao-stt-stream';
const DEFAULT_WS_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';
const MAX_PENDING_AUDIO_CHUNKS = 32;
const TERMINAL_PARTIAL_COMMIT_MS = 700;
const DEFAULT_PARTIAL_COMMIT_MS = 1_200;

const enum AsrMessageType {
  FullClientRequest = 0x1,
  AudioOnlyRequest = 0x2,
  FullServerResponse = 0x9,
  ServerAck = 0xb,
  ServerErrorResponse = 0xf,
}

const enum AsrFlag {
  NoSequence = 0x0,
  PosSequence = 0x1,
  NegSequence = 0x2,
  NegWithSequence = 0x3,
}

const enum Serialization {
  Raw = 0x0,
  Json = 0x1,
}

const enum Compression {
  None = 0x0,
  Gzip = 0x1,
}

export interface ArkStreamSession extends StreamingSTTSession {}

export function hasDoubaoSpeech(): boolean {
  return hasDoubaoSpeechCredentials();
}

function connectionHeaders(connectId: string): Record<string, string> {
  return {
    ...buildDoubaoApiHeaders(requireDoubaoSpeechCredentials()),
    'X-Api-Resource-Id': getDoubaoStreamingAsrResourceId(),
    'X-Api-Connect-Id': connectId,
  };
}

function mapLanguage(language?: string): string | undefined {
  const normalized = (language || '').trim().toLowerCase();
  if (!normalized || normalized === 'zh') return 'zh-CN';
  if (normalized === 'en') return 'en-US';
  return language;
}

function int32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(value, 0);
  return buf;
}

function uint32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value, 0);
  return buf;
}

function header(
  messageType: AsrMessageType,
  flag: AsrFlag,
  serialization: Serialization = Serialization.Json,
  compression: Compression = Compression.None,
): Buffer {
  return Buffer.from([
    (0x1 << 4) | 0x1,
    (messageType << 4) | flag,
    (serialization << 4) | compression,
    0x00,
  ]);
}

function buildFullClientRequest(sequence: number, payload: Record<string, unknown>, compress = true): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const body = compress ? gzipSync(json) : json;
  return Buffer.concat([
    header(
      AsrMessageType.FullClientRequest,
      AsrFlag.PosSequence,
      Serialization.Json,
      compress ? Compression.Gzip : Compression.None,
    ),
    int32(sequence),
    uint32(body.length),
    body,
  ]);
}

function buildAudioRequest(sequence: number, audio: Buffer, compress = true): Buffer {
  let effectiveSequence = sequence;
  let effectiveAudio = audio;
  let effectiveCompression = compress;
  if (audio.length === 0 && sequence > 0) {
    effectiveSequence = -sequence;
    effectiveCompression = false;
  }
  if (effectiveCompression) {
    effectiveAudio = gzipSync(effectiveAudio);
  }
  return Buffer.concat([
    header(
      AsrMessageType.AudioOnlyRequest,
      effectiveSequence > 0 ? AsrFlag.PosSequence : AsrFlag.NegWithSequence,
      Serialization.Raw,
      effectiveCompression ? Compression.Gzip : Compression.None,
    ),
    int32(effectiveSequence),
    uint32(effectiveAudio.length),
    effectiveAudio,
  ]);
}

function readPayloadJson(payload: Buffer, serialization: number, compression: number): unknown {
  let body = payload;
  if (compression === Compression.Gzip && body.length > 0) {
    body = gunzipSync(body);
  }
  if (serialization === Serialization.Json) {
    const text = body.toString('utf8').trim();
    return text ? JSON.parse(text) : null;
  }
  return body;
}

function parseResponse(data: Buffer): { sequence?: number; isLastPackage: boolean; message?: any; code?: number } {
  if (data.length < 4) return { isLastPackage: false };
  const headerSize = data[0] & 0x0f;
  const messageType = data[1] >> 4;
  const flags = data[1] & 0x0f;
  const serialization = data[2] >> 4;
  const compression = data[2] & 0x0f;
  let payload = data.subarray(headerSize * 4);
  const result: { sequence?: number; isLastPackage: boolean; message?: any; code?: number } = {
    isLastPackage: flags === AsrFlag.NegSequence || flags === AsrFlag.NegWithSequence,
  };

  let payloadBody: Buffer | null = null;
  if (messageType === AsrMessageType.FullServerResponse) {
    if ((flags === AsrFlag.PosSequence || flags === AsrFlag.NegWithSequence) && payload.length >= 4) {
      result.sequence = payload.readInt32BE(0);
      payload = payload.subarray(4);
    }
    if (payload.length >= 4) {
      const size = payload.readUInt32BE(0);
      payloadBody = payload.subarray(4, 4 + size);
    }
  } else if (messageType === AsrMessageType.ServerAck) {
    if (flags !== AsrFlag.NoSequence && payload.length >= 4) {
      result.sequence = payload.readInt32BE(0);
      payload = payload.subarray(4);
    }
    if (payload.length >= 4) {
      const size = payload.readUInt32BE(0);
      payloadBody = payload.subarray(4, 4 + size);
    }
  } else if (messageType === AsrMessageType.ServerErrorResponse) {
    if (payload.length >= 8) {
      result.code = payload.readUInt32BE(0);
      const size = payload.readUInt32BE(4);
      payloadBody = payload.subarray(8, 8 + size);
      result.isLastPackage = true;
    }
  }

  if (payloadBody && payloadBody.length > 0) {
    result.message = readPayloadJson(payloadBody, serialization, compression);
  }
  if (typeof result.sequence === 'number' && result.sequence < 0) {
    result.isLastPackage = true;
  }
  return result;
}

export const __doubaoStreamingProtocolForTests = Object.freeze({
  buildAudioRequest,
  buildRequest,
  getStablePartialCommitDelayMs,
  getUncommittedTranscript,
  parseResponse,
  extractText,
});

function getStablePartialCommitDelayMs(text: string): number {
  return /[。！？!?…][”’」』】）)]?$/.test(String(text || '').trim())
    ? TERMINAL_PARTIAL_COMMIT_MS
    : DEFAULT_PARTIAL_COMMIT_MS;
}

function getUncommittedTranscript(committed: string, current: string): string {
  const previous = String(committed || '').trim();
  const next = String(current || '').trim();
  if (!next || next === previous || previous.startsWith(next)) return '';
  if (previous && next.startsWith(previous)) return next.slice(previous.length).trim();
  return next;
}

function buildRequest(language?: string): Record<string, unknown> {
  return {
    user: {
      uid: 'lumi_user',
      platform: process.platform,
      app_version: process.env.npm_package_version || '3.0.0',
    },
    audio: {
      format: 'pcm',
      codec: 'raw',
      rate: 16000,
      bits: 16,
      channel: 1,
      language: mapLanguage(language),
    },
    request: {
      model_name: process.env.DOUBAO_ASR_MODEL || 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: false,
      show_utterances: true,
      result_type: 'full',
      vad_segment_duration: Number(process.env.DOUBAO_ASR_VAD_SEGMENT_MS || 3000),
      end_window_size: Number(process.env.DOUBAO_ASR_END_WINDOW_MS || 800),
      // `0` lets the provider's VAD close an utterance after end_window_size.
      // A positive 10s default kept ordinary microphone sessions in interim
      // mode until the entire WebSocket was closed: subtitles appeared, but no
      // final transcript ever reached Lumi's response pipeline.
      force_to_speech_time: Number(process.env.DOUBAO_ASR_FORCE_TO_SPEECH_MS || 0),
    },
  };
}

function extractText(message: any): { text: string; isFinal: boolean } | null {
  if (!message) return null;
  const msg = message.message || message;
  const result = msg.result || msg.results || msg;
  const firstResult = Array.isArray(result) ? result[0] : result;
  const text = String(
    firstResult?.text
    || firstResult?.transcript
    || msg.text
    || msg.transcript
    || '',
  ).trim();
  if (!text) return null;

  const utterances = firstResult?.utterances || msg.utterances || [];
  const latestUtterance = Array.isArray(utterances) && utterances.length > 0
    ? utterances[utterances.length - 1]
    : null;
  const utteranceFinal = Boolean(
    latestUtterance?.definite === true || latestUtterance?.is_final === true,
  );
  const explicitFinal = firstResult?.definite === true
    || firstResult?.is_final === true
    || firstResult?.final === true
    || msg.is_final === true
    || msg.final === true;

  return { text, isFinal: utteranceFinal || explicitFinal };
}

function emitError(callbacks: Array<(err: Error) => void>, err: Error) {
  recordFailure(PROVIDER, undefined, err);
  callbacks.forEach(cb => cb(err));
}

export function createStream(
  language: string = 'zh-CN',
  interimResults: boolean = true,
): ArkStreamSession {
  if (!isCircuitClosed(PROVIDER)) {
    throw new Error('[CircuitBreaker] Doubao STT is temporarily unavailable (circuit open). The circuit will probe automatically after cooldown.');
  }

  const url = process.env.DOUBAO_ASR_WS_URL || DEFAULT_WS_URL;
  const ws = new WebSocket(url, {
    headers: connectionHeaders(randomUUID()),
  });

  const resultCallbacks: Array<(result: STTResult) => void> = [];
  const errorCallbacks: Array<(err: Error) => void> = [];
  const audioQueue: Buffer[] = [];
  let sequence = 1;
  let sessionReady = false;
  let closed = false;
  let ending = false;
  let errorNotified = false;
  let lastPartial = '';
  let committedTranscript = '';
  let scheduledTranscript = '';
  let stablePartialTimer: ReturnType<typeof setTimeout> | null = null;

  const queueAudio = (chunk: Buffer) => {
    if (audioQueue.length < MAX_PENDING_AUDIO_CHUNKS) audioQueue.push(Buffer.from(chunk));
  };

  const notifyError = (error: Error) => {
    if (errorNotified || ending) return;
    errorNotified = true;
    if (stablePartialTimer) clearTimeout(stablePartialTimer);
    stablePartialTimer = null;
    emitError(errorCallbacks, error);
  };

  const emitFinalTranscript = (aggregateText: string, source: 'provider' | 'stable-partial') => {
    if (stablePartialTimer) clearTimeout(stablePartialTimer);
    stablePartialTimer = null;
    scheduledTranscript = '';
    const text = getUncommittedTranscript(committedTranscript, aggregateText);
    if (!text) return;
    committedTranscript = aggregateText.trim();
    lastPartial = '';
    logger.info(`[Doubao-ASR] Final (${source}): "${text}"`);
    resultCallbacks.forEach(cb => cb({ text, isFinal: true, speechFinal: true, model: 'doubao-bigmodel' }));
  };

  const scheduleStablePartialCommit = (aggregateText: string) => {
    if (ending || closed || aggregateText === scheduledTranscript) return;
    if (stablePartialTimer) clearTimeout(stablePartialTimer);
    scheduledTranscript = aggregateText;
    stablePartialTimer = setTimeout(() => {
      stablePartialTimer = null;
      if (ending || closed || scheduledTranscript !== aggregateText) return;
      emitFinalTranscript(aggregateText, 'stable-partial');
    }, getStablePartialCommitDelayMs(aggregateText));
  };

  function sendAudioFrame(chunk: Buffer) {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    ws.send(buildAudioRequest(++sequence, chunk));
  }

  ws.on('open', () => {
    logger.info('[Doubao-ASR] WebSocket connected, sending full client request');
    ws.send(buildFullClientRequest(sequence, buildRequest(language)));
  });

  ws.on('message', (raw: WebSocket.RawData) => {
    try {
      const packet = parseResponse(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as any));
      if (packet.code) {
        const detail = typeof packet.message === 'string' ? packet.message : JSON.stringify(packet.message || {});
        throw new Error(`Doubao-ASR server error ${packet.code}: ${detail}`);
      }

      if (!sessionReady) {
        sessionReady = true;
        recordSuccess(PROVIDER);
        logger.info('[Doubao-ASR] Session ready');
        for (const chunk of audioQueue.splice(0)) sendAudioFrame(chunk);
      }

      const extracted = extractText(packet.message);
      if (extracted) {
        const isFinal = packet.isLastPackage || extracted.isFinal;
        if (isFinal) {
          emitFinalTranscript(extracted.text, 'provider');
        } else {
          const pendingText = getUncommittedTranscript(committedTranscript, extracted.text);
          if (pendingText && interimResults && shouldEmitStreamingPartial(lastPartial, pendingText)) {
            lastPartial = pendingText;
            resultCallbacks.forEach(cb => cb({ text: pendingText, isFinal: false, model: 'doubao-bigmodel' }));
          }
          if (pendingText) scheduleStablePartialCommit(extracted.text);
        }
      }
    } catch (err: any) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error('[Doubao-ASR] Response parse error:', error.message);
      notifyError(error);
    }
  });

  ws.on('error', (err: Error) => {
    logger.error('[Doubao-ASR] WebSocket error:', err.message);
    notifyError(new Error(`Doubao-ASR WebSocket error: ${err.message}`));
  });

  ws.on('close', (code: number, reason: Buffer) => {
    closed = true;
    if (stablePartialTimer) clearTimeout(stablePartialTimer);
    stablePartialTimer = null;
    if (!ending) {
      notifyError(new Error(`Doubao-ASR closed (code=${code}, reason=${reason?.toString() || 'none'})`));
    }
    logger.info(`[Doubao-ASR] Closed (code=${code}, reason=${reason?.toString() || 'none'})`);
  });

  return {
    sendAudio(chunk: Buffer) {
      if (ending) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!sessionReady || ws.readyState !== WebSocket.OPEN) {
        queueAudio(buffer);
        return;
      }
      sendAudioFrame(buffer);
    },
    end() {
      if (closed) return;
      ending = true;
      if (stablePartialTimer) clearTimeout(stablePartialTimer);
      stablePartialTimer = null;
      audioQueue.length = 0;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(buildAudioRequest(++sequence, Buffer.alloc(0), false));
        setTimeout(() => {
          try { ws.close(); } catch {}
        }, 500);
      } else {
        try { ws.close(); } catch {}
      }
    },
    onResult(callback) {
      resultCallbacks.push(callback);
    },
    onError(callback) {
      errorCallbacks.push(callback);
    },
  };
}

export interface DoubaoStreamingProbeResult {
  ok: true;
  credentialMode: 'api-key';
  endpoint: string;
  resourceId: string;
  latencyMs: number;
}

export async function probeDoubaoStreamingConnection(
  options: { timeoutMs?: number; language?: string } = {},
): Promise<DoubaoStreamingProbeResult> {
  const timeoutMs = Math.max(1_000, Math.min(30_000, options.timeoutMs || 8_000));
  const language = options.language || 'zh-CN';
  const endpoint = process.env.DOUBAO_ASR_WS_URL || DEFAULT_WS_URL;
  const resourceId = getDoubaoStreamingAsrResourceId();
  const credentialMode = getDoubaoSpeechCredentialMode();
  if (!credentialMode) requireDoubaoSpeechCredentials();
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint, { headers: connectionHeaders(randomUUID()) });
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`Doubao-ASR probe timed out after ${timeoutMs}ms`)), timeoutMs);

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (error) {
        recordFailure(PROVIDER, undefined, error);
        reject(error);
        return;
      }
      recordSuccess(PROVIDER);
      resolve({
        ok: true,
        credentialMode: credentialMode!,
        endpoint,
        resourceId,
        latencyMs: Date.now() - startedAt,
      });
    };

    ws.once('open', () => {
      try {
        ws.send(buildFullClientRequest(1, buildRequest(language)));
      } catch (error: any) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    ws.once('message', (raw: WebSocket.RawData) => {
      try {
        const packet = parseResponse(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as any));
        if (packet.code) {
          const detail = typeof packet.message === 'string' ? packet.message : JSON.stringify(packet.message || {});
          finish(new Error(`Doubao-ASR server error ${packet.code}: ${detail}`));
          return;
        }
        finish();
      } catch (error: any) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    ws.once('unexpected-response', (_request, response) => {
      const messageHeader = response.headers['x-api-message'];
      const message = Array.isArray(messageHeader) ? messageHeader.join(', ') : messageHeader;
      const logIdHeader = response.headers['x-tt-logid'];
      const logId = Array.isArray(logIdHeader) ? logIdHeader[0] : logIdHeader;
      finish(new Error(
        `Doubao-ASR authentication handshake failed with HTTP ${response.statusCode || 'unknown'}`
        + `${message ? `: ${message}` : ''}`
        + `${logId ? ` [logid=${logId}]` : ''}`,
      ));
    });
    ws.once('error', (error: Error) => finish(new Error(`Doubao-ASR WebSocket error: ${error.message}`)));
    ws.once('close', (code: number, reason: Buffer) => {
      if (!settled) finish(new Error(`Doubao-ASR probe closed before acknowledgement (code=${code}, reason=${reason?.toString() || 'none'})`));
    });
  });
}
