import { type StoredExecution, type ChatExecutionPersistenceAdapter } from './contracts';

export const executionState = {
  executions: new Map<string, StoredExecution>(),
  activeByScope: new Map<string, string>(),
  persistenceAdapter: null as ChatExecutionPersistenceAdapter | null,
  persistenceQueue: Promise.resolve() as Promise<void>,
  lastPersistentPurgeAt: 0,
};

export function createSidecarDurabilityBoundary(): Pick<StoredExecution,
  | 'sidecarDurabilityBarrier'
  | 'resolveSidecarDurability'
  | 'rejectSidecarDurability'
  | 'sidecarDurabilitySettled'
> {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const barrier = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // The original handler commonly settles the boundary before a duplicate
  // exists. Mark the rejection observed without changing what later awaiters
  // receive from the original promise.
  void barrier.catch(() => undefined);
  return {
    sidecarDurabilityBarrier: barrier,
    resolveSidecarDurability: resolve,
    rejectSidecarDurability: reject,
    sidecarDurabilitySettled: false,
  };
}

export function resolveSidecarDurability(record: StoredExecution): void {
  if (record.sidecar !== true || record.sidecarDurabilitySettled === true) return;
  record.sidecarDurabilitySettled = true;
  record.resolveSidecarDurability?.();
}

export function rejectSidecarDurability(record: StoredExecution, error: unknown): void {
  if (record.sidecar !== true || record.sidecarDurabilitySettled === true) return;
  record.sidecarDurabilitySettled = true;
  record.rejectSidecarDurability?.(error);
}

/** Includes queued foreground turns and control sidecars, not just the current slot. */
export function countUnsettledChatExecutions(): number {
  let count = 0;
  for (const record of executionState.executions.values()) {
    if (record.inProcess && (!record.terminal || record.terminalReceiptPending)) count += 1;
  }
  return count;
}

export function resetChatExecutionRegistryForTests(): void {
  executionState.executions.clear();
  executionState.activeByScope.clear();
  executionState.persistenceAdapter = null;
  executionState.persistenceQueue = Promise.resolve();
  executionState.lastPersistentPurgeAt = 0;
}
