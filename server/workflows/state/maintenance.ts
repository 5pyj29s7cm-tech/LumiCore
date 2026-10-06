import { flushDBOrThrow } from "../../../db_layer";
import { reconcileExpiredWorkflowRuns } from './reconciliation';

let workflowMaintenanceTimer: ReturnType<typeof setInterval> | null = null;

let workflowMaintenanceRunning = false;

/** Sweep crashed/expired workers during normal uptime, not only on restart. */
export function startWorkflowRuntimeMaintenance(intervalMs = 15_000): void {
  if (workflowMaintenanceTimer) return;
  workflowMaintenanceTimer = setInterval(() => {
    if (workflowMaintenanceRunning) return;
    workflowMaintenanceRunning = true;
    void (async () => {
    try {
      const changed = reconcileExpiredWorkflowRuns();
      if (changed > 0) await persistWorkflowRuntimeBarrier();
    } catch (error) {
      console.warn('[WorkflowRuntime] lease maintenance failed:', error);
    } finally {
      workflowMaintenanceRunning = false;
    }
    })();
  }, Math.max(5_000, intervalMs));
  workflowMaintenanceTimer.unref?.();
}

/** Stop future sweeps and retain the running lease until the current save finishes. */
export async function stopWorkflowRuntimeMaintenance(): Promise<void> {
  if (workflowMaintenanceTimer) clearInterval(workflowMaintenanceTimer);
  workflowMaintenanceTimer = null;
  while (workflowMaintenanceRunning) await new Promise(resolve => setTimeout(resolve, 20));
}

/** Await SQLite durability before exposing a workflow state transition. */
export async function persistWorkflowRuntimeBarrier(): Promise<void> {
  await flushDBOrThrow();
}
