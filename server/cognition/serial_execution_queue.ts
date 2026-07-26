export type SerialExecutionLeaseState = 'queued' | 'active' | 'cancelled' | 'finished';

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
    if (this.predecessor) await this.predecessor.finished;
    if (this.controller.signal.aborted) {
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
    this.leaseState = 'finished';
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
