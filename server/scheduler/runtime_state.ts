import { readDatabaseTables } from "../../db_layer";
import { redactSchedulerDiagnostic } from './diagnostics';
import type { ScheduledTask } from './contracts';

const SCHEDULER_RUNTIME_STATE_SETTING = 'scheduler_task_runtime_state_v1';

/** Load disabled task IDs from DB */
export function loadDisabledState(): Set<string> {
    try {
      const db = readDatabaseTables(["settings"]);
      const setting = (db.settings || []).find((s: any) => s.key === 'scheduler_disabled_tasks');
      if (setting?.value) {
        return new Set(JSON.parse(setting.value));
      }
    } catch (error: any) {
      console.error('[Scheduler] Failed to load disabled task state:', redactSchedulerDiagnostic(error));
    }
    return new Set();
  }

export function hydrateRuntimeState(task: ScheduledTask) {
    task.lastStatus = task.lastStatus || (task.lastRun ? 'completed' : 'idle');
    task.lastError = task.lastError ? redactSchedulerDiagnostic(task.lastError) : null;
    task.lastDurationMs = task.lastDurationMs ?? null;
    task.lastStartedAt = task.lastStartedAt ?? null;
    task.nextRun = task.nextRun ?? null;
    task.persistenceStatus = task.persistenceStatus || 'ok';
    task.lastPersistenceError = task.lastPersistenceError
      ? redactSchedulerDiagnostic(task.lastPersistenceError)
      : null;
    task.requiresReconciliation = task.requiresReconciliation === true;
    task.quarantinedExecutionId = task.quarantinedExecutionId || null;
    task.quarantineReason = task.quarantineReason
      ? redactSchedulerDiagnostic(task.quarantineReason)
      : null;
    task.reconciledAt = task.reconciledAt || null;
    task.reconciliationResolution = task.reconciliationResolution || null;
    try {
      const db = readDatabaseTables(["settings"]);
      const setting = (db.settings || []).find((candidate: any) => (
        candidate.key === SCHEDULER_RUNTIME_STATE_SETTING
      ));
      if (!setting?.value) return;
      const stored = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
      const snapshot = stored && typeof stored === 'object' ? stored[task.id] : null;
      if (!snapshot || typeof snapshot !== 'object') return;
      if (typeof snapshot.lastRun === 'string' || snapshot.lastRun === null) task.lastRun = snapshot.lastRun;
      if (typeof snapshot.lastStatus === 'string') task.lastStatus = snapshot.lastStatus;
      if (typeof snapshot.lastError === 'string' || snapshot.lastError === null) {
        task.lastError = snapshot.lastError ? redactSchedulerDiagnostic(snapshot.lastError) : null;
      }
      if (Number.isFinite(snapshot.lastDurationMs) || snapshot.lastDurationMs === null) {
        task.lastDurationMs = snapshot.lastDurationMs;
      }
      if (typeof snapshot.lastStartedAt === 'string' || snapshot.lastStartedAt === null) {
        task.lastStartedAt = snapshot.lastStartedAt;
      }
      if (typeof snapshot.nextRun === 'string' || snapshot.nextRun === null) task.nextRun = snapshot.nextRun;
      if (['ok', 'coalesced', 'failed'].includes(snapshot.persistenceStatus)) {
        task.persistenceStatus = snapshot.persistenceStatus;
      }
      if (typeof snapshot.lastPersistenceError === 'string' || snapshot.lastPersistenceError === null) {
        task.lastPersistenceError = snapshot.lastPersistenceError
          ? redactSchedulerDiagnostic(snapshot.lastPersistenceError)
          : null;
      }
      task.requiresReconciliation = snapshot.requiresReconciliation === true;
      task.quarantinedExecutionId = typeof snapshot.quarantinedExecutionId === 'string'
        ? snapshot.quarantinedExecutionId
        : null;
      task.quarantineReason = typeof snapshot.quarantineReason === 'string'
        ? redactSchedulerDiagnostic(snapshot.quarantineReason)
        : null;
      task.reconciledAt = typeof snapshot.reconciledAt === 'string' ? snapshot.reconciledAt : null;
      task.reconciliationResolution = [
        'confirmed_no_side_effect',
        'accepted_unknown_outcome',
      ].includes(snapshot.reconciliationResolution)
        ? snapshot.reconciliationResolution
        : null;
      if (snapshot.lastStatus === 'executing' || snapshot.lastStatus === 'cancelling') {
        task.lastStatus = 'unknown';
        task.lastError = 'The previous scheduler process stopped before handler settlement and a terminal receipt; side-effect outcome remains unknown.';
        task.requiresReconciliation = true;
        task.quarantineReason = task.lastError;
      }
    } catch (error: any) {
      task.persistenceStatus = 'failed';
      task.lastPersistenceError = redactSchedulerDiagnostic(error);
      console.error(`[Scheduler] Failed to restore runtime state for "${redactSchedulerDiagnostic(task.id)}":`, task.lastPersistenceError);
    }
  }

export function stageRuntimeState(db: any, task: ScheduledTask) {
    if (!db.settings) db.settings = [];
    let setting = db.settings.find((candidate: any) => candidate.key === SCHEDULER_RUNTIME_STATE_SETTING);
    let stored: Record<string, any> = {};
    if (setting?.value) {
      try {
        const parsed = typeof setting.value === 'string' ? JSON.parse(setting.value) : setting.value;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed;
      } catch (error: any) {
        console.error('[Scheduler] Invalid persisted runtime state was replaced:', redactSchedulerDiagnostic(error));
      }
    }
    stored[task.id] = {
      lastRun: task.lastRun ?? null,
      lastStatus: task.lastStatus || 'idle',
      lastError: task.lastError ? redactSchedulerDiagnostic(task.lastError) : null,
      lastDurationMs: task.lastDurationMs ?? null,
      lastStartedAt: task.lastStartedAt ?? null,
      nextRun: task.nextRun ?? null,
      persistenceStatus: task.persistenceStatus || 'ok',
      lastPersistenceError: task.lastPersistenceError
        ? redactSchedulerDiagnostic(task.lastPersistenceError)
        : null,
      requiresReconciliation: task.requiresReconciliation === true,
      quarantinedExecutionId: task.quarantinedExecutionId || null,
      quarantineReason: task.quarantineReason
        ? redactSchedulerDiagnostic(task.quarantineReason)
        : null,
      reconciledAt: task.reconciledAt || null,
      reconciliationResolution: task.reconciliationResolution || null,
    };
    const value = JSON.stringify(stored);
    if (setting) setting.value = value;
    else db.settings.push({ key: SCHEDULER_RUNTIME_STATE_SETTING, value });
  }
