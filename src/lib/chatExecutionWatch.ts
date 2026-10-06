export type ChatWatchEvent = 'acknowledged' | 'ack_timeout' | 'rejected' | 'no_ack' | 'probe_timeout' | 'lost' | 'working';
type ResumeResult = { ok?: boolean; snapshot?: { requestId: string; source: string; terminal: boolean; status: string }; error?: string };
type WatchOptions = {
  requestId: string;
  source: string;
  firstProbeMs: number;
  probe: (reply: (result?: ResumeResult) => void) => void;
  onEvent: (event: ChatWatchEvent, error?: string) => void;
};

/** Transport timers only. The persistent socket listener owns terminal delivery and settlement. */
export class ChatExecutionWatch {
  private disposed = false;
  private acknowledged = false;
  private lastStatus = '';
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: WatchOptions, private readonly clock: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> = globalThis) {
    this.schedule('ack', 5000, () => this.options.onEvent('ack_timeout'));
    this.scheduleProbe(options.firstProbeMs);
  }

  acknowledge(ack?: { ok?: boolean; error?: string }): void {
    if (this.disposed) return;
    this.clear('ack');
    if (!ack?.ok) { this.fail('rejected', ack?.error); return; }
    this.acknowledged = true;
    this.options.onEvent('acknowledged');
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

  private scheduleProbe(delayMs: number): void {
    this.schedule('safety', delayMs, () => {
      if (!this.acknowledged) { this.fail('no_ack'); return; }
      let answered = false;
      this.schedule('probe', 10000, () => {
        answered = true;
        this.options.onEvent('probe_timeout');
        this.scheduleProbe(30000);
      });
      this.options.probe(result => {
        if (answered || this.disposed) return;
        answered = true;
        this.clear('probe');
        const snapshot = result?.snapshot;
        if (!result?.ok || !snapshot || snapshot.requestId !== this.options.requestId || snapshot.source !== this.options.source) {
          this.fail('lost', result?.error);
          return;
        }
        if (!snapshot.terminal && snapshot.status !== this.lastStatus) {
          this.lastStatus = snapshot.status;
          this.options.onEvent('working');
        }
        // A terminal snapshot is not a delivered terminal receipt. Retry if its replay was lost.
        this.scheduleProbe(30000);
      });
    });
  }

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
