import { STTConfig, STTResult, STTProvider } from './types';
import * as whisper from './providers/whisper';
import * as qwen from './providers/qwen';
import * as ark from './providers/ark';
import * as arkStream from './providers/ark_stream';
import * as localWhisper from './providers/local-whisper';
import { getKey } from '../config/keys';
import { getVoicePreference } from '../config/voice_preference';
import { recordLatency } from '../monitor/latency_store';
import { isCircuitClosed, isCircuitHealthy } from '../cloud/circuit_breaker';

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
): qwen.QwenStreamSession | arkStream.ArkStreamSession {
  const provider = config.provider;
  if (provider === 'qwen') {
    return qwen.createStream(config.language, config.interimResults);
  }
  if (provider === 'ark') {
    return arkStream.createStream(config.language || 'zh-CN', config.interimResults);
  }
  throw new Error(`Streaming not supported for provider: ${provider}`);
}

export function getActiveSTTProvider(options: { requireHealthy?: boolean } = {}): STTProvider | null {
  const pref = getVoicePreference();
  const available = options.requireHealthy ? isCircuitHealthy : isCircuitClosed;
  const doubaoSpeech = process.env.DOUBAO_SPEECH_KEY || getKey('DOUBAO_SPEECH_KEY');
  const hasDoubao = Boolean(doubaoSpeech && doubaoSpeech.includes(':'));
  const qwenKey = hasQwenKey();
  const openaiKey = hasOpenAIKey();
  if (pref.stt === 'local-whisper' && localWhisper.isLocalWhisperAvailable()) return 'local-whisper';
  if (pref.stt === 'qwen' && qwenKey && available('qwen-stt')) return 'qwen';
  if (pref.stt === 'ark' && hasDoubao && available('doubao-stt-stream')) return 'ark';
  if (pref.stt === 'whisper' && openaiKey && available('openai', 'whisper-1')) return 'whisper';
  // Auto mode and unavailable explicit selections — prefer healthy providers.
  try {
    if (localWhisper.isLocalWhisperAvailable()) return 'local-whisper';
  } catch {}
  if (hasDoubao && available('doubao-stt-stream')) return 'ark';
  if (qwenKey && available('qwen-stt')) return 'qwen';
  if (openaiKey && available('openai', 'whisper-1')) return 'whisper';
  return null;
}

export function getActiveStreamingSTTProvider(options: { requireHealthy?: boolean } = {}): StreamingSTTProvider | null {
  const pref = getVoicePreference();
  const available = options.requireHealthy ? isCircuitHealthy : isCircuitClosed;
  const qwenKey = hasQwenKey();
  const doubaoSpeech = arkStream.hasDoubaoSpeech();

  if (pref.stt === 'qwen' && qwenKey && available('qwen-stt')) return 'qwen';
  if (pref.stt === 'ark' && doubaoSpeech && available('doubao-stt-stream')) return 'ark';
  if (pref.stt === 'local-whisper' || pref.stt === 'whisper') return null;

  if (doubaoSpeech && available('doubao-stt-stream')) return 'ark';
  if (qwenKey && available('qwen-stt')) return 'qwen';
  return null;
}
