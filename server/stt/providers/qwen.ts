import { STTResult } from '../types';
import { logger } from '../../../logger';
import { getKey } from '../../config/keys';
import { isCircuitClosed, recordSuccess, recordFailure } from '../../cloud/circuit_breaker';
import { classifyCloudError } from '../../cloud/core';

function getApiKey(): string {
  const key = process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY
    || getKey('DASHSCOPE_API_KEY') || getKey('QWEN_API_KEY');
  if (!key) throw new Error('DASHSCOPE_API_KEY is not configured. Add it in Settings → Voice Services.');
  return key;
}

export interface QwenStreamSession {
  sendAudio(chunk: Buffer): void;
  end(): void;
  onResult: (callback: (result: STTResult) => void) => void;
  onError: (callback: (err: Error) => void) => void;
}

const PROVIDER = 'qwen-stt';

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

  function nextId(): string {
    return `evt_${++eventCounter}_${Date.now()}`;
  }

  ws.onopen = () => {
    logger.info('[Qwen-ASR] WebSocket connected, sending session.update');

    // Configure session: VAD mode, PCM 16kHz mono
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
          silence_duration_ms: 1000,
          prefix_padding_ms: 300,
        },
      },
    }));
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
          logger.info('[Qwen-ASR] Speech detected');
          break;

        case 'input_audio_buffer.speech_stopped':
          logger.info('[Qwen-ASR] Speech ended');
          break;

        case 'conversation.item.input_audio_transcription.text': {
          const text = msg.text || '';
          const stash = msg.stash || '';
          const preview = text + stash;
          if (preview && interimResults) {
            resultCallbacks.forEach(cb => cb({ text: preview, isFinal: false }));
          }
          break;
        }

        case 'conversation.item.input_audio_transcription.completed': {
          const transcript = msg.transcript || '';
          logger.info(`[Qwen-ASR] Final: "${transcript}"`);
          if (transcript) {
            resultCallbacks.forEach(cb => cb({ text: transcript, isFinal: true }));
          }
          break;
        }

        case 'session.finished':
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
            errorCallbacks.forEach(cb => cb(err));
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
    errorCallbacks.forEach(cb => cb(new Error('Qwen-ASR WebSocket error')));
  };

  ws.onclose = (event: CloseEvent) => {
    if (event.code !== 1000 && event.code !== 1001 && event.code !== 0) {
      const err = new Error(`Qwen-ASR closed (code=${event.code}, reason=${event.reason || 'none'})`);
      const classified = classifyCloudError(err, PROVIDER);
      recordFailure(PROVIDER, undefined, err, {
        openImmediately: classified.category === 'auth' || classified.category === 'quota',
      });
    }
    logger.info(`[Qwen-ASR] Closed (code=${event.code}, reason=${event.reason || 'none'})`);
  };

  return {
    sendAudio(chunk: Buffer) {
      if (ws.readyState !== WebSocketImpl.OPEN) return;
      if (!sessionReady) {
        audioQueue.push(chunk);
        return;
      }
      ws.send(JSON.stringify({
        event_id: nextId(),
        type: 'input_audio_buffer.append',
        audio: Buffer.from(chunk).toString('base64'),
      }));
    },
    end() {
      if (ws.readyState === WebSocketImpl.OPEN) {
        ws.send(JSON.stringify({ event_id: nextId(), type: 'session.finish' }));
        setTimeout(() => {
          try { ws.close(); } catch {}
        }, 500);
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
