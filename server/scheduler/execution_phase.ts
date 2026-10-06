import type { CapabilityExecutionPlan } from "../cognition/capability_execution_plan";
import type { ScheduledTask, ScheduledTaskExecutionContract } from './contracts';

export class ScheduledTaskExecutionError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'scheduler_handler_timed_out'
      | 'scheduler_execution_timed_out'
      | 'scheduler_handler_aborted'
      | 'scheduler_delivery_withheld'
      | 'scheduler_delivery_invalid',
  ) {
    super(message);
    this.name = 'ScheduledTaskExecutionError';
  }
}

export interface ScheduledInFlightHandler {
  lifecycleGeneration: number;
  controller: AbortController;
  task: ScheduledTask;
  plan: CapabilityExecutionPlan | null;
  contract: ScheduledTaskExecutionContract;
  startedAt: Date;
  deadline: Date;
  deadlineTimer: NodeJS.Timeout;
  phase: 'planning' | 'admission_persistence' | 'handler' | 'delivery' | 'terminal_persistence';
  handlerStarted: boolean;
  handlerSettled: boolean;
  handlerOutcome?: 'fulfilled' | 'rejected';
  schedulerFinished: boolean;
  pendingLateSettlement: boolean;
  lateSettlementFinalizing: boolean;
  pendingDurableOperations: Set<Promise<unknown>>;
  durableOperationRejected: boolean;
  lateSettlementPendingHandler: boolean;
  lateSettlementPendingDurability: boolean;
  compactAudit: boolean;
}

export async function awaitExecutionPhase<T>(
    operation: Promise<T>,
    execution: ScheduledInFlightHandler,
    phase: ScheduledInFlightHandler['phase'],
  ): Promise<T> {
    execution.phase = phase;
    if (execution.controller.signal.aborted) {
      throw execution.controller.signal.reason;
    }
    let removeAbortListener = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(
        execution.controller.signal.reason instanceof Error
          ? execution.controller.signal.reason
          : new ScheduledTaskExecutionError(
            'Scheduled execution was aborted while an operation was still settling.',
            'scheduler_handler_aborted',
          ),
      );
      execution.controller.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => execution.controller.signal.removeEventListener('abort', onAbort);
    });
    try {
      return await Promise.race([operation, interrupted]);
    } finally {
      removeAbortListener();
    }
  }

export function executionOperationsSettled(execution: ScheduledInFlightHandler): boolean {
    return execution.handlerSettled && execution.pendingDurableOperations.size === 0;
  }
