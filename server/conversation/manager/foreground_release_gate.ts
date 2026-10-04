

export interface DurableForegroundReleaseGateSnapshot {
  attempts: number;
  resourcesReleased: boolean;
  recoveryOwned: boolean;
  retryScheduled: boolean;
}


export interface DurableForegroundReleaseGate {
  release(reason?: string): Promise<boolean>;
  snapshot(): DurableForegroundReleaseGateSnapshot;
  /** Cancel the unref'd recovery worker during test/server teardown. */
  dispose(): void;
}


export interface CreateDurableForegroundReleaseGateInput {
  /** Returns true only after the exact request is strictly durable/release-safe. */
  converge(reason: string): Promise<boolean>;
  /** Idempotent heartbeat/desktop/serial cleanup. */
  releaseResources(): void;
  onFailure?(input: { reason: string; error: unknown; attempts: number }): void;
  onRecoveryTakeover?(input: { reason: string; error: unknown; attempts: number }): void;
  retryDelaysMs?: readonly number[];
  recoveryTakeoverAfterAttempts?: number;
}


/**
 * Gate transport cleanup behind strict durable convergence.
 *
 * Transient failures retain every foreground resource. A structurally broken
 * request cannot hold the desktop/serial lane forever, however: after bounded
 * exponential attempts this gate becomes the explicit fail-closed recovery
 * owner, releases transport resources, and continues low-frequency persistence
 * retries without reporting convergence. The manager request owner remains
 * intact until a later strict barrier succeeds.
 */
export function createDurableForegroundReleaseGate(
  input: CreateDurableForegroundReleaseGateInput,
): DurableForegroundReleaseGate {
  const retryDelaysMs = (input.retryDelaysMs?.length
    ? input.retryDelaysMs
    : [250, 500, 1_000, 2_000, 4_000, 10_000, 30_000])
    .map(value => Math.max(1, Math.floor(Number(value) || 0)));
  const recoveryTakeoverAfterAttempts = Math.max(
    1,
    Math.floor(Number(input.recoveryTakeoverAfterAttempts ?? 6) || 1),
  );
  let attempts = 0;
  let resourcesReleased = false;
  let recoveryOwned = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<boolean> | null = null;
  let latestReason = 'Foreground request reached its release boundary.';
  let disposed = false;

  const releaseResourcesOnce = (): void => {
    if (resourcesReleased) return;
    input.releaseResources();
    resourcesReleased = true;
  };
  const scheduleRetry = (): void => {
    if (disposed || retryTimer) return;
    const delay = retryDelaysMs[Math.min(Math.max(0, attempts - 1), retryDelaysMs.length - 1)];
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void release(latestReason);
    }, delay);
    retryTimer.unref?.();
  };
  const release = async (reason = latestReason): Promise<boolean> => {
    latestReason = String(reason || latestReason);
    if (disposed) return false;
    if (resourcesReleased && !recoveryOwned) return true;
    if (inFlight) return inFlight;
    // A finally block and a fast-path boundary may both call release. Once a
    // retry worker is scheduled, those duplicate calls must not accelerate the
    // takeover threshold or create a second worker.
    if (retryTimer) return false;
    const attempt = (async (): Promise<boolean> => {
      attempts += 1;
      let failure: unknown = null;
      try {
        if (await input.converge(latestReason)) {
          releaseResourcesOnce();
          recoveryOwned = false;
          if (retryTimer) clearTimeout(retryTimer);
          retryTimer = null;
          return true;
        }
        failure = new Error('foreground_request_not_durably_converged');
      } catch (error) {
        failure = error;
      }

      input.onFailure?.({ reason: latestReason, error: failure, attempts });
      if (!recoveryOwned && attempts >= recoveryTakeoverAfterAttempts) {
        recoveryOwned = true;
        input.onRecoveryTakeover?.({ reason: latestReason, error: failure, attempts });
        // The gate, rather than the channel executor, now owns retry/recovery.
        // This releases scarce transport resources but deliberately returns
        // false so no caller can mistake takeover for durable convergence.
        releaseResourcesOnce();
      }
      scheduleRetry();
      return false;
    })();
    inFlight = attempt;
    try {
      return await attempt;
    } finally {
      if (inFlight === attempt) inFlight = null;
    }
  };

  return {
    release,
    dispose: () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    },
    snapshot: () => ({
      attempts,
      resourcesReleased,
      recoveryOwned,
      retryScheduled: Boolean(retryTimer),
    }),
  };
}
