import { checkpointAutonomousTask, type dequeue, type markRunning, markCancelled, isTaskCancellationRequested, isTaskPauseRequested, markPaused, recordAutonomousTaskFailure } from "../task_queue";
import type { ToolExecutionRecord } from "../../tools/types";
import type { Server as SocketIOServer } from "socket.io";
import { isRealtimeUserActive } from "../foreground_activity";
import { snapshotDurableToolRecords } from "../../cognition/durable_task_recovery";
import { buildTaskCompletionFeedback } from "../../cognition/acceptance_evidence";
import type { inferAutonomousPublicLanguage } from './customer_projection';
import type { executeNextAutonomousTask } from '../task_executor';
import { markLinkedPlanPaused, markLinkedPlanCancelled, publishAutonomousTaskInterruption, markLinkedPlanFailed } from './linked_plan';
import { projectAutonomousCompletionFeedback, projectAutonomousCustomerMessage } from './customer_projection';

export function finalizeAutonomousTaskFailure(err: any, { task, running, io, taskRoom, toolLedger, sideEffectClass, leaseLost, publicLanguage, authorizationWasRevoked }: {
  task: NonNullable<ReturnType<typeof dequeue>>;
  running: NonNullable<ReturnType<typeof markRunning>>;
  io: SocketIOServer;
  taskRoom: string;
  toolLedger: ToolExecutionRecord[];
  sideEffectClass: NonNullable<NonNullable<ReturnType<typeof markRunning>>["executionPlan"]>["risk"]["sideEffectClass"] | undefined;
  leaseLost: boolean;
  publicLanguage: ReturnType<typeof inferAutonomousPublicLanguage>;
  authorizationWasRevoked: () => boolean;
}): Awaited<ReturnType<typeof executeNextAutonomousTask>> {

    const errorMsg = err.message || 'Unknown error';
    authorizationWasRevoked();
    if (isTaskPauseRequested(task.id, task.userId) && !isTaskCancellationRequested(task.id, task.userId)) {
      markPaused(task.id);
      markLinkedPlanPaused(task);
      io.to(taskRoom).emit('autonomous:task_paused', {
        taskId: task.id,
        title: task.title,
        timestamp: new Date().toISOString(),
      });
      return { executed: true, taskId: task.id, result: 'Paused' };
    }
    if (isTaskCancellationRequested(task.id, task.userId) || isRealtimeUserActive(task.userId)) {
      const reason = isRealtimeUserActive(task.userId)
        ? 'Cancelled because a live user voice session took priority'
        : errorMsg;
      const cancelled = markCancelled(task.id, reason);
      markLinkedPlanCancelled(task);
      const machineFeedback = buildTaskCompletionFeedback(cancelled?.terminalReceipt, task.title, {
        status: cancelled?.status || 'cancelled',
        reason,
      });
      io.to(taskRoom).emit('autonomous:task_cancelled', {
        taskId: task.id,
        title: task.title,
        completionFeedback: projectAutonomousCompletionFeedback(machineFeedback),
        timestamp: new Date().toISOString(),
      });
      return { executed: true, taskId: task.id, result: 'Cancelled by user' };
    }
    const checkpointed = checkpointAutonomousTask(task.id, {
      phase: 'failed',
      receiptIds: Array.from(new Set([
        ...(running.checkpoint?.receiptIds || []),
        ...toolLedger.map(item => item.id).filter((id): id is string => Boolean(id)),
      ])),
      receipts: [
        ...(running.checkpoint?.receipts || []),
        ...snapshotDurableToolRecords(toolLedger),
      ],
      detail: errorMsg,
    }, running.leaseId);
    if (!checkpointed) {
      return { executed: true, taskId: task.id, result: 'Task lease was lost; stale failure was discarded.' };
    }
    const settled = recordAutonomousTaskFailure(task.id, {
      error: errorMsg,
      receiptSnapshots: checkpointed.checkpoint?.receipts || [],
      sideEffectClass,
      leaseLost,
    }, running.leaseId);
    if (!settled) {
      return { executed: true, taskId: task.id, result: 'Task lease was lost; stale failure was discarded.' };
    }
    const interruption = publishAutonomousTaskInterruption(io, taskRoom, task, settled);
    if (interruption) return { executed: true, taskId: task.id, result: interruption };
    const willRetry = settled.status === 'pending';
    if (!willRetry) markLinkedPlanFailed(task, errorMsg);
    const publicFailureText = projectAutonomousCustomerMessage(errorMsg, {
      language: publicLanguage,
      state: willRetry ? 'retrying' : 'failed',
    });
    const machineFeedback = buildTaskCompletionFeedback(settled.terminalReceipt, task.title, {
      status: settled.status,
      reason: errorMsg,
    });

    io.to(taskRoom).emit(willRetry ? 'autonomous:task_retry_scheduled' : 'autonomous:task_failed', {
      taskId: task.id,
      title: task.title,
      error: publicFailureText,
      result: publicFailureText,
      status: settled.status,
      nextAttemptAt: settled.nextAttemptAt,
      completionFeedback: projectAutonomousCompletionFeedback(machineFeedback),
      timestamp: new Date().toISOString(),
    });

    console.warn(`[AutoExecutor] Task "${task.title}" failed:`, errorMsg);
    return {
      executed: true,
      taskId: task.id,
      result: willRetry ? `Retry scheduled: ${settled.nextAttemptAt}` : `Failed: ${errorMsg}`,
    };

}
