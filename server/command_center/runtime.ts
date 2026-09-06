import type { Server } from 'socket.io';
import { readDB } from '../../db_layer';
import { cancelTask, getTaskQueue, persistAutonomousTaskQueue, type AutonomousTask } from '../autonomy/task_queue';
import { executeNextAutonomousTask, retryAutonomousTaskFinalizations, type LLMGetters } from '../autonomy/task_executor';
import { runtimeBackgroundWork, runtimeShutdownCancellation } from '../runtime/shutdown_work';
import { isDurableTaskReady } from '../cognition/durable_task_recovery';
import { isOrganizationMembershipAuthorizationCurrent } from '../org/membership_authorization';

const activeUsers = new Map<string, Promise<void>>();

function isRequestedPlanTask(task: AutonomousTask): boolean {
  if (task.source !== 'user_request' || !task.planId
    || !task.idempotencyKey?.startsWith(`command-center-plan:${task.planId}:`)) return false;
  return (readDB().commandCenterPlans || []).some((plan: any) => plan.id === task.planId
    && plan.userId === task.userId && plan.domain === (task.domain || 'personal')
    && plan.orgId === (task.orgId || ''));
}

/** Consume explicit one-off requests without enabling unattended generation. */
export function dispatchManualCommandCenterPlanTasks(
  io: Server,
  getters: LLMGetters,
  options: { userId?: string; signal?: AbortSignal } = {},
): Promise<void> {
  return runtimeBackgroundWork.track(dispatchRequests(io, getters, options));
}

async function dispatchRequests(io: Server, getters: LLMGetters, options: { userId?: string; signal?: AbortSignal }): Promise<void> {
  if (options.signal?.aborted) return;
  await retryAutonomousTaskFinalizations(io);
  const users = [...new Set(getTaskQueue(options.userId).filter(isRequestedPlanTask).map(task => task.userId))];
  const outcomes = await Promise.allSettled(users.map(userId => {
    // Another consumer owns this user until the actual executor and save settle.
    if (activeUsers.has(userId)) return;
    const controller = new AbortController();
    const unregisterShutdown = runtimeShutdownCancellation.register(controller);
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const work = Promise.resolve().then(async () => {
      // Bounded by the durable queue capacity; new unattended work is never generated here.
      for (let count = 0; count < 20 && !controller.signal.aborted; count += 1) {
        const task = getTaskQueue(userId).find(candidate => candidate.status === 'pending'
          && isDurableTaskReady(candidate.nextAttemptAt) && isRequestedPlanTask(candidate));
        if (!task) return;
        const isAuthorized = () => task.domain !== 'work'
          || isOrganizationMembershipAuthorizationCurrent(task.membershipAuthorization, task.orgId || '', userId);
        if (!isAuthorized()) {
          cancelTask(task.id, userId);
          await persistAutonomousTaskQueue();
          continue;
        }
        const result = await executeNextAutonomousTask(io, getters, userId, {
          taskId: task.id, signal: controller.signal, isAuthorized,
        });
        if (!result.executed) return; // A live voice/owner/safety gate can defer it to the next tick.
      }
    }).finally(() => {
      unregisterShutdown();
      options.signal?.removeEventListener('abort', onAbort);
      activeUsers.delete(userId);
    });
    activeUsers.set(userId, work);
    return work;
  }));
  const failed = outcomes.find(outcome => outcome.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
