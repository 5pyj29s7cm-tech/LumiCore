import { describe, expect, it, vi } from 'vitest';
import {
  getUnifiedRuntimeSupervisorStatus,
  setUnifiedRuntimeSupervisor,
  UnifiedRuntimeSupervisor,
} from '../server/runtime/unified_supervisor';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('unified runtime supervisor', () => {
  it('runs bounded jobs, records evidence, and publishes a structural snapshot', async () => {
    const run = vi.fn(() => ({ healthy: true, queueLength: 0 }));
    const supervisor = new UnifiedRuntimeSupervisor([{ id: 'health', intervalMs: 1_000, timeoutMs: 100, run }]);
    setUnifiedRuntimeSupervisor(supervisor);
    await supervisor.runOnce('health');
    expect(supervisor.status()).toMatchObject({
      running: false,
      jobs: [{ id: 'health', outcome: 'ok', runs: 1, failures: 0, lastResult: { healthy: true, queueLength: 0 } }],
    });
    expect(getUnifiedRuntimeSupervisorStatus().jobs[0]?.id).toBe('health');
    supervisor.stop();
    setUnifiedRuntimeSupervisor(null);
  });

  it('never overlaps the same job', async () => {
    const gate = deferred<string>();
    const run = vi.fn(() => gate.promise);
    const supervisor = new UnifiedRuntimeSupervisor([{ id: 'single-flight', intervalMs: 100, timeoutMs: 1_000, run }]);
    const first = supervisor.runOnce('single-flight');
    await Promise.resolve();
    const secondStatus = await supervisor.runOnce('single-flight');
    expect(secondStatus.inFlight).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    gate.resolve('done');
    await first;
    expect(supervisor.status().jobs[0]).toMatchObject({ outcome: 'ok', inFlight: false, runs: 1 });
  });

  it('records failures without stopping other jobs', async () => {
    const supervisor = new UnifiedRuntimeSupervisor([
      { id: 'failure', intervalMs: 100, timeoutMs: 100, run: () => { throw new Error('probe unavailable'); } },
      { id: 'healthy', intervalMs: 100, timeoutMs: 100, run: () => 'ok' },
    ]);
    await supervisor.runOnce('failure');
    await supervisor.runOnce('healthy');
    expect(supervisor.status().jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'failure', outcome: 'failed', failures: 1, consecutiveFailures: 1, lastError: 'probe unavailable' }),
      expect.objectContaining({ id: 'healthy', outcome: 'ok', failures: 0 }),
    ]));
  });

  it('marks deadlines while retaining the no-overlap lease until work settles', async () => {
    const gate = deferred<string>();
    const supervisor = new UnifiedRuntimeSupervisor([{
      id: 'slow',
      intervalMs: 100,
      timeoutMs: 50,
      run: () => gate.promise,
    }]);
    const pending = supervisor.runOnce('slow');
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(supervisor.status().jobs[0]).toMatchObject({ outcome: 'timeout', inFlight: true, failures: 1 });
    gate.resolve('late');
    await pending;
    expect(supervisor.status().jobs[0]).toMatchObject({ outcome: 'timeout', inFlight: false, runs: 1 });
  });
});
