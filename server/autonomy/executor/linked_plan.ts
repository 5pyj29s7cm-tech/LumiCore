import { CN_AUTONOMOUS_CUSTOMER_MESSAGES } from '../../regions/messages/autonomous_customer_messages';
import type { Server as SocketIOServer } from "socket.io";
import type { AutonomousTask } from "../task_queue";
import { getPlan, updatePlan, updatePlanStep } from "../planner";
import type { PlanScope } from "../planner";
import { buildTaskCompletionFeedback } from "../../cognition/acceptance_evidence";
import { projectAutonomousCompletionFeedback } from './customer_projection';

export function clipPlanResult(value: string, max = 1800): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

export function planScopeForTask(task: AutonomousTask): PlanScope {
  const domain = task.domain === 'work' ? 'work' : 'personal';
  return {
    userId: task.userId,
    domain,
    orgId: domain === 'work' ? String(task.orgId || '') : '',
  };
}

export function markLinkedPlanRunning(task: AutonomousTask) {
  if (!task.planId) return;
  const scope = planScopeForTask(task);
  const plan = getPlan(task.planId, scope);
  if (!plan || plan.status !== 'active') return;
  const step = plan.steps.find(item => item.status === 'in_progress')
    || plan.steps.find(item => item.status === 'pending');
  if (step) {
    updatePlanStep(plan.id, step.id, {
      status: 'in_progress',
      result: `Autonomous task started: ${task.title}`,
    }, scope);
  }
}

export function markLinkedPlanFailed(task: AutonomousTask, error: string) {
  if (!task.planId) return;
  const scope = planScopeForTask(task);
  const plan = getPlan(task.planId, scope);
  if (!plan) return;
  const clipped = clipPlanResult(CN_AUTONOMOUS_CUSTOMER_MESSAGES.learningBlocked(error), 1000);
  const step = plan.steps.find(item => item.status === 'in_progress')
    || plan.steps.find(item => item.status === 'pending');

  if (step) {
    updatePlanStep(plan.id, step.id, {
      status: 'skipped',
      result: clipped,
    }, scope);
  }

  updatePlan(plan.id, {
    status: 'paused',
    result: clipped,
  }, scope);
}

export function markLinkedPlanCancelled(task: AutonomousTask) {
  if (!task.planId) return;
  const scope = planScopeForTask(task);
  const plan = getPlan(task.planId, scope);
  if (!plan) return;
  const message = 'Autonomous task cancelled by user';
  const step = plan.steps.find(item => item.status === 'in_progress');
  if (step) updatePlanStep(plan.id, step.id, { status: 'skipped', result: message }, scope);
  updatePlan(plan.id, { status: 'cancelled', result: message }, scope);
}

export function markLinkedPlanPaused(task: AutonomousTask) {
  if (!task.planId) return;
  const scope = planScopeForTask(task);
  const plan = getPlan(task.planId, scope);
  if (!plan || plan.status === 'cancelled' || plan.status === 'completed') return;
  // Preserve the current step and its receipts so an explicit resume can
  // continue it. Pausing does not skip or fail the remaining work.
  updatePlan(plan.id, { status: 'paused', result: 'Autonomous task paused by user' }, scope);
}

export function publishAutonomousTaskInterruption(
  io: SocketIOServer,
  room: string,
  task: AutonomousTask,
  settled: AutonomousTask,
): string | null {
  if (settled.status !== 'cancelled' && settled.status !== 'paused') return null;
  if (settled.status === 'cancelled') markLinkedPlanCancelled(task);
  else markLinkedPlanPaused(task);
  io.to(room).emit(settled.status === 'cancelled' ? 'autonomous:task_cancelled' : 'autonomous:task_paused', {
    taskId: task.id,
    title: task.title,
    status: settled.status,
    completionFeedback: projectAutonomousCompletionFeedback(buildTaskCompletionFeedback(
      settled.terminalReceipt, task.title, { status: settled.status },
    )),
    timestamp: new Date().toISOString(),
  });
  return settled.status === 'cancelled' ? 'Cancelled by user' : 'Paused';
}
