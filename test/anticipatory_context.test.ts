import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectAnticipatoryContext } from '../server/context/anticipatory_context';

afterEach(() => {
  vi.useRealTimers();
});

describe('anticipatory read-only context', () => {
  it('starts independent reads together and returns their stable values', async () => {
    let resolveMemory!: (value: string) => void;
    let resolveKnowledge!: (value: string) => void;
    const started: string[] = [];
    const memory = new Promise<string>(resolve => { resolveMemory = resolve; });
    const knowledge = new Promise<string>(resolve => { resolveKnowledge = resolve; });

    const pending = collectAnticipatoryContext([
      { key: 'memory', operation: 'read', sideEffectClass: 'none', run: () => { started.push('memory'); return memory; } },
      { key: 'knowledge', operation: 'read', sideEffectClass: 'none', run: () => { started.push('knowledge'); return knowledge; } },
    ]);

    expect(started).toEqual(['memory', 'knowledge']);
    resolveKnowledge('kb');
    resolveMemory('memory');
    await expect(pending).resolves.toMatchObject({
      values: { memory: 'memory', knowledge: 'kb' },
      completed: expect.arrayContaining(['memory', 'knowledge']),
      failed: [],
      timedOut: [],
    });
  });

  it('returns at the deadline and ignores late mutation of the snapshot', async () => {
    vi.useFakeTimers();
    let resolveSlow!: (value: string) => void;
    const slow = new Promise<string>(resolve => { resolveSlow = resolve; });
    const pending = collectAnticipatoryContext([
      { key: 'fast', operation: 'read', sideEffectClass: 'none', run: () => 'ready' },
      { key: 'slow', operation: 'status', sideEffectClass: 'none', run: () => slow },
    ], { deadlineMs: 50 });

    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;
    expect(result.values).toEqual({ fast: 'ready' });
    expect(result.timedOut).toEqual(['slow']);

    resolveSlow('late');
    await Promise.resolve();
    expect(result.values).toEqual({ fast: 'ready' });
  });

  it('deduplicates identical read keys so a source is queried once', async () => {
    const run = vi.fn(() => 'current');
    const result = await collectAnticipatoryContext([
      { key: 'memory', operation: 'read', sideEffectClass: 'none', run },
      { key: 'memory', operation: 'read', sideEffectClass: 'none', run },
    ]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.values).toEqual({ memory: 'current' });
  });
});
