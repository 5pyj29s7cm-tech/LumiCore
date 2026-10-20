import { normalizeConversationActionState, RECONFIRMATION_REQUIRED_BLOCKER } from "../../cognition/action_continuation";
import { mergeTaskReceipts, taskCompletionFromReceipts, toolRecordSucceeded, conversationTaskStatusOwnsExecutionLease, isTerminalConversationTaskStatus } from "../../cognition/task_execution_ledger";
import { inspectPersistedToolExecutionReceipt } from "../../tools/persisted_execution_receipt";
import type { ToolExecutionRecord } from "../../tools/types";
import { ensureTables, parseObject, sanitizeState, taskPersistenceUnknownMarker } from './serialization';
import type { ConversationActionTaskRow, ConversationActionReceiptRow } from './contracts';
import { syncConversationActionTaskLedger, finalizeConversationActionTask } from './task_lifecycle';
import { conversationActionStateFromTask } from './queries';

export function migrateLegacyConversationActionLedger(db: any): number {
  ensureTables(db);
  let migrated = 0;
  for (const conversation of db.conversations || []) {
    const state = normalizeConversationActionState(conversation.actionContinuationState);
    if (!state?.taskId) continue;
    if ((db.conversationActionTasks as ConversationActionTaskRow[]).some(task => task.id === state.taskId)) continue;
    if (syncConversationActionTaskLedger(db, { conversation, state, now: state.updatedAt })) migrated += 1;
  }
  return migrated;
}

/**
 * A terminal task belongs in durable history, never in the conversation's
 * live continuation slot. Older builds could persist that stale projection;
 * clear it without deleting the task or changing its ordering timestamps.
 */
export function repairTerminalConversationActionPointers(db: any): number {
  ensureTables(db);
  let repaired = 0;
  for (const conversation of db.conversations || []) {
    const state = normalizeConversationActionState(conversation.actionContinuationState);
    if (!state) continue;
    const durableTask = state.taskId
      ? (db.conversationActionTasks as ConversationActionTaskRow[]).find(task => (
          task.id === state.taskId
          && task.conversationId === conversation.id
          && task.userId === conversation.userId
        ))
      : null;
    const pointerIsTerminal = !state.unfinished
      || isTerminalConversationTaskStatus(state.status)
      || Boolean(durableTask && isTerminalConversationTaskStatus(durableTask.status));
    if (!pointerIsTerminal) continue;
    delete conversation.actionContinuationState;
    repaired += 1;
  }
  return repaired;
}

/**
 * One-version repair for terminal rows created before request-lease cleanup was
 * enforced at the normalization and ledger boundaries. Keep ordering
 * timestamps intact so a repair cannot make old work look newly completed.
 */
export function repairTerminalConversationActionTaskLeases(db: any): number {
  ensureTables(db);
  let repaired = 0;
  for (const task of db.conversationActionTasks as ConversationActionTaskRow[]) {
    if (task.conversationId.startsWith('scheduler:')) continue;
    if (!isTerminalConversationTaskStatus(task.status)) continue;
    const context = parseObject(task.context);
    const rawActionState = parseObject(context.actionState);
    if (!String(task.activeRequestId || '').trim() && !String(rawActionState.activeRequestId || '').trim()) continue;
    const actionState = normalizeConversationActionState({
      ...rawActionState,
      status: task.status,
      unfinished: false,
      activeRequestId: undefined,
    });
    task.activeRequestId = '';
    task.revision = Math.max(1, Number(task.revision) || 0) + 1;
    task.context = JSON.stringify({
      ...context,
      ...(actionState ? { actionState: sanitizeState(actionState) } : {}),
    });
    repaired += 1;
  }
  return repaired;
}

/**
 * Process-local request leases cannot survive a backend restart. Recover every
 * non-scheduler ledger row, including older rows hidden by a newer task. Hidden
 * rows keep their original ordering timestamp so recovery cannot steal the
 * conversation's current task pointer; the repair time remains in context.
 */
export function recoverConversationActionTaskLeases(
  db: any,
  now = new Date().toISOString(),
  options: {
    /** True only when startup hydration restored the exact one-time envelope. */
    hasExactPendingConfirmation?: (task: ConversationActionTaskRow) => boolean;
  } = {},
): number {
  ensureTables(db);
  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  let recovered = 0;

  for (const task of tasks) {
    if (task.conversationId.startsWith('scheduler:')) continue;
    if (!['planning', 'executing', 'verifying', 'waiting_confirmation'].includes(task.status)) continue;

    const hasNewerTask = tasks.some(candidate => (
      candidate.id !== task.id
      && candidate.conversationId === task.conversationId
      && candidate.userId === task.userId
      && candidate.createdAt.localeCompare(task.createdAt) > 0
    ));
    const previousStatus = task.status;
    if (
      previousStatus === 'waiting_confirmation'
      && options.hasExactPendingConfirmation?.(task)
    ) {
      // A hydrated encrypted envelope still owns this boundary. It has no
      // process-local executor lease to recover, so leave the task untouched.
      // In particular, do not reduce Windows DPAPI-backed restart behavior.
      continue;
    }
    const blocker = previousStatus === 'waiting_confirmation'
      ? RECONFIRMATION_REQUIRED_BLOCKER
      : 'The previous runtime ended before this task reached a terminal receipt.';
    const context = parseObject(task.context);
    const actionState = normalizeConversationActionState(context.actionState);
    const orderingTimestamp = hasNewerTask ? task.updatedAt : now;

    const conversation = (db.conversations || []).find((candidate: any) => (
      candidate.id === task.conversationId && candidate.userId === task.userId
    ));
    const recoverableState = actionState || conversationActionStateFromTask(task);
    if (conversation && recoverableState) {
      const finalized = finalizeConversationActionTask(db, {
        conversation,
        state: recoverableState,
        outcome: 'blocked',
        requestId: task.activeRequestId,
        blocker,
        now: orderingTimestamp,
        retainPendingAction: true,
        updateLivePointer: !hasNewerTask,
      });
      if (finalized) {
        const refreshedContext = parseObject(task.context);
        task.context = JSON.stringify({
          ...refreshedContext,
          executionLeaseRecovery: {
            recoveredAt: now,
            priorStatus: previousStatus,
            newerTaskAlreadyExists: hasNewerTask,
          },
        });
        recovered += 1;
        continue;
      }
    }

    // Legacy/malformed rows without their owning conversation cannot pass
    // through the foreground finalizer; keep this bounded migration fallback.
    task.status = 'blocked';
    task.blocker = blocker;
    task.activeRequestId = '';
    task.revision = Math.max(1, Number(task.revision) || 0) + 1;
    task.updatedAt = orderingTimestamp;
    task.context = JSON.stringify({
      ...context,
      executionLeaseRecovery: {
        recoveredAt: now,
        priorStatus: previousStatus,
        newerTaskAlreadyExists: hasNewerTask,
      },
      ...(actionState
        ? {
            actionState: sanitizeState({
              ...actionState,
              version: 2,
              status: 'blocked',
              unfinished: true,
              latestBlocker: blocker,
              activeRequestId: undefined,
              revision: Math.max(actionState.revision || 0, task.revision),
              updatedAt: orderingTimestamp,
            }),
          }
        : {}),
    });
    recovered += 1;
  }
  return recovered;
}

/**
 * One-version repair for receipts written by the former text-scanning
 * success detector. A verified structured result containing diagnostics such
 * as `failed: 0` could be persisted as a failure. Only contradictory rows
 * that already carry an explicit verified terminal decision are repaired.
 */
export function repairContradictoryConversationActionReceipts(db: any): number {
  ensureTables(db);
  let repaired = 0;
  const repairedRecords = new Map<string, ToolExecutionRecord[]>();
  for (const row of db.conversationActionReceipts as ConversationActionReceiptRow[]) {
    if (row.outcome !== 'failed') continue;
    const inspection = inspectPersistedToolExecutionReceipt(row);
    if (!inspection.valid || !inspection.explicitlyTerminalVerified) continue;
    const envelope = inspection.envelope!;
    const result = envelope.result as Record<string, any> | undefined;
    if (!result || typeof result !== 'object') continue;
    const record: ToolExecutionRecord = {
      taskId: row.taskId,
      turnId: row.turnId,
      requestId: row.requestId,
      idempotencyKey: row.idempotencyKey,
      name: row.toolName,
      arguments: envelope.toolName === 'client_action'
        ? {
            action: String(result.action || ''),
            target: String(result.target || row.targetIdentity || ''),
            ...(typeof result?.relayResult?.enabled === 'boolean'
              ? { enabled: result.relayResult.enabled }
              : {}),
          }
        : row.targetIdentity
          ? { target: row.targetIdentity }
          : {},
      result: JSON.stringify(result),
      receipt: result,
      terminalVerification: {
        status: 'verified',
        strategy: 'terminal_receipt',
        reason: String(envelope?.verification?.reason || 'Verified terminal receipt.'),
      },
    };
    if (!toolRecordSucceeded(record)) continue;
    row.outcome = 'verified_success';
    row.envelope = JSON.stringify({
      ...envelope,
      status: 'verified_success',
      error: undefined,
    });
    const records = repairedRecords.get(row.taskId) || [];
    records.push(record);
    repairedRecords.set(row.taskId, records);
    repaired += 1;
  }

  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  for (const [taskId, records] of repairedRecords) {
    const task = tasks.find(candidate => candidate.id === taskId);
    if (!task) continue;
    const context = parseObject(task.context);
    const state = normalizeConversationActionState(context.actionState);
    if (!state) continue;
    const receipts = mergeTaskReceipts(
      state.receipts || [],
      records,
      task.updatedAt,
    );
    const completion = taskCompletionFromReceipts(
      state.goal || task.goal,
      receipts,
      state.taskCapsule,
    );
    const finalization = parseObject(context.taskFinalization);
    const sameRequestNegativeFinalization = ['blocked', 'cancelled', 'failed', 'persistence_unknown'].includes(finalization.outcome)
      && Boolean(finalization.requestId)
      && records.some(record => record.requestId === finalization.requestId);
    const canComplete = completion.complete
      && !sameRequestNegativeFinalization
      && !taskPersistenceUnknownMarker(task);
    const status = canComplete ? 'completed' : task.status;
    const nextState = normalizeConversationActionState({
      ...state,
      receipts,
      status,
      unfinished: !isTerminalConversationTaskStatus(status),
      latestBlocker: canComplete ? '' : state.latestBlocker,
      activeRequestId: conversationTaskStatusOwnsExecutionLease(status)
        ? state.activeRequestId
        : undefined,
      completionSource: canComplete ? 'tool_receipt' : state.completionSource,
      revision: Math.max(state.revision || 0, task.revision || 0) + 1,
      updatedAt: task.updatedAt,
    });
    if (nextState) context.actionState = sanitizeState(nextState);
    task.context = JSON.stringify(context);
    task.status = status;
    if (canComplete) {
      task.blocker = '';
      task.activeRequestId = '';
      task.completionSource = 'tool_receipt';
      task.completedAt = task.completedAt || task.updatedAt;
    }
    task.revision = nextState?.revision || task.revision;
  }

  // Terminal and confirmation-waiting states cannot simultaneously carry a
  // live execution blocker. Older builds could leave the confirmation-denial
  // text behind after cancellation, which made the command-center widget show
  // a contradictory cancelled+error state. Repair those rows on bootstrap.
  for (const task of tasks) {
    if (!['completed', 'failed', 'cancelled', 'waiting_confirmation'].includes(task.status)) continue;
    if (!String(task.blocker || '').trim()) continue;
    const context = parseObject(task.context);
    const state = normalizeConversationActionState(context.actionState);
    if (state) {
      const nextState = normalizeConversationActionState({
        ...state,
        status: task.status,
        latestBlocker: '',
        unfinished: !isTerminalConversationTaskStatus(task.status),
      });
      if (nextState) context.actionState = sanitizeState(nextState);
      task.context = JSON.stringify(context);
    }
    task.blocker = '';
    repaired += 1;
  }
  return repaired;
}
