import type { AutonomousTask } from './task_queue';

// A saved tool receipt does not prove the whole task's final state was saved.
// Keep this projection independent of DB/queue initialization so every task
// read surface can withhold completion while its durable barrier is pending.
const pendingFinalizations = new Set<string>();

export function setAutonomousTaskFinalizationPending(id: string, pending: boolean): void {
  if (pending) pendingFinalizations.add(id);
  else pendingFinalizations.delete(id);
}

export function isAutonomousTaskFinalizationPending(id: string): boolean {
  return pendingFinalizations.has(id);
}

export function projectAutonomousTaskFinalization(task: AutonomousTask): AutonomousTask {
  if (!pendingFinalizations.has(task.id)) return task;
  return { ...task, status: 'blocked', finalized: false, verified: false, blocked: true,
    terminalReceipt: undefined, finalizationPending: true,
    error: 'The work finished, but its final state is awaiting a successful save.' };
}

export function resetAutonomousTaskFinalizationsForTests(): void {
  pendingFinalizations.clear();
}
