import type { ActionIntentAnalysis } from "../normalized_action_intent";
import { buildActionEvidenceContract } from "../action_contract";
import { toolRecordTerminalPayload } from "../../tools/receipt_payload";
import type { ConversationActionContinuationState, PendingRuntimeCancellationRecheck } from './contracts';
import { normalizeConversationActionState } from './state_normalization';
import { compact } from './history_values';

/**
 * Return the exact immutable runtime targets of a cancellation that the
 * server already accepted but has not terminally verified. A caller may use
 * this only to recheck/reconcile that same cancellation; the helper never
 * widens an empty or malformed target set into cancel-all authority.
 */
export function pendingRuntimeCancellationRecheck(
  value: ConversationActionContinuationState | null | undefined, analysis?: ActionIntentAnalysis
): PendingRuntimeCancellationRecheck | null {
  const state = normalizeConversationActionState(value);
  if (!state?.taskId || !state.unfinished) return null;
  // New cleanup flows own a dedicated cancel task, so later status rechecks
  // must keep authority from the immutable root goal. The latest instruction
  // is retained only as a compatibility fallback for older ledgers that
  // attached the accepted cleanup to an observe task.
  const hasCancellationContract = [state.goal, state.latestInstruction]
    .filter(Boolean)
    .some(candidate => {
      const contract = buildActionEvidenceContract(candidate, analysis);
      return contract.kind === 'task_control'
        && contract.preferredTools.includes('runtime_work_cancel');
    });
  if (!hasCancellationContract) {
    return null;
  }
  const latestCancellation = [...(state.receipts || [])]
    .reverse()
    .find(receipt => receipt.name === 'runtime_work_cancel');
  if (!latestCancellation) return null;
  const payload = toolRecordTerminalPayload({
    receipt: latestCancellation.receipt,
    result: latestCancellation.result,
  });
  const result = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, any>
    : null;
  if (
    result?.ok !== true
    || String(result.status || '').toLowerCase() !== 'cancelling'
    || Number(result.failedCount || 0) !== 0
    || latestCancellation.terminalVerification?.status === 'verified'
  ) return null;
  // The original tool arguments are the only mutation authority. A handler
  // receipt is evidence about that call; it cannot add targets by reporting a
  // wider `requestedTaskIds` set. Require both sides to carry a non-empty
  // exact-ID set and fail closed when the receipt over-reports even one id.
  const exactTaskIds = (candidate: unknown): string[] | null => {
    if (!Array.isArray(candidate) || candidate.length === 0 || candidate.length > 64) return null;
    const normalized: string[] = [];
    for (const item of candidate) {
      if (typeof item !== 'string') return null;
      const taskId = item.trim();
      if (!taskId || taskId.length > 180) return null;
      normalized.push(taskId);
    }
    const unique = Array.from(new Set(normalized));
    return unique.length > 0 ? unique : null;
  };
  const authorizedTaskIds = exactTaskIds(latestCancellation.arguments?.taskIds);
  const requestedTaskIds = exactTaskIds(result.requestedTaskIds);
  if (!authorizedTaskIds || !requestedTaskIds) return null;
  const authorizedTaskIdSet = new Set(authorizedTaskIds);
  // Reconcile the complete original set. A subset cannot escalate authority,
  // but accepting it would silently stop tracking omitted cancellations and
  // could later claim the multi-target task completed from partial evidence.
  if (
    requestedTaskIds.length !== authorizedTaskIdSet.size
    || requestedTaskIds.some(taskId => !authorizedTaskIdSet.has(taskId))
  ) return null;
  return {
    taskId: state.taskId,
    taskIds: requestedTaskIds,
    priorReceiptId: compact(latestCancellation.id, 180),
    priorStatus: 'cancelling',
  };
}
