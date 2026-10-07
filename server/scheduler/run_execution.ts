import { readDatabaseTables } from "../../db_layer";
import { authorizeCapabilityPlanTool } from "../cognition/capability_execution_plan";
import { getScheduledCapabilityExecutionStatus, persistScheduledCapabilityExecution } from "../conversation/ledger/scheduler";
import type { ScheduledTask, ScheduledTaskRunStatus } from './contracts';

import { redactSchedulerDiagnostic } from './diagnostics';
import { getScheduledTaskExecutionContract } from './execution_contract';
import { ScheduledTaskExecutionError } from './execution_phase';

import { buildScheduledTaskExecutionPlan } from './capability_plan';
import { buildScheduledTaskRecord } from './execution_record';

import type { ScheduledExecutionRuntime } from './execution_runtime';

  export async function runScheduledExecution(owner: ScheduledExecutionRuntime, task: ScheduledTask): Promise<void> {
    if (
      task.enabled === false
      || task.requiresReconciliation
      || owner.active.has(task.id)
    ) return;
    const lifecycleGeneration = owner.context.getLifecycleGeneration();
    const startedAt = new Date();
    const contract = getScheduledTaskExecutionContract(task);
    const compactAudit = task.auditMode !== 'full';
    const execution = owner.beginExecution(task, startedAt, contract, compactAudit);
    let userDeliveryDeclared = false;
    let rollbackTerminalLedger: (() => void) | null = null;
    try {
      const plan = execution.plan = buildScheduledTaskExecutionPlan(task, startedAt);
      const authorization = authorizeCapabilityPlanTool(plan, 'scheduler_task_handler');
      const db = readDatabaseTables(["conversationActionTasks","conversationActionReceipts","conversationActionTurns","settings"]);
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
          await owner.context.persistence.strict(db, task, true, execution);
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
      await owner.context.persistence.strict(db, task, !authorization.allowed, execution);
      if (!authorization.allowed) {
        console.warn(
          `[Scheduler] Task "${redactSchedulerDiagnostic(task.id)}" blocked by capability policy: ${redactSchedulerDiagnostic(authorization.reason)}`,
        );
        return;
      }
      const registeredTask = owner.context.getTasks().find(candidate => candidate === task);
      if (
        lifecycleGeneration !== owner.context.getLifecycleGeneration()
        || !registeredTask
        || registeredTask.enabled === false
      ) {
        throw new ScheduledTaskExecutionError(
          'Scheduled execution was cancelled before its handler started.',
          'scheduler_handler_aborted',
        );
      }
      execution.handlerStarted = true;
      execution.handlerSettled = false;
      const result = await owner.executeTaskHandler(task, plan, execution);
      execution.phase = 'delivery';
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
      const delivery = await owner.context.deliveries.deliverTaskResult(task, plan, result, deliveryTimestamp, execution);
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
      const completedDb = readDatabaseTables(["conversationActionTasks","conversationActionReceipts","conversationActionTurns","settings"]);
      rollbackTerminalLedger = owner.captureScheduledLedgerCheckpoint(completedDb, task.id, plan.taskId);
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
        await owner.context.persistence.strict(completedDb, completedTask, userDeliveryDeclared, execution);
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
      const plan = execution.plan;
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
      const deadlineExpired = typedError?.code === 'scheduler_execution_timed_out'
        || typedError?.code === 'scheduler_handler_timed_out';
      const abortRequested = typedError?.code === 'scheduler_handler_aborted';
      const persistenceFailed = task.persistenceStatus === 'failed'
        || execution.phase === 'admission_persistence'
        || execution.phase === 'terminal_persistence'
        || (execution.handlerSettled && execution.phase === 'delivery');
      const errorCode = typedError?.code
        || (!execution.handlerStarted && execution.phase === 'admission_persistence'
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
        owner.context.clearTimer(task.id);
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
          const db = readDatabaseTables(["conversationActionTasks","conversationActionReceipts","conversationActionTurns","settings"]);
          persistScheduledCapabilityExecution(db, {
            scheduledTaskId: task.id,
            plan,
            status: 'executing',
            blocker: task.lastError,
            records: [],
            now: failedAt.toISOString(),
            compactAudit,
          });
          owner.context.persistence.recovery(db, task, task.persistenceStatus === 'failed');
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
      if (!execution.handlerStarted) {
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
        owner.context.clearTimer(task.id);
      }
      if (plan) {
        try {
          const db = readDatabaseTables(["conversationActionTasks","conversationActionReceipts","conversationActionTurns","settings"]);
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
          owner.context.persistence.recovery(
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
          owner.context.persistence.recovery(
            readDatabaseTables(["settings"]),
            task,
            task.persistenceStatus === 'failed',
          );
        } catch {
          // ScheduledRuntimePersistence already records and logs the failure.
        }
      }
      console.warn(`[Scheduler] Task "${redactSchedulerDiagnostic(task.id)}" ${runtimeStatus}:`, blocker);
    } finally {
      owner.finishSchedulerExecution(task.id);
    }
  }
