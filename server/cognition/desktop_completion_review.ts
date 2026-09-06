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

export function desktopCompletionReviewText(task: string): string {
  return /[\u3400-\u9fff]/u.test(task)
    ? CN_EXECUTION_EVIDENCE_MESSAGES.desktopCompletionNeedsObservation
    : 'I preserved the current progress and stopped further control actions. The result on the current screen still needs checking.';
}
