/** A transport closing or a terminal UI message is not a save receipt. */
export class ShutdownWorkTracker {
  private active = new Set<symbol>();
  private idleWaiters = new Set<() => void>();

  begin(): () => void {
    const key = Symbol();
    this.active.add(key);
    return () => {
      this.active.delete(key);
      if (this.active.size === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    };
  }

  track<T>(work: Promise<T>): Promise<T> {
    const finish = this.begin();
    return work.finally(finish);
  }

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0) await new Promise<void>(resolve => this.idleWaiters.add(resolve));
  }
}

export const runtimeBackgroundWork = new ShutdownWorkTracker();

/** Process shutdown cancels work; ordinary socket reconnects do not. */
export class RuntimeShutdownCancellation {
  private requested = false;
  private controllers = new Set<AbortController>();

  register(controller: AbortController): () => void {
    if (this.requested) controller.abort(new Error('Runtime shutdown requested'));
    else this.controllers.add(controller);
    return () => { this.controllers.delete(controller); };
  }

  request(): void {
    this.requested = true;
    for (const controller of this.controllers) controller.abort(new Error('Runtime shutdown requested'));
  }
}

export const runtimeShutdownCancellation = new RuntimeShutdownCancellation();

export async function waitUntilRuntimeIdle(isIdle: () => boolean): Promise<void> {
  while (!isIdle()) await new Promise(resolve => setTimeout(resolve, 20));
}
