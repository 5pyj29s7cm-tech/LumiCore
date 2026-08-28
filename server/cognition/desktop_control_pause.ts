import type { ToolExecutionRecord } from '../tools/types';
import { buildActionContract, hasCoreActionEvidence } from './action_contract';

export interface DesktopControlPauseAdjudicationInput {
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
  const contract = buildActionContract(input.taskText);
  if (!contract.applies) return true;
  return !hasCoreActionEvidence(
    contract,
    input.toolRecords || [],
    input.taskText,
  );
}
