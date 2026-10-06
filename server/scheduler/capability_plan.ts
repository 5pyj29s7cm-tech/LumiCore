import { buildScheduledCapabilityExecutionPlan, type CapabilityExecutionPlan } from "../cognition/capability_execution_plan";
import type { CapabilityLane, CapabilityOperation, CapabilitySideEffect } from "../tools/types";
import type { ScheduledExecutionClass, ScheduledTask } from './contracts';
import { buildScheduledExecutionId } from './execution_identity';

const SCHEDULED_EXECUTION_POLICIES: Record<ScheduledExecutionClass, {
  lane: CapabilityLane;
  operation: CapabilityOperation;
  sideEffectClass: 'local_write';
  sideEffects: CapabilitySideEffect[];
}> = {
  maintenance: {
    lane: 'system',
    operation: 'mutate',
    sideEffectClass: 'local_write',
    sideEffects: [{ type: 'local_write', scope: 'declared scheduler maintenance state', reversible: true }],
  },
  proactive_delivery: {
    lane: 'system',
    operation: 'communicate',
    sideEffectClass: 'local_write',
    sideEffects: [
      { type: 'local_write', scope: 'scoped proactive interaction ledger', reversible: true },
      { type: 'local_state_change', scope: 'local Lumi notification queue', reversible: true },
    ],
  },
  client_probe: {
    lane: 'client',
    operation: 'communicate',
    sideEffectClass: 'local_write',
    sideEffects: [{ type: 'local_state_change', scope: 'connected Lumi client session', reversible: true }],
  },
  autonomous_orchestration: {
    lane: 'agents',
    operation: 'mutate',
    sideEffectClass: 'local_write',
    sideEffects: [{ type: 'local_write', scope: 'autonomous local task queue and receipts', reversible: true }],
  },
};

export function buildScheduledTaskExecutionPlan(
  task: Pick<ScheduledTask, 'id' | 'cron' | 'executionClass'>,
  at: Date = new Date(),
): CapabilityExecutionPlan {
  const policy = SCHEDULED_EXECUTION_POLICIES[task.executionClass];
  if (!policy) throw new Error(`Scheduler task '${task.id}' has no declared execution policy.`);
  return buildScheduledCapabilityExecutionPlan({
    taskId: buildScheduledExecutionId(task.id, task.cron, at),
    scheduledTaskId: task.id,
    lane: policy.lane,
    operation: policy.operation,
    sideEffectClass: policy.sideEffectClass,
    sideEffects: policy.sideEffects,
  });
}
