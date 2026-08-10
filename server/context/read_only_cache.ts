import crypto from 'node:crypto';

export interface ReadOnlyCacheDescriptor {
  scopeKey: string;
  key: string;
  ttlMs?: number;
  prewarm?: boolean;
}

export interface ReadOnlyCacheMetrics {
  hits: number;
  misses: number;
  joins: number;
  loads: number;
  loadFailures: number;
  expired: number;
  prewarmRuns: number;
  prewarmFailures: number;
  entries: number;
  inflight: number;
}

interface CacheEntry {
  value: unknown;
  scopeKey: string;
  key: string;
  ttlMs: number;
  expiresAt: number;
  refreshAt: number;
  loader?: () => unknown | Promise<unknown>;
}

const DEFAULT_TTL_MS = 60_000;
const MIN_TTL_MS = 10;
const MAX_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;

function digest(parts: unknown[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function createReadOnlyCacheKey(...parts: unknown[]): string {
  return `roc_${digest(parts).slice(0, 40)}`;
}

export function createReadOnlyCacheScope(...parts: unknown[]): string {
  return `scope_${digest(parts).slice(0, 32)}`;
}

function boundedTtl(value?: number): number {
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(value) || DEFAULT_TTL_MS));
}

export class ReadOnlyTtlCache {
  private entries = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<unknown>>();
  private counters: Omit<ReadOnlyCacheMetrics, 'entries' | 'inflight'> = {
    hits: 0,
    misses: 0,
    joins: 0,
    loads: 0,
    loadFailures: 0,
    expired: 0,
    prewarmRuns: 0,
    prewarmFailures: 0,
  };

  private compositeKey(cache: ReadOnlyCacheDescriptor): string {
    const scopeKey = String(cache.scopeKey || '').trim();
    const key = String(cache.key || '').trim();
    if (!scopeKey || !key) throw new Error('read-only cache requires scoped digest keys');
    return `${scopeKey}:${key}`;
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) continue;
      this.entries.delete(key);
      this.counters.expired += 1;
    }
    if (this.entries.size <= MAX_ENTRIES) return;
    const oldest = [...this.entries.entries()]
      .sort((left, right) => left[1].expiresAt - right[1].expiresAt)
      .slice(0, this.entries.size - MAX_ENTRIES);
    for (const [key] of oldest) this.entries.delete(key);
  }

  async getOrLoad<T>(input: {
    operation: 'read' | 'status';
    sideEffectClass: 'none';
    cache: ReadOnlyCacheDescriptor;
    load: () => T | Promise<T>;
  }): Promise<T> {
    if (!['read', 'status'].includes(input.operation) || input.sideEffectClass !== 'none') {
      throw new Error('read-only cache rejected unsafe operation');
    }
    const key = this.compositeKey(input.cache);
    const now = Date.now();
    this.prune(now);
    const current = this.entries.get(key);
    if (current && current.expiresAt > now) {
      this.counters.hits += 1;
      return current.value as T;
    }
    const pending = this.inflight.get(key);
    if (pending) {
      this.counters.joins += 1;
      return pending as Promise<T>;
    }
    this.counters.misses += 1;
    return this.loadAndStore(key, input.cache, input.load, false) as Promise<T>;
  }

  private loadAndStore(
    key: string,
    cache: ReadOnlyCacheDescriptor,
    loader: () => unknown | Promise<unknown>,
    prewarm: boolean,
  ): Promise<unknown> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const ttlMs = boundedTtl(cache.ttlMs);
    const pending = Promise.resolve()
      .then(loader)
      .then(value => {
        const loadedAt = Date.now();
        this.counters.loads += 1;
        if (prewarm) this.counters.prewarmRuns += 1;
        this.entries.set(key, {
          value,
          scopeKey: cache.scopeKey,
          key: cache.key,
          ttlMs,
          expiresAt: loadedAt + ttlMs,
          refreshAt: loadedAt + Math.floor(ttlMs * 0.8),
          ...(cache.prewarm ? { loader } : {}),
        });
        this.prune(loadedAt);
        return value;
      })
      .catch(error => {
        this.counters.loadFailures += 1;
        if (prewarm) this.counters.prewarmFailures += 1;
        throw error;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, pending);
    return pending;
  }

  async runScheduledPrewarm(options: { deadlineMs?: number; maxJobs?: number } = {}): Promise<{
    attempted: number;
    completed: number;
    failed: number;
    timedOut: number;
  }> {
    const now = Date.now();
    const due = [...this.entries.entries()]
      .filter(([, entry]) => Boolean(entry.loader) && entry.refreshAt <= now && entry.expiresAt > now)
      .sort((left, right) => left[1].refreshAt - right[1].refreshAt)
      .slice(0, Math.max(1, options.maxJobs || 8));
    if (due.length === 0) return { attempted: 0, completed: 0, failed: 0, timedOut: 0 };

    let completed = 0;
    let failed = 0;
    const executions = due.map(([key, entry]) => this.loadAndStore(key, {
      scopeKey: entry.scopeKey,
      key: entry.key,
      ttlMs: entry.ttlMs,
      prewarm: true,
    }, entry.loader!, true).then(() => { completed += 1; }).catch(() => { failed += 1; }));
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      Promise.allSettled(executions),
      new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(1, options.deadlineMs || 1_500)); }),
    ]);
    if (timer) clearTimeout(timer);
    return {
      attempted: due.length,
      completed,
      failed,
      timedOut: Math.max(0, due.length - completed - failed),
    };
  }

  metrics(): ReadOnlyCacheMetrics {
    return { ...this.counters, entries: this.entries.size, inflight: this.inflight.size };
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
    for (const key of Object.keys(this.counters) as Array<keyof typeof this.counters>) this.counters[key] = 0;
  }
}

export const readOnlyContextCache = new ReadOnlyTtlCache();

export function runScheduledReadOnlyPrewarm(options: { deadlineMs?: number; maxJobs?: number } = {}) {
  return readOnlyContextCache.runScheduledPrewarm(options);
}
