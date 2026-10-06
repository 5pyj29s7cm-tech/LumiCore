import type { ConversationActionContinuationState } from './contracts';

/**
 * Durable fail-closed marker used when a restart cannot recover the exact
 * confirmation envelope. The old task description remains available for
 * context, but it is not authority to reconstruct dangerous tool arguments.
 */
export const RECONFIRMATION_REQUIRED_BLOCKER =
  'reconfirmation_required: The exact pending confirmation is unavailable after runtime restart. Generate and display a fresh review proposal before accepting confirmation.';

export function conversationActionRequiresFreshConfirmationReview(
  value: ConversationActionContinuationState | null | undefined,
): boolean {
  return Boolean(
    value?.unfinished
    && value.status === 'blocked'
    && /^reconfirmation_required(?:\b|:)/iu.test(String(value.latestBlocker || '').trim()),
  );
}
