/**
 * Provider Fallback Chains — auto-fallback between cloud providers.
 *
 * Each service (LLM, STT, TTS) has a prioritized list of providers.
 * If the primary provider fails (circuit open, auth error, timeout, 5xx),
 * the system transparently falls back to the next available provider.
 */

import { isCircuitClosed, recordFailure, recordSuccess } from './circuit_breaker';
import { isCloudRetryable } from './retry';
import { getKey } from '../config/keys';
import fs from 'fs';
import path from 'path';

// ── Provider Priority Lists ──

export const LLM_PRIORITY: Array<{ provider: string; label: string }> = [
  { provider: 'deepseek', label: 'DeepSeek' },
  { provider: 'qwen', label: 'Qwen' },
  { provider: 'openai', label: 'OpenAI' },
  { provider: 'gemini', label: 'Gemini' },
  { provider: 'anthropic', label: 'Anthropic' },
  { provider: 'glm', label: 'GLM / 智谱' },
];

export const STT_PRIORITY: Array<{ provider: string; label: string }> = [
  { provider: 'ark', label: 'Doubao-ASR' },
  { provider: 'qwen', label: 'Qwen-ASR' },
  { provider: 'whisper', label: 'Whisper' },
];

export const TTS_PRIORITY: Array<{ provider: string; label: string }> = [
  { provider: 'local-cosyvoice', label: 'Local CosyVoice' },
  { provider: 'ark', label: 'Doubao TTS' },
  { provider: 'cosyvoice', label: 'DashScope CosyVoice' },
  { provider: 'gptsovits', label: 'GPT-SoVITS' },
];

// ── Fallback Chain ──

export interface FallbackChainOptions {
  /** Override the default priority list */
  priority?: Array<{ provider: string; label: string }>;
  /** Provider availability checkers: return true if the provider is configured */
  availabilityCheckers: Record<string, () => boolean>;
  /** Whether to fall through providers on transient errors (default: true) */
  cascadeOnRetryable?: boolean;
  /** Whether to fall through on non-retryable (auth) errors (default: false) */
  cascadeOnNonRetryable?: boolean;
}

export interface FallbackAttempt {
  provider: string;
  label: string;
  success: boolean;
  error?: string;
  durationMs: number;
}

export interface FallbackResult<T> {
  value: T;
  provider: string;
  label: string;
  attempts: FallbackAttempt[];
}

/**
 * Execute a function across a fallback chain of providers.
 * Tries providers in priority order. If one fails (and cascade is enabled),
 * tries the next available provider.
 *
 * @param execute - Async function that takes a provider name and returns the result
 * @param options - Fallback chain configuration
 * @returns The first successful result along with the attempt log
 * @throws If ALL providers fail, throws the LAST error
 */
export async function withFallback<T>(
  execute: (provider: string) => Promise<T>,
  options: FallbackChainOptions,
): Promise<FallbackResult<T>> {
  const priority = options.priority || [];
  const cascadeOnRetryable = options.cascadeOnRetryable !== false;
  const cascadeOnNonRetryable = options.cascadeOnNonRetryable || false;
  const attempts: FallbackAttempt[] = [];
  let lastError: Error | undefined;

  for (const { provider, label } of priority) {
    // Check if provider is configured
    const isAvailable = options.availabilityCheckers[provider];
    if (isAvailable && !isAvailable()) {
      attempts.push({
        provider,
        label,
        success: false,
        error: 'Not configured (no API key)',
        durationMs: 0,
      });
      continue;
    }

    // Circuit breaker check
    if (!isCircuitClosed(provider)) {
      attempts.push({
        provider,
        label,
        success: false,
        error: 'Circuit breaker open',
        durationMs: 0,
      });
      console.log(`[Fallback] ${label} circuit is OPEN — skipping`);
      continue;
    }

    const start = Date.now();
    try {
      const value = await execute(provider);
      const durationMs = Date.now() - start;
      recordSuccess(provider);

      attempts.push({
        provider,
        label,
        success: true,
        durationMs,
      });

      return { value, provider, label, attempts };
    } catch (err: any) {
      const durationMs = Date.now() - start;
      lastError = err;
      const isRetryable = isCloudRetryable(err);

      recordFailure(provider, undefined, err);

      attempts.push({
        provider,
        label,
        success: false,
        error: err.message || String(err),
        durationMs,
      });

      console.log(`[Fallback] ${label} failed (${err.message?.slice(0, 80)}) — ${isRetryable ? 'retryable' : 'non-retryable'}`);

      // Decide whether to cascade to next provider
      if (isRetryable && !cascadeOnRetryable) {
        throw err; // Don't cascade retryable errors
      }
      if (!isRetryable && !cascadeOnNonRetryable) {
        throw err; // Don't cascade non-retryable (auth) errors
      }
      // Otherwise, continue to next provider
    }
  }

  // All providers failed
  throw lastError || new Error('All providers exhausted');
}

/**
 * Check which LLM providers have API keys configured.
 * Uses environment variables.
 */
export function getAvailableLLMProviders(): Record<string, boolean> {
  return {
    deepseek: !!(process.env.DEEPSEEK_API_KEY || getKey('DEEPSEEK_API_KEY')),
    qwen: !!(process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || getKey('DASHSCOPE_API_KEY') || getKey('QWEN_API_KEY')),
    openai: !!(process.env.OPENAI_API_KEY || getKey('OPENAI_API_KEY')),
    gemini: !!(process.env.GEMINI_API_KEY || getKey('GEMINI_API_KEY')),
    anthropic: !!(process.env.ANTHROPIC_API_KEY || getKey('ANTHROPIC_API_KEY')),
    glm: !!(process.env.GLM_API_KEY || getKey('GLM_API_KEY')),
  };
}

/**
 * Check which STT providers have API keys configured.
 */
export function getAvailableSTTProviders(): Record<string, boolean> {
  const doubaoSpeech = process.env.DOUBAO_SPEECH_KEY || getKey('DOUBAO_SPEECH_KEY') || '';
  return {
    ark: doubaoSpeech.includes(':'),
    qwen: !!(process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || getKey('DASHSCOPE_API_KEY') || getKey('QWEN_API_KEY')),
    whisper: !!(process.env.OPENAI_API_KEY || getKey('OPENAI_API_KEY')),
  };
}

/**
 * Check which TTS providers have API keys configured.
 */
export function getAvailableTTSProviders(): Record<string, boolean> {
  const gptSovitsDir = path.join(process.cwd(), 'gpt-sovits-src');
  const doubaoSpeech = process.env.DOUBAO_SPEECH_KEY || getKey('DOUBAO_SPEECH_KEY') || '';
  return {
    'local-cosyvoice': !!(
      process.env.LOCAL_COSYVOICE_ENABLED === 'true'
      || process.env.LOCAL_COSYVOICE_API_URL
      || process.env.COSYVOICE_LOCAL_API_URL
    ),
    ark: doubaoSpeech.includes(':'),
    cosyvoice: !!(process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || getKey('DASHSCOPE_API_KEY') || getKey('QWEN_API_KEY')),
    gptsovits: !!(
      process.env.GPTSOVITS_API_URL
      || process.env.GPTSOVITS_ENABLED === 'true'
      || getKey('GPTSOVITS_API_URL')
      || (
        fs.existsSync(path.join(gptSovitsDir, 'venv', 'Scripts', 'python.exe'))
        && fs.existsSync(path.join(gptSovitsDir, 'api_v2.py'))
      )
    ),
  };
}
