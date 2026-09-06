import type { ToolExecutionRecord } from '../tools/types';
import { parseReceiptObject, toolRecordTerminalPayload } from '../tools/receipt_payload';
import { CN_EXECUTION_EVIDENCE_MESSAGES } from '../regions/packs/cn/execution_evidence_messages';

export const DESKTOP_COMPLETION_REVIEW_REASON = 'desktop_completion_needs_observation';

/** A real, current control attempt reached a completion candidate, not a new action request. */
export function findDesktopCompletionReview(
  records: ToolExecutionRecord[],
  scope: { requestId?: string; taskId?: string } = {},
): ToolExecutionRecord | undefined {
  const matching = (values: Array<string | undefined>, expected?: string) => {
    if (!expected) return true;
    const present = values.filter(Boolean);
    return present.length > 0 && present.every(value => value === expected);
  };
  const record = [...records].reverse().find(item => item.name === 'computer_use'
    && matching([item.requestId, item.turnId, item.envelope?.requestId, item.envelope?.turnId], scope.requestId)
    && matching([item.taskId, item.envelope?.taskId], scope.taskId));
  if (!record || !['failed', 'unverified'].includes(record.terminalVerification?.status || '')) return undefined;
  const payload = parseReceiptObject(toolRecordTerminalPayload(record));
  return payload?.ok === false && payload.status === 'unverified'
    && payload.completionVerified === false && payload.resumeStrategy === 'observe_only'
    && typeof payload.completionCandidate === 'string' && payload.completionCandidate.trim()
    ? record : undefined;
}

export function desktopCompletionReviewText(task: string, record?: ToolExecutionRecord): string {
  const candidate = record && findDesktopCompletionReview([record]);
  const payload = candidate && parseReceiptObject(toolRecordTerminalPayload(candidate));
  const observation = parseReceiptObject(payload?.playbackObservation);
  const zh = /[\u3400-\u9fff]/u.test(task);
  if (payload?.verificationReason === 'observation_unavailable') {
    return zh ? CN_EXECUTION_EVIDENCE_MESSAGES.playbackObservationUnavailable
      : 'I could not read the playback screen, so I cannot confirm playback. I stopped further control actions.';
  }
  if (payload?.verificationReason === 'target_changed') {
    return zh ? CN_EXECUTION_EVIDENCE_MESSAGES.playbackTargetChanged
      : 'The playback window changed before I could confirm the requested content. I stopped further control actions.';
  }
  switch (observation?.phase) {
    case 'advertisement':
      return zh ? CN_EXECUTION_EVIDENCE_MESSAGES.playbackAdUnconfirmed
        : 'The advertisement is still playing; I have not confirmed the programme has started. I stopped further control actions.';
    case 'buffering':
      return zh ? CN_EXECUTION_EVIDENCE_MESSAGES.playbackLoadingUnconfirmed
        : 'The player is still loading; I have not confirmed playback. I stopped further control actions.';
    case 'paused':
      return zh ? CN_EXECUTION_EVIDENCE_MESSAGES.playbackPausedUnconfirmed
        : 'The screen shows playback is paused. I stopped further control actions.';
    case 'blocked':
      return zh ? CN_EXECUTION_EVIDENCE_MESSAGES.playbackBlockedUnconfirmed
        : 'Playback is blocked, and I have not confirmed the programme has started. I stopped further control actions.';
    case 'content':
      return zh ? CN_EXECUTION_EVIDENCE_MESSAGES.playbackContentUnconfirmed
        : 'The video picture is visible, but I could not confirm continuing playback. I stopped further control actions.';
    case 'unknown':
      return zh ? CN_EXECUTION_EVIDENCE_MESSAGES.playbackProgressUnconfirmed
        : 'I preserved the progress and stopped further control actions. I have not seen reliable playback progress and cannot confirm playback.';
    default:
      return zh ? CN_EXECUTION_EVIDENCE_MESSAGES.desktopCompletionNeedsObservation
        : 'I preserved the current progress and stopped further control actions, but could not confirm the result.';
  }
}
