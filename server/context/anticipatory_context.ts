import {
  readOnlyContextCache,
  type ReadOnlyCacheDescriptor,
} from './read_only_cache';

export interface AnticipatoryContextJob {
  key: string;
  operation: 'read' | 'status';
  sideEffectClass: 'none';
  cache?: ReadOnlyCacheDescriptor;
  run: () => unknown | Promise<unknown>;
}

export interface AnticipatoryContextResult {
  values: Record<string, unknown>;
  completed: string[];
  failed: Array<{ key: string; error: string }>;
  timedOut: string[];
  elapsedMs: number;
}

/**
 * Runs only explicitly read-only context lookups in parallel. The caller gets
 * a stable snapshot at the deadline; late reads cannot mutate the returned
 * result or block the user-facing turn.
 */
export async function collectAnticipatoryContext(
  jobs: AnticipatoryContextJob[],
  options: { deadlineMs?: number } = {},
): Promise<AnticipatoryContextResult> {
  const startedAt = Date.now();
  const deadlineMs = Math.max(1, options.deadlineMs ?? 1_500);
  const values: Record<string, unknown> = {};
  const completed = new Set<string>();
  const failed: Array<{ key: string; error: string }> = [];
  const uniqueJobs = Array.from(new Map(jobs.map(job => [job.key, job])).values());

  const executions = uniqueJobs.map(async job => {
    try {
      if (!['read', 'status'].includes(job.operation) || job.sideEffectClass !== 'none') {
        throw new Error('anticipatory context rejected unsafe operation');
      }
      values[job.key] = job.cache
        ? await readOnlyContextCache.getOrLoad({
            operation: job.operation,
            sideEffectClass: job.sideEffectClass,
            cache: job.cache,
            load: job.run,
          })
        : await job.run();
      completed.add(job.key);
    } catch (error: any) {
      failed.push({ key: job.key, error: error?.message || String(error) });
    }
  });

  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  await Promise.race([
    Promise.allSettled(executions),
    new Promise<void>(resolve => {
      deadlineTimer = setTimeout(resolve, deadlineMs);
    }),
  ]);
  if (deadlineTimer) clearTimeout(deadlineTimer);

  const failedKeys = new Set(failed.map(item => item.key));
  const timedOut = uniqueJobs
    .map(job => job.key)
    .filter(key => !completed.has(key) && !failedKeys.has(key));

  return {
    values: { ...values },
    completed: Array.from(completed),
    failed: [...failed],
    timedOut,
    elapsedMs: Date.now() - startedAt,
  };
}
