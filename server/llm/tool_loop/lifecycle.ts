import { redactDiagnosticSecrets } from "../../client/diagnostic_sanitizer";

/**
 * A lifecycle observer is part of the durable execution boundary, not model
 * telemetry. Its failure must never be reclassified as a provider failure or
 * converted into a misleading "checkpoint preserved" response.
 */
export type ToolLifecyclePersistencePhase = 'adapter_started' | 'terminal';

export interface ToolLifecyclePersistenceErrorDetails {
  phase?: ToolLifecyclePersistencePhase;
  toolName?: string;
  toolCallId?: string;
  timeoutMs?: number;
  quarantined?: boolean;
}

export class ToolLifecyclePersistenceError extends Error {
  readonly cause: unknown;
  readonly code: 'TOOL_LIFECYCLE_PERSISTENCE_FAILED' | 'TOOL_LIFECYCLE_OBSERVER_TIMEOUT';
  readonly phase?: ToolLifecyclePersistencePhase;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly timeoutMs?: number;
  /** True means an uncertainty fence must remain authoritative; never replay. */
  readonly quarantined: boolean;

  constructor(cause: unknown, details: ToolLifecyclePersistenceErrorDetails = {}) {
    const timedOut = Number.isFinite(details.timeoutMs) && Number(details.timeoutMs) > 0;
    const phase = details.phase ? ` during ${details.phase}` : '';
    const quarantine = details.quarantined
      ? ' The durable adapter-start uncertainty fence remains quarantined; automatic replay is forbidden.'
      : '';
    super(`Tool lifecycle persistence failed${phase}: ${redactDiagnosticSecrets(
      cause instanceof Error ? cause.message : String(cause || 'unknown error'),
    ).slice(0, 500)}${quarantine}`);
    this.name = 'ToolLifecyclePersistenceError';
    this.cause = cause;
    this.code = timedOut
      ? 'TOOL_LIFECYCLE_OBSERVER_TIMEOUT'
      : 'TOOL_LIFECYCLE_PERSISTENCE_FAILED';
    this.phase = details.phase;
    this.toolName = details.toolName;
    this.toolCallId = details.toolCallId;
    this.timeoutMs = timedOut ? Math.max(1, Math.trunc(Number(details.timeoutMs))) : undefined;
    this.quarantined = details.quarantined === true;
  }
}

export function isToolLifecyclePersistenceError(error: unknown): error is ToolLifecyclePersistenceError {
  return error instanceof ToolLifecyclePersistenceError;
}

export const DEFAULT_TOOL_LIFECYCLE_OBSERVER_TIMEOUT_MS = 15_000;

export interface ToolLifecycleObserverInput {
  phase: ToolLifecyclePersistencePhase;
  toolName?: string;
  toolCallId?: string;
  timeoutMs: number;
  quarantined: boolean;
  observe: () => unknown;
}

export class ToolLifecycleObserverTimeoutError extends Error {
  constructor(readonly timeoutMs: number, phase: ToolLifecyclePersistencePhase) {
    super(`Durable ${phase} observer did not settle within ${timeoutMs}ms`);
    this.name = 'ToolLifecycleObserverTimeoutError';
  }
}

export async function waitForToolLifecycleObserver(input: ToolLifecycleObserverInput): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const observerOperation = Promise.resolve().then(input.observe);
  try {
    await Promise.race([
      observerOperation,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new ToolLifecycleObserverTimeoutError(input.timeoutMs, input.phase));
        }, input.timeoutMs);
      }),
    ]);
  } catch (error) {
    if (isToolLifecyclePersistenceError(error)) throw error;
    throw new ToolLifecyclePersistenceError(error, {
      phase: input.phase,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      timeoutMs: error instanceof ToolLifecycleObserverTimeoutError
        ? error.timeoutMs
        : undefined,
      quarantined: input.quarantined,
    });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export function toolLifecycleCallKey(call: { id?: string; name?: string }): string {
  const id = String(call.id || '').trim();
  if (id) return `id:${id}`;
  return `name:${String(call.name || '').trim()}`;
}
