import type { ModelAttemptTimeouts, ModelAttemptDeadlineStage, AttemptDeadline } from './contracts';

export const DEFAULT_MODEL_ATTEMPT_TIMEOUTS: Readonly<ModelAttemptTimeouts> = Object.freeze({
  requestMs: 20_000,
  firstByteMs: 20_000,
  semanticContentMs: 45_000,
  idleMs: 20_000,
  absoluteMs: 60_000,
});

export class ModelAttemptDeadlineError extends Error {
  readonly stage: ModelAttemptDeadlineStage;
  readonly timeoutMs: number;
  readonly callerCancelled: boolean;

  constructor(stage: ModelAttemptDeadlineStage, timeoutMs: number, options: { cause?: unknown; completedEmpty?: boolean } = {}) {
    const message = stage === 'cancelled'
      ? 'Model attempt cancelled by caller'
      : options.completedEmpty
        ? 'Model attempt completed without semantic content'
        : `Model attempt ${stage} timeout after ${timeoutMs}ms`;
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ModelAttemptDeadlineError';
    this.stage = stage;
    this.timeoutMs = timeoutMs;
    this.callerCancelled = stage === 'cancelled';
  }
}

export function positiveTimeout(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.trunc(parsed)) : fallback;
}

export function resolveModelAttemptTimeouts(config?: Partial<ModelAttemptTimeouts>): ModelAttemptTimeouts {
  const resolved: ModelAttemptTimeouts = {
    requestMs: positiveTimeout(config?.requestMs, DEFAULT_MODEL_ATTEMPT_TIMEOUTS.requestMs),
    firstByteMs: positiveTimeout(config?.firstByteMs, DEFAULT_MODEL_ATTEMPT_TIMEOUTS.firstByteMs),
    semanticContentMs: positiveTimeout(config?.semanticContentMs, DEFAULT_MODEL_ATTEMPT_TIMEOUTS.semanticContentMs),
    idleMs: positiveTimeout(config?.idleMs, DEFAULT_MODEL_ATTEMPT_TIMEOUTS.idleMs),
    absoluteMs: positiveTimeout(config?.absoluteMs, DEFAULT_MODEL_ATTEMPT_TIMEOUTS.absoluteMs),
  };
  // Stage deadlines cannot outlive the enclosing attempt. Keeping the values
  // configurable makes this mechanism usable by future models without adding
  // provider- or model-name branches.
  resolved.requestMs = Math.min(resolved.requestMs, resolved.absoluteMs);
  resolved.firstByteMs = Math.min(resolved.firstByteMs, resolved.absoluteMs);
  resolved.semanticContentMs = Math.min(resolved.semanticContentMs, resolved.absoluteMs);
  resolved.idleMs = Math.min(resolved.idleMs, resolved.absoluteMs);
  return resolved;
}

/**
 * Supervises one provider attempt from request creation through the terminal
 * stream frame. Every wait is raced outside the SDK, so an implementation that
 * ignores AbortSignal cannot hold the chat execution open indefinitely.
 */
export class ModelAttemptSupervisor {
  readonly signal: AbortSignal;
  readonly timeouts: ModelAttemptTimeouts;
  private readonly startedAt = Date.now();
  private readonly controller = new AbortController();
  private firstByteSeen = false;
  private semanticContentSeen = false;
  private lastFrameAt = this.startedAt;

  constructor(private readonly callerSignal: AbortSignal | undefined, config?: Partial<ModelAttemptTimeouts>) {
    this.timeouts = resolveModelAttemptTimeouts(config);
    this.signal = callerSignal
      ? AbortSignal.any([callerSignal, this.controller.signal])
      : this.controller.signal;
  }

  request<T>(operation: () => PromiseLike<T>): Promise<T> {
    return this.wait(
      Promise.resolve().then(operation),
      [
        { stage: 'request', dueAt: this.startedAt + this.timeouts.requestMs, timeoutMs: this.timeouts.requestMs },
        this.absoluteDeadline(),
      ],
    );
  }

  async next<T>(iterator: AsyncIterator<T>): Promise<IteratorResult<T>> {
    const lifecycleDeadline: AttemptDeadline = this.firstByteSeen
      ? { stage: 'idle', dueAt: this.lastFrameAt + this.timeouts.idleMs, timeoutMs: this.timeouts.idleMs }
      : { stage: 'first_byte', dueAt: this.startedAt + this.timeouts.firstByteMs, timeoutMs: this.timeouts.firstByteMs };
    const deadlines = [lifecycleDeadline, this.absoluteDeadline()];
    if (!this.semanticContentSeen) {
      deadlines.push({
        stage: 'semantic_content',
        dueAt: this.startedAt + this.timeouts.semanticContentMs,
        timeoutMs: this.timeouts.semanticContentMs,
      });
    }
    const item = await this.wait(Promise.resolve().then(() => iterator.next()), deadlines);
    if (!item.done) {
      this.firstByteSeen = true;
      this.lastFrameAt = Date.now();
    }
    return item;
  }

  completion<T>(operation: PromiseLike<T>): Promise<T> {
    const deadlines = [this.absoluteDeadline()];
    if (!this.semanticContentSeen) {
      deadlines.push({
        stage: 'semantic_content',
        dueAt: this.startedAt + this.timeouts.semanticContentMs,
        timeoutMs: this.timeouts.semanticContentMs,
      });
    }
    return this.wait(Promise.resolve(operation), deadlines);
  }

  markSemanticContent(): void {
    this.semanticContentSeen = true;
  }

  assertSemanticContent(): void {
    if (this.semanticContentSeen) return;
    const error = new ModelAttemptDeadlineError('semantic_content', this.timeouts.semanticContentMs, { completedEmpty: true });
    this.abort(error);
    throw error;
  }

  abort(error: Error): void {
    if (!this.controller.signal.aborted) this.controller.abort(error);
  }

  private absoluteDeadline(): AttemptDeadline {
    return {
      stage: 'absolute',
      dueAt: this.startedAt + this.timeouts.absoluteMs,
      timeoutMs: this.timeouts.absoluteMs,
    };
  }

  private wait<T>(operation: Promise<T>, deadlines: AttemptDeadline[]): Promise<T> {
    if (this.callerSignal?.aborted) {
      void operation.catch(() => {});
      return Promise.reject(new ModelAttemptDeadlineError('cancelled', 0, { cause: this.callerSignal.reason }));
    }
    const deadline = deadlines.reduce((earliest, candidate) => candidate.dueAt < earliest.dueAt ? candidate : earliest);
    const remainingMs = deadline.dueAt - Date.now();
    if (remainingMs <= 0) {
      const error = new ModelAttemptDeadlineError(deadline.stage, deadline.timeoutMs);
      this.abort(error);
      void operation.catch(() => {});
      return Promise.reject(error);
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.callerSignal?.removeEventListener('abort', onCallerAbort);
        callback();
      };
      const onCallerAbort = () => finish(() => {
        reject(new ModelAttemptDeadlineError('cancelled', 0, { cause: this.callerSignal?.reason }));
      });
      const timer = setTimeout(() => finish(() => {
        const error = new ModelAttemptDeadlineError(deadline.stage, deadline.timeoutMs);
        this.abort(error);
        reject(error);
      }), remainingMs);
      this.callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
      operation.then(
        value => finish(() => resolve(value)),
        error => finish(() => reject(error)),
      );
    });
  }
}

export function stopIterator(iterator: AsyncIterator<unknown> | undefined): void {
  if (!iterator?.return) return;
  try {
    const stopped = iterator.return();
    void Promise.resolve(stopped).catch(() => {});
  } catch {
    // The attempt has already reached a terminal error; iterator cleanup is
    // best-effort and must never replace that error.
  }
}
