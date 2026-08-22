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
  /**
   * Hard deadline for the whole operation, including retries. Unlike an SDK
   * timeout this still settles the caller when the underlying promise ignores
   * AbortSignal. The operation signal passed to `fn` is aborted as well.
   */
  timeoutMs?: number;
  /** Called after each failed attempt (for logging) */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
}

export class CloudResilienceTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Cloud operation timed out after ${timeoutMs}ms`);
    this.name = 'CloudResilienceTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException('Operation cancelled', 'AbortError');
}

/**
 * Race at the application boundary instead of relying on a provider SDK to
 * honour cancellation. Promise handlers remain attached, so a late provider
 * rejection is observed and cannot become an unhandled rejection.
 */
function raceWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
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
  fn: (signal?: AbortSignal) => Promise<T>,
  options: ResilienceOptions,
): Promise<T> {
  const { provider, model, maxRetries = 2, baseDelayMs = 500, signal, timeoutMs } = options;

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

  const deadlineController = Number.isFinite(timeoutMs) && Number(timeoutMs) > 0
    ? new AbortController()
    : undefined;
  const operationSignal = signal && deadlineController
    ? AbortSignal.any([signal, deadlineController.signal])
    : signal || deadlineController?.signal;
  const deadlineTimer = deadlineController
    ? setTimeout(() => deadlineController.abort(new CloudResilienceTimeoutError(Number(timeoutMs))), Number(timeoutMs))
    : undefined;

  try {
    // 2. Execute with retry
    const retryOpts: Partial<RetryOptions> = {
      maxAttempts: maxRetries + 1, // +1 because first attempt counts
      baseDelayMs,
      maxDelayMs: 15_000,
      backoffFactor: 2,
      signal: operationSignal,
      onRetry: options.onRetry,
    };

    const operation = withRetry(() => fn(operationSignal), retryOpts);
    const result = await raceWithAbort(operation, operationSignal);

    // 3. Success — record to circuit breaker
    recordSuccess(provider, model);
    return result;
  } catch (err: any) {
    // A caller choosing to stop work says nothing about provider health. A
    // hard deadline, on the other hand, is a real failed provider attempt.
    if (signal?.aborted && !(err instanceof CloudResilienceTimeoutError)) {
      throw err;
    }

    // 4. Failure — classify and record
    const classified = classifyCloudError(err, provider);
    recordFailure(provider, model, err, {
      openImmediately: classified.category === 'auth' || classified.category === 'quota',
    });

    // Attach classification to error for upstream handling
    err.cloudCategory = classified.category;
    err.cloudProvider = provider;

    throw err;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}

/** Check if a provider is available (circuit closed + configured) */
export function isProviderAvailable(provider: string, model?: string): boolean {
  return isCircuitClosed(provider, model);
}
