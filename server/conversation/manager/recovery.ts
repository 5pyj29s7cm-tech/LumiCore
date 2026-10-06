import { listConversationActionTurns, reconcileConversationActionTurnLease, reconcileConversationActionTurnLeases } from "../action_turn_ledger";
import { readDatabaseTables, commitDatabaseTables } from "../../../db_layer";
import type { Conversation } from "./contracts";
import { normalizeConversationActionState, RECONFIRMATION_REQUIRED_BLOCKER } from "../../cognition/action_continuation";
import { migrateLegacyConversationActionLedger, recoverConversationActionTaskLeases, repairTerminalConversationActionPointers, repairTerminalConversationActionTaskLeases, repairContradictoryConversationActionReceipts } from "../ledger/recovery";
import { compactLegacyScheduledCapabilityExecutions } from "../ledger/scheduler";
import { finalizeConversationActionTask } from "../ledger/task_lifecycle";
import { conversationTaskStatusOwnsExecutionLease } from "../../cognition/task_execution_ledger";
import { managerActionTurnLeases, managerActionTurnHeartbeatStops } from "../action_execution_runtime";
import { hydrateConversationActionState, hasExactPendingConfirmationForTask } from "../action_state_hydration";

/**
 * Foreground request leases are process-local. After a backend restart there
 * is no executor that can still own a persisted planning/executing state, and
 * a waiting confirmation is valid only when startup hydration restored its
 * exact one-time envelope. Convert true orphans to resumable blockers instead
 * of telling the next turn that old work is still running.
 */
export function recoverOrphanedConversationActionExecutions(
  now = new Date().toISOString(),
): number {
  const db = readDatabaseTables(["conversationActionReceipts","conversationActionTasks","conversationActionTurns","conversations","interactions","modelRoutingReceipts"]);
  const migrated = migrateLegacyConversationActionLedger(db);
  const repairedTerminalPointers = repairTerminalConversationActionPointers(db);
  const repairedTerminalLeases = repairTerminalConversationActionTaskLeases(db);
  const recoveredLedgerLeases = recoverConversationActionTaskLeases(db, now, {
    hasExactPendingConfirmation: hasExactPendingConfirmationForTask,
  });
  const repairedReceipts = repairContradictoryConversationActionReceipts(db);
  const schedulerCompaction = compactLegacyScheduledCapabilityExecutions(db);
  for (const stopHeartbeat of [...managerActionTurnHeartbeatStops.values()]) {
    stopHeartbeat();
  }
  managerActionTurnLeases.clear();
  let reconciledActionTurns = 0;
  for (const turn of listConversationActionTurns()) {
    const assistant = (db.interactions || []).find((row: any) => (
      row.userId === turn.userId
      && row.conversationId === turn.conversationId
      && row.role === 'assistant'
      && (
        String(row.requestId || '') === turn.requestId
        || String(row.externalMessageId || '') === turn.requestId
      )
    ));
    const conversation = (db.conversations || []).find((row: Conversation) => (
      row.id === turn.conversationId && row.userId === turn.userId
    ));
    const result = assistant
      ? reconcileConversationActionTurnLease({
          conversationId: turn.conversationId,
          userId: turn.userId,
          requestId: turn.requestId,
          observedStatus: 'terminal',
          terminalMessageId: assistant.id,
          reason: 'assistant transcript found during restart reconciliation',
          now,
        })
      : conversation?.status === 'closed'
        ? reconcileConversationActionTurnLease({
            conversationId: turn.conversationId,
            userId: turn.userId,
            requestId: turn.requestId,
            observedStatus: 'cancelled',
            reason: 'conversation was already closed during restart reconciliation',
            now,
          })
        : null;
    if (result?.reconciled) reconciledActionTurns += 1;
  }
  const recoveredActionTurnLeases = reconcileConversationActionTurnLeases({
    // This function is a startup hook. A synthetic epoch also makes its
    // restart behavior deterministic in same-process integration tests.
    processEpoch: `manager-restart:${crypto.randomUUID()}`,
    now,
  }).released;
  let recovered = 0;
  let recoveredPendingTurns = 0;
  for (const conversation of db.conversations || []) {
    hydrateConversationActionState(db, conversation);
    // Foreground request ownership is process-local. After restart every
    // transcript pairing slot is orphaned, including terminal/no-task states
    // that the older recovery filter skipped entirely.
    if (conversation.pendingActionContinuation) {
      delete conversation.pendingActionContinuation;
      recoveredPendingTurns += 1;
    }
    const previous = normalizeConversationActionState(conversation.actionContinuationState);
    if (
      !previous?.unfinished
      || (!conversationTaskStatusOwnsExecutionLease(previous.status)
        && previous.status !== 'waiting_confirmation')
    ) continue;
    const waitingForConfirmation = previous.status === 'waiting_confirmation';
    if (waitingForConfirmation && previous.taskId && hasExactPendingConfirmationForTask({
      id: previous.taskId,
      conversationId: conversation.id,
      userId: conversation.userId,
      domain: conversation.domain,
      orgId: conversation.orgId,
    })) {
      // The exact encrypted envelope was hydrated before this startup hook.
      // Keep the task waiting; its one-time grant is still safe to consume.
      continue;
    }
    const finalized = finalizeConversationActionTask(db, {
      conversation,
      state: previous,
      outcome: 'blocked',
      requestId: previous.activeRequestId,
      blocker: waitingForConfirmation
        ? RECONFIRMATION_REQUIRED_BLOCKER
        : 'The previous runtime ended before this task reached a terminal receipt.',
      now,
    });
    if (finalized) recovered += 1;
  }
  if (
    migrated > 0
    || repairedTerminalPointers > 0
    || repairedTerminalLeases > 0
    || recoveredLedgerLeases > 0
    || repairedReceipts > 0
    || schedulerCompaction.tasksRemoved > 0
    || reconciledActionTurns > 0
    || recoveredActionTurnLeases > 0
    || recoveredPendingTurns > 0
    || recovered > 0
  ) commitDatabaseTables(db);
  return repairedTerminalPointers
    + repairedTerminalLeases
    + recoveredLedgerLeases
    + reconciledActionTurns
    + recoveredActionTurnLeases
    + recovered
    + recoveredPendingTurns;
}
