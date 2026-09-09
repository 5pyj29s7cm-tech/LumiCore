import {
  readOnlyContextCache,
  type ReadOnlyCacheDescriptor,
} from './read_only_cache';

export interface AnticipatoryContextJob {
  key: string;
  operation: 'read' | 'status';
  sideEffectClass: 'none';
  cache?: ReadOnlyCacheDescriptor;
  /** Only non-cached work receives the lifetime of this collection. */
  run: (signal?: AbortSignal) => unknown | Promise<unknown>;
}

export interface AnticipatoryContextResult {
  values: Record<string, unknown>;
  completed: string[];
  failed: Array<{ key: string; error: string }>;
  timedOut: string[];
  cancelled: string[];
  elapsedMs: number;
}

/**
 * Runs only explicitly read-only context lookups in parallel. The caller gets
 * a stable snapshot at the deadline; late reads cannot mutate the returned
 * result or block the user-facing turn. Deadline/caller cancellation aborts
 * owned reads; cache loaders keep their shared lifetime across callers.
 */
export async function collectAnticipatoryContext(
  jobs: AnticipatoryContextJob[],
  options: { deadlineMs?: number; signal?: AbortSignal } = {},
): Promise<AnticipatoryContextResult> {
  const startedAt = Date.now();
  const deadlineMs = Math.max(1, Number.isFinite(options.deadlineMs) ? options.deadlineMs! : 1_500);
  const values: Record<string, unknown> = {};
  const completed = new Set<string>();
  const failed: Array<{ key: string; error: string }> = [];
  const uniqueJobs = Array.from(new Map(jobs.map(job => [job.key, job])).values());
  const ownedReads = new AbortController();
  let closed = false;
  let stoppedBy: 'deadline' | 'caller' | undefined;
  let notifyStopped!: () => void;
  const stopped = new Promise<void>(resolve => { notifyStopped = resolve; });
  const stop = (reason: 'deadline' | 'caller') => {
    if (closed) return;
    closed = true;
    stoppedBy = reason;
    ownedReads.abort(reason === 'caller'
      ? options.signal?.reason
      : new DOMException('Anticipatory context deadline exceeded', 'TimeoutError'));
    notifyStopped();
  };
  const onParentAbort = () => stop('caller');
  if (options.signal?.aborted) onParentAbort();
  else options.signal?.addEventListener('abort', onParentAbort, { once: true });
  const deadlineTimer = closed ? null : setTimeout(() => stop('deadline'), deadlineMs);

  const executions = uniqueJobs.map(async job => {
    if (closed) return;
    try {
      if (!['read', 'status'].includes(job.operation) || job.sideEffectClass !== 'none') {
        throw new Error('anticipatory context rejected unsafe operation');
      }
      const value = job.cache
        ? await readOnlyContextCache.getOrLoad({
            operation: job.operation,
            sideEffectClass: job.sideEffectClass,
            cache: job.cache,
            // A timeout of one waiter must not abort another waiter's load
            // or leave a cancelled signal in the scheduled prewarm closure.
            load: () => job.run(),
          })
        : await job.run(ownedReads.signal);
      if (closed) return;
      values[job.key] = value;
      completed.add(job.key);
    } catch (error: any) {
      if (closed) return;
      failed.push({ key: job.key, error: error?.message || String(error) });
    }
  });

  try {
    await Promise.race([Promise.allSettled(executions), stopped]);
  } finally {
    closed = true;
    if (deadlineTimer) clearTimeout(deadlineTimer);
    options.signal?.removeEventListener('abort', onParentAbort);
  }

  const failedKeys = new Set(failed.map(item => item.key));
  const unfinished = uniqueJobs
    .map(job => job.key)
    .filter(key => !completed.has(key) && !failedKeys.has(key));

  return {
    values: { ...values },
    completed: Array.from(completed),
    failed: [...failed],
    timedOut: stoppedBy === 'caller' ? [] : unfinished,
    cancelled: stoppedBy === 'caller' ? unfinished : [],
    elapsedMs: Date.now() - startedAt,
  };
}
