import type { ScheduledExecutionClass, ScheduledTask, ScheduledTaskExecutionContract } from './contracts';

const DEFAULT_TASK_TIMEOUT_MS: Record<ScheduledExecutionClass, number> = {
  client_probe: 30_000,
  proactive_delivery: 2 * 60_000,
  maintenance: 5 * 60_000,
  autonomous_orchestration: 15 * 60_000,
};

const TASK_TIMEOUT_ENV: Record<ScheduledExecutionClass, string> = {
  client_probe: 'LUMI_SCHEDULER_CLIENT_PROBE_TIMEOUT_MS',
  proactive_delivery: 'LUMI_SCHEDULER_PROACTIVE_DELIVERY_TIMEOUT_MS',
  maintenance: 'LUMI_SCHEDULER_MAINTENANCE_TIMEOUT_MS',
  autonomous_orchestration: 'LUMI_SCHEDULER_AUTONOMOUS_ORCHESTRATION_TIMEOUT_MS',
};

function normalizedTimeout(value: unknown): number | null {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout >= 10 && timeout <= 60 * 60_000
    ? Math.round(timeout)
    : null;
}

/** High-frequency client probes use the DB layer's coalesced flush budget. */
export function requiresStrictScheduledPersistence(
  executionClass: ScheduledExecutionClass,
  hasUserDelivery = false,
): boolean {
  return hasUserDelivery || executionClass !== 'client_probe';
}

/** Resolve a bounded wall-clock timeout with task override > class env > safe class default. */
export function getScheduledTaskTimeoutMs(
  executionClass: ScheduledExecutionClass,
  override?: number,
): number {
  return normalizedTimeout(override)
    ?? normalizedTimeout(process.env[TASK_TIMEOUT_ENV[executionClass]])
    ?? DEFAULT_TASK_TIMEOUT_MS[executionClass];
}

export function getScheduledTaskExecutionContract(
  task: Pick<ScheduledTask, 'executionClass' | 'timeoutMs' | 'deliveryPolicy'>,
  hasUserDelivery = false,
): ScheduledTaskExecutionContract {
  const strictPersistence = requiresStrictScheduledPersistence(
    task.executionClass,
    hasUserDelivery || task.deliveryPolicy === 'scoped',
  );
  return {
    timeoutMs: getScheduledTaskTimeoutMs(task.executionClass, task.timeoutMs),
    outcome: strictPersistence ? 'durable_terminal_receipt' : 'coalesced_probe_receipt',
    successCriteria: [
      'handler_settled_before_deadline',
      'declared_deliveries_persisted_before_emission',
      strictPersistence
        ? 'verified_terminal_receipt_persisted'
        : 'verified_probe_receipt_accepted_for_coalesced_persistence',
    ],
    evidence: [
      'capability_execution_plan',
      'scheduler_task_handler_terminal_receipt',
      'scoped_delivery_receipt_when_applicable',
    ],
    stopping: [
      'success_criteria_met',
      'wall_clock_timeout',
      'abort_signal',
      'capability_policy_block',
      'previous_slot_outcome_unknown',
    ],
    retry: {
      maxRetriesPerSlot: 0,
      onUnknownOutcome: 'reconcile_then_stop',
    },
    concurrency: {
      maxConcurrentRuns: 1,
      policy: 'skip_while_running',
    },
    finalAcceptance: strictPersistence
      ? 'scheduler_persisted_verified_terminal_receipt'
      : 'scheduler_coalesced_verified_probe_receipt',
  };
}
