import { normalizeConversationActionState } from "../../cognition/action_continuation";
import { mergeTaskReceipts, taskCompletionFromReceipts, toolRecordSucceeded, conversationTaskStatusOwnsExecutionLease, isTerminalConversationTaskStatus, type ConversationTaskStatus } from "../../cognition/task_execution_ledger";
import { isConfirmationBlockedToolRecord } from "../../tools/confirmation_block";
import type { ToolExecutionRecord } from "../../tools/types";
import type { ConversationActionTerminalDisposition, ConversationActionTaskRow } from './contracts';
import { ensureTables, parseObject, sanitizeState } from './serialization';
import { appendConversationActionReceipts } from './receipt_store';
import { finalizeConversationActionTask } from './task_lifecycle';

/**
 * Persist terminal records that arrive after their request was replaced.
 *
 * Every task-bound receipt remains append-only audit evidence. Recomputing the
 * task projection is a stronger operation: the receipt request must still be
 * the exact active owner in the task context, task row, and action-turn ledger.
 * A historical receipt from an older request on the same task is therefore
 * archived without being allowed to settle a successor's live projection.
 */
export function archiveBoundConversationActionReceipts(
  db: any,
  input: {
    conversationId: string;
    userId: string;
    records: ToolExecutionRecord[];
    turnId?: string;
    now?: string;
    /** @internal Exact, manager-fenced terminal adjudication for this request. */
    terminalDisposition?: ConversationActionTerminalDisposition;
    /** @internal Current assistant result owned by currentPairingAuthority. */
    assistantState?: string;
    /**
     * @internal Legacy requestless compatibility. Only the manager's current
     * user/assistant pairing may use this; stale/replay archive calls omit it.
     */
    currentPairingAuthority?: {
      userMessageId: string;
      assistantMessageId: string;
    };
  },
): {
  archived: number;
  taskIds: string[];
  adjudicatedTaskIds: string[];
  terminalDispositionApplied: boolean;
} {
  ensureTables(db);
  const now = input.now || new Date().toISOString();
  const tasks = db.conversationActionTasks as ConversationActionTaskRow[];
  const grouped = new Map<string, ToolExecutionRecord[]>();
  for (const record of input.records || []) {
    const taskId = String(record.taskId || '').trim();
    if (!taskId) continue;
    const task = tasks.find(candidate => (
      candidate.id === taskId
      && candidate.conversationId === input.conversationId
      && candidate.userId === input.userId
    ));
    if (!task) continue;
    const records = grouped.get(taskId) || [];
    records.push(record);
    grouped.set(taskId, records);
  }

  let archived = 0;
  const taskIds: string[] = [];
  const adjudicatedTaskIds: string[] = [];
  let terminalDispositionApplied = false;
  for (const [taskId, records] of grouped) {
    const task = tasks.find(candidate => candidate.id === taskId)!;
    archived += appendConversationActionReceipts(db, {
      task,
      records,
      turnId: input.turnId,
      requestId: records.find(record => record.requestId)?.requestId,
      now,
    }).length;
    const context = parseObject(task.context);
    const state = normalizeConversationActionState(context.actionState);
    if (state) {
      const requestIds = [...new Set(
        records.map(record => String(record.requestId || '').trim()).filter(Boolean),
      )];
      const receiptRequestId = requestIds.length === 1
        && records.every(record => String(record.requestId || '').trim() === requestIds[0])
        ? requestIds[0]
        : '';
      const activeTurn = receiptRequestId
        ? (db.conversationActionTurns || []).find((candidate: any) => (
            candidate.conversationId === input.conversationId
            && candidate.userId === input.userId
            && candidate.requestId === receiptRequestId
            && candidate.taskId === taskId
            && (candidate.status === 'accepted' || candidate.status === 'leased')
          ))
        : null;
      const exactRequestOwnsActiveTask = Boolean(
        receiptRequestId
        && state.activeRequestId === receiptRequestId
        && task.activeRequestId === receiptRequestId
        && activeTurn,
      );
      const authority = input.currentPairingAuthority;
      const conversation = (db.conversations || []).find((candidate: any) => (
        candidate.id === input.conversationId && candidate.userId === input.userId
      ));
      const pending = conversation?.pendingActionContinuation;
      const exactUser = authority?.userMessageId
        ? (db.interactions || []).find((candidate: any) => (
            candidate.id === authority.userMessageId
            && candidate.conversationId === input.conversationId
            && candidate.userId === input.userId
            && candidate.role === 'user'
          ))
        : null;
      const exactAssistant = authority?.assistantMessageId
        ? (db.interactions || []).find((candidate: any) => (
            candidate.id === authority.assistantMessageId
            && candidate.conversationId === input.conversationId
            && candidate.userId === input.userId
            && candidate.role === 'assistant'
            && candidate.mode !== 'proactive'
          ))
        : null;
      const competingActiveTurn = (db.conversationActionTurns || []).some((candidate: any) => (
        candidate.conversationId === input.conversationId
        && candidate.userId === input.userId
        && candidate.taskId === taskId
        && (candidate.status === 'accepted' || candidate.status === 'leased')
      ));
      const currentRequestlessPairingOwnsTask = Boolean(
        !receiptRequestId
        && records.every(record => !String(record.requestId || '').trim())
        && !state.activeRequestId
        && !task.activeRequestId
        && authority?.userMessageId
        && authority?.assistantMessageId
        && pending?.messageId === authority.userMessageId
        && !pending?.requestId
        && exactUser
        && exactAssistant
        && !String(exactAssistant.requestId || '').trim()
        && !competingActiveTurn,
      );
      const requestOwnsActiveTask = exactRequestOwnsActiveTask
        || currentRequestlessPairingOwnsTask;
      if (!requestOwnsActiveTask) {
        // Audit-only path. In particular, never merge an R1 receipt into the
        // R2 state merely because both requests are bound to the same task id.
        taskIds.push(taskId);
        continue;
      }
      adjudicatedTaskIds.push(taskId);
      const disposition = input.terminalDisposition;
      const dispositionRequestId = String(disposition?.requestId || '').trim().slice(0, 180);
      const dispositionReason = String(disposition?.reason || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 380);
      const boundTurn = dispositionRequestId
        ? (db.conversationActionTurns || []).find((candidate: any) => (
            candidate.conversationId === input.conversationId
            && candidate.userId === input.userId
            && candidate.requestId === dispositionRequestId
            && candidate.taskId === taskId
            && (candidate.status === 'accepted' || candidate.status === 'leased')
          ))
        : null;
      const authoritativeDisposition = Boolean(
        (disposition?.outcome === 'blocked' || disposition?.outcome === 'cancelled')
        && disposition.taskId === taskId
        && dispositionRequestId
        && dispositionReason
        && !isTerminalConversationTaskStatus(task.status)
        && boundTurn
        && requestOwnsActiveTask
        && records.every(record => (
          String(record.taskId || '').trim() === taskId
          && String(record.requestId || '').trim() === dispositionRequestId
        )),
      );
      const receipts = mergeTaskReceipts(state.receipts || [], records, now);
      const completion = taskCompletionFromReceipts(
        state.goal || task.goal,
        receipts,
        state.taskCapsule,
        exactRequestOwnsActiveTask ? { requestId: receiptRequestId, taskId } : undefined,
      );
      const waitingForConfirmation = records.some(record => isConfirmationBlockedToolRecord(record)
        && (!receiptRequestId || String(record.requestId || record.turnId || '') === receiptRequestId));
      const hasFailure = records.some(record => !toolRecordSucceeded(record));
      const status: ConversationTaskStatus = authoritativeDisposition
        ? disposition!.outcome
        : isTerminalConversationTaskStatus(task.status)
        ? task.status
        : waitingForConfirmation
          ? 'waiting_confirmation'
          : completion.complete
            ? 'completed'
            : hasFailure
              ? 'blocked'
              : task.status;
      const requestLeaseActive = Boolean(state.unfinished)
        && conversationTaskStatusOwnsExecutionLease(status);
      const nextState = normalizeConversationActionState({
        ...state,
        receipts,
        status,
        unfinished: !isTerminalConversationTaskStatus(status),
        latestBlocker: status === 'blocked'
          ? authoritativeDisposition
            ? dispositionReason
            : completion.blocker || task.blocker
          : status === 'failed' || status === 'cancelled'
            ? authoritativeDisposition ? dispositionReason : task.blocker
            : '',
        activeRequestId: !authoritativeDisposition && requestLeaseActive
          && !records.some(record => record.requestId === state.activeRequestId)
          ? state.activeRequestId
          : undefined,
        completionSource: !authoritativeDisposition && status === 'completed' && completion.complete
          ? 'tool_receipt'
          : authoritativeDisposition
            ? undefined
            : state.completionSource,
        assistantState: input.currentPairingAuthority && input.assistantState !== undefined
          ? String(input.assistantState || '').replace(/\s+/g, ' ').trim().slice(0, 700)
          : state.assistantState,
        revision: Math.max(state.revision || 0, task.revision || 0) + 1,
        updatedAt: now,
      });
      if (nextState && (status === 'blocked' || isTerminalConversationTaskStatus(status))) {
        finalizeConversationActionTask(db, {
          conversation: conversation || {
            id: task.conversationId,
            userId: task.userId,
            domain: task.domain,
            orgId: task.orgId,
          },
          state: nextState,
          outcome: status as 'blocked' | 'completed' | 'failed' | 'cancelled',
          requestId: authoritativeDisposition
            ? dispositionRequestId
            : records.find(record => record.requestId)?.requestId,
          blocker: nextState.latestBlocker,
          assistantState: nextState.assistantState,
          completionSource: nextState.completionSource,
          now,
          updateLivePointer: Boolean(conversation),
        });
        if (authoritativeDisposition) terminalDispositionApplied = true;
      } else {
        if (nextState) context.actionState = sanitizeState(nextState);
        task.context = JSON.stringify(context);
        task.status = status;
        task.blocker = status === 'cancelled' ? task.blocker : '';
        task.activeRequestId = nextState?.activeRequestId || '';
        task.completionSource = nextState?.completionSource || task.completionSource;
        task.updatedAt = now;
        task.revision = nextState?.revision || task.revision;
      }
    }
    taskIds.push(taskId);
  }
  return { archived, taskIds, adjudicatedTaskIds, terminalDispositionApplied };
}
