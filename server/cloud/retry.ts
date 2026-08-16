/**
 * Retry utilities with exponential backoff + jitter.
 * Used by all cloud API consumers (LLM, STT, TTS, Messaging).
 */

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Multiplier applied each attempt (default 2) */
  backoffFactor?: number;
  /** Optional: custom logic to decide if an error is retryable */
  isRetryable?: (error: Error) => boolean;
  /** Optional: called after each failed attempt */
  onRetry?: (attempt: number, error: Error, delayMs: number) => void;
  /** Optional: AbortSignal for cancellation */
  signal?: AbortSignal;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  backoffFactor: 2,
};

/**
 * Determin whether an error is transient and retryable.
 * Network errors, 5xx, rate limits, and timeouts are retryable.
 * Auth errors, 4xx (except 429), and configuration errors are not.
 */
export function isCloudRetryable(error: Error): boolean {
  const msg = error.message?.toLowerCase() || '';
  const hasStatus = (...codes: number[]) => codes.some(code => new RegExp(`(?:^|\\D)${code}(?:\\D|$)`).test(msg));

  // Non-retryable — fail fast
  if (
    msg.includes('not configured') ||
    msg.includes('invalid api key') ||
    msg.includes('unauthorized') ||
    msg.includes('authentication') ||
    msg.includes('forbidden') ||
    msg.includes('not found') ||
    msg.includes('bad request') ||
    msg.includes('resource id is mismatched') ||
    msg.includes('no readable text')
  ) {
    return false;
  }

  // Retryable — transient failures
  return (
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('econnreset') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    hasStatus(429, 500, 502, 503, 504) ||
    msg.includes('rate limit') ||
    msg.includes('quota exceeded') ||
    msg.includes('service unavailable') ||
    msg.includes('too many requests') ||
    msg.includes('internal server error') ||
    msg.includes('temporarily') ||
    msg.includes('try again') ||
    msg.includes('overloaded') ||
    msg.includes('capacity') ||
    msg.includes('unavailable')
  );
}

/**
 * Execute a function with retry logic (exponential backoff + jitter).
 * Returns the result of the first successful call.
 * Throws the last error if all attempts fail.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>,
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const isRetryable = opts.isRetryable || isCloudRetryable;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      // Check for cancellation before each attempt
      if (opts.signal?.aborted) {
        throw new Error('Operation cancelled');
      }
      return await fn();
    } catch (err: any) {
      lastError = err;

      // Non-retryable or last attempt — propagate immediately
      if (!isRetryable(err) || attempt >= opts.maxAttempts) {
        throw err;
      }

      // Calculate delay with jitter (±25%)
      const delay = Math.min(
        opts.baseDelayMs * Math.pow(opts.backoffFactor || 2, attempt - 1),
        opts.maxDelayMs,
      );
      const jitter = delay * (0.75 + Math.random() * 0.5); // 75%–125% of delay
      const actualDelay = Math.round(jitter);

      opts.onRetry?.(attempt, err, actualDelay);

      await sleep(actualDelay, opts.signal);
    }
  }

  throw lastError || new Error('Retry exhausted');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Operation cancelled'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Operation cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wraps an async function with a simple timeout guard.
 * Throws if the function takes longer than `ms`.
 */
export function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms),
    ),
  ]);
}
