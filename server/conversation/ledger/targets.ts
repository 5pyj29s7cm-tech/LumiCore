import type { ConversationActionContinuationState } from "../../cognition/action_continuation";

/**
 * Resolve the target owned by the durable task capsule, rather than inferring
 * it again from the wording of the current turn. A correction commonly names
 * both the rejected and replacement paths, while normalized action intent is
 * intentionally non-executing for that wording. Falling back to the existing
 * ledger row in that case leaves the top-level task target permanently pinned
 * to the first path even though the current receipt uses the replacement.
 */
export function currentTaskCorrectionTarget(state: ConversationActionContinuationState): string {
  const capsule = state.taskCapsule;
  if (!capsule) return '';

  const correction = capsule.latestCorrection;
  const correctionOwnsCurrentInstruction = Boolean(
    correction?.replacementTarget
    && (
      (
        correction.eventRef
        && state.latestInstructionRef
        && correction.eventRef === state.latestInstructionRef
      )
      || (
        correction.text
        && capsule.currentInstruction
        && correction.text === capsule.currentInstruction
      )
    ),
  );
  if (correctionOwnsCurrentInstruction) {
    return String(correction!.replacementTarget || '').trim().slice(0, 500);
  }

  return '';
}

export function durableTaskCapsuleTarget(state: ConversationActionContinuationState): string {
  const capsule = state.taskCapsule;
  if (!capsule) return '';
  if (capsule.target.status === 'rejected') return '';
  return String(
    capsule.target.path
    || capsule.target.object
    || capsule.target.label
    || capsule.target.application
    || '',
  ).trim().slice(0, 500);
}
