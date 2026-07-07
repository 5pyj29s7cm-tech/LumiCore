import { STTConfig, STTResult, STTProvider } from './types';
import * as whisper from './providers/whisper';
import * as qwen from './providers/qwen';
import * as ark from './providers/ark';
import * as localWhisper from './providers/local-whisper';
import { getKey } from '../config/keys';
import { getVoicePreference } from '../config/voice_preference';
import { recordLatency } from '../monitor/latency_store';
import { isCircuitClosed } from '../cloud/circuit_breaker';

type StreamingSTTProvider = 'qwen';

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
): qwen.QwenStreamSession {
  const provider = config.provider;
  if (provider === 'qwen') {
    return qwen.createStream(config.language, config.interimResults);
  }
  throw new Error(`Streaming not supported for provider: ${provider}`);
}

export function getActiveSTTProvider(): STTProvider | null {
  const pref = getVoicePreference();
  // If user explicitly chose a provider, use it (even if circuit is open — user knows best)
  if (pref.stt === 'local-whisper' && localWhisper.isLocalWhisperAvailable()) return 'local-whisper';
  if (pref.stt === 'qwen') return 'qwen';
  if (pref.stt === 'ark') return 'ark';
  if (pref.stt === 'whisper') return 'whisper';
  // Auto mode — prefer local, then healthy cloud providers
  try {
    if (localWhisper.isLocalWhisperAvailable()) return 'local-whisper';
  } catch {}
  const doubaoSpeech = process.env.DOUBAO_SPEECH_KEY || getKey('DOUBAO_SPEECH_KEY');
  if (doubaoSpeech && doubaoSpeech.includes(':')) return 'ark';
  // Check every cloud provider — skip ones with open circuit breakers
  const qwenKey = hasQwenKey();
  if (qwenKey && isCircuitClosed('qwen')) return 'qwen';
  // Fallback: try them anyway if nothing healthy (circuit may have recovered)
  if (qwenKey) return 'qwen';
  if (hasOpenAIKey()) return 'whisper';
  return null;
}

export function getActiveStreamingSTTProvider(): StreamingSTTProvider | null {
  const pref = getVoicePreference();
  const qwenKey = hasQwenKey();

  if (pref.stt === 'qwen') return qwenKey ? 'qwen' : null;
  if (pref.stt === 'local-whisper' || pref.stt === 'ark' || pref.stt === 'whisper') return null;

  if (qwenKey && isCircuitClosed('qwen-stt')) return 'qwen';
  if (qwenKey) return 'qwen';
  return null;
}
