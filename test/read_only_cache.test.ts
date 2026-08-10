import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectAnticipatoryContext } from '../server/context/anticipatory_context';
import {
  createReadOnlyCacheKey,
  createReadOnlyCacheScope,
  ReadOnlyTtlCache,
} from '../server/context/read_only_cache';

describe('strict read-only TTL context cache', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('deduplicates concurrent loads, reuses TTL values, and expires cleanly', async () => {
    const cache = new ReadOnlyTtlCache();
    let release!: (value: string) => void;
    const deferred = new Promise<string>(resolve => { release = resolve; });
    const load = vi.fn(() => deferred);
    const descriptor = { scopeKey: createReadOnlyCacheScope('user-a'), key: createReadOnlyCacheKey('query-a'), ttlMs: 100 };
    const first = cache.getOrLoad({ operation: 'read', sideEffectClass: 'none', cache: descriptor, load });
    const second = cache.getOrLoad({ operation: 'read', sideEffectClass: 'none', cache: descriptor, load });
    release('value-a');
    await expect(Promise.all([first, second])).resolves.toEqual(['value-a', 'value-a']);
    await expect(cache.getOrLoad({ operation: 'read', sideEffectClass: 'none', cache: descriptor, load })).resolves.toBe('value-a');
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.metrics()).toMatchObject({ hits: 1, misses: 1, joins: 1, loads: 1 });

    await vi.advanceTimersByTimeAsync(101);
    const reload = vi.fn(() => 'value-b');
    await expect(cache.getOrLoad({ operation: 'status', sideEffectClass: 'none', cache: descriptor, load: reload })).resolves.toBe('value-b');
    expect(cache.metrics().expired).toBe(1);
  });

  it('keeps scopes isolated and does not cache failures', async () => {
    const cache = new ReadOnlyTtlCache();
    const key = createReadOnlyCacheKey('same-query');
    const failed = vi.fn(() => Promise.reject(new Error('temporary outage')));
    await expect(cache.getOrLoad({ operation: 'read', sideEffectClass: 'none', cache: { scopeKey: createReadOnlyCacheScope('user-a'), key }, load: failed })).rejects.toThrow('temporary outage');
    await expect(cache.getOrLoad({ operation: 'read', sideEffectClass: 'none', cache: { scopeKey: createReadOnlyCacheScope('user-a'), key }, load: () => 'a' })).resolves.toBe('a');
    await expect(cache.getOrLoad({ operation: 'read', sideEffectClass: 'none', cache: { scopeKey: createReadOnlyCacheScope('user-b'), key }, load: () => 'b' })).resolves.toBe('b');
    expect(cache.metrics()).toMatchObject({ loadFailures: 1, entries: 2 });
  });

  it('prewarms only registered safe loaders after the refresh threshold', async () => {
    const cache = new ReadOnlyTtlCache();
    const load = vi.fn(() => `value-${load.mock.calls.length}`);
    const descriptor = { scopeKey: createReadOnlyCacheScope('user'), key: createReadOnlyCacheKey('query'), ttlMs: 100, prewarm: true };
    await cache.getOrLoad({ operation: 'read', sideEffectClass: 'none', cache: descriptor, load });
    expect(await cache.runScheduledPrewarm()).toEqual({ attempted: 0, completed: 0, failed: 0, timedOut: 0 });
    await vi.advanceTimersByTimeAsync(80);
    expect(await cache.runScheduledPrewarm()).toEqual({ attempted: 1, completed: 1, failed: 0, timedOut: 0 });
    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.metrics().prewarmRuns).toBe(1);
  });

  it('fails closed for runtime-unsafe anticipatory jobs', async () => {
    const run = vi.fn(() => 'must not run');
    const result = await collectAnticipatoryContext([{
      key: 'unsafe',
      operation: 'mutate',
      sideEffectClass: 'local_write',
      run,
    } as any]);
    expect(run).not.toHaveBeenCalled();
    expect(result.failed[0]?.error).toContain('rejected unsafe operation');
    expect(result.values).toEqual({});

    const cache = new ReadOnlyTtlCache();
    await expect((cache as any).getOrLoad({
      operation: 'mutate',
      sideEffectClass: 'external_commit',
      cache: { scopeKey: 'scope', key: 'key' },
      load: run,
    })).rejects.toThrow('rejected unsafe operation');
  });
});
