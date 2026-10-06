import type { ExtensionRevision } from './contracts';
import { executionCounts } from './runtime_state';

export async function runWithConcurrency<T>(revision: ExtensionRevision, operation: () => Promise<T>): Promise<T> {
  const release = acquireConcurrency(revision);
  try { return await operation(); } finally { release(); }
}

export function acquireConcurrency(revision: ExtensionRevision): () => void {
  const key = revision.id;
  const current = executionCounts.get(key) || 0;
  const limit = revision.manifest.permissions.maxConcurrency!;
  if (current >= limit) throw new Error(`Extension ${revision.extensionId} concurrency budget is exhausted.`);
  executionCounts.set(key, current + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = Math.max(0, (executionCounts.get(key) || 1) - 1);
    if (remaining) executionCounts.set(key, remaining);
    else executionCounts.delete(key);
  };
}
