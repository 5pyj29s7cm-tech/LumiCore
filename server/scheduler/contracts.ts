

export interface ScheduledDelivery {
  userId: string;
  message: string;
  domain?: 'personal' | 'work';
  orgId?: string;
  /** Model-authored user-visible text must pass the shared output finalizer. */
  modelGenerated?: boolean;
  /** Server-owned reminder claims, committed together with the delivery row. */
  reminderIds?: string[];
}

export type ScheduledTaskResult = string | ScheduledDelivery[] | null;

export interface ScheduledDeliveryFinalization {
  delivery: ScheduledDelivery | null;
  finalized: boolean;
  blocked: boolean;
  reason: string;
}

export type ScheduledExecutionClass =
  | 'maintenance'
  | 'proactive_delivery'
  | 'client_probe'
  | 'autonomous_orchestration';

export type ScheduledTaskRunStatus =
  | 'idle'
  | 'executing'
  | 'cancelling'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'timed_out'
  | 'cancelled'
  | 'unknown';

export interface ScheduledTaskExecutionContract {
  timeoutMs: number;
  outcome: 'durable_terminal_receipt' | 'coalesced_probe_receipt';
  successCriteria: string[];
  evidence: string[];
  stopping: string[];
  retry: {
    maxRetriesPerSlot: 0;
    onUnknownOutcome: 'reconcile_then_stop';
  };
  concurrency: {
    maxConcurrentRuns: 1;
    policy: 'skip_while_running';
  };
  finalAcceptance:
    | 'scheduler_persisted_verified_terminal_receipt'
    | 'scheduler_coalesced_verified_probe_receipt';
}

export interface ScheduledTaskExecutionContext {
  signal: AbortSignal;
  taskId: string;
  executionId: string;
  startedAt: string;
  deadline: string;
  contract: ScheduledTaskExecutionContract;
}

export interface ScheduledTask {
  id: string;
  cron: string;
  lastRun: string | null;
  /** Explicit semantic boundary compiled before the handler may run. */
  executionClass: ScheduledExecutionClass;
  handler: (context?: ScheduledTaskExecutionContext) => Promise<ScheduledTaskResult>;
  /** Per-task wall-clock bound. Defaults are selected from executionClass. */
  timeoutMs?: number;
  /** If true, result is stored internally but NOT broadcast as a proactive notification */
  quiet?: boolean;
  /** If false, task is paused and will not fire */
  enabled?: boolean;
  /** Client probes that may return user-visible deliveries must opt in before admission. */
  deliveryPolicy?: 'none' | 'scoped';
  /**
   * Collapse successful runs into a bounded audit summary. Compact is the
   * safe default; use full only when every successful slot is itself a
   * business record. Failures and unknown outcomes are always preserved.
   */
  auditMode?: 'full' | 'compact';
  lastStatus?: ScheduledTaskRunStatus;
  lastError?: string | null;
  lastDurationMs?: number | null;
  lastStartedAt?: string | null;
  nextRun?: string | null;
  persistenceStatus?: 'ok' | 'coalesced' | 'failed';
  lastPersistenceError?: string | null;
  /** Durable unknown-outcome fence. Cleared only by explicit reconciliation. */
  requiresReconciliation?: boolean;
  quarantinedExecutionId?: string | null;
  quarantineReason?: string | null;
  reconciledAt?: string | null;
  reconciliationResolution?: 'confirmed_no_side_effect' | 'accepted_unknown_outcome' | null;
}
