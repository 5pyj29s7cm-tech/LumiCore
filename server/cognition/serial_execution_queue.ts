export type SerialExecutionLeaseState = 'queued' | 'active' | 'cancelled' | 'timed_out' | 'finished';

export const DEFAULT_SERIAL_EXECUTION_WAIT_TIMEOUT_MS = 120_000;
export const DEFAULT_SERIAL_EXECUTION_CANCEL_TIMEOUT_MS = 10_000;

export class SerialExecutionWaitTimeoutError extends Error {
  readonly code = 'serial_execution_wait_timeout';

  constructor(
    readonly key: string,
    readonly requestId: string,
    readonly timeoutMs: number,
  ) {
    super(`Serial execution wait timed out after ${timeoutMs}ms.`);
    this.name = 'SerialExecutionWaitTimeoutError';
  }
}

export class SerialExecutionCancellationTimeoutError extends Error {
  readonly code = 'serial_execution_cancellation_timeout';

  constructor(
    readonly key: string,
    readonly requestId: string,
    readonly timeoutMs: number,
  ) {
    super(`Serial execution cancellation did not settle after ${timeoutMs}ms.`);
    this.name = 'SerialExecutionCancellationTimeoutError';
  }
}

export interface SerialExecutionQueueOptions {
  waitTimeoutMs?: number;
  cancelTimeoutMs?: number;
}

type QueueState = {
  active?: SerialExecutionLease;
  tail?: SerialExecutionLease;
  leases: Map<string, SerialExecutionLease>;
};

/**
 * One reserved foreground turn in a per-scope FIFO execution queue.
 *
 * A cancelled queued lease still waits for its predecessor before resolving.
 * This is intentional: resolving it immediately would let a later successor
 * overtake the still-running predecessor and recreate the stream-crossing race.
 */
export class SerialExecutionLease {
  readonly controller = new AbortController();
  readonly finished: Promise<void>;

  private finish!: () => void;
  private released = false;
  private leaseState: SerialExecutionLeaseState = 'queued';

  constructor(
    private readonly owner: SerialExecutionQueue,
    readonly key: string,
    readonly requestId: string,
    readonly predecessor?: SerialExecutionLease,
  ) {
    this.finished = new Promise<void>(resolve => {
      this.finish = resolve;
    });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get state(): SerialExecutionLeaseState {
    return this.leaseState;
  }

  cancel(): void {
    if (this.released) return;
    this.controller.abort();
    if (this.leaseState === 'queued') this.leaseState = 'cancelled';
  }

  async waitForTurn(): Promise<boolean> {
    if (this.predecessor) {
      const timeoutMs = this.owner.waitTimeoutMs;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const predecessorFinished = this.predecessor.finished.then(() => 'finished' as const);
      const waitTimedOut = new Promise<'timed_out'>(resolve => {
        timeout = setTimeout(() => resolve('timed_out'), timeoutMs);
      });
      const outcome = await Promise.race([predecessorFinished, waitTimedOut]);
      if (timeout) clearTimeout(timeout);
      if (outcome === 'timed_out') {
        this.leaseState = 'timed_out';
        this.controller.abort(new SerialExecutionWaitTimeoutError(this.key, this.requestId, timeoutMs));
        this.release();
        return false;
      }
    }
    if (this.controller.signal.aborted) {
      this.release();
      return false;
    }
    // A timed-out or cancelled middle lease may finish before the true active
    // predecessor. Never let its successor overtake that still-running owner.
    const active = this.owner.getActive(this.key);
    if (active && active !== this) {
      this.controller.abort(new Error('serial_execution_predecessor_still_active'));
      this.leaseState = 'cancelled';
      this.release();
      return false;
    }
    this.leaseState = 'active';
    this.owner.activate(this);
    return true;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.leaseState !== 'timed_out') this.leaseState = 'finished';
    this.owner.release(this);
    this.finish();
  }
}

/**
 * Serializes foreground executions by user/domain/source without coupling the
 * ordering contract to a particular Socket.IO transport.
 */
export class SerialExecutionQueue {
  private readonly states = new Map<string, QueueState>();
  readonly waitTimeoutMs: number;
  readonly cancelTimeoutMs: number;

  constructor(options: SerialExecutionQueueOptions = {}) {
    const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_SERIAL_EXECUTION_WAIT_TIMEOUT_MS;
    const cancelTimeoutMs = options.cancelTimeoutMs ?? DEFAULT_SERIAL_EXECUTION_CANCEL_TIMEOUT_MS;
    if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 1 || waitTimeoutMs > 30 * 60_000) {
      throw new TypeError('waitTimeoutMs must be an integer between 1 and 1800000');
    }
    if (!Number.isSafeInteger(cancelTimeoutMs) || cancelTimeoutMs < 1 || cancelTimeoutMs > 5 * 60_000) {
      throw new TypeError('cancelTimeoutMs must be an integer between 1 and 300000');
    }
    this.waitTimeoutMs = waitTimeoutMs;
    this.cancelTimeoutMs = cancelTimeoutMs;
  }

  reserve(key: string, requestId: string): SerialExecutionLease {
    const state = this.states.get(key) || { leases: new Map<string, SerialExecutionLease>() };
    const existing = state.leases.get(requestId);
    if (existing) return existing;

    const lease = new SerialExecutionLease(this, key, requestId, state.tail);
    state.tail = lease;
    state.leases.set(requestId, lease);
    this.states.set(key, state);
    return lease;
  }

  getActive(key: string): SerialExecutionLease | undefined {
    return this.states.get(key)?.active;
  }

  getTail(key: string): SerialExecutionLease | undefined {
    return this.states.get(key)?.tail;
  }

  getByRequestId(key: string, requestId: string): SerialExecutionLease | undefined {
    return this.states.get(key)?.leases.get(requestId);
  }

  getCurrent(key: string): SerialExecutionLease | undefined {
    return this.getActive(key) || this.getTail(key);
  }

  cancelAll(key: string): Promise<void> {
    const leases = [...(this.states.get(key)?.leases.values() || [])];
    for (const lease of leases) lease.cancel();
    return Promise.all(leases.map(lease => lease.finished)).then(() => undefined);
  }

  /** Cancel only the request named by a durable control intent. */
  cancelRequest(key: string, requestId: string): Promise<boolean> {
    const lease = this.getByRequestId(key, requestId);
    if (!lease) return Promise.resolve(false);
    const wasQueued = lease.state === 'queued' || lease.state === 'cancelled';
    lease.cancel();
    if (wasQueued) return Promise.resolve(true);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const settled = lease.finished.then(() => true);
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new SerialExecutionCancellationTimeoutError(
        key,
        requestId,
        this.cancelTimeoutMs,
      )), this.cancelTimeoutMs);
    });
    return Promise.race([settled, timedOut]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  activate(lease: SerialExecutionLease): void {
    const state = this.states.get(lease.key);
    if (!state || state.leases.get(lease.requestId) !== lease) return;
    if (state.active && state.active !== lease) {
      throw new Error(
        `Serial execution invariant violated for ${lease.key}: ${state.active.requestId} is still active`,
      );
    }
    state.active = lease;
  }

  release(lease: SerialExecutionLease): void {
    const state = this.states.get(lease.key);
    if (!state) return;
    if (state.active === lease) state.active = undefined;
    if (state.leases.get(lease.requestId) === lease) state.leases.delete(lease.requestId);
    if (state.tail === lease) state.tail = undefined;
    if (state.leases.size === 0) this.states.delete(lease.key);
  }
}
