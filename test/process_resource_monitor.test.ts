import { describe, expect, it } from 'vitest';
import {
  sampleProcessTree,
  SupervisedProcessResourceMonitor,
} from '../server/runtime/process_resource_monitor';

describe('supervised process tree resource monitor', () => {
  it('samples the live root process with a non-zero process count and working set', async () => {
    const usage = await sampleProcessTree(process.pid);

    expect(usage.processCount).toBeGreaterThanOrEqual(1);
    expect(usage.rssBytes).toBeGreaterThan(1024 * 1024);
    expect(usage.privateBytes).toBeGreaterThan(0);
  }, 15_000);

  it('enforces a private-memory ceiling independently of the RSS ceiling', async () => {
    let resolveExceeded!: (value: any) => void;
    const exceeded = new Promise<any>(resolve => {
      resolveExceeded = resolve;
    });
    const monitor = new SupervisedProcessResourceMonitor({
      budgetBytes: Number.MAX_SAFE_INTEGER,
      privateBudgetBytes: 1,
      onBudgetExceeded: resolveExceeded,
    });
    try {
      monitor.start(process.pid);
      const snapshot = await Promise.race([
        exceeded,
        new Promise((_, reject) => setTimeout(() => reject(new Error('private-memory budget was not enforced')), 12_000)),
      ]);
      expect(snapshot.privateBytes).toBeGreaterThan(snapshot.privateBudgetBytes);
      expect(snapshot.budgetExceededCount).toBeGreaterThanOrEqual(1);
    } finally {
      monitor.stop();
    }
  }, 15_000);
});
