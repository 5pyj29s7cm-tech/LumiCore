import { describe, expect, it } from 'vitest';
import { SerialExecutionQueue } from '../server/cognition/serial_execution_queue';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('SerialExecutionQueue', () => {
  it('runs three rapidly queued turns in strict FIFO order', async () => {
    const queue = new SerialExecutionQueue();
    const gates = [deferred(), deferred(), deferred()];
    const events: string[] = [];

    const run = async (requestId: string, index: number) => {
      const lease = queue.reserve('user:personal:chat', requestId);
      if (!await lease.waitForTurn()) return;
      events.push(`start:${requestId}`);
      await gates[index].promise;
      events.push(`end:${requestId}`);
      lease.release();
    };

    const runs = [run('A', 0), run('B', 1), run('C', 2)];
    await flushMicrotasks();
    expect(events).toEqual(['start:A']);

    gates[0].resolve();
    await flushMicrotasks();
    expect(events).toEqual(['start:A', 'end:A', 'start:B']);

    gates[1].resolve();
    await flushMicrotasks();
    expect(events).toEqual(['start:A', 'end:A', 'start:B', 'end:B', 'start:C']);

    gates[2].resolve();
    await Promise.all(runs);
    expect(events).toEqual([
      'start:A', 'end:A',
      'start:B', 'end:B',
      'start:C', 'end:C',
    ]);
  });

  it('does not let a cancelled queued turn resurrect or let successors overtake', async () => {
    const queue = new SerialExecutionQueue();
    const activeGate = deferred();
    const successorGate = deferred();
    const events: string[] = [];

    const active = queue.reserve('scope', 'A');
    const activeRun = (async () => {
      expect(await active.waitForTurn()).toBe(true);
      events.push('start:A');
      await activeGate.promise;
      events.push('end:A');
      active.release();
    })();

    const cancelled = queue.reserve('scope', 'B');
    const cancelledRun = (async () => {
      if (!await cancelled.waitForTurn()) return;
      events.push('start:B');
      cancelled.release();
    })();

    const successor = queue.reserve('scope', 'C');
    const successorRun = (async () => {
      expect(await successor.waitForTurn()).toBe(true);
      events.push('start:C');
      await successorGate.promise;
      events.push('end:C');
      successor.release();
    })();

    cancelled.cancel();
    await flushMicrotasks();
    expect(events).toEqual(['start:A']);

    activeGate.resolve();
    await Promise.all([activeRun, cancelledRun]);
    await flushMicrotasks();
    expect(events).toEqual(['start:A', 'end:A', 'start:C']);
    expect(events).not.toContain('start:B');

    successorGate.resolve();
    await successorRun;
  });

  it('keeps the active lease addressable while newer leases are queued', async () => {
    const queue = new SerialExecutionQueue();
    const active = queue.reserve('scope', 'A');
    expect(await active.waitForTurn()).toBe(true);
    const queued = queue.reserve('scope', 'B');

    expect(queue.getActive('scope')).toBe(active);
    expect(queue.getTail('scope')).toBe(queued);
    expect(queue.getByRequestId('scope', 'A')).toBe(active);
    expect(queue.getByRequestId('scope', 'B')).toBe(queued);

    queued.cancel();
    active.release();
    expect(await queued.waitForTurn()).toBe(false);
    expect(queue.getCurrent('scope')).toBeUndefined();
  });

  it('keeps one lease per request id across reconnect retries', () => {
    const queue = new SerialExecutionQueue();
    const original = queue.reserve('scope', 'request-1');
    const retried = queue.reserve('scope', 'request-1');

    expect(retried).toBe(original);
    expect(queue.getByRequestId('scope', 'request-1')).toBe(original);
    original.cancel();
    original.release();
  });

  it('cancels an active turn and every queued predecessor before a replacement starts', async () => {
    const queue = new SerialExecutionQueue();
    const activeGate = deferred();
    const events: string[] = [];

    const first = queue.reserve('scope', 'A');
    const firstRun = (async () => {
      expect(await first.waitForTurn()).toBe(true);
      events.push('start:A');
      await activeGate.promise;
      first.release();
    })();
    const queued = queue.reserve('scope', 'B');
    const queuedRun = queued.waitForTurn();

    const cancelled = queue.cancelAll('scope');
    const replacement = queue.reserve('scope', 'C');
    const replacementRun = replacement.waitForTurn();

    await flushMicrotasks();
    expect(replacement.state).toBe('queued');
    expect(first.signal.aborted).toBe(true);
    expect(queued.signal.aborted).toBe(true);

    activeGate.resolve();
    await firstRun;
    expect(await queuedRun).toBe(false);
    await cancelled;
    expect(await replacementRun).toBe(true);
    expect(events).toEqual(['start:A']);
    replacement.release();
  });
});
