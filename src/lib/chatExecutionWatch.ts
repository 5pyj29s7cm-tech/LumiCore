export type ChatWatchEvent = 'acknowledged' | 'ack_timeout' | 'rejected' | 'no_ack' | 'probe_timeout' | 'lost' | 'working';
export type ChatWatchSnapshot = { requestId: string; source: string; terminal: boolean; status: string; conversationId?: string };
type ResumeResult = { ok?: boolean; snapshot?: ChatWatchSnapshot; code?: string; error?: string };
type WatchOptions = {
  requestId: string;
  source: string;
  firstProbeMs: number;
  probe: (reply: (result?: ResumeResult) => void) => void;
  onEvent: (event: ChatWatchEvent, error?: string) => void;
  onSnapshot?: (snapshot: ChatWatchSnapshot) => void;
};

/** One transport owner per request. Only terminal delivery settles successful work. */
export class ChatExecutionWatch {
  private disposed = false;
  private acknowledged = false;
  private probing = false;
  private missingReplies = 0;
  private lastStatus = '';
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: WatchOptions, private readonly clock: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> = globalThis) {
    this.schedule('ack', 5000, () => this.options.onEvent('ack_timeout'));
    this.scheduleProbe(options.firstProbeMs);
  }

  acknowledge(ack?: { ok?: boolean; error?: string }): void {
    if (this.disposed) return;
    if (ack?.ok === false) { this.fail('rejected', ack.error); return; }
    if (ack?.ok !== true) return;
    this.clear('ack');
    this.acknowledged = true;
    this.missingReplies = 0;
    this.options.onEvent('acknowledged');
  }

  /** Reconnect and the safety timer use the same exact-request reconciliation. */
  resume(): void {
    if (this.disposed || this.probing) return;
    this.clear('safety');
    this.probing = true;
    let answered = false;
    this.schedule('probe', 10000, () => {
      answered = true; this.probing = false;
      this.options.onEvent('probe_timeout');
      this.scheduleProbe(30000);
    });
    this.options.probe(result => {
      if (answered || this.disposed) return;
      answered = true; this.probing = false; this.clear('probe');
      const snapshot = result?.snapshot;
      if (!result?.ok || !snapshot) {
        const missing = result?.code === 'EXECUTION_NOT_FOUND' || result?.error === 'Execution not found or no longer recoverable';
        if (missing && ++this.missingReplies >= 3) { this.fail(this.acknowledged ? 'lost' : 'no_ack'); return; }
        if (result?.ok === false && !missing) { this.fail('rejected', result.error); return; }
        // A buffered send can arrive before admission registers its execution.
        // Missing/malformed/transient replies are not terminal evidence.
        this.options.onEvent('probe_timeout');
        this.scheduleProbe(15000);
        return;
      }
      if (snapshot.requestId !== this.options.requestId || snapshot.source !== this.options.source) { this.fail('lost'); return; }
      this.clear('ack'); this.acknowledged = true; this.missingReplies = 0;
      this.options.onSnapshot?.(snapshot);
      if (this.disposed) return;
      if (!snapshot.terminal && snapshot.status !== this.lastStatus) {
        this.lastStatus = snapshot.status;
        this.options.onEvent('working');
      }
      // Terminal replay, rather than a status snapshot, delivers the result.
      this.scheduleProbe(30000);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) this.clock.clearTimeout(timer);
    this.timers.clear();
  }

  private fail(event: 'rejected' | 'no_ack' | 'lost', error?: string): void {
    this.dispose();
    this.options.onEvent(event, error);
  }
  private scheduleProbe(delayMs: number): void { this.schedule('safety', delayMs, () => this.resume()); }
  private clear(key: string): void {
    const timer = this.timers.get(key);
    if (timer !== undefined) this.clock.clearTimeout(timer);
    this.timers.delete(key);
  }
  private schedule(key: string, delayMs: number, callback: () => void): void {
    this.clear(key);
    if (this.disposed) return;
    this.timers.set(key, this.clock.setTimeout(() => {
      this.timers.delete(key);
      if (!this.disposed) callback();
    }, delayMs));
  }
}
