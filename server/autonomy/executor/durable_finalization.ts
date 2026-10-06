import { cancelAutonomousTaskFinalization, persistAutonomousTaskQueue, setAutonomousTaskFinalizationPending } from "../task_queue";
import type { Server as SocketIOServer } from "socket.io";
import type { AutonomousTask } from "../task_queue";
import { buildTaskCompletionFeedback } from "../../cognition/acceptance_evidence";
import { markLinkedPlanCancelled } from './linked_plan';
import { projectAutonomousCompletionFeedback } from './customer_projection';

interface PendingCompletion {
  room: string;
  payload: Record<string, unknown>;
  confirmPlanSaved?: () => void;
  task: AutonomousTask;
  isAuthorized: () => boolean;
  returnResult: { executed: boolean; taskId: string; result: string };
  cancelled?: boolean;
}

const pendingCompletions = new Map<string, PendingCompletion>();

export function stageAutonomousTaskFinalization(completion: PendingCompletion): void {
  setAutonomousTaskFinalizationPending(completion.task.id, true);
  pendingCompletions.set(completion.task.id, completion);
}

export function hasPendingAutonomousTaskFinalization(taskId: string): boolean {
  return pendingCompletions.has(taskId);
}

let taskFinalizationQueue: Promise<void> = Promise.resolve();

function cancelUnauthorizedCompletion(completion: PendingCompletion): boolean {
  if (completion.cancelled || completion.isAuthorized()) return false;
  const settled = cancelAutonomousTaskFinalization(completion.task.id, 'Task authorization was revoked before final delivery');
  if (!settled) throw new Error('Pending task finalization could not be cancelled after authorization was revoked');
  markLinkedPlanCancelled(completion.task);
  completion.cancelled = true;
  completion.returnResult.result = 'Cancelled because task authorization was revoked';
  completion.payload = {
    taskId: completion.task.id, title: completion.task.title, status: 'cancelled',
    finalized: false, verified: false,
    completionFeedback: projectAutonomousCompletionFeedback(buildTaskCompletionFeedback(
      settled?.terminalReceipt, completion.task.title, { status: 'cancelled' },
    )),
    timestamp: new Date().toISOString(),
  };
  return true;
}

/** Retry only durable finalization, never the already-settled tool actions. */
export function persistAutonomousTaskFinalizations(io: SocketIOServer): Promise<void> {
  // Every caller gets its own barrier and snapshots only once it owns the
  // queue. Reusing an in-flight promise would omit later staged completions.
  const finalization = taskFinalizationQueue.then(() => flushAutonomousTaskFinalizations(io));
  taskFinalizationQueue = finalization.catch(() => {});
  return finalization;
}

async function flushAutonomousTaskFinalizations(io: SocketIOServer): Promise<void> {
  // Snapshot before the write barrier: a completion staged during this await
  // belongs to its own barrier and must not be published by this invocation.
  const pending = [...pendingCompletions];
  let authorizationChanged: boolean;
  do {
    for (const [taskId, completion] of pending) {
      if (pendingCompletions.get(taskId) === completion) cancelUnauthorizedCompletion(completion);
    }
    await persistAutonomousTaskQueue();
    // Revocation can arrive while SQLite acknowledges the write. Persist the
    // cancelled state before publishing anything; each entry changes once.
    authorizationChanged = false;
    for (const [taskId, completion] of pending) {
      if (pendingCompletions.get(taskId) === completion && cancelUnauthorizedCompletion(completion)) authorizationChanged = true;
    }
  } while (authorizationChanged);
  for (const [taskId, completion] of pending) {
    if (pendingCompletions.get(taskId) !== completion) continue;
    pendingCompletions.delete(taskId);
    setAutonomousTaskFinalizationPending(taskId, false);
    completion.confirmPlanSaved?.();
    io.to(completion.room).emit(completion.cancelled ? 'autonomous:task_cancelled' : 'autonomous:task_completed', completion.payload);
  }
}

export async function retryAutonomousTaskFinalizations(io: SocketIOServer): Promise<void> {
  if (pendingCompletions.size > 0) await persistAutonomousTaskFinalizations(io);
}
