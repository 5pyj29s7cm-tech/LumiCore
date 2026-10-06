import { formatCnToolFailureDetail } from "../../regions/messages/voice_fast_path_messages";
import { CN_TASK_EXECUTION_MESSAGES } from "../../regions/messages/task_execution_messages";
import type { ConversationActionContinuationState } from './contracts';
import { normalizeConversationActionState } from './state_normalization';
import { conversationActionRequiresFreshConfirmationReview } from './confirmation';

export function formatConversationActionTaskStatus(
  value: ConversationActionContinuationState | null | undefined,
  options: { executionActive?: boolean } = {},
): string {
  const state = normalizeConversationActionState(value);
  if (!state) return CN_TASK_EXECUTION_MESSAGES.noResumableTask;
  const rootGoal = state.goal.slice(0, 80);
  const latestInstruction = state.latestInstruction.slice(0, 80);
  const goal = latestInstruction && latestInstruction !== rootGoal
    ? CN_TASK_EXECUTION_MESSAGES.goalWithCurrentStep(rootGoal, latestInstruction)
    : rootGoal;
  const successes = (state.receipts || []).filter(receipt => receipt.outcome === 'success').length;
  if (state.status === 'cancelled') {
    return CN_TASK_EXECUTION_MESSAGES.statusCancelled(goal);
  }
  if (conversationActionRequiresFreshConfirmationReview(state)) {
    return CN_TASK_EXECUTION_MESSAGES.statusFreshConfirmation(goal);
  }
  if (state.status === 'waiting_confirmation') {
    return CN_TASK_EXECUTION_MESSAGES.statusWaitingConfirmation(goal);
  }
  if (state.status === 'failed' || state.latestBlocker) {
    const detail = formatCnToolFailureDetail(
      state.latestBlocker || 'The task ended without a verified result.',
    ).replace(/[。；;]+$/u, '');
    return CN_TASK_EXECUTION_MESSAGES.statusFailed(goal, detail, successes);
  }
  if (state.status === 'completed' || !state.unfinished) {
    if (state.completionSource === 'user_observation') {
      return CN_TASK_EXECUTION_MESSAGES.completedFromUserObservation(goal);
    }
    return CN_TASK_EXECUTION_MESSAGES.statusCompleted(goal);
  }
  if (
    options.executionActive === true
    || (
      options.executionActive === undefined
      && Boolean(String(state.activeRequestId || '').trim())
      && ['planning', 'executing', 'verifying'].includes(state.status || '')
    )
  ) {
    return CN_TASK_EXECUTION_MESSAGES.statusActive(goal, successes);
  }
  return CN_TASK_EXECUTION_MESSAGES.statusResumable(goal, successes);
}
