import { buildTransportNeutralConfirmationScope, getPendingConfirmation } from '../tools/pending_confirmation';
import { type Conversation } from "./manager/contracts";
import { classifyConversationActionFollowupIntent, needsRecentActionContinuationContext, normalizeConversationActionState, type ConversationActionContinuationState } from '../cognition/action_continuation';
import { conversationTaskStatusOwnsExecutionLease } from '../cognition/task_execution_ledger';
import { getConversationActionStateByTaskId, getConversationActionStateFromLedger } from "./ledger/queries";
import { syncConversationActionTaskLedger } from "./ledger/task_lifecycle";

export function hasExactPendingConfirmationForTask(input: {
  id: string;
  conversationId: string;
  userId: string;
  domain?: string;
  orgId?: string;
}): boolean {
  if (!input.id || !input.conversationId || !input.userId) return false;
  return Boolean(getPendingConfirmation(
    input.userId,
    buildTransportNeutralConfirmationScope({
      domain: input.domain,
      orgId: input.orgId,
      conversationId: input.conversationId,
      taskId: input.id,
    }),
  ));
}

export function hydrateConversationActionState(
  db: any,
  conversation: Conversation,
  query = '',
): ConversationActionContinuationState | null {
  const existing = normalizeConversationActionState(conversation.actionContinuationState);
  const resolveHistoricalTask = Boolean(
    query.trim() && needsRecentActionContinuationContext(query),
  );
  // Once an unrelated conversational turn detaches the live pointer, only an
  // explicit continuation query may rehydrate unfinished historical work.
  // Looking up the newest ledger row for every ordinary turn recreates the
  // stale pointer we just detached and lets an old goal leak into new text.
  const recoverableActiveTask = !existing && !resolveHistoricalTask
    ? (db.conversationActionTasks || [])
      .filter((task: any) => (
        task.conversationId === conversation.id
        && task.userId === conversation.userId
        && conversationTaskStatusOwnsExecutionLease(task.status)
        && Boolean(String(task.activeRequestId || '').trim())
        && (db.conversationActionTurns || []).some((turn: any) => (
          turn.conversationId === conversation.id
          && turn.userId === conversation.userId
          && turn.taskId === task.id
          && turn.requestId === task.activeRequestId
          && (turn.status === 'accepted' || turn.status === 'leased')
        ))
      ))
      .sort((left: any, right: any) => (
        String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
        || String(right.createdAt || '').localeCompare(String(left.createdAt || ''))
      ))[0]
    : null;
  const recoverableActiveState = recoverableActiveTask
    ? getConversationActionStateByTaskId(db, {
        conversationId: conversation.id,
        userId: conversation.userId,
        taskId: String(recoverableActiveTask.id || ''),
      })
    : null;
  const ledgerState = existing || resolveHistoricalTask
    ? getConversationActionStateFromLedger(db, {
        conversationId: conversation.id,
        userId: conversation.userId,
        query: resolveHistoricalTask ? query : '',
      })
    : recoverableActiveState;
  const exactExistingLedgerState = existing?.taskId
    ? getConversationActionStateByTaskId(db, {
        conversationId: conversation.id,
        userId: conversation.userId,
        taskId: existing.taskId,
      })
    : null;
  const exactLedgerUpdatedAt = exactExistingLedgerState
    ? Date.parse(exactExistingLedgerState.updatedAt)
    : Number.NaN;
  const rawExistingUpdatedAt = existing ? Date.parse(existing.updatedAt) : Number.NaN;
  const authoritativeExisting = exactExistingLedgerState
    && Number.isFinite(exactLedgerUpdatedAt)
    && (!Number.isFinite(rawExistingUpdatedAt) || exactLedgerUpdatedAt >= rawExistingUpdatedAt)
    ? exactExistingLedgerState
    : existing;
  const existingLive = authoritativeExisting?.unfinished ? authoritativeExisting : null;
  const ledgerLive = ledgerState?.unfinished ? ledgerState : null;
  const existingUpdatedAt = existingLive ? Date.parse(existingLive.updatedAt) : Number.NaN;
  const ledgerUpdatedAt = ledgerLive ? Date.parse(ledgerLive.updatedAt) : Number.NaN;
  const state = existingLive && ledgerLive
    ? existingLive.taskId === ledgerLive.taskId
      && Number.isFinite(ledgerUpdatedAt)
      && (!Number.isFinite(existingUpdatedAt) || ledgerUpdatedAt > existingUpdatedAt)
        ? ledgerLive
        : existingLive
    : existingLive || ledgerLive;
  // Historical and terminal projections live only in the durable ledger.
  // A query may influence which unfinished ledger row is selected, but it may
  // never repopulate the conversation's live pointer with completed work.
  if (state) conversation.actionContinuationState = state;
  else delete conversation.actionContinuationState;
  return state;
}

function shouldDetachUnrelatedActionState(
  state: ConversationActionContinuationState | null | undefined,
  userText: string,
): boolean {
  const current = normalizeConversationActionState(state);
  if (
    !current?.unfinished
    || !['blocked', 'waiting_confirmation'].includes(current.status || '')
  ) return false;
  return classifyConversationActionFollowupIntent(userText, current) === 'none';
}

/**
 * A blocked/confirmation-waiting task stays resumable in the durable ledger,
 * but stops being the conversation's live pointer once the user clearly starts
 * an unrelated turn. Detachment is not cancellation: an explicit later
 * continue/retry/confirmation may select the same task from the ledger.
 */
export function detachUnrelatedConversationActionState(
  db: any,
  conversation: Conversation,
  userText: string,
  now: string,
): boolean {
  const previous = normalizeConversationActionState(conversation.actionContinuationState);
  if (!previous || !shouldDetachUnrelatedActionState(previous, userText)) return false;
  // Persist the unfinished state without a request lease, then remove only the
  // compatibility projection. The task identity, blocker, policy, receipts
  // and pending confirmation remain authoritative in the durable ledger.
  syncConversationActionTaskLedger(db, {
    conversation,
    state: previous,
    userText: previous.latestInstruction || previous.goal,
    now,
  });
  delete conversation.actionContinuationState;
  return true;
}

export function compactRolloverText(value: unknown, limit: number): string {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  return clean.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
}
