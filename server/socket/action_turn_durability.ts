import {
  classifyConversationActionFollowupIntent,
  conversationActionRequiresFreshConfirmationReview,
  type ConversationActionContinuationState,
} from '../cognition/action_continuation';
import { resolveActiveTaskMessageRelation } from '../cognition/task_concurrency';
import { classifyTaskCapsuleTurn } from '../conversation/task_capsule';
import {
  clearPendingConfirmationDurably,
  formatPendingConfirmationPrompt,
  getPendingConfirmationDurably,
  isConfirmationCancellation,
  isExplicitConfirmationReply,
  type PendingConfirmationScope,
  type PendingToolConfirmation,
} from '../tools/pending_confirmation';

const ACCEPTED_TURN_ADMISSION = Symbol('accepted-turn-admission');

export interface AcceptedUserTurnAdmission<T> {
  readonly persisted: T;
  readonly [ACCEPTED_TURN_ADMISSION]: true;
}

export interface AcceptedTurnConfirmationResolution {
  pending: PendingToolConfirmation | null;
  /**
   * Runtime-only, integrity-checked exact action that a target correction just
   * revoked. It may seed a narrowly validated corrected call, but it is never
   * itself reusable or exposed to the model/client.
   */
  revokedCorrectionBasis: PendingToolConfirmation | null;
  scope: PendingConfirmationScope;
  prompt: string;
  cleared: boolean;
  correctionRequiresFreshConfirmation: boolean;
}

/**
 * First write barrier for an accepted user action turn. The admission token
 * does not exist until both the transcript mutation and its strict flush have
 * succeeded, so cancellation, confirmation, queue, registry and tool work can
 * be explicitly fenced behind `runAfterAcceptedUserTurnAdmission`.
 */
export async function admitAcceptedUserTurnDurably<T>(input: {
  persistAcceptedUserTurn: () => T | Promise<T>;
  flush: () => Promise<void>;
  onPersistenceUnknown: (error: unknown) => void | Promise<void>;
}): Promise<AcceptedUserTurnAdmission<T> | null> {
  try {
    const persisted = await input.persistAcceptedUserTurn();
    await input.flush();
    return {
      persisted,
      [ACCEPTED_TURN_ADMISSION]: true,
    };
  } catch (error) {
    await input.onPersistenceUnknown(error);
    return null;
  }
}

export function runAfterAcceptedUserTurnAdmission<T>(
  admission: AcceptedUserTurnAdmission<unknown>,
  operation: () => T,
): T {
  if (!admission || admission[ACCEPTED_TURN_ADMISSION] !== true) {
    throw new Error('Accepted user turn admission is required');
  }
  return operation();
}

/**
 * Shared post-admission confirmation resolver for chat, voice, task and remote
 * transports. An unrelated turn revokes only a taskless channel grant; it
 * cannot consume or erase a confirmation bound to another durable task.
 */
export async function resolveAcceptedTurnConfirmation(input: {
  admission: AcceptedUserTurnAdmission<unknown>;
  userId: string;
  userText: string;
  actionState?: ConversationActionContinuationState | null;
  taskScope: PendingConfirmationScope;
  channelScope: PendingConfirmationScope;
}): Promise<AcceptedTurnConfirmationResolution> {
  return runAfterAcceptedUserTurnAdmission(input.admission, async () => {
    const explicitConfirmation = isExplicitConfirmationReply(input.userText);
    const cancellation = isConfirmationCancellation(input.userText);
    const followupIntent = classifyConversationActionFollowupIntent(input.userText, input.actionState);
    const unrelated = !explicitConfirmation
      && !cancellation
      && followupIntent === 'none';
    const taskRelation = resolveActiveTaskMessageRelation(input.userText, input.actionState);
    const taskCapsuleTurn = classifyTaskCapsuleTurn(input.userText, input.actionState);
    const correctionRequiresFreshConfirmation = Boolean(
      (
        (
          taskRelation.feedback === 'correction'
          && ['active_task', 'previous_task'].includes(taskRelation.binding)
        )
        || taskCapsuleTurn === 'target_correction'
      )
      && (
        input.actionState?.status === 'waiting_confirmation'
        || conversationActionRequiresFreshConfirmationReview(input.actionState)
      )
      && input.taskScope.taskId,
    );
    let cleared = false;
    let revokedCorrectionBasis: PendingToolConfirmation | null = null;

    if (cancellation) {
      const clearedTask = await clearPendingConfirmationDurably(input.userId, input.taskScope);
      const clearedTaskless = await clearPendingConfirmationDurably(input.userId, input.channelScope);
      cleared = clearedTask || clearedTaskless;
    } else if (correctionRequiresFreshConfirmation) {
      // A correction invalidates the exact action that was awaiting approval.
      // Revoke it before replanning so a later short "confirm" can never
      // execute the rejected target. The corrected action must establish its
      // own one-time confirmation boundary.
      const existing = await getPendingConfirmationDurably(input.userId, input.taskScope);
      if (existing) {
        cleared = await clearPendingConfirmationDurably(input.userId, input.taskScope);
        if (!cleared) throw new Error('Pending confirmation correction could not be revoked');
        revokedCorrectionBasis = existing;
      }
    } else if (unrelated) {
      // A taskless grant is a one-turn offer. A new unrelated instruction
      // revokes it, while exact task-bound grants remain resumable.
      cleared = await clearPendingConfirmationDurably(input.userId, input.channelScope);
    }

    const pending = explicitConfirmation
      ? await getPendingConfirmationDurably(input.userId, input.taskScope)
        || await getPendingConfirmationDurably(input.userId, input.channelScope)
      : null;
    const scope = pending && !pending.taskId ? input.channelScope : input.taskScope;
    return {
      pending,
      revokedCorrectionBasis,
      scope,
      prompt: pending ? formatPendingConfirmationPrompt(pending) : '',
      cleared,
      correctionRequiresFreshConfirmation,
    };
  });
}
