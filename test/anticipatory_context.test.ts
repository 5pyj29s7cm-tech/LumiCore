import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectAnticipatoryContext } from '../server/context/anticipatory_context';
import { readOnlyContextCache } from '../server/context/read_only_cache';

afterEach(() => {
  vi.useRealTimers();
  readOnlyContextCache.clear();
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

  it('aborts the underlying non-cached read at its deadline without reporting a normal timeout as failure', async () => {
    vi.useFakeTimers();
    let readSignal: AbortSignal | undefined;
    const pending = collectAnticipatoryContext([{
      key: 'rag', operation: 'read', sideEffectClass: 'none',
      run: signal => new Promise((_resolve, reject) => {
        readSignal = signal;
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      }),
    }], { deadlineMs: 25 });
    expect(readSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(25);
    expect(readSignal?.aborted).toBe(true);
    expect(await pending).toMatchObject({ values: {}, completed: [], failed: [], timedOut: ['rag'], cancelled: [] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start any job for an already cancelled parent', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = vi.fn(() => 'must not load');
    const result = await collectAnticipatoryContext([
      { key: 'owned', operation: 'read', sideEffectClass: 'none', run },
      { key: 'cached', operation: 'read', sideEffectClass: 'none', cache: { scopeKey: 's', key: 'k' }, run },
    ], { signal: controller.signal });
    expect(run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ completed: [], timedOut: [], cancelled: ['owned', 'cached'] });
  });

  it('cancels an in-flight owned read promptly and keeps the returned snapshot stable', async () => {
    const controller = new AbortController();
    let ownedSignal: AbortSignal | undefined;
    let finish!: (value: string) => void;
    const pending = collectAnticipatoryContext([{
      key: 'rag', operation: 'read', sideEffectClass: 'none',
      run: signal => { ownedSignal = signal; return new Promise<string>(resolve => { finish = resolve; }); },
    }], { signal: controller.signal, deadlineMs: 60_000 });
    controller.abort(new Error('turn replaced'));
    const result = await pending;
    expect(ownedSignal?.aborted).toBe(true);
    expect(result).toMatchObject({ values: {}, completed: [], failed: [], timedOut: [], cancelled: ['rag'] });
    finish('late result from a noncooperative source');
    await Promise.resolve();
    expect(result.values).toEqual({});
  });

  it('does not start later jobs if the parent is cancelled during the first synchronous read', async () => {
    const controller = new AbortController();
    const later = vi.fn();
    const result = await collectAnticipatoryContext([
      { key: 'first', operation: 'read', sideEffectClass: 'none', run: () => { controller.abort(); return 'stale'; } },
      { key: 'later', operation: 'read', sideEffectClass: 'none', run: later },
    ], { signal: controller.signal });
    expect(later).not.toHaveBeenCalled();
    expect(result.values).toEqual({});
    expect(result.cancelled).toEqual(['first', 'later']);
  });

  it.each(['caller', 'deadline'])('keeps a shared cached loader alive after another collection stops for %s', async stopReason => {
    vi.useFakeTimers();
    let finish!: (value: string) => void;
    const run = vi.fn((_signal?: AbortSignal) => new Promise<string>(resolve => { finish = resolve; }));
    const job = { key: 'shared', operation: 'read' as const, sideEffectClass: 'none' as const,
      cache: { scopeKey: 'shared-scope', key: 'shared-value', prewarm: true }, run };
    const controller = new AbortController();
    const first = collectAnticipatoryContext([job], { deadlineMs: 25, signal: controller.signal });
    const second = collectAnticipatoryContext([job], { deadlineMs: 100 });
    await Promise.resolve();
    expect(run).toHaveBeenCalledExactlyOnceWith();
    if (stopReason === 'caller') controller.abort();
    else await vi.advanceTimersByTimeAsync(25);
    expect((await first)[stopReason === 'caller' ? 'cancelled' : 'timedOut']).toEqual(['shared']);
    finish('shared result');
    expect(await second).toMatchObject({ values: { shared: 'shared result' }, cancelled: [], timedOut: [] });
    expect(await collectAnticipatoryContext([job])).toMatchObject({ values: { shared: 'shared result' } });
    expect(run).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
