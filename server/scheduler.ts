import { createScheduledBuiltinTasks } from "./scheduler/builtins";
import crypto from "node:crypto";
import type { Server as SocketIOServer } from "socket.io";
import type { Reminder } from "./memory";
import { flushDBOrThrow, readDatabaseTables, commitDatabaseTables } from "../db_layer";
import { authorizeCapabilityPlanTool, type CapabilityExecutionPlan } from "./cognition/capability_execution_plan";
import { getScheduledCapabilityExecutionStatus, persistScheduledCapabilityExecution } from "./conversation/ledger/scheduler";
import type { ScheduledTask, ScheduledTaskExecutionContract, ScheduledDelivery, ScheduledTaskResult, ScheduledTaskRunStatus } from './scheduler/contracts';
import type { ScheduledInFlightHandler } from './scheduler/execution_phase';
import { hydrateRuntimeState, loadDisabledState, stageRuntimeState } from './scheduler/runtime_state';
import { redactSchedulerDiagnostic } from './scheduler/diagnostics';
import { requiresStrictScheduledPersistence, getScheduledTaskTimeoutMs, getScheduledTaskExecutionContract } from './scheduler/execution_contract';
import { awaitExecutionPhase, ScheduledTaskExecutionError, executionOperationsSettled } from './scheduler/execution_phase';
import { buildScheduledProactiveInteractionId } from './scheduler/execution_identity';
import { finalizeScheduledDelivery } from './scheduler/delivery_finalization';
import { parseSchedule, nextCronTime } from './scheduler/schedule';
import { buildScheduledTaskExecutionPlan } from './scheduler/capability_plan';
import { buildScheduledTaskRecord } from './scheduler/execution_record';
import { resolveScheduledUserIds } from './scheduler/user_selection';
import { createReminderCheckTask } from './scheduler/reminder_check';

export type { ScheduledDelivery } from './scheduler/contracts';
export type { ScheduledDeliveryFinalization } from './scheduler/contracts';
export { finalizeScheduledDelivery } from './scheduler/delivery_finalization';
export type { ScheduledExecutionClass } from './scheduler/contracts';
export type { ScheduledTaskRunStatus } from './scheduler/contracts';
export type { ScheduledTaskExecutionContract } from './scheduler/contracts';
export type { ScheduledTaskExecutionContext } from './scheduler/contracts';
export type { ScheduledTask } from './scheduler/contracts';
export { redactSchedulerDiagnostic } from './scheduler/diagnostics';
export { requiresStrictScheduledPersistence } from './scheduler/execution_contract';
export { getScheduledTaskTimeoutMs } from './scheduler/execution_contract';
export { getScheduledTaskExecutionContract } from './scheduler/execution_contract';
export type { ParsedSchedule } from './scheduler/schedule';
export { parseSchedule } from './scheduler/schedule';
export { buildScheduledExecutionId } from './scheduler/execution_identity';
export { buildScheduledTaskExecutionPlan } from './scheduler/capability_plan';
export { buildScheduledProactiveInteractionId } from './scheduler/execution_identity';
export { resolveScheduledUserIds } from './scheduler/user_selection';
export { createReminderCheckTask } from './scheduler/reminder_check';

export class Scheduler {
  private tasks: ScheduledTask[] = [];
  private timers: Map<string, NodeJS.Timeout> = new Map();
  private runningTasks: Set<string> = new Set();
  private runningControllers: Map<string, AbortController> = new Map();
  private inFlightHandlers: Map<string, ScheduledInFlightHandler> = new Map();
  /**
   * A lifecycle generation stops every closure. A per-task generation also
   * invalidates an already-running cron closure when the same task is
   * re-registered, disabled and enabled, or quarantined pending settlement.
   */
  private scheduleGenerations: Map<string, number> = new Map();
  private lifecycleGeneration = 0;
  io: SocketIOServer | null = null;
  private disabledTasks: Set<string> = new Set();
  private maintenanceQueue: Array<{ task: ScheduledTask; generation: number; resolve: () => void }> = [];
  private maintenanceActive = new Set<string>();

  constructor(
    private readonly strictFlush: () => Promise<void> = flushDBOrThrow,
    private readonly writeDatabase: (data: any) => void = commitDatabaseTables,
    private readonly maintenanceConcurrency = 2,
  ) {}

  setIO(io: SocketIOServer) {
    this.io = io;
  }

  register(task: ScheduledTask) {
    hydrateRuntimeState(task);
    // Restore enable/disable state from persistence
    const storedDisabled = loadDisabledState();
    if (storedDisabled.has(task.id)) {
      task.enabled = false;
      this.disabledTasks.add(task.id);
    }
    const existingIndex = this.tasks.findIndex(existing => existing.id === task.id);
    if (existingIndex >= 0) {
      const replacedTask = this.tasks[existingIndex];
      this.clearTimer(task.id);
      this.abortRunningTask(task.id, 'Scheduled task registration was replaced.');
      if (replacedTask !== task) {
        replacedTask.enabled = false;
        task.lastRun = replacedTask.lastRun;
        task.lastStatus = replacedTask.lastStatus;
        task.lastError = replacedTask.lastError;
        task.lastDurationMs = replacedTask.lastDurationMs;
        task.lastStartedAt = replacedTask.lastStartedAt;
        task.persistenceStatus = replacedTask.persistenceStatus;
        task.lastPersistenceError = replacedTask.lastPersistenceError;
      }
      this.tasks[existingIndex] = task;
    } else {
      this.tasks.push(task);
    }
    this.scheduleTask(task);
  }

  /** Persist disabled task IDs to DB */
  private persistDisabledState() {
    try {
      const db = readDatabaseTables(["settings"]);
      let setting = (db.settings || []).find((s: any) => s.key === 'scheduler_disabled_tasks');
      const value = JSON.stringify([...this.disabledTasks]);
      if (setting) {
        setting.value = value;
      } else {
        if (!db.settings) db.settings = [];
        db.settings.push({ key: 'scheduler_disabled_tasks', value });
      }
      this.writeDatabase(db);
    } catch (error: any) {
      console.error('[Scheduler] Failed to persist disabled task state:', redactSchedulerDiagnostic(error));
    }
  }

  private async persistDbWithRuntimeState(
    db: any,
    task: ScheduledTask,
    hasUserDelivery = false,
    execution?: ScheduledInFlightHandler,
  ) {
    const strict = requiresStrictScheduledPersistence(
      task.executionClass,
      hasUserDelivery || task.deliveryPolicy === 'scoped',
    );
    task.persistenceStatus = strict ? 'ok' : 'coalesced';
    task.lastPersistenceError = null;
    if (task.lastError) task.lastError = redactSchedulerDiagnostic(task.lastError);
    stageRuntimeState(db, task);
    try {
      this.writeDatabase(db);
      if (strict) {
        const flush = execution
          ? this.trackDurableOperation(this.strictFlush(), execution)
          : this.strictFlush();
        await (execution
          ? awaitExecutionPhase(flush, execution, execution.phase)
          : flush);
      }
    } catch (error: any) {
      task.persistenceStatus = 'failed';
      task.lastPersistenceError = redactSchedulerDiagnostic(error);
      console.error(`[Scheduler] Failed to persist runtime state for "${redactSchedulerDiagnostic(task.id)}":`, task.lastPersistenceError);
      throw error;
    }
  }

  private persistRuntimeState(task: ScheduledTask) {
    const preservePersistenceFailure = task.persistenceStatus === 'failed';
    const priorPersistenceError = task.lastPersistenceError;
    try {
      if (!preservePersistenceFailure) {
        task.persistenceStatus = task.executionClass === 'client_probe' ? 'coalesced' : 'ok';
        task.lastPersistenceError = null;
      }
      if (task.lastError) task.lastError = redactSchedulerDiagnostic(task.lastError);
      const db = readDatabaseTables(["settings"]);
      stageRuntimeState(db, task);
      this.writeDatabase(db);
      if (preservePersistenceFailure) {
        task.persistenceStatus = 'failed';
        task.lastPersistenceError = priorPersistenceError;
      }
    } catch (error: any) {
      task.persistenceStatus = 'failed';
      task.lastPersistenceError = redactSchedulerDiagnostic(error);
      console.error(`[Scheduler] Failed to persist runtime state for "${redactSchedulerDiagnostic(task.id)}":`, task.lastPersistenceError);
    }
  }

  private persistRecoveryDbWithRuntimeState(
    db: any,
    task: ScheduledTask,
    preservePersistenceFailure = false,
  ) {
    const priorPersistenceError = task.lastPersistenceError;
    if (!preservePersistenceFailure) {
      task.persistenceStatus = 'coalesced';
      task.lastPersistenceError = null;
    }
    if (task.lastError) task.lastError = redactSchedulerDiagnostic(task.lastError);
    stageRuntimeState(db, task);
    try {
      this.writeDatabase(db);
      if (preservePersistenceFailure) {
        task.persistenceStatus = 'failed';
        task.lastPersistenceError = priorPersistenceError;
      }
    } catch (error: any) {
      task.persistenceStatus = 'failed';
      task.lastPersistenceError = redactSchedulerDiagnostic(error);
      console.error(
        `[Scheduler] Failed to persist recovery state for "${redactSchedulerDiagnostic(task.id)}":`,
        task.lastPersistenceError,
      );
    }
  }

  private abortRunningTask(id: string, reason: string) {
    const controller = this.runningControllers.get(id);
    if (controller && !controller.signal.aborted) {
      const execution = this.inFlightHandlers.get(id);
      if (execution) {
        clearTimeout(execution.deadlineTimer);
        if (execution.handlerStarted) {
          const visibleTask = this.tasks.find(candidate => candidate.id === id) || execution.task;
          const handlerPending = !execution.handlerSettled;
          const durabilityPending = execution.pendingDurableOperations.size > 0;
          const message = handlerPending
            ? 'Cancellation was requested, but the handler is still settling; side-effect outcome remains unknown.'
            : durabilityPending
              ? 'Cancellation was requested, but durable persistence is still settling; side-effect outcome remains unknown.'
            : 'Cancellation was requested while execution finalization was still pending; side-effect outcome remains unknown.';
          for (const target of new Set([execution.task, visibleTask])) {
            target.lastStatus = handlerPending ? 'cancelling' : 'unknown';
            target.lastError = message;
          }
          try {
            this.persistRecoveryDbWithRuntimeState(
              readDatabaseTables(["conversationActionReceipts","conversationActionTasks","interactions","reminders","settings","users","conversationActionTurns","conversations"]),
              visibleTask,
              visibleTask.persistenceStatus === 'failed' || execution.task.persistenceStatus === 'failed',
            );
          } catch {
            // persistRecoveryDbWithRuntimeState already records and logs the failure.
          }
        }
      }
      controller.abort(new ScheduledTaskExecutionError(reason, 'scheduler_handler_aborted'));
    }
  }

  private beginExecution(
    task: ScheduledTask,
    startedAt: Date,
    contract: ScheduledTaskExecutionContract,
    compactAudit: boolean,
  ): ScheduledInFlightHandler {
    const controller = new AbortController();
    const deadline = new Date(startedAt.getTime() + contract.timeoutMs);
    let execution!: ScheduledInFlightHandler;
    const deadlineTimer = setTimeout(() => {
      if (controller.signal.aborted) return;
      controller.abort(new ScheduledTaskExecutionError(
        `Scheduled execution exceeded its ${contract.timeoutMs}ms end-to-end deadline during ${execution.phase}; the active operation may still be settling.`,
        'scheduler_execution_timed_out',
      ));
    }, contract.timeoutMs);
    execution = {
      lifecycleGeneration: this.lifecycleGeneration,
      controller,
      task,
      plan: null,
      contract,
      startedAt,
      deadline,
      deadlineTimer,
      phase: 'planning',
      handlerStarted: false,
      handlerSettled: true,
      handlerOutcome: undefined,
      schedulerFinished: false,
      pendingLateSettlement: false,
      lateSettlementFinalizing: false,
      pendingDurableOperations: new Set(),
      durableOperationRejected: false,
      lateSettlementPendingHandler: false,
      lateSettlementPendingDurability: false,
      compactAudit,
    };
    this.runningControllers.set(task.id, controller);
    this.inFlightHandlers.set(task.id, execution);
    return execution;
  }

  private trackDurableOperation<T>(
    operation: Promise<T>,
    execution: ScheduledInFlightHandler,
  ): Promise<T> {
    const tracked = Promise.resolve(operation);
    execution.pendingDurableOperations.add(tracked);
    void tracked.then(
      () => this.markDurableOperationSettled(execution.task.id, execution, tracked, 'fulfilled'),
      () => this.markDurableOperationSettled(execution.task.id, execution, tracked, 'rejected'),
    );
    return tracked;
  }

  disableTask(id: string): boolean {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return false;
    task.enabled = false;
    this.disabledTasks.add(id);
    this.clearTimer(id);
    this.abortRunningTask(id, 'Scheduled task was disabled.');
    task.nextRun = null;
    this.persistRuntimeState(task);
    this.persistDisabledState();
    console.log(`[Scheduler] Task "${redactSchedulerDiagnostic(id)}" disabled`);
    return true;
  }

  enableTask(id: string): boolean {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return false;
    task.enabled = true;
    this.disabledTasks.delete(id);
    const pendingSettlement = this.inFlightHandlers.get(id);
    if (
      (!pendingSettlement?.pendingLateSettlement
        || executionOperationsSettled(pendingSettlement))
      && !task.requiresReconciliation
    ) {
      this.scheduleTask(task);
    } else {
      task.nextRun = null;
      this.persistRuntimeState(task);
    }
    this.persistDisabledState();
    console.log(`[Scheduler] Task "${redactSchedulerDiagnostic(id)}" enabled`);
    return true;
  }

  private clearTimer(id: string) {
    this.scheduleGenerations.set(id, (this.scheduleGenerations.get(id) || 0) + 1);
    const timer = this.timers.get(id);
    if (timer) {
      clearInterval(timer);
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  toggleTask(id: string): { enabled: boolean; found: boolean } {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return { enabled: false, found: false };
    if (task.enabled !== false) {
      this.disableTask(id);
      return { enabled: false, found: true };
    } else {
      this.enableTask(id);
      return { enabled: true, found: true };
    }
  }

  listTasks() {
    return this.tasks.map(task => ({
      id: task.id,
      cron: task.cron,
      lastRun: task.lastRun,
      lastStatus: task.lastStatus || 'idle',
      lastError: task.lastError ? redactSchedulerDiagnostic(task.lastError) : null,
      lastDurationMs: task.lastDurationMs ?? null,
      lastStartedAt: task.lastStartedAt ?? null,
      nextRun: task.nextRun ?? null,
      running: this.runningTasks.has(task.id),
      queued: this.maintenanceQueue.some(entry => entry.task.id === task.id),
      settlementPending: Boolean(
        this.inFlightHandlers.get(task.id)?.pendingLateSettlement
        && !executionOperationsSettled(this.inFlightHandlers.get(task.id)!)
      ),
      executionClass: task.executionClass,
      timeoutMs: getScheduledTaskTimeoutMs(task.executionClass, task.timeoutMs),
      executionContract: getScheduledTaskExecutionContract(task),
      persistenceStatus: task.persistenceStatus || 'ok',
      lastPersistenceError: task.lastPersistenceError
        ? redactSchedulerDiagnostic(task.lastPersistenceError)
        : null,
      active: this.timers.has(task.id),
      enabled: task.enabled !== false,
      requiresReconciliation: task.requiresReconciliation === true,
      quarantinedExecutionId: task.quarantinedExecutionId || null,
      quarantineReason: task.quarantineReason
        ? redactSchedulerDiagnostic(task.quarantineReason)
        : null,
      reconciledAt: task.reconciledAt || null,
      reconciliationResolution: task.reconciliationResolution || null,
    }));
  }

  async reconcileTask(
    id: string,
    resolution: 'confirmed_no_side_effect' | 'accepted_unknown_outcome',
  ): Promise<{ reconciled: boolean; found: boolean; reason: string }> {
    const task = this.tasks.find(candidate => candidate.id === id);
    if (!task) return { reconciled: false, found: false, reason: 'task_not_found' };
    const inFlight = this.inFlightHandlers.get(id);
    if (inFlight) {
      if (!inFlight.handlerSettled) {
        return { reconciled: false, found: true, reason: 'handler_still_settling' };
      }
      if (inFlight.pendingDurableOperations.size > 0 || inFlight.lateSettlementFinalizing) {
        return { reconciled: false, found: true, reason: 'durable_operation_still_settling' };
      }
      if (!inFlight.schedulerFinished) {
        return { reconciled: false, found: true, reason: 'execution_still_active' };
      }
    }
    if (!task.requiresReconciliation) {
      return { reconciled: false, found: true, reason: 'reconciliation_not_required' };
    }

    const reconciledAt = new Date().toISOString();
    const reconciledTask: ScheduledTask = {
      ...task,
      requiresReconciliation: false,
      quarantinedExecutionId: null,
      quarantineReason: null,
      reconciledAt,
      reconciliationResolution: resolution,
      persistenceStatus: 'ok',
      lastPersistenceError: null,
    };
    const currentDb = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","interactions","reminders","settings","users","conversationActionTurns","conversations"]);
    const candidateDb = {
      ...currentDb,
      settings: (currentDb.settings || []).map((setting: any) => ({ ...setting })),
    };
    // Resuming future slots does not resolve the historical side effect. Keep
    // even legacy executions without an execution ID before clearing the fence.
    candidateDb.settings.push({
      key: `scheduler_reconciliation_v1:${crypto.randomUUID()}`,
      value: JSON.stringify({ taskId: task.id, executionId: task.quarantinedExecutionId || null,
        resolution, reconciledAt, historicalStatus: task.lastStatus,
        lastStartedAt: task.lastStartedAt, lastRun: task.lastRun,
        quarantineReason: task.quarantineReason, lastError: task.lastError,
        persistenceStatus: task.persistenceStatus, lastPersistenceError: task.lastPersistenceError,
        replayed: false }),
    });
    stageRuntimeState(candidateDb, reconciledTask);
    try {
      this.writeDatabase(candidateDb);
      await this.strictFlush();
    } catch (error: any) {
      // Never authorize re-entry if the reconciliation decision was not
      // durable. Restore the previous in-memory projection best-effort.
      this.writeDatabase(currentDb);
      task.persistenceStatus = 'failed';
      task.lastPersistenceError = redactSchedulerDiagnostic(error);
      return { reconciled: false, found: true, reason: 'reconciliation_persistence_failed' };
    }

    task.requiresReconciliation = false;
    task.quarantinedExecutionId = null;
    task.quarantineReason = null;
    task.reconciledAt = reconciledAt;
    task.reconciliationResolution = resolution;
    task.persistenceStatus = 'ok';
    task.lastPersistenceError = null;
    if (task.enabled !== false) this.scheduleTask(task);
    return { reconciled: true, found: true, reason: 'reconciled' };
  }

  /**
   * Stage the complete candidate batch and swap it into the in-memory database
   * with one write. No delivery row becomes visible before every row has been
   * materialized, so a later item cannot strand an earlier silent message.
   */
  private persistProactiveMessageBatch(
    taskId: string,
    executionId: string,
    deliveries: Array<{ deliveryIndex: number; delivery: ScheduledDelivery }>,
    timestamp: string,
  ): { createdInteractionIds: string[]; createdDeliveryIndexes: Set<number>; reminderChanges: Array<{ before: Reminder; after: Reminder }> } {
    const currentDb = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","interactions","reminders","settings","users","conversationActionTurns","conversations"]);
    const originalInteractions = Array.isArray(currentDb.interactions)
      ? currentDb.interactions
      : [];
    const candidateDb = {
      ...currentDb,
      interactions: [...originalInteractions],
      reminders: [...(currentDb.reminders || [])],
    };
    const existingIds = new Set(originalInteractions.map((candidate: any) => candidate.id));
    const createdInteractionIds: string[] = [];
    const createdDeliveryIndexes = new Set<number>();
    const reminderChanges: Array<{ before: Reminder; after: Reminder }> = [];
    const claimedReminderIds = new Set<string>();
    for (const { deliveryIndex, delivery } of deliveries) {
      const id = buildScheduledProactiveInteractionId(executionId, deliveryIndex, delivery);
      if (existingIds.has(id)) continue;
      if (taskId === 'reminder_check' || delivery.reminderIds) {
        if (taskId !== 'reminder_check' || !delivery.reminderIds?.length) {
          throw new ScheduledTaskExecutionError('Reminder delivery is missing its server-owned claims.', 'scheduler_delivery_invalid');
        }
        const reminders = delivery.reminderIds.map(reminderId => {
          const reminder = candidateDb.reminders.find((item: Reminder) => item.id === reminderId);
          if (claimedReminderIds.has(reminderId) || !reminder || reminder.status !== 'pending'
            || !reminder.dueAt || reminder.dueAt > timestamp
            || reminder.userId !== delivery.userId
            || (reminder.domain || 'personal') !== (delivery.domain || 'personal')
            || (reminder.orgId || '') !== (delivery.orgId || '')) {
            throw new ScheduledTaskExecutionError('Reminder delivery claims are no longer current or do not match the recipient.', 'scheduler_delivery_invalid');
          }
          claimedReminderIds.add(reminderId);
          const before = { ...reminder };
          const after = { ...reminder, status: 'fired' as const, firedAt: timestamp };
          candidateDb.reminders[candidateDb.reminders.indexOf(reminder)] = after;
          reminderChanges.push({ before, after });
          return reminder;
        });
        // A reminder can be edited between handler selection and delivery.
        // Construct the message from the same authoritative candidate we commit.
        delivery.message = `Reminder: ${reminders.map((reminder: Reminder) => reminder.content).join(' | ')}`;
      }
      existingIds.add(id);
      candidateDb.interactions.push({
        id,
        userId: delivery.userId,
        agentId: 'lumi',
        conversationId: '',
        module: 'lumi',
        message: `[${taskId}] ${delivery.message}`,
        response: '',
        role: 'assistant',
        personality: 'lumi',
        mode: 'proactive',
        toolCalls: JSON.stringify({ executionId, scheduledTaskId: taskId, ...(delivery.reminderIds ? { reminderIds: delivery.reminderIds } : {}) }),
        domain: delivery.domain || 'personal',
        orgId: delivery.domain === 'work' ? delivery.orgId || '' : '',
        timestamp,
      });
      createdInteractionIds.push(id);
      createdDeliveryIndexes.add(deliveryIndex);
    }
    if (createdInteractionIds.length === 0) {
      return { createdInteractionIds, createdDeliveryIndexes, reminderChanges };
    }
    try {
      this.writeDatabase(candidateDb);
    } catch (error) {
      try {
        this.rollbackProactiveMessageBatch(createdInteractionIds, reminderChanges);
      } catch (rollbackError) {
        throw new Error(
          'Atomic proactive delivery persistence failed and its in-memory rollback could not be confirmed.',
          { cause: rollbackError },
        );
      }
      throw error;
    }
    return { createdInteractionIds, createdDeliveryIndexes, reminderChanges };
  }

  private rollbackProactiveMessageBatch(createdInteractionIds: string[], reminderChanges: Array<{ before: Reminder; after: Reminder }> = []): void {
    if (createdInteractionIds.length === 0) return;
    const rollbackDb = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","interactions","reminders","settings","users","conversationActionTurns","conversations"]);
    const created = new Set(createdInteractionIds);
    // Mutate the live projection before calling the writer as well: even a
    // writer that throws after swapping its candidate cannot leave these rows
    // available to a retry as created=false.
    rollbackDb.interactions = (rollbackDb.interactions || [])
      .filter((candidate: any) => !created.has(candidate.id));
    // Restore only our claim. Do not resurrect a deleted reminder or overwrite
    // another user's edit while the asynchronous flush was settling.
    rollbackDb.reminders = (rollbackDb.reminders || []).map((reminder: Reminder) => {
      const change = reminderChanges.find(item => item.after.id === reminder.id);
      return change && reminder.status === change.after.status && reminder.firedAt === change.after.firedAt
        ? { ...reminder, status: change.before.status, firedAt: change.before.firedAt }
        : reminder;
    });
    this.writeDatabase(rollbackDb);
  }

  private async deliverTaskResult(
    task: ScheduledTask,
    plan: CapabilityExecutionPlan,
    result: ScheduledTaskResult,
    timestamp: string,
    execution: ScheduledInFlightHandler,
  ): Promise<{ deliveryCount: number; persistedCount: number; emittedCount: number; withheldCount: number }> {
    const summary = { deliveryCount: 0, persistedCount: 0, emittedCount: 0, withheldCount: 0 };
    if (execution.controller.signal.aborted) throw execution.controller.signal.reason;
    if (!result) return summary;
    if (!Array.isArray(result)) {
      if (!task.quiet) {
        console.warn(`[Scheduler] Dropped unscoped proactive result from "${redactSchedulerDiagnostic(task.id)}". Return ScheduledDelivery[] instead.`);
      }
      return summary;
    }

    // Validate the complete delivery envelope before creating any durable row
    // or emitting anything. In particular, a work-scoped delivery without an
    // organization must never silently fall back to a personal user room.
    const invalidDeliveryIndex = result.findIndex((delivery: any) => (
      !delivery
      || typeof delivery !== 'object'
      || typeof delivery.userId !== 'string'
      || !delivery.userId.trim()
      || typeof delivery.message !== 'string'
      || !delivery.message.trim()
      || (delivery.domain !== undefined && delivery.domain !== 'personal' && delivery.domain !== 'work')
      || (delivery.domain === 'work' && (
        typeof delivery.orgId !== 'string' || !delivery.orgId.trim()
      ))
    ));
    if (invalidDeliveryIndex >= 0) {
      throw new ScheduledTaskExecutionError(
        `Scheduled delivery ${invalidDeliveryIndex} was rejected because its recipient, message, or scope was invalid.`,
        'scheduler_delivery_invalid',
      );
    }

    const preparedDeliveries: Array<{
      deliveryIndex: number;
      normalized: ScheduledDelivery;
      finalized: boolean;
      reason: string;
    }> = [];
    result.forEach((delivery, deliveryIndex) => {
      summary.deliveryCount += 1;
      const deliveryFinalization = finalizeScheduledDelivery(task.id, delivery);
      if (!deliveryFinalization.delivery) {
        summary.withheldCount += 1;
        console.warn(
          `[Scheduler] Withheld unverified model-authored proactive message from "${redactSchedulerDiagnostic(task.id)}": `
          + redactSchedulerDiagnostic(deliveryFinalization.reason),
        );
        return;
      }
      const safeDelivery = deliveryFinalization.delivery;
      const normalized: ScheduledDelivery = {
        userId: safeDelivery.userId.trim(),
        message: safeDelivery.message.trim(),
        domain: safeDelivery.domain === 'work' ? 'work' : 'personal',
        orgId: safeDelivery.domain === 'work' ? safeDelivery.orgId!.trim() : '',
        ...(safeDelivery.reminderIds ? { reminderIds: [...safeDelivery.reminderIds] } : {}),
      };
      preparedDeliveries.push({
        deliveryIndex,
        normalized,
        finalized: deliveryFinalization.finalized,
        reason: deliveryFinalization.reason,
      });
    });
    let batch: ReturnType<Scheduler['persistProactiveMessageBatch']>;
    try {
      batch = this.persistProactiveMessageBatch(
        task.id,
        plan.taskId,
        preparedDeliveries.map(item => ({
          deliveryIndex: item.deliveryIndex,
          delivery: item.normalized,
        })),
        timestamp,
      );
    } catch (error) {
      task.persistenceStatus = 'failed';
      task.lastPersistenceError = redactSchedulerDiagnostic(error);
      throw error;
    }
    summary.persistedCount = preparedDeliveries.length;
    const pendingEmissions = preparedDeliveries.filter(item => (
      batch.createdDeliveryIndexes.has(item.deliveryIndex) && !task.quiet && this.io
    ));
    if (batch.createdInteractionIds.length > 0) {
      // Never tell the client about a proactive result that exists only in
      // process memory. The strict flush is the delivery evidence boundary.
      const deliveryFlush = this.trackDurableOperation(this.strictFlush(), execution);
      try {
        await awaitExecutionPhase(deliveryFlush, execution, 'delivery');
        if (execution.controller.signal.aborted) throw execution.controller.signal.reason;
      } catch (error) {
        task.persistenceStatus = 'failed';
        task.lastPersistenceError = redactSchedulerDiagnostic(error);
        try {
          this.rollbackProactiveMessageBatch(batch.createdInteractionIds, batch.reminderChanges);
        } catch (rollbackError: any) {
          task.lastPersistenceError = redactSchedulerDiagnostic(
            `${task.lastPersistenceError || 'Delivery persistence failed'}; rollback failed: ${rollbackError}`,
          );
        }
        // A timed-out flush may still commit its captured candidate. Chain a
        // strict rollback boundary behind its real settlement and keep both
        // promises inside the execution fence.
        const rollbackFlush = this.trackDurableOperation(
          deliveryFlush.catch(() => undefined).then(() => this.strictFlush()),
          execution,
        );
        if (!execution.controller.signal.aborted) {
          try {
            await awaitExecutionPhase(rollbackFlush, execution, 'delivery');
          } catch (rollbackError: any) {
            task.lastPersistenceError = redactSchedulerDiagnostic(
              `${task.lastPersistenceError || 'Delivery persistence failed'}; durable rollback failed: ${rollbackError}`,
            );
            if (execution.controller.signal.aborted) {
              throw execution.controller.signal.reason;
            }
          }
        }
        throw error;
      }
      for (const emission of pendingEmissions) {
        if (emission.normalized.reminderIds?.some(reminderId => {
          const expected = batch.reminderChanges.find(item => item.after.id === reminderId)?.after;
          const current = (readDatabaseTables(["conversationActionReceipts","conversationActionTasks","interactions","reminders","settings","users","conversationActionTurns","conversations"]).reminders || []).find((item: Reminder) => item.id === reminderId);
          return !expected || !current || current.status !== 'fired' || current.firedAt !== expected.firedAt
            || current.userId !== expected.userId || current.content !== expected.content || current.dueAt !== expected.dueAt
            || (current.domain || 'personal') !== (expected.domain || 'personal') || (current.orgId || '') !== (expected.orgId || '');
        })) continue;
        const room = emission.normalized.domain === 'work' && emission.normalized.orgId
          ? `user:${emission.normalized.userId}:org:${emission.normalized.orgId}`
          : `user:${emission.normalized.userId}:personal`;
        this.io!.to(room).emit('agent:proactive', {
          taskId: task.id,
          interactionId: buildScheduledProactiveInteractionId(plan.taskId, emission.deliveryIndex, emission.normalized),
          message: emission.normalized.message,
          domain: emission.normalized.domain,
          orgId: emission.normalized.orgId,
          timestamp,
          finalized: emission.finalized,
          blocked: false,
          reason: emission.reason,
        });
        summary.emittedCount += 1;
      }
    }
    return summary;
  }

  private scheduleTask(task: ScheduledTask) {
    this.clearTimer(task.id);
    const taskScheduleGeneration = this.scheduleGenerations.get(task.id) || 0;
    const scheduleGeneration = this.lifecycleGeneration;
    if (task.enabled === false) {
      task.nextRun = null;
      this.persistRuntimeState(task);
      console.log(`[Scheduler] Task "${redactSchedulerDiagnostic(task.id)}" is disabled — skipping schedule`);
      return;
    }
    if (task.requiresReconciliation) {
      task.nextRun = null;
      this.persistRuntimeState(task);
      console.warn(
        `[Scheduler] Task "${redactSchedulerDiagnostic(task.id)}" remains quarantined until its unknown outcome is explicitly reconciled.`,
      );
      return;
    }
    const parsed = parseSchedule(task.cron);

    if (parsed.type === 'interval') {
      // Simple fixed interval — use setInterval (backward compat)
      task.nextRun = new Date(Date.now() + parsed.intervalMs).toISOString();
      this.persistRuntimeState(task);
      const timer = setInterval(() => {
        if (
          scheduleGeneration !== this.lifecycleGeneration
          || taskScheduleGeneration !== this.scheduleGenerations.get(task.id)
        ) return;
        task.nextRun = new Date(Date.now() + parsed.intervalMs).toISOString();
        this.persistRuntimeState(task);
        void this.runTask(task);
      }, parsed.intervalMs);
      this.timers.set(task.id, timer);
      console.log(`[Scheduler] Registered task "${redactSchedulerDiagnostic(task.id)}" every ${parsed.intervalMs / 1000}s${task.quiet ? ' (quiet)' : ''}`);
    } else {
      // Real cron expression — use recursive setTimeout to hit exact times
      const runAndReschedule = async () => {
        if (
          scheduleGeneration !== this.lifecycleGeneration
          || taskScheduleGeneration !== this.scheduleGenerations.get(task.id)
        ) return;
        await this.runTask(task);
        if (
          scheduleGeneration !== this.lifecycleGeneration
          || taskScheduleGeneration !== this.scheduleGenerations.get(task.id)
          || task.enabled === false
          || !this.tasks.some(item => item === task)
        ) return;
        // Schedule next run
        const nextMs = nextCronTime(parsed.fields!);
        task.nextRun = new Date(Date.now() + nextMs).toISOString();
        this.persistRuntimeState(task);
        this.setTaskTimeout(task.id, runAndReschedule, nextMs, taskScheduleGeneration);
      };
      const firstMs = nextCronTime(parsed.fields!);
      task.nextRun = new Date(Date.now() + firstMs).toISOString();
      this.persistRuntimeState(task);
      this.setTaskTimeout(task.id, runAndReschedule, firstMs, taskScheduleGeneration);
      const [m, h, dom, mon, dow] = parsed.fields!;
      console.log(`[Scheduler] Registered cron task "${redactSchedulerDiagnostic(task.id)}" — ${m} ${h} ${dom} ${mon} ${dow} (next in ${Math.round(firstMs / 1000)}s)`);
    }
  }

  private runTask(task: ScheduledTask): Promise<void> {
    if (task.executionClass !== 'maintenance') return this.runAdmittedTask(task);
    if (task.enabled === false || task.requiresReconciliation || this.runningTasks.has(task.id)
      || this.maintenanceActive.has(task.id) || this.maintenanceQueue.some(entry => entry.task.id === task.id)) return Promise.resolve();
    // Interval jobs share startup offsets and used to all flush and call
    // models at once. Queue before starting their execution deadlines, leaving
    // foreground probes and reminder delivery outside this maintenance lane.
    return new Promise(resolve => {
      this.maintenanceQueue.push({ task, generation: this.lifecycleGeneration, resolve });
      this.drainMaintenanceQueue();
    });
  }

  private drainMaintenanceQueue(): void {
    while (this.maintenanceActive.size < Math.max(1, this.maintenanceConcurrency) && this.maintenanceQueue.length) {
      const entry = this.maintenanceQueue.shift()!;
      if (entry.generation !== this.lifecycleGeneration || entry.task.enabled === false
        || entry.task.requiresReconciliation || !this.tasks.includes(entry.task)) { entry.resolve(); continue; }
      this.maintenanceActive.add(entry.task.id);
      void this.runAdmittedTask(entry.task).finally(() => {
        if (!this.runningTasks.has(entry.task.id)) this.maintenanceActive.delete(entry.task.id);
        entry.resolve(); this.drainMaintenanceQueue();
      });
    }
  }

  private async runAdmittedTask(task: ScheduledTask): Promise<void> {
    if (
      task.enabled === false
      || task.requiresReconciliation
      || this.runningTasks.has(task.id)
    ) return;
    this.runningTasks.add(task.id);
    const lifecycleGeneration = this.lifecycleGeneration;
    const startedAt = new Date();
    const contract = getScheduledTaskExecutionContract(task);
    const compactAudit = task.auditMode !== 'full';
    const execution = this.beginExecution(task, startedAt, contract, compactAudit);
    let plan: CapabilityExecutionPlan | null = null;
    let handlerStarted = false;
    let handlerSettled = false;
    let userDeliveryDeclared = false;
    let rollbackTerminalLedger: (() => void) | null = null;
    let phase: 'planning' | 'handler' | 'delivery' | 'terminal_persistence' = 'planning';
    try {
      plan = buildScheduledTaskExecutionPlan(task, startedAt);
      execution.plan = plan;
      const authorization = authorizeCapabilityPlanTool(plan, 'scheduler_task_handler');
      const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","interactions","reminders","settings","users","conversationActionTurns","conversations"]);
      const previousStatus = compactAudit
        ? getScheduledCapabilityExecutionStatus(db, {
            scheduledTaskId: task.id,
            executionId: plan.taskId,
          })
        : (db.conversationActionTasks || []).find((candidate: any) => candidate.id === plan.taskId)?.status;
      if (previousStatus) {
        if (previousStatus === 'executing') {
          const unknownAt = new Date();
          const record = buildScheduledTaskRecord(plan, {
            verified: false,
            status: 'unknown',
            error: 'scheduler_previous_outcome_unknown',
            durationMs: Math.max(0, unknownAt.getTime() - startedAt.getTime()),
            contract,
            stoppingReason: 'previous_slot_outcome_unknown',
          });
          persistScheduledCapabilityExecution(db, {
            scheduledTaskId: task.id,
            plan,
            status: 'blocked',
            blocker: 'A previous execution in this exact schedule slot has an unknown outcome; replay was stopped.',
            records: [record],
            now: unknownAt.toISOString(),
            compactAudit,
          });
          task.lastRun = unknownAt.toISOString();
          task.lastStatus = 'unknown';
          task.lastError = 'A previous execution in this exact schedule slot has an unknown outcome; replay was stopped.';
          task.lastDurationMs = Math.max(0, unknownAt.getTime() - startedAt.getTime());
          execution.phase = 'terminal_persistence';
          await this.persistDbWithRuntimeState(db, task, true, execution);
        }
        return;
      }
      task.lastStartedAt = startedAt.toISOString();
      task.lastStatus = authorization.allowed ? 'executing' : 'blocked';
      task.lastError = authorization.allowed ? null : redactSchedulerDiagnostic(authorization.reason);
      task.lastDurationMs = null;
      if (!authorization.allowed) task.lastRun = startedAt.toISOString();
      persistScheduledCapabilityExecution(db, {
        scheduledTaskId: task.id,
        plan,
        status: authorization.allowed ? 'executing' : 'blocked',
        blocker: authorization.allowed ? '' : redactSchedulerDiagnostic(authorization.reason),
        records: authorization.allowed ? [] : [buildScheduledTaskRecord(plan, {
          verified: false,
          status: 'blocked',
          error: redactSchedulerDiagnostic(authorization.reason),
          durationMs: 0,
          contract,
          stoppingReason: 'capability_policy_block',
        })],
        now: startedAt.toISOString(),
        compactAudit,
      });
      execution.phase = 'admission_persistence';
      await this.persistDbWithRuntimeState(db, task, !authorization.allowed, execution);
      if (!authorization.allowed) {
        console.warn(
          `[Scheduler] Task "${redactSchedulerDiagnostic(task.id)}" blocked by capability policy: ${redactSchedulerDiagnostic(authorization.reason)}`,
        );
        return;
      }
      const registeredTask = this.tasks.find(candidate => candidate === task);
      if (
        lifecycleGeneration !== this.lifecycleGeneration
        || !registeredTask
        || registeredTask.enabled === false
      ) {
        throw new ScheduledTaskExecutionError(
          'Scheduled execution was cancelled before its handler started.',
          'scheduler_handler_aborted',
        );
      }
      handlerStarted = true;
      execution.handlerStarted = true;
      execution.handlerSettled = false;
      phase = 'handler';
      const result = await this.executeTaskHandler(task, plan, execution);
      handlerSettled = true;
      phase = 'delivery';
      if (
        task.executionClass === 'client_probe'
        && task.deliveryPolicy !== 'scoped'
        && Array.isArray(result)
        && result.length > 0
      ) {
        throw new ScheduledTaskExecutionError(
          'A client_probe returned user-visible deliveries without declaring deliveryPolicy="scoped" before admission.',
          'scheduler_delivery_invalid',
        );
      }
      const deliveryTimestamp = new Date().toISOString();
      const delivery = await this.deliverTaskResult(task, plan, result, deliveryTimestamp, execution);
      userDeliveryDeclared = delivery.deliveryCount > 0;
      if (
        delivery.deliveryCount > 0
        && delivery.persistedCount === 0
        && delivery.withheldCount === delivery.deliveryCount
      ) {
        throw new ScheduledTaskExecutionError(
          'Every declared proactive delivery was withheld by terminal output verification.',
          'scheduler_delivery_withheld',
        );
      }
      const completedAt = new Date();
      const completedTask: ScheduledTask = {
        ...task,
        lastRun: completedAt.toISOString(),
        lastStatus: 'completed',
        lastError: null,
        lastDurationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      };
      phase = 'terminal_persistence';
      const completedDb = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","interactions","reminders","settings","users","conversationActionTurns","conversations"]);
      rollbackTerminalLedger = this.captureScheduledLedgerCheckpoint(completedDb, task.id, plan.taskId);
      persistScheduledCapabilityExecution(completedDb, {
        scheduledTaskId: task.id,
        plan,
        status: 'completed',
        records: [buildScheduledTaskRecord(plan, {
          verified: true,
          status: 'verified',
          delivery,
          durationMs: completedTask.lastDurationMs!,
          contract,
          stoppingReason: 'success_criteria_met',
        })],
        now: completedTask.lastRun,
        compactAudit,
      });
      // The handler returning is not completion. The scheduler accepts success
      // only after the verified receipt and runtime state cross the durability
      // boundary declared by the execution class and actual side effects.
      execution.phase = 'terminal_persistence';
      try {
        await this.persistDbWithRuntimeState(completedDb, completedTask, userDeliveryDeclared, execution);
      } catch (error) {
        task.persistenceStatus = completedTask.persistenceStatus;
        task.lastPersistenceError = completedTask.lastPersistenceError;
        throw error;
      }
      task.lastRun = completedTask.lastRun;
      task.lastStatus = completedTask.lastStatus;
      task.lastError = completedTask.lastError;
      task.lastDurationMs = completedTask.lastDurationMs;
      task.persistenceStatus = completedTask.persistenceStatus;
      task.lastPersistenceError = completedTask.lastPersistenceError;
      rollbackTerminalLedger = null;
    } catch (err: any) {
      if (rollbackTerminalLedger) {
        try {
          rollbackTerminalLedger();
        } catch (rollbackError: any) {
          task.persistenceStatus = 'failed';
          task.lastPersistenceError = redactSchedulerDiagnostic(rollbackError);
          console.error(
            `[Scheduler] Failed to roll back terminal ledger for "${redactSchedulerDiagnostic(task.id)}":`,
            task.lastPersistenceError,
          );
        }
        rollbackTerminalLedger = null;
      }
      const failedAt = new Date();
      const typedError = err instanceof ScheduledTaskExecutionError ? err : null;
      handlerSettled = handlerSettled || execution.handlerSettled;
      const deadlineExpired = typedError?.code === 'scheduler_execution_timed_out'
        || typedError?.code === 'scheduler_handler_timed_out';
      const abortRequested = typedError?.code === 'scheduler_handler_aborted';
      const persistenceFailed = task.persistenceStatus === 'failed'
        || execution.phase === 'admission_persistence'
        || phase === 'terminal_persistence'
        || (handlerSettled && phase === 'delivery');
      const errorCode = typedError?.code
        || (!handlerStarted && execution.phase === 'admission_persistence'
          ? 'scheduler_admission_persistence_failed'
          : persistenceFailed
            ? 'scheduler_terminal_persistence_failed'
            : 'scheduler_handler_failed');
      const errorMessage = redactSchedulerDiagnostic(err?.message || err || errorCode);
      task.lastDurationMs = Math.max(0, failedAt.getTime() - startedAt.getTime());
      const handlerStillSettling = !execution.handlerSettled;
      const durabilityStillSettling = execution.pendingDurableOperations.size > 0;

      if (
        (handlerStillSettling || durabilityStillSettling)
        && (deadlineExpired || abortRequested)
        && plan
      ) {
        execution.pendingLateSettlement = true;
        execution.lateSettlementPendingHandler ||= handlerStillSettling;
        execution.lateSettlementPendingDurability ||= durabilityStillSettling;
        // A handler or durability boundary that ignored abort is quarantined:
        // no future timer may enter until every operation truly settles.
        this.clearTimer(task.id);
        task.nextRun = null;
        task.lastStatus = abortRequested && handlerStillSettling ? 'cancelling' : 'unknown';
        const durablePhaseLabel = execution.phase === 'delivery'
          ? 'delivery persistence'
          : execution.phase.replaceAll('_', ' ');
        const pendingSubject = handlerStillSettling && durabilityStillSettling
          ? 'the handler and durable persistence are still settling'
          : handlerStillSettling
            ? 'the handler is still settling'
            : `durable ${durablePhaseLabel} is still settling`;
        task.lastError = abortRequested
          ? `Cancellation was requested, but ${pendingSubject}; side-effect outcome remains unknown.`
          : `The end-to-end wall-clock deadline expired, but ${pendingSubject}; side-effect outcome remains unknown.`;
        task.requiresReconciliation = true;
        task.quarantinedExecutionId = plan.taskId;
        task.quarantineReason = task.lastError;
        try {
          const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","interactions","reminders","settings","users","conversationActionTurns","conversations"]);
          persistScheduledCapabilityExecution(db, {
            scheduledTaskId: task.id,
            plan,
            status: 'executing',
            blocker: task.lastError,
            records: [],
            now: failedAt.toISOString(),
            compactAudit,
          });
          this.persistRecoveryDbWithRuntimeState(db, task, task.persistenceStatus === 'failed');
        } catch (pendingError: any) {
          task.persistenceStatus = 'failed';
          task.lastPersistenceError = redactSchedulerDiagnostic(pendingError);
          console.error(
            `[Scheduler] Failed to persist pending settlement for "${redactSchedulerDiagnostic(task.id)}":`,
            task.lastPersistenceError,
          );
        }
        console.warn(
          `[Scheduler] Task "${redactSchedulerDiagnostic(task.id)}" ${task.lastStatus}:`,
          task.lastError,
        );
        return;
      }

      let runtimeStatus: ScheduledTaskRunStatus;
      let blocker: string;
      let receiptStatus: 'blocked' | 'failed' | 'unknown';
      let stoppingReason: string;
      if (!handlerStarted) {
        runtimeStatus = abortRequested ? 'cancelled' : 'blocked';
        blocker = abortRequested
          ? 'Execution was cancelled before the handler started; no handler side effects occurred.'
          : deadlineExpired
            ? 'The end-to-end deadline expired before the handler started; no handler side effects occurred.'
            : `Pre-handler durability failed and the handler was not started: ${errorMessage}`;
        receiptStatus = 'blocked';
        stoppingReason = abortRequested
          ? 'cancelled_before_handler'
          : deadlineExpired
            ? 'deadline_before_handler'
            : 'admission_persistence_failed';
      } else if (
        typedError?.code === 'scheduler_delivery_withheld'
        || typedError?.code === 'scheduler_delivery_invalid'
      ) {
        runtimeStatus = 'blocked';
        blocker = typedError.code === 'scheduler_delivery_invalid'
          ? errorMessage
          : 'Every declared proactive delivery was withheld by terminal output verification.';
        receiptStatus = 'blocked';
        stoppingReason = typedError.code === 'scheduler_delivery_invalid'
          ? 'delivery_scope_or_shape_invalid'
          : 'delivery_verification_blocked';
      } else if (deadlineExpired || abortRequested || persistenceFailed) {
        runtimeStatus = 'unknown';
        blocker = deadlineExpired
          ? `The end-to-end execution deadline expired during ${execution.phase}; the late result was not accepted, side-effect outcome remains unknown, and this slot will not be replayed.`
          : abortRequested
            ? 'The handler settled after cancellation was requested; its result was not accepted, side-effect outcome remains unknown, and this slot will not be replayed.'
            : 'The handler returned, but terminal evidence could not be durably accepted; side-effect outcome remains unknown and replay is disabled.';
        receiptStatus = 'unknown';
        stoppingReason = deadlineExpired
          ? `deadline_during_${execution.phase}`
          : abortRequested
            ? 'settled_after_cancellation'
            : 'terminal_persistence_failed';
      } else {
        runtimeStatus = 'failed';
        blocker = `Scheduled handler failed; automatic replay for this slot is disabled. Detail: ${errorMessage}`;
        receiptStatus = 'failed';
        stoppingReason = 'handler_failed';
      }

      task.lastRun = failedAt.toISOString();
      task.lastStatus = runtimeStatus;
      task.lastError = blocker;
      if (runtimeStatus === 'unknown') {
        task.requiresReconciliation = true;
        task.quarantinedExecutionId = plan?.taskId || task.quarantinedExecutionId || null;
        task.quarantineReason = blocker;
        task.nextRun = null;
        this.clearTimer(task.id);
      }
      if (plan) {
        try {
          const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","interactions","reminders","settings","users","conversationActionTurns","conversations"]);
          persistScheduledCapabilityExecution(db, {
            scheduledTaskId: task.id,
            plan,
            status: 'blocked',
            blocker,
            records: [buildScheduledTaskRecord(plan, {
              verified: false,
              status: receiptStatus,
              error: errorCode,
              durationMs: task.lastDurationMs,
              contract,
              stoppingReason,
            })],
            now: failedAt.toISOString(),
            compactAudit,
          });
          this.persistRecoveryDbWithRuntimeState(
            db,
            task,
            task.persistenceStatus === 'failed',
          );
        } catch (ledgerError: any) {
          task.persistenceStatus = 'failed';
          task.lastPersistenceError = redactSchedulerDiagnostic(ledgerError);
          console.error(`[Scheduler] Failed to persist task failure for "${redactSchedulerDiagnostic(task.id)}":`, task.lastPersistenceError);
        }
      } else {
        try {
          this.persistRecoveryDbWithRuntimeState(
            readDatabaseTables(["conversationActionReceipts","conversationActionTasks","interactions","reminders","settings","users","conversationActionTurns","conversations"]),
            task,
            task.persistenceStatus === 'failed',
          );
        } catch {
          // persistRecoveryDbWithRuntimeState already records and logs the failure.
        }
      }
      console.warn(`[Scheduler] Task "${redactSchedulerDiagnostic(task.id)}" ${runtimeStatus}:`, blocker);
    } finally {
      this.finishSchedulerExecution(task.id);
    }
  }

  private finishSchedulerExecution(taskId: string) {
    const inFlight = this.inFlightHandlers.get(taskId);
    if (!inFlight) {
      this.runningTasks.delete(taskId);
      return;
    }
    inFlight.schedulerFinished = true;
    this.maybeReleaseExecutionFence(taskId, inFlight);
  }

  private markHandlerSettled(
    taskId: string,
    inFlight: ScheduledInFlightHandler,
    outcome: 'fulfilled' | 'rejected',
  ) {
    inFlight.handlerSettled = true;
    inFlight.handlerOutcome = outcome;
    this.maybeReleaseExecutionFence(taskId, inFlight);
  }

  private markDurableOperationSettled(
    taskId: string,
    inFlight: ScheduledInFlightHandler,
    operation: Promise<unknown>,
    outcome: 'fulfilled' | 'rejected',
  ) {
    inFlight.pendingDurableOperations.delete(operation);
    if (outcome === 'rejected') inFlight.durableOperationRejected = true;
    this.maybeReleaseExecutionFence(taskId, inFlight);
  }

  private maybeReleaseExecutionFence(taskId: string, inFlight: ScheduledInFlightHandler) {
    if (
      !inFlight.schedulerFinished
      || !executionOperationsSettled(inFlight)
      || this.inFlightHandlers.get(taskId) !== inFlight
    ) return;
    if (inFlight.pendingLateSettlement) {
      void this.finalizeLateHandlerSettlement(
        taskId,
        inFlight,
        inFlight.handlerOutcome || 'rejected',
      );
    } else {
      this.releaseHandlerFence(taskId, inFlight);
    }
  }

  private async finalizeLateHandlerSettlement(
    taskId: string,
    inFlight: ScheduledInFlightHandler,
    outcome: 'fulfilled' | 'rejected',
  ) {
    if (inFlight.lateSettlementFinalizing || this.inFlightHandlers.get(taskId) !== inFlight) return;
    inFlight.lateSettlementFinalizing = true;
    const settledAt = new Date();
    const timeout = inFlight.controller.signal.reason instanceof ScheduledTaskExecutionError
      && ['scheduler_execution_timed_out', 'scheduler_handler_timed_out']
        .includes(inFlight.controller.signal.reason.code);
    const settlementSubject = inFlight.lateSettlementPendingHandler
      ? inFlight.lateSettlementPendingDurability
        ? `handler ${outcome} and all durable operations settled${inFlight.durableOperationRejected ? ' with a persistence failure' : ''}`
        : `handler ${outcome}`
      : `durable operation${inFlight.durableOperationRejected ? ' rejected' : ' settled'}`;
    const message = timeout
      ? `The ${settlementSubject} after the end-to-end deadline; its late result was discarded, side-effect outcome remains unknown, and this slot will not be replayed.`
      : `The ${settlementSubject} after cancellation was requested; its late result was discarded, side-effect outcome remains unknown, and this slot will not be replayed.`;
    const visibleTask = this.tasks.find(candidate => candidate.id === taskId) || inFlight.task;
    for (const target of new Set([inFlight.task, visibleTask])) {
      target.lastRun = settledAt.toISOString();
      target.lastStatus = 'unknown';
      target.lastError = message;
      target.lastDurationMs = Math.max(0, settledAt.getTime() - inFlight.startedAt.getTime());
      target.requiresReconciliation = true;
      target.quarantinedExecutionId = inFlight.plan?.taskId || target.quarantinedExecutionId || null;
      target.quarantineReason = message;
      target.nextRun = null;
    }
    try {
      const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","interactions","reminders","settings","users","conversationActionTurns","conversations"]);
      if (inFlight.plan) {
        persistScheduledCapabilityExecution(db, {
          scheduledTaskId: taskId,
          plan: inFlight.plan,
          status: 'blocked',
          blocker: message,
          records: [buildScheduledTaskRecord(inFlight.plan, {
            verified: false,
            status: 'unknown',
            error: timeout
              ? 'scheduler_late_settlement_after_timeout'
              : 'scheduler_late_settlement_after_cancellation',
            durationMs: visibleTask.lastDurationMs || 0,
            contract: inFlight.contract,
            stoppingReason: timeout
              ? 'late_settle_after_deadline'
              : 'late_settle_after_cancellation',
          })],
          now: settledAt.toISOString(),
          compactAudit: inFlight.compactAudit,
        });
      }
      this.persistRecoveryDbWithRuntimeState(
        db,
        visibleTask,
        visibleTask.persistenceStatus === 'failed',
      );
      inFlight.pendingLateSettlement = false;
      console.warn(`[Scheduler] Task "${redactSchedulerDiagnostic(taskId)}" unknown:`, message);
    } catch (error: any) {
      visibleTask.persistenceStatus = 'failed';
      visibleTask.lastPersistenceError = redactSchedulerDiagnostic(error);
      console.error(
        `[Scheduler] Failed to persist late settlement for "${redactSchedulerDiagnostic(taskId)}":`,
        visibleTask.lastPersistenceError,
      );
    } finally {
      this.releaseHandlerFence(taskId, inFlight);
    }
    if (timeout && !inFlight.handlerStarted && !inFlight.durableOperationRejected
      && inFlight.lifecycleGeneration === this.lifecycleGeneration) {
      // The delayed admission write has settled and no handler ever ran.
      // This is a provable no-side-effect outcome, not a permanent quarantine.
      // Reconcile durably and schedule a future slot; never replay this slot.
      await this.reconcileTask(taskId, 'confirmed_no_side_effect');
    }
  }

  private releaseHandlerFence(taskId: string, inFlight: ScheduledInFlightHandler) {
    if (this.inFlightHandlers.get(taskId) !== inFlight) return;
    clearTimeout(inFlight.deadlineTimer);
    this.inFlightHandlers.delete(taskId);
    if (this.runningControllers.get(taskId) === inFlight.controller) {
      this.runningControllers.delete(taskId);
    }
    this.runningTasks.delete(taskId);
    this.maintenanceActive.delete(taskId);
    this.drainMaintenanceQueue();
  }

  private async executeTaskHandler(
    task: ScheduledTask,
    plan: CapabilityExecutionPlan,
    execution: ScheduledInFlightHandler,
  ): Promise<ScheduledTaskResult> {
    const handler = Promise.resolve().then(() => task.handler({
      signal: execution.controller.signal,
      taskId: task.id,
      executionId: plan.taskId,
      startedAt: execution.startedAt.toISOString(),
      deadline: execution.deadline.toISOString(),
      contract: execution.contract,
    }));
    void handler.then(
      () => this.markHandlerSettled(task.id, execution, 'fulfilled'),
      () => this.markHandlerSettled(task.id, execution, 'rejected'),
    );
    return awaitExecutionPhase(handler, execution, 'handler');
  }

  private captureScheduledLedgerCheckpoint(
    db: any,
    scheduledTaskId: string,
    executionId: string,
  ): () => void {
    const conversationId = `scheduler:${scheduledTaskId}`;
    const snapshots = new Map<string, any>();
    for (const candidate of db.conversationActionTasks || []) {
      if (candidate?.conversationId === conversationId && candidate?.target === scheduledTaskId) {
        snapshots.set(candidate.id, JSON.parse(JSON.stringify(candidate)));
      }
    }
    const receiptIds = new Set((db.conversationActionReceipts || [])
      .filter((candidate: any) => (
        candidate?.turnId === executionId || candidate?.requestId === executionId
      ))
      .map((candidate: any) => candidate.id));
    return () => {
      const currentDb = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","interactions","reminders","settings","users","conversationActionTurns","conversations"]);
      currentDb.conversationActionTasks = (currentDb.conversationActionTasks || []).filter((candidate: any) => {
        if (candidate?.conversationId !== conversationId || candidate?.target !== scheduledTaskId) return true;
        return snapshots.has(candidate.id);
      });
      for (const [id, snapshot] of snapshots) {
        const current = currentDb.conversationActionTasks.find((candidate: any) => candidate.id === id);
        if (current) Object.assign(current, JSON.parse(JSON.stringify(snapshot)));
        else currentDb.conversationActionTasks.push(JSON.parse(JSON.stringify(snapshot)));
      }
      currentDb.conversationActionReceipts = (currentDb.conversationActionReceipts || [])
        .filter((candidate: any) => (
          candidate?.turnId !== executionId
          && candidate?.requestId !== executionId
        ) || receiptIds.has(candidate.id));
      this.writeDatabase(currentDb);
    };
  }

  private setTaskTimeout(
    id: string,
    callback: () => void | Promise<void>,
    delayMs: number,
    scheduleGeneration = this.scheduleGenerations.get(id) || 0,
  ): NodeJS.Timeout {
    const maxDelay = 2_147_483_647; // Node timers are signed 32-bit milliseconds.
    const safeDelay = Math.max(1000, Math.min(delayMs, maxDelay));
    const remainingAfterThisChunk = Math.max(0, delayMs - safeDelay);

    const timer = setTimeout(() => {
      if (scheduleGeneration !== this.scheduleGenerations.get(id)) return;
      if (remainingAfterThisChunk > 0) {
        this.setTaskTimeout(id, callback, remainingAfterThisChunk, scheduleGeneration);
        return;
      }
      void callback();
    }, safeDelay);

    this.timers.set(id, timer);
    return timer;
  }

  stop(options: { drainSettledHandlers?: boolean } = {}) {
    this.lifecycleGeneration += 1;
    for (const entry of this.maintenanceQueue.splice(0)) entry.resolve();
    for (const timer of this.timers.values()) {
      clearInterval(timer);
      clearTimeout(timer); // Also clear cron timeouts
    }
    this.timers.clear();
    for (const task of this.tasks) {
      task.nextRun = null;
      this.persistRuntimeState(task);
    }
    for (const taskId of this.runningControllers.keys()) {
      const execution = this.inFlightHandlers.get(taskId);
      if (options.drainSettledHandlers && execution?.handlerStarted && execution.handlerSettled
        && execution.handlerOutcome === 'fulfilled' && !execution.controller.signal.aborted) {
        // The handler is finished. Let the existing bounded delivery/receipt
        // commit drain instead of turning a normal restart into an unknown side
        // effect. Its original deadline still applies; no new slot is admitted.
        continue;
      }
      this.abortRunningTask(taskId, 'Scheduler stopped before the handler reached a terminal outcome.');
    }
  }
}

export const scheduler = new Scheduler();

/**
 * Register built-in proactive tasks.
 * Accepts LLM provider getters so consolidation and self-reflection can call the LLM.
 */
export function registerScheduledTasks(
  getDeepSeek: () => any,
  getGemini: () => any,
  getOpenAI?: () => any,
  getAnthropic?: () => any,
  getQwen?: () => any,
  getOllama?: () => any,
  getLmStudio?: () => any,
  getArk?: () => any,
  getXiaomi?: () => any,
  getKimi?: () => any,
  getGlm?: () => any,
  getRelay?: () => any,
) {


  /** Get scheduler recipients from the authoritative user registry. */
  function getAllUserIds(): string[] {
    return resolveScheduledUserIds(readDatabaseTables(["conversationActionReceipts","conversationActionTasks","interactions","reminders","settings","users","conversationActionTurns","conversations"]));
  }


  function getSystemAdminUserIds(): string[] {
    const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","interactions","reminders","settings","users","conversationActionTurns","conversations"]);
    return (db.users || [])
      .filter((user: any) => user?.uid && user.role === 'admin')
      .map((user: any) => user.uid);
  }
  const getters = { getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen,
    getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay };
  const tasks = createScheduledBuiltinTasks({ scheduler, getters, getAllUserIds, getSystemAdminUserIds,
    createReminderCheckTask, redactSchedulerDiagnostic });
  for (const task of tasks) scheduler.register(task);
}
