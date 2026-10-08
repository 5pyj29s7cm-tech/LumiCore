import type { ToolExecutionRecord, ToolContext } from '../tools/types';
import { buildActionEvidenceContract, hasCoreActionEvidence } from './action_contract';

export interface DesktopControlPauseAdjudicationInput extends Pick<ToolContext, 'acceptedActionContract' | 'acceptedTaskTarget' | 'requestId' | 'taskId'> {
  pauseReason?: string | null;
  waitingForConfirmation?: boolean;
  taskText: string;
  toolRecords?: ToolExecutionRecord[];
}

/**
 * Physical input revokes authority for future desktop actions; it does not
 * rewrite an already verified terminal result. Every foreground channel uses
 * this same predicate so chat, task, and voice cannot disagree at the final
 * boundary.
 */
export function shouldBlockForDesktopControlPause(
  input: DesktopControlPauseAdjudicationInput,
): boolean {
  if (!String(input.pauseReason || '').trim() || input.waitingForConfirmation) return false;
  const contract = buildActionEvidenceContract(input.taskText, undefined, input.acceptedActionContract);
  if (!contract.applies) return true;
  return !hasCoreActionEvidence(
    contract,
    input.toolRecords || [],
    input.taskText, undefined, input, input.acceptedTaskTarget,
  );
}
