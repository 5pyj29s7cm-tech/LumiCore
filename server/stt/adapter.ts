import { STTConfig, STTResult, STTProvider, StreamingSTTSession } from './types';
import * as whisper from './providers/whisper';
import * as qwen from './providers/qwen';
import * as ark from './providers/ark';
import * as arkStream from './providers/ark_stream';
import * as localWhisper from './providers/local-whisper';
import * as relay from './providers/official';
import { getKey } from '../config/keys';
import { getVoicePreference } from '../config/voice_preference';
import { recordLatency } from '../monitor/latency_store';
import { isCircuitClosed, isCircuitHealthy, recordFailure, recordSuccess } from '../cloud/circuit_breaker';
import { relayConfigured } from '../relay/config';

// The supplied official API guide does not define a realtime audio contract.
// Keep relay out
// of the realtime selector until an explicit streaming adapter is implemented;
// selecting it must not create a session whose final result is silently lost.
type StreamingSTTProvider = 'qwen' | 'ark';

function hasQwenKey(): boolean {
  return Boolean(process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY
    || getKey('DASHSCOPE_API_KEY') || getKey('QWEN_API_KEY'));
}

function hasOpenAIKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY || getKey('OPENAI_API_KEY'));
}

export async function transcribe(audioBuffer: Buffer, config: STTConfig): Promise<STTResult> {
  const start = Date.now();
  // Local Whisper is batch-only; use it only when installed.
  const effectiveProvider = config.provider === 'local-whisper' && !localWhisper.isLocalWhisperAvailable()
    ? getActiveSTTProvider()
    : config.provider;

  if (!effectiveProvider) {
    throw new Error('No STT provider configured. Configure local Whisper, DashScope, OpenAI Whisper, or Doubao Speech.');
  }

  let result: STTResult;
  switch (effectiveProvider) {
    case 'local-whisper':
      result = await localWhisper.transcribe(audioBuffer, config.language);
      break;
    case 'whisper':
      result = await whisper.transcribe(audioBuffer, config.language);
      break;
    case 'ark':
      result = await ark.transcribe(audioBuffer, config.language);
      break;
    case 'relay':
      try {
        result = await relay.transcribe(audioBuffer, config.language, { model: config.model });
        // Batch-only official STT uses its own shared circuit. Without this
        // accounting a failed endpoint would remain "healthy" forever and a
        // configured voice route would keep retrying it on every utterance.
        recordSuccess('relay-stt');
      } catch (error: any) {
        recordFailure('relay-stt', undefined, error instanceof Error ? error : new Error(String(error)), { openImmediately: true });
        throw error;
      }
      break;
    case 'qwen':
      result = await new Promise((resolve, reject) => {
        const session = qwen.createStream(config.language || 'zh', false);
        session.onResult((result) => {
          if (result.isFinal) resolve(result);
        });
        session.onError(reject);
        session.sendAudio(audioBuffer);
        session.end();
        setTimeout(() => resolve({ text: '', isFinal: false }), 8000);
      });
      break;
    default:
      throw new Error(`Unknown STT provider: ${config.provider}`);
  }
  recordLatency('stt', Date.now() - start);
  return result;
}

export function createStreamingSession(
  config: STTConfig,
): StreamingSTTSession {
  const provider = config.provider;
  if (provider === 'qwen') {
    return qwen.createStream(config.language, config.interimResults);
  }
  if (provider === 'ark') {
    return arkStream.createStream(config.language || 'zh-CN', config.interimResults);
  }
  if (provider === 'relay') {
    throw new Error('Lumi Official API STT is batch-only; configure a realtime STT provider for live microphone calls.');
  }
  throw new Error(`Streaming not supported for provider: ${provider}`);
}

export interface ResilientStreamingSessionOptions {
  reconnectDelaysMs?: number[];
  maxPendingChunks?: number;
  createSession?: (config: STTConfig) => StreamingSTTSession;
  onRecovering?: (details: { attempt: number; delayMs: number; error: Error }) => void;
  onRecovered?: (details: { attempt: number }) => void;
}

const NON_RECOVERABLE_STT_ERROR = /(?:api.?key|access.?token|not configured|auth|unauthori[sz]ed|forbidden|quota|circuit open|not supported)/i;

export function isRecoverableStreamingSTTError(error: Error): boolean {
  return !NON_RECOVERABLE_STT_ERROR.test(error.message || '');
}

/**
 * Keeps a realtime STT lane alive across short provider disconnects. Audio
 * received during recovery is bounded and replayed exactly once into the new
 * provider session. Configuration/auth failures still fail immediately.
 */
export function createResilientStreamingSession(
  config: STTConfig,
  options: ResilientStreamingSessionOptions = {},
): StreamingSTTSession {
  const reconnectDelaysMs = options.reconnectDelaysMs ?? [250, 750, 2_000];
  const maxPendingChunks = Math.max(1, options.maxPendingChunks ?? 32);
  const factory = options.createSession ?? createStreamingSession;
  const resultCallbacks: Array<(result: STTResult) => void> = [];
  const errorCallbacks: Array<(err: Error) => void> = [];
  const pendingAudio: Buffer[] = [];

  let active: StreamingSTTSession | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let recoveringAttempt = 0;
  let stopped = false;
  let terminalErrorSent = false;
  let terminalError: Error | null = null;
  let endpointSilenceMs: number | null = null;

  const emitTerminalError = (error: Error) => {
    if (terminalErrorSent || stopped) return;
    terminalErrorSent = true;
    terminalError = error;
    stopped = true;
    pendingAudio.length = 0;
    errorCallbacks.forEach(callback => callback(error));
  };

  const enqueueAudio = (chunk: Buffer) => {
    if (pendingAudio.length >= maxPendingChunks) return;
    pendingAudio.push(Buffer.from(chunk));
  };

  const scheduleRecovery = (error: Error) => {
    if (stopped || terminalErrorSent) return;
    if (!isRecoverableStreamingSTTError(error) || reconnectAttempt >= reconnectDelaysMs.length) {
      emitTerminalError(error);
      return;
    }
    const delayMs = Math.max(0, reconnectDelaysMs[reconnectAttempt] ?? 0);
    reconnectAttempt += 1;
    recoveringAttempt = reconnectAttempt;
    options.onRecovering?.({ attempt: reconnectAttempt, delayMs, error });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      startProviderSession();
    }, delayMs);
  };

  const handleProviderError = (providerSession: StreamingSTTSession, error: Error) => {
    if (stopped || active !== providerSession) return;
    active = null;
    try { providerSession.end(); } catch {}
    scheduleRecovery(error);
  };

  const attachProviderSession = (providerSession: StreamingSTTSession) => {
    active = providerSession;
    if (endpointSilenceMs !== null) providerSession.updateEndpointing?.(endpointSilenceMs);
    providerSession.onResult(result => {
      if (stopped || active !== providerSession) return;
      if (recoveringAttempt > 0) {
        options.onRecovered?.({ attempt: recoveringAttempt });
        recoveringAttempt = 0;
      }
      reconnectAttempt = 0;
      resultCallbacks.forEach(callback => callback(result));
    });
    providerSession.onError(error => handleProviderError(providerSession, error));
    for (const chunk of pendingAudio.splice(0)) providerSession.sendAudio(chunk);
  };

  function startProviderSession(): void {
    if (stopped) return;
    try {
      attachProviderSession(factory(config));
    } catch (error: any) {
      scheduleRecovery(error instanceof Error ? error : new Error(String(error)));
    }
  }

  startProviderSession();

  return {
    sendAudio(chunk: Buffer) {
      if (stopped) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!active) {
        enqueueAudio(buffer);
        return;
      }
      try {
        active.sendAudio(buffer);
      } catch (error: any) {
        enqueueAudio(buffer);
        handleProviderError(active, error instanceof Error ? error : new Error(String(error)));
      }
    },
    end() {
      if (stopped) return;
      stopped = true;
      pendingAudio.length = 0;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const providerSession = active;
      active = null;
      try { providerSession?.end(); } catch {}
    },
    updateEndpointing(silenceDurationMs: number) {
      endpointSilenceMs = silenceDurationMs;
      active?.updateEndpointing?.(silenceDurationMs);
    },
    onResult(callback) {
      resultCallbacks.push(callback);
    },
    onError(callback) {
      errorCallbacks.push(callback);
      if (terminalError) callback(terminalError);
    },
  };
}

export function getActiveSTTProvider(options: { requireHealthy?: boolean } = {}): STTProvider | null {
  const pref = getVoicePreference();
  const available = options.requireHealthy ? isCircuitHealthy : isCircuitClosed;
  const hasDoubao = arkStream.hasDoubaoSpeech();
  const qwenKey = hasQwenKey();
  const openaiKey = hasOpenAIKey();
  const relayReady = relayConfigured();
  if (pref.stt === 'local-whisper' && localWhisper.isLocalWhisperAvailable()) return 'local-whisper';
  if (pref.stt === 'qwen' && qwenKey && available('qwen-stt')) return 'qwen';
  if (pref.stt === 'ark' && hasDoubao && available('doubao-stt-stream')) return 'ark';
  if (pref.stt === 'whisper' && openaiKey && available('openai', 'whisper-1')) return 'whisper';
  if (pref.stt === 'relay' && relayReady && available('relay-stt')) return 'relay';
  // Auto mode and unavailable explicit selections — prefer healthy providers.
  try {
    if (localWhisper.isLocalWhisperAvailable()) return 'local-whisper';
  } catch {}
  if (hasDoubao && available('doubao-stt-stream')) return 'ark';
  if (qwenKey && available('qwen-stt')) return 'qwen';
  if (openaiKey && available('openai', 'whisper-1')) return 'whisper';
  // Do not silently opt an automatic microphone route into the billable
  // official gateway.  A relay selection remains available when explicitly
  // chosen in Voice settings (handled above).
  return null;
}

export function getActiveStreamingSTTProvider(options: { requireHealthy?: boolean } = {}): StreamingSTTProvider | null {
  const pref = getVoicePreference();
  const available = options.requireHealthy ? isCircuitHealthy : isCircuitClosed;
  const qwenKey = hasQwenKey();
  const doubaoSpeech = arkStream.hasDoubaoSpeech();

  if (pref.stt === 'qwen' && qwenKey && available('qwen-stt')) return 'qwen';
  if (pref.stt === 'ark' && doubaoSpeech && available('doubao-stt-stream')) return 'ark';
  // The official guide currently specifies REST file transcription only. Do
  // not silently replace an explicit official selection with another
  // provider's realtime stream; callers can use the batch lane instead.
  if (pref.stt === 'local-whisper' || pref.stt === 'whisper' || pref.stt === 'relay') return null;

  if (doubaoSpeech && available('doubao-stt-stream')) return 'ark';
  if (qwenKey && available('qwen-stt')) return 'qwen';
  return null;
}
