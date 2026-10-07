import { readDatabaseTables } from "../../db_layer";
import { type CapabilityExecutionPlan } from "../cognition/capability_execution_plan";
import { persistScheduledCapabilityExecution } from "../conversation/ledger/scheduler";
import type { ScheduledTask, ScheduledTaskExecutionContract, ScheduledTaskResult } from './contracts';
import type { ScheduledInFlightHandler } from './execution_phase';

import { redactSchedulerDiagnostic } from './diagnostics';

import { awaitExecutionPhase, ScheduledTaskExecutionError, executionOperationsSettled } from './execution_phase';

import { buildScheduledTaskRecord } from './execution_record';

import { runScheduledExecution } from './run_execution';
import type { ScheduledExecutionContext, ScheduledExecutionRuntime } from './execution_runtime';

export class ScheduledExecutionOwner implements ScheduledExecutionRuntime {
  readonly active = new Map<string, ScheduledInFlightHandler>();
  constructor(readonly context: ScheduledExecutionContext) {}
  run(task: ScheduledTask): Promise<void> { return runScheduledExecution(this, task); }

  startDurableFlush(execution?: ScheduledInFlightHandler): Promise<void> {
    const flush = this.context.strictFlush();
    return execution ? this.trackDurableOperation(flush, execution) : flush;
  }

  flushExecution(execution?: ScheduledInFlightHandler): Promise<void> {
    const flush = this.startDurableFlush(execution);
    return execution ? awaitExecutionPhase(flush, execution, execution.phase) : flush;
  }

  abortRunningTask(id: string, reason: string) {
    const execution = this.active.get(id);
    if (execution && !execution.controller.signal.aborted) {
      const { controller } = execution;
      clearTimeout(execution.deadlineTimer);
      if (execution.handlerStarted) {
        const visibleTask = this.context.getTasks().find(candidate => candidate.id === id) || execution.task;
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
          this.context.persistence.recovery(
            readDatabaseTables(["settings"]),
            visibleTask,
            visibleTask.persistenceStatus === 'failed' || execution.task.persistenceStatus === 'failed',
          );
        } catch {
          // ScheduledRuntimePersistence already records and logs the failure.
        }
      }
      controller.abort(new ScheduledTaskExecutionError(reason, 'scheduler_handler_aborted'));
    }
  }

  beginExecution(
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
      lifecycleGeneration: this.context.getLifecycleGeneration(),
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
    this.active.set(task.id, execution);
    return execution;
  }

  trackDurableOperation<T>(
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

  finishSchedulerExecution(taskId: string) {
    const inFlight = this.active.get(taskId);
    if (!inFlight) return;
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
      || this.active.get(taskId) !== inFlight
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
    if (inFlight.lateSettlementFinalizing || this.active.get(taskId) !== inFlight) return;
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
    const visibleTask = this.context.getTasks().find(candidate => candidate.id === taskId) || inFlight.task;
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
      const db = readDatabaseTables(["conversationActionTasks","conversationActionReceipts","conversationActionTurns","settings"]);
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
      this.context.persistence.recovery(
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
      && inFlight.lifecycleGeneration === this.context.getLifecycleGeneration()) {
      // The delayed admission write has settled and no handler ever ran.
      // This is a provable no-side-effect outcome, not a permanent quarantine.
      // Reconcile durably and schedule a future slot; never replay this slot.
      await this.context.reconcileTask(taskId, 'confirmed_no_side_effect');
    }
  }

  private releaseHandlerFence(taskId: string, inFlight: ScheduledInFlightHandler) {
    if (this.active.get(taskId) !== inFlight) return;
    clearTimeout(inFlight.deadlineTimer);
    this.active.delete(taskId);
    this.context.onReleased(taskId);
  }

  async executeTaskHandler(
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

  captureScheduledLedgerCheckpoint(
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
      const currentDb = readDatabaseTables(["conversationActionTasks","conversationActionReceipts"]);
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
      this.context.writeDatabase(currentDb);
    };
  }
}
