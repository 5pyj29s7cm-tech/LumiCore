import { canAutoApproveAction } from './action_constitution';
import {
  consumePendingConfirmationDurably, recordPendingConfirmationDurably,
  confirmationArgumentsMatch, pendingConfirmationMatchesExactProposal,
  type PendingToolConfirmation, type PendingConfirmationScope,
} from './pending_confirmation';

export interface TurnConfirmationInput {
  userId: string;
  source: string;
  requestId: string;
  actionIntent: string;
  autoApprovalIntent?: string;
  pending?: PendingToolConfirmation | null;
  consumeScope: () => PendingConfirmationScope | undefined;
  proposalScope: () => PendingConfirmationScope | undefined;
  correctionRequiresFreshConfirmation?: boolean;
  exactWriteCorrection?: boolean;
  recoveryCall?: () => { name: string; arguments: Record<string, any> } | null | undefined;
  assertCurrent?: () => void;
  isCancelled?: () => boolean;
  onPending: (pending: PendingToolConfirmation) => void;
}

/** A turn may consume one exact grant or create one immutable proposal. */
export function createTurnConfirmation(input: TurnConfirmationInput) {
  let created = false;
  let consumed = false;
  let busy = false;
  return async (toolName: string, args: Record<string, any>): Promise<boolean> => {
    input.assertCurrent?.();
    if (created || busy || input.isCancelled?.()) return false;
    busy = true;
    try {
      const consumeScope = input.consumeScope();
      if (!consumed && input.pending && consumeScope
        && await consumePendingConfirmationDurably(input.userId, input.pending.id, toolName, args, consumeScope)) {
        consumed = true;
        input.assertCurrent?.();
        return !input.isCancelled?.();
      }
      if (!input.correctionRequiresFreshConfirmation
        && canAutoApproveAction(toolName, args, { actionIntent: input.autoApprovalIntent ?? input.actionIntent })) return true;
      const scope = input.proposalScope();
      if (!scope) return false;
      if (input.exactWriteCorrection) {
        const call = input.recoveryCall?.();
        if (!call || toolName !== call.name || !confirmationArgumentsMatch(args, call.arguments)) {
          throw new Error('Corrected write confirmation did not match the runtime-owned exact proposal');
        }
      }
      const pending = await recordPendingConfirmationDurably(input.userId, toolName, args, input.source, {
        ...scope, originRequestId: input.requestId, actionIntent: input.actionIntent,
      });
      // Latch immediately after durable creation, including revoked-authority paths.
      created = true;
      input.assertCurrent?.();
      if (input.correctionRequiresFreshConfirmation && !pendingConfirmationMatchesExactProposal(
        pending, toolName, args, { taskId: scope.taskId, originRequestId: input.requestId },
      )) throw new Error('Corrected action confirmation was not bound to the current task request');
      input.onPending(pending);
      return false;
    } finally {
      busy = false;
    }
  };
}
