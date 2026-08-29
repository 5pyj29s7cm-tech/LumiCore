/**
 * Cloud API Core — Central orchestration for all cloud-dependent operations.
 *
 * Provides:
 * 1. Unified retry + exponential backoff for all cloud calls
 * 2. Provider fallback chains (primary → secondary → fallback)
 * 3. Circuit breaker pattern (fail-fast when provider is down)
 * 4. Health check endpoint for monitoring provider status
 * 5. Error classification
 *
 * Every cloud-dependent module (LLM, STT, TTS, Messaging, Weather)
 * routes through this core for consistent error handling.
 */

import { withRetry, isCloudRetryable, withTimeout } from './retry';
export { withRetry, isCloudRetryable, withTimeout, withFallback, isCircuitClosed, isCircuitHealthy, recordSuccess, recordFailure, resetCircuit, getCircuitStatus, setCircuitBreakerConfig, getAvailableLLMProviders, getAvailableSTTProviders, getAvailableTTSProviders, LLM_PRIORITY, STT_PRIORITY, TTS_PRIORITY };
export type { RetryOptions } from './retry';

import { withFallback, getAvailableLLMProviders, getAvailableSTTProviders, getAvailableTTSProviders, LLM_PRIORITY, STT_PRIORITY, TTS_PRIORITY } from './fallback';
export type { FallbackResult, FallbackAttempt, FallbackChainOptions } from './fallback';

import { isCircuitClosed, isCircuitHealthy, recordSuccess, recordFailure, resetCircuit, getCircuitStatus, setCircuitBreakerConfig } from './circuit_breaker';
export type { CircuitState } from './circuit_breaker';

// ── Error Classification ──

export type CloudErrorCategory =
  | 'auth'              // Missing/invalid API key
  | 'quota'             // Rate limited / quota exceeded
  | 'timeout'           // Request timed out
  | 'network'           // Network error (DNS, connection refused, etc.)
  | 'server_error'      // 5xx server error
  | 'bad_request'       // 4xx client error (not auth)
  | 'circuit_open'      // Circuit breaker is open (fail-fast)
  | 'unknown';          // Unclassified

export interface ClassifiedError {
  category: CloudErrorCategory;
  message: string;
  isRetryable: boolean;
  provider?: string;
}

/**
 * Classify a cloud API error into a category with retry guidance.
 */
export function classifyCloudError(error: Error, provider?: string): ClassifiedError {
  const msg = error.message?.toLowerCase() || '';
  const attachedStatus = Number((error as Error & { status?: unknown; statusCode?: unknown }).status
    ?? (error as Error & { statusCode?: unknown }).statusCode);
  const hasStatus = (...codes: number[]) => codes.some(code => (
    attachedStatus === code || new RegExp(`(?:^|\\D)${code}(?:\\D|$)`).test(msg)
  ));

  if (msg.includes('circuit') || msg.includes('circuit breaker')) {
    return { category: 'circuit_open', message: error.message, isRetryable: true, provider };
  }

  if (
    msg.includes('not configured') ||
    msg.includes('invalid api key') ||
    msg.includes('unauthorized') ||
    msg.includes('authentication') ||
    hasStatus(401, 403)
  ) {
    return { category: 'auth', message: error.message, isRetryable: false, provider };
  }

  const billingFailure = hasStatus(402)
    || msg.includes('overdue')
    || msg.includes('payment required')
    || msg.includes('insufficient balance')
    || msg.includes('account is in good standing');
  if (
    billingFailure ||
    hasStatus(429) ||
    msg.includes('rate limit') ||
    msg.includes('quota') ||
    msg.includes('too many requests')
  ) {
    // Billing exhaustion cannot succeed by immediately retrying the same
    // provider. It still opens that provider's circuit immediately, while the
    // independent model dispatcher remains free to select a configured
    // fallback candidate.
    return { category: 'quota', message: error.message, isRetryable: !billingFailure, provider };
  }

  if (
    msg.includes('timeout') ||
    msg.includes('timed out')
  ) {
    return { category: 'timeout', message: error.message, isRetryable: true, provider };
  }

  if (
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('econnreset') ||
    msg.includes('network') ||
    msg.includes('fetch failed')
  ) {
    return { category: 'network', message: error.message, isRetryable: true, provider };
  }

  if (
    hasStatus(500, 502, 503, 504) ||
    msg.includes('internal server error') ||
    msg.includes('service unavailable')
  ) {
    return { category: 'server_error', message: error.message, isRetryable: true, provider };
  }

  if (
    hasStatus(400, 404, 422) ||
    msg.includes('bad request') ||
    msg.includes('not found') ||
    msg.includes('resource id is mismatched') ||
    msg.includes('no readable text')
  ) {
    return { category: 'bad_request', message: error.message, isRetryable: false, provider };
  }

  return { category: 'unknown', message: error.message, isRetryable: false, provider };
}

// ── Health Check ──

export interface ProviderHealth {
  provider: string;
  configured: boolean;
  circuitState: string;
  lastChecked: number;
}

/**
 * Get health status of all tracked cloud providers.
 * Returns which are configured, circuit state, etc.
 */
export function getCloudHealth(): {
  llm: ProviderHealth[];
  stt: ProviderHealth[];
  tts: ProviderHealth[];
  circuits: ReturnType<typeof getCircuitStatus>;
} {
  const llmProviders = getAvailableLLMProviders();
  const sttProviders = getAvailableSTTProviders();
  const ttsProviders = getAvailableTTSProviders();
  const circuits = getCircuitStatus();

  const toHealth = (
    provider: string,
    configured: boolean,
    circuitKeys: string[] = [provider],
  ): ProviderHealth => {
    const matching = circuits.filter(circuit => circuitKeys.some(key => (
      circuit.key === key || circuit.key.startsWith(`${key}:`)
    )));
    const circuit = matching.find(item => item.state === 'open')
      || matching.find(item => item.state === 'half-open')
      || matching[0];
    return {
      provider,
      configured,
      circuitState: circuit?.state || 'closed',
      lastChecked: Date.now(),
    };
  };

  return {
    // Keep the official gateway visible for diagnostics without adding it to
    // the automatic fallback priority. A health row is informational; route
    // selection still requires an explicit user choice/candidate.
    llm: [
      ...LLM_PRIORITY.map(p => toHealth(p.provider, llmProviders[p.provider] || false)),
      toHealth('relay', llmProviders.relay || false, ['relay']),
    ],
    stt: [...STT_PRIORITY.map(p => toHealth(
      p.provider,
      sttProviders[p.provider] || false,
      p.provider === 'qwen'
        ? ['qwen-stt', 'qwen']
        : p.provider === 'ark'
          ? ['doubao-stt-stream', 'ark']
          : ['openai'],
    )), toHealth('relay', sttProviders.relay || false, ['relay-stt'])],
    tts: [...TTS_PRIORITY.map(p => toHealth(
      p.provider,
      ttsProviders[p.provider] || false,
      p.provider === 'ark' ? ['doubao-tts'] : [p.provider],
    )), toHealth('relay', ttsProviders.relay || false, ['relay-tts'])],
    circuits,
  };
}
