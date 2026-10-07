
import { readDatabaseTables } from '../../db_layer';
import type { ScheduledTask } from './contracts';
import type { ScheduledInFlightHandler } from './execution_phase';
import { requiresStrictScheduledPersistence } from './execution_contract';
import { redactSchedulerDiagnostic } from './diagnostics';
import { stageRuntimeState } from './runtime_state';

/** One projection writer serves ordinary metadata, strict admission and recovery. */
export class ScheduledRuntimePersistence {
  constructor(
    private writeDatabase: (data: any) => void,
    private flush: (execution?: ScheduledInFlightHandler) => Promise<void>,
  ) {}

  private project(db: any, task: ScheduledTask, status: 'ok' | 'coalesced', preserveFailure = false): void {
    const priorError = task.lastPersistenceError;
    if (!preserveFailure) {
      task.persistenceStatus = status;
      task.lastPersistenceError = null;
    }
    if (task.lastError) task.lastError = redactSchedulerDiagnostic(task.lastError);
    stageRuntimeState(db, task);
    this.writeDatabase(db);
    if (preserveFailure) {
      task.persistenceStatus = 'failed';
      task.lastPersistenceError = priorError;
    }
  }

  private failure(task: ScheduledTask, error: unknown, context = 'runtime'): void {
    task.persistenceStatus = 'failed';
    task.lastPersistenceError = redactSchedulerDiagnostic(error);
    console.error('[Scheduler] Failed to persist ' + context + ' state for "' + redactSchedulerDiagnostic(task.id) + '":', task.lastPersistenceError);
  }

  async strict(db: any, task: ScheduledTask, hasUserDelivery = false, execution?: ScheduledInFlightHandler): Promise<void> {
    const strict = requiresStrictScheduledPersistence(task.executionClass, hasUserDelivery || task.deliveryPolicy === 'scoped');
    try {
      this.project(db, task, strict ? 'ok' : 'coalesced');
      if (strict) await this.flush(execution);
    } catch (error) {
      this.failure(task, error);
      throw error;
    }
  }

  private bestEffort(read: () => any, task: ScheduledTask, status: 'ok' | 'coalesced', preserveFailure: boolean, context: string): void {
    try { this.project(read(), task, status, preserveFailure); }
    catch (error) { this.failure(task, error, context); }
  }

  runtime(task: ScheduledTask): void {
    this.bestEffort(() => readDatabaseTables(['settings']), task,
      task.executionClass === 'client_probe' ? 'coalesced' : 'ok', task.persistenceStatus === 'failed', 'runtime');
  }

  recovery(db: any, task: ScheduledTask, preserveFailure = false): void {
    this.bestEffort(() => db, task, 'coalesced', preserveFailure, 'recovery');
  }
}
