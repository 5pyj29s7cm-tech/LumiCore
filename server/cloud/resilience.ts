/**
 * Unified Cloud Resilience Wrapper
 *
 * Wraps any cloud API call with the full resilience stack:
 *   1. Circuit breaker check — fail-fast if provider is down
 *   2. Retry with exponential backoff + jitter — transient errors
 *   3. Circuit breaker recording — track success/failure
 *   4. Error classification — categorize for logging & decisions
 *
 * Usage:
 *   const result = await withCloudResilience(
 *     () => openai.chat.completions.create(...),
 *     { provider: 'openai', model: 'gpt-4o', maxRetries: 2 },
 *   );
 */

import { isCircuitClosed, recordSuccess, recordFailure } from './circuit_breaker';
import { withRetry, isCloudRetryable, RetryOptions } from './retry';
import { classifyCloudError, CloudErrorCategory } from './core';

export interface ResilienceOptions {
  provider: string;
  model?: string;
  /** Max retry attempts (0 = no retry, fail fast on first error) */
  maxRetries?: number;
  /** Override base delay for retries */
  baseDelayMs?: number;
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Called after each failed attempt (for logging) */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

/**
 * Execute an async function with circuit breaker + retry + recording.
 *
 * Flow:
 *   1. Check circuit breaker — if OPEN, fail fast with descriptive error
 *   2. Execute with retry (exponential backoff for retryable errors)
 *   3. On success: record to circuit breaker → return result
 *   4. On failure: classify error, record to circuit breaker, re-throw
 */
export async function withCloudResilience<T>(
  fn: () => Promise<T>,
  options: ResilienceOptions,
): Promise<T> {
  const { provider, model, maxRetries = 2, baseDelayMs = 500, signal } = options;

  // 1. Circuit breaker gate
  if (!isCircuitClosed(provider, model)) {
    const err = new Error(
      `[CircuitBreaker] ${provider}${model ? ` (${model})` : ''} is OPEN — failing fast.` +
      ` The circuit will automatically probe after the cooldown period.`,
    );
    // Ensure the error is classified as circuit_open for upstream fallback logic
    (err as any).cloudCategory = 'circuit_open' as CloudErrorCategory;
    recordFailure(provider, model, err);
    throw err;
  }

  try {
    // 2. Execute with retry
    const retryOpts: Partial<RetryOptions> = {
      maxAttempts: maxRetries + 1, // +1 because first attempt counts
      baseDelayMs,
      maxDelayMs: 15_000,
      backoffFactor: 2,
      signal,
      onRetry: options.onRetry,
    };

    const result = await withRetry(fn, retryOpts);

    // 3. Success — record to circuit breaker
    recordSuccess(provider, model);
    return result;
  } catch (err: any) {
    // 4. Failure — classify and record
    const classified = classifyCloudError(err, provider);
    recordFailure(provider, model, err, {
      openImmediately: classified.category === 'auth' || classified.category === 'quota',
    });

    // Attach classification to error for upstream handling
    err.cloudCategory = classified.category;
    err.cloudProvider = provider;

    throw err;
  }
}

/** Check if a provider is available (circuit closed + configured) */
export function isProviderAvailable(provider: string, model?: string): boolean {
  return isCircuitClosed(provider, model);
}
