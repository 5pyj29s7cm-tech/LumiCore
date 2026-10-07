import { ScheduledExecutionOwner } from './scheduler/execution_owner';
import { ScheduledRuntimePersistence } from './scheduler/persistence';
import { ScheduledDeliveryService } from './scheduler/delivery';
import { createScheduledBuiltinTasks } from "./scheduler/builtins";
import crypto from "node:crypto";
import type { Server as SocketIOServer } from "socket.io";
import { flushDBOrThrow, readDatabaseTables, commitDatabaseTables } from "../db_layer";

import type { ScheduledTask } from './scheduler/contracts';

import { hydrateRuntimeState, loadDisabledState, stageRuntimeState } from './scheduler/runtime_state';
import { redactSchedulerDiagnostic } from './scheduler/diagnostics';
import { getScheduledTaskTimeoutMs, getScheduledTaskExecutionContract } from './scheduler/execution_contract';
import { executionOperationsSettled } from './scheduler/execution_phase';
import { parseSchedule, nextCronTime } from './scheduler/schedule';

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
  private readonly persistence = new ScheduledRuntimePersistence(
    data => this.writeDatabase(data), execution => this.executions.flushExecution(execution),
  );
  private readonly deliveries = new ScheduledDeliveryService(
    data => this.writeDatabase(data), () => this.io,
    execution => this.executions.startDurableFlush(execution),
    (operation, execution) => this.executions.trackDurableOperation(operation, execution),
  );

  private readonly executions = new ScheduledExecutionOwner({
    getTasks: () => this.tasks,
    getLifecycleGeneration: () => this.lifecycleGeneration,
    persistence: this.persistence,
    deliveries: this.deliveries,
    strictFlush: () => this.strictFlush(),
    writeDatabase: data => this.writeDatabase(data),
    clearTimer: id => this.clearTimer(id),
    reconcileTask: (id, resolution) => this.reconcileTask(id, resolution),
    onReleased: id => { this.maintenanceActive.delete(id); this.drainMaintenanceQueue(); },
  });

  private tasks: ScheduledTask[] = [];
  private timers: Map<string, NodeJS.Timeout> = new Map();
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
      this.executions.abortRunningTask(task.id, 'Scheduled task registration was replaced.');
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

  disableTask(id: string): boolean {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return false;
    task.enabled = false;
    this.disabledTasks.add(id);
    this.clearTimer(id);
    this.executions.abortRunningTask(id, 'Scheduled task was disabled.');
    task.nextRun = null;
    this.persistence.runtime(task);
    this.persistDisabledState();
    console.log(`[Scheduler] Task "${redactSchedulerDiagnostic(id)}" disabled`);
    return true;
  }

  enableTask(id: string): boolean {
    const task = this.tasks.find(t => t.id === id);
    if (!task) return false;
    task.enabled = true;
    this.disabledTasks.delete(id);
    const pendingSettlement = this.executions.active.get(id);
    if (
      (!pendingSettlement?.pendingLateSettlement
        || executionOperationsSettled(pendingSettlement))
      && !task.requiresReconciliation
    ) {
      this.scheduleTask(task);
    } else {
      task.nextRun = null;
      this.persistence.runtime(task);
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
      running: this.executions.active.has(task.id),
      queued: this.maintenanceQueue.some(entry => entry.task.id === task.id),
      settlementPending: Boolean(
        this.executions.active.get(task.id)?.pendingLateSettlement
        && !executionOperationsSettled(this.executions.active.get(task.id)!)
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
    const inFlight = this.executions.active.get(id);
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
    const currentDb = readDatabaseTables(["settings"]);
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

  private scheduleTask(task: ScheduledTask) {
    this.clearTimer(task.id);
    const taskScheduleGeneration = this.scheduleGenerations.get(task.id) || 0;
    const scheduleGeneration = this.lifecycleGeneration;
    if (task.enabled === false) {
      task.nextRun = null;
      this.persistence.runtime(task);
      console.log(`[Scheduler] Task "${redactSchedulerDiagnostic(task.id)}" is disabled — skipping schedule`);
      return;
    }
    if (task.requiresReconciliation) {
      task.nextRun = null;
      this.persistence.runtime(task);
      console.warn(
        `[Scheduler] Task "${redactSchedulerDiagnostic(task.id)}" remains quarantined until its unknown outcome is explicitly reconciled.`,
      );
      return;
    }
    const parsed = parseSchedule(task.cron);

    if (parsed.type === 'interval') {
      // Simple fixed interval — use setInterval (backward compat)
      task.nextRun = new Date(Date.now() + parsed.intervalMs).toISOString();
      this.persistence.runtime(task);
      const timer = setInterval(() => {
        if (
          scheduleGeneration !== this.lifecycleGeneration
          || taskScheduleGeneration !== this.scheduleGenerations.get(task.id)
        ) return;
        task.nextRun = new Date(Date.now() + parsed.intervalMs).toISOString();
        this.persistence.runtime(task);
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
        this.persistence.runtime(task);
        this.setTaskTimeout(task.id, runAndReschedule, nextMs, taskScheduleGeneration);
      };
      const firstMs = nextCronTime(parsed.fields!);
      task.nextRun = new Date(Date.now() + firstMs).toISOString();
      this.persistence.runtime(task);
      this.setTaskTimeout(task.id, runAndReschedule, firstMs, taskScheduleGeneration);
      const [m, h, dom, mon, dow] = parsed.fields!;
      console.log(`[Scheduler] Registered cron task "${redactSchedulerDiagnostic(task.id)}" — ${m} ${h} ${dom} ${mon} ${dow} (next in ${Math.round(firstMs / 1000)}s)`);
    }
  }

  private runTask(task: ScheduledTask): Promise<void> {
    if (task.executionClass !== 'maintenance') return this.executions.run(task);
    if (task.enabled === false || task.requiresReconciliation || this.executions.active.has(task.id)
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
      void this.executions.run(entry.task).finally(() => {
        if (!this.executions.active.has(entry.task.id)) this.maintenanceActive.delete(entry.task.id);
        entry.resolve(); this.drainMaintenanceQueue();
      });
    }
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
      this.persistence.runtime(task);
    }
    for (const [taskId, execution] of this.executions.active) {
      if (options.drainSettledHandlers && execution?.handlerStarted && execution.handlerSettled
        && execution.handlerOutcome === 'fulfilled' && !execution.controller.signal.aborted) {
        // The handler is finished. Let the existing bounded delivery/receipt
        // commit drain instead of turning a normal restart into an unknown side
        // effect. Its original deadline still applies; no new slot is admitted.
        continue;
      }
      this.executions.abortRunningTask(taskId, 'Scheduler stopped before the handler reached a terminal outcome.');
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
    return resolveScheduledUserIds(readDatabaseTables(["users"]));
  }

  function getSystemAdminUserIds(): string[] {
    const db = readDatabaseTables(["users"]);
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
