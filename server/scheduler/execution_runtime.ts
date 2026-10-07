import type { CapabilityExecutionPlan } from '../cognition/capability_execution_plan';
import type { ScheduledTask, ScheduledTaskExecutionContract, ScheduledTaskResult } from './contracts';
import type { ScheduledInFlightHandler } from './execution_phase';
import type { ScheduledRuntimePersistence } from './persistence';
import type { ScheduledDeliveryService } from './delivery';

export interface ScheduledExecutionContext {
  getTasks(): readonly ScheduledTask[];
  getLifecycleGeneration(): number;
  persistence: ScheduledRuntimePersistence;
  deliveries: ScheduledDeliveryService;
  strictFlush(): Promise<void>;
  writeDatabase(data: any): void;
  clearTimer(taskId: string): void;
  onReleased(taskId: string): void;
  reconcileTask(taskId: string, resolution: 'confirmed_no_side_effect' | 'accepted_unknown_outcome'):
    Promise<{ reconciled: boolean; found: boolean; reason: string }>;
}

export interface ScheduledExecutionRuntime {
  readonly context: ScheduledExecutionContext;
  readonly active: ReadonlyMap<string, ScheduledInFlightHandler>;
  beginExecution(task: ScheduledTask, startedAt: Date, contract: ScheduledTaskExecutionContract, compactAudit: boolean): ScheduledInFlightHandler;
  executeTaskHandler(task: ScheduledTask, plan: CapabilityExecutionPlan, execution: ScheduledInFlightHandler): Promise<ScheduledTaskResult>;
  captureScheduledLedgerCheckpoint(db: any, scheduledTaskId: string, executionId: string): () => void;
  finishSchedulerExecution(taskId: string): void;
}
