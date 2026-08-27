import type { ToolExecutionRecord } from '../tools/types';
import { toolRecordVerifiedForCompletion } from '../cognition/task_execution_ledger';

export interface DuplicateConfirmationTranscriptRecord {
  id?: string;
  role?: string;
  requestId?: string;
  externalMessageId?: string;
  cognitiveIntent?: string;
  toolCalls?: unknown[];
}

function recordRequestId(record: DuplicateConfirmationTranscriptRecord): string {
  return String(record.requestId || record.externalMessageId || '').trim();
}

/**
 * A repeated confirmation is safe to settle without replanning only when the
 * durable transcript proves that the immediately preceding assistant turn
 * completed an action resumed from the confirmation gate.  The live pointer
 * is intentionally absent after terminal cleanup, so it cannot be the source
 * of truth for this decision.
 */
export function findAdjacentVerifiedConfirmedAction(input: {
  messages: DuplicateConfirmationTranscriptRecord[];
  currentRequestId: string;
}): ToolExecutionRecord | null {
  const currentRequestId = String(input.currentRequestId || '').trim();
  if (!currentRequestId) return null;

  let currentUserIndex = -1;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const record = input.messages[index];
    if (record.role !== 'user' || recordRequestId(record) !== currentRequestId) continue;
    currentUserIndex = index;
    break;
  }
  if (currentUserIndex <= 0) return null;

  const previous = input.messages[currentUserIndex - 1];
  if (previous.role !== 'assistant' || previous.cognitiveIntent !== 'confirmation') return null;

  const toolCalls = Array.isArray(previous.toolCalls)
    ? previous.toolCalls.filter((record): record is ToolExecutionRecord => Boolean(
        record
        && typeof record === 'object'
        && !Array.isArray(record)
        && typeof (record as ToolExecutionRecord).name === 'string',
      ))
    : [];

  return toolCalls.find(record => (
    record.executionOrigin === 'confirmed_action_resume'
    && toolRecordVerifiedForCompletion(record)
  )) || null;
}
