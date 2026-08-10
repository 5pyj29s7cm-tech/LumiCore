import { STTResult, StreamingSTTSession } from '../types';
import { logger } from '../../../logger';
import { getKey } from '../../config/keys';
import { isCircuitClosed, recordSuccess, recordFailure } from '../../cloud/circuit_breaker';
import { classifyCloudError } from '../../cloud/core';
import { shouldEmitStreamingPartial } from '../partial_transcript';
import { clampEndpointSilenceMs } from '../adaptive_endpointing';

function getApiKey(): string {
  const key = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY
    || getKey('DASHSCOPE_API_KEY') || getKey('QWEN_API_KEY');
  if (!key) throw new Error('DASHSCOPE_API_KEY is not configured. Add it in Settings → Voice Services.');
  return key;
}

export interface QwenStreamSession extends StreamingSTTSession {}

const PROVIDER = 'qwen-stt';
const MAX_PENDING_AUDIO_CHUNKS = 32;

export function createStream(
  language: string = 'zh',
  interimResults: boolean = true,
): QwenStreamSession {
  if (!isCircuitClosed(PROVIDER)) {
    throw new Error('[CircuitBreaker] Qwen STT is temporarily unavailable (circuit open). The circuit will probe automatically after cooldown.');
  }

  const apiKey = getApiKey();
  const model = 'qwen3-asr-flash-realtime';
  const url = `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${model}`;

  const WebSocketImpl = (globalThis as any).WebSocket;
  if (!WebSocketImpl) {
    throw new Error('WebSocket not available. Requires Node.js 22+ or install ws package.');
  }

  const ws = new WebSocketImpl(url, {
    headers: { Authorization: `bearer ${apiKey}` },
  });

  const resultCallbacks: Array<(result: STTResult) => void> = [];
  const errorCallbacks: Array<(err: Error) => void> = [];
  const audioQueue: Buffer[] = [];
  let sessionReady = false;
  let eventCounter = 0;
  let ending = false;
  let errorNotified = false;
  let lastPartial = '';
  let endpointSilenceMs = clampEndpointSilenceMs(Number(process.env.QWEN_ASR_SILENCE_MS || 850));

  const queueAudio = (chunk: Buffer) => {
    // Preserve the opening of the utterance; a normal provider handshake
    // completes well before this roughly four-second PCM window fills.
    if (audioQueue.length < MAX_PENDING_AUDIO_CHUNKS) audioQueue.push(Buffer.from(chunk));
  };

  const notifyError = (err: Error) => {
    if (errorNotified || ending) return;
    errorNotified = true;
    errorCallbacks.forEach(callback => callback(err));
  };

  function nextId(): string {
    return `evt_${++eventCounter}_${Date.now()}`;
  }

  function sendSessionUpdate(): void {
    ws.send(JSON.stringify({
      event_id: nextId(),
      type: 'session.update',
      session: {
        input_audio_format: 'pcm',
        sample_rate: 16000,
        input_audio_transcription: { language },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.0,
          silence_duration_ms: endpointSilenceMs,
          prefix_padding_ms: 300,
        },
      },
    }));
  }

  ws.onopen = () => {
    logger.info('[Qwen-ASR] WebSocket connected, sending session.update');
    // Configure session: VAD mode, PCM 16kHz mono.
    sendSessionUpdate();
  };

  ws.onmessage = (event: MessageEvent) => {
    const raw = event.data as string;
    try {
      const msg = JSON.parse(raw);

      switch (msg.type) {
        case 'session.created':
          sessionReady = true;
          recordSuccess(PROVIDER);
          logger.info('[Qwen-ASR] Session ready');
          // Flush queued audio
          for (const chunk of audioQueue) {
            ws.send(JSON.stringify({
              event_id: nextId(),
              type: 'input_audio_buffer.append',
              audio: Buffer.from(chunk).toString('base64'),
            }));
          }
          audioQueue.length = 0;
          break;

        case 'input_audio_buffer.speech_started':
          lastPartial = '';
          resultCallbacks.forEach(callback => callback({ text: '', isFinal: false, speechStarted: true }));
          logger.info('[Qwen-ASR] Speech detected');
          break;

        case 'input_audio_buffer.speech_stopped':
          resultCallbacks.forEach(callback => callback({ text: '', isFinal: false, speechFinal: true }));
          logger.info('[Qwen-ASR] Speech ended');
          break;

        case 'conversation.item.input_audio_transcription.text': {
          const text = msg.text || '';
          const stash = msg.stash || '';
          const preview = text + stash;
          if (interimResults && shouldEmitStreamingPartial(lastPartial, preview)) {
            lastPartial = preview;
            resultCallbacks.forEach(cb => cb({ text: preview, isFinal: false }));
          }
          break;
        }

        case 'conversation.item.input_audio_transcription.completed': {
          const transcript = msg.transcript || '';
          logger.info(`[Qwen-ASR] Final: "${transcript}"`);
          if (transcript) {
            lastPartial = '';
            resultCallbacks.forEach(cb => cb({ text: transcript, isFinal: true }));
          }
          break;
        }

        case 'session.finished':
          ending = true;
          logger.info('[Qwen-ASR] Session finished');
          break;

        case 'error':
          {
            const err = new Error(msg.message || 'Qwen-ASR server error');
            const classified = classifyCloudError(err, PROVIDER);
            recordFailure(PROVIDER, undefined, err, {
              openImmediately: classified.category === 'auth' || classified.category === 'quota',
            });
            logger.error('[Qwen-ASR] Server error:', msg.message || msg);
            notifyError(err);
          }
          break;
      }
    } catch {
      // Binary data, ignore
    }
  };

  ws.onerror = (event: Event) => {
    const err = new Error(`Qwen-ASR WebSocket error: ${(event as any).message || event.type || 'unknown'}`);
    recordFailure(PROVIDER, undefined, err);
    logger.error('[Qwen-ASR] WebSocket error:', (event as any).message || event.type || 'unknown');
    notifyError(err);
  };

  ws.onclose = (event: CloseEvent) => {
    const err = new Error(`Qwen-ASR closed (code=${event.code}, reason=${event.reason || 'none'})`);
    if (!ending) {
      const classified = classifyCloudError(err, PROVIDER);
      recordFailure(PROVIDER, undefined, err, {
        openImmediately: classified.category === 'auth' || classified.category === 'quota',
      });
      notifyError(err);
    }
    logger.info(`[Qwen-ASR] Closed (code=${event.code}, reason=${event.reason || 'none'})`);
  };

  return {
    sendAudio(chunk: Buffer) {
      if (ending) return;
      if (ws.readyState !== WebSocketImpl.OPEN || !sessionReady) {
        queueAudio(chunk);
        return;
      }
      ws.send(JSON.stringify({
        event_id: nextId(),
        type: 'input_audio_buffer.append',
        audio: Buffer.from(chunk).toString('base64'),
      }));
    },
    end() {
      ending = true;
      audioQueue.length = 0;
      if (ws.readyState === WebSocketImpl.OPEN) {
        ws.send(JSON.stringify({ event_id: nextId(), type: 'session.finish' }));
        setTimeout(() => {
          try { ws.close(); } catch {}
        }, 500);
      }
    },
    updateEndpointing(silenceDurationMs: number) {
      endpointSilenceMs = clampEndpointSilenceMs(silenceDurationMs);
      if (!ending && sessionReady && ws.readyState === WebSocketImpl.OPEN) sendSessionUpdate();
    },
    onResult(callback) {
      resultCallbacks.push(callback);
    },
    onError(callback) {
      errorCallbacks.push(callback);
    },
  };
}
