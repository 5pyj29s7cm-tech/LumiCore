import { createModelTurnState, type ModelTurnState } from "../model_turn_state";
import { normalizeActionIntent } from "../../cognition/normalized_action_intent";
import { isCnLiteralTableFieldEdit } from "../../regions/input/zh_action_continuation";
import { resolveModelAttemptTimeouts, type StreamCallback, type ModelAttemptTimeouts } from "../providers";
import type { LLMConfig } from './contracts';

export const DEFAULT_TOOL_LOOP_MODEL_WAIT_BUDGET_MS = 120_000;

export class ToolLoopModelBudgetError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Model/tool loop exhausted its ${timeoutMs}ms cumulative model-wait budget`);
    this.name = 'ToolLoopModelBudgetError';
    this.timeoutMs = timeoutMs;
  }
}

export function positiveBudget(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.trunc(parsed)) : fallback;
}

export function resolveInteractiveToolConfig(config: LLMConfig, task: string): LLMConfig {
  // An explicit field replacement already names the requested value. Keep the
  // user's model and its full tool/verification contract, without spending a
  // hidden reasoning pass deciding whether to apply that literal edit. General
  // document creation, analysis and open-ended reasoning retain their settings.
  if (config.thinkingMode === undefined
    && (config.provider === 'relay' || config.provider === 'deepseek')
    && normalizeActionIntent(task).rule === 'explicit-artifact-edit'
    && isCnLiteralTableFieldEdit(task)) {
    return { ...config, thinkingMode: 'disabled' };
  }
  return config;
}

export interface ModelBudgetAttempt {
  signal: AbortSignal;
  attemptTimeouts: ModelAttemptTimeouts;
  onChunk?: StreamCallback;
}

export class ToolLoopModelBudget {
  readonly timeoutMs: number;
  private remainingBudgetMs: number;
  private closed = false;
  private generation = 0;

  constructor(
    timeoutMs: number,
    private readonly callerSignal?: AbortSignal,
    private readonly isCancelled?: () => boolean,
    private readonly turnState: ModelTurnState = createModelTurnState(),
  ) {
    this.timeoutMs = timeoutMs;
    this.remainingBudgetMs = Math.max(0, timeoutMs - turnState.modelWaitMs);
  }

  get acceptsEvents(): boolean {
    return !this.closed && !this.callerCancelled();
  }

  remainingMs(): number {
    return Math.max(0, this.remainingBudgetMs);
  }

  clipAttemptTimeouts(config?: Partial<ModelAttemptTimeouts>): ModelAttemptTimeouts {
    const remainingMs = this.remainingMs();
    if (remainingMs <= 0) {
      throw new ToolLoopModelBudgetError(this.timeoutMs);
    }
    const resolved = resolveModelAttemptTimeouts({
      ...config,
      semanticContentMs: config?.semanticContentMs === undefined ? this.timeoutMs : config.semanticContentMs,
      absoluteMs: config?.absoluteMs === undefined ? this.timeoutMs : config.absoluteMs,
    });
    // The caller's cumulative deadline is enforced by runModelAttempt's
    // AbortSignal. Do not also shorten the provider's health deadline: a turn
    // with 797 ms left is not evidence that a healthy local model is hung.
    // Competing timers previously opened its circuit for the next two minutes.
    return resolved;
  }

  async runModelAttempt<T>(
    configuredTimeouts: Partial<ModelAttemptTimeouts> | undefined,
    onChunk: StreamCallback | undefined,
    operation: (attempt: ModelBudgetAttempt) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new Error('Model/tool loop is no longer active');
    if (this.callerCancelled()) throw this.cancellationError();

    const attemptTimeouts = this.clipAttemptTimeouts(configuredTimeouts);
    const modelBudgetForAttempt = this.remainingMs();
    const startedAt = Date.now();
    const generation = ++this.generation;
    const controller = new AbortController();
    const signal = this.callerSignal
      ? AbortSignal.any([this.callerSignal, controller.signal])
      : controller.signal;
    const guardedChunk: StreamCallback | undefined = onChunk
      ? chunk => {
          if (
            !this.closed
            && generation === this.generation
            && !signal.aborted
            && !this.callerCancelled()
          ) onChunk(chunk);
        }
      : undefined;
    const deadlineTimer = setTimeout(() => {
      if (!controller.signal.aborted) {
        controller.abort(new ToolLoopModelBudgetError(this.timeoutMs));
      }
    }, modelBudgetForAttempt);
    const cancellationPoll = this.isCancelled
      ? setInterval(() => {
          if (controller.signal.aborted || !this.callerCancelled()) return;
          controller.abort(this.cancellationError());
        }, 25)
      : undefined;
    (cancellationPoll as any)?.unref?.();

    const providerOperation = Promise.resolve().then(() => operation({
      signal,
      attemptTimeouts,
      onChunk: guardedChunk,
    }));
    try {
      return await this.wait(providerOperation, signal);
    } finally {
      clearTimeout(deadlineTimer);
      if (cancellationPoll) clearInterval(cancellationPoll);
      if (generation === this.generation) this.generation += 1;
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      this.remainingBudgetMs = Math.max(0, this.remainingBudgetMs - elapsedMs);
      this.turnState.modelWaitMs += elapsedMs;
    }
  }

  dispose(): void {
    this.closed = true;
    this.generation += 1;
  }

  private wait<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      void operation.catch(() => {});
      return Promise.reject(this.abortReason(signal));
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => finish(() => reject(this.abortReason(signal)));
      signal.addEventListener('abort', onAbort, { once: true });
      operation.then(
        value => finish(() => resolve(value)),
        error => finish(() => reject(error)),
      );
    });
  }

  private callerCancelled(): boolean {
    if (this.callerSignal?.aborted) return true;
    try { return Boolean(this.isCancelled?.()); } catch { return false; }
  }

  private cancellationError(): Error {
    const reason = this.callerSignal?.reason;
    if (reason instanceof Error) return reason;
    const error = new Error('Model/tool turn cancelled by caller');
    error.name = 'AbortError';
    return error;
  }

  private abortReason(signal: AbortSignal): Error {
    return signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Model attempt cancelled', 'AbortError');
  }
}
