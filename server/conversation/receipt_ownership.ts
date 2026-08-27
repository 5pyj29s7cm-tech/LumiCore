import type { ToolExecutionRecord } from '../tools/types';

export type ConversationReceiptMismatchDimension = 'task_id' | 'request_id';

export interface ConversationReceiptOwnerIdentity {
  taskId?: string;
  requestId?: string;
}

export interface ConversationReceiptOwnershipClassification {
  classification: 'current' | 'stale' | 'unbound';
  mismatchDimensions: ConversationReceiptMismatchDimension[];
}

function identity(value: unknown): string {
  return String(value || '').trim();
}

/**
 * Transport-neutral ownership fence shared by live assistant persistence and
 * isolated acceptance evidence. A receipt is stale only when both sides carry
 * a comparable immutable identity and at least one dimension disagrees.
 */
export function classifyConversationReceiptOwnership(
  record: Pick<ToolExecutionRecord, 'taskId' | 'requestId'>,
  owner: ConversationReceiptOwnerIdentity,
): ConversationReceiptOwnershipClassification {
  const recordTaskId = identity(record?.taskId);
  const recordRequestId = identity(record?.requestId);
  const ownerTaskId = identity(owner?.taskId);
  const ownerRequestId = identity(owner?.requestId);
  const mismatchDimensions: ConversationReceiptMismatchDimension[] = [];
  if (recordTaskId && ownerTaskId && recordTaskId !== ownerTaskId) {
    mismatchDimensions.push('task_id');
  }
  if (recordRequestId && ownerRequestId && recordRequestId !== ownerRequestId) {
    mismatchDimensions.push('request_id');
  }
  if (mismatchDimensions.length > 0) {
    return { classification: 'stale', mismatchDimensions };
  }
  if (
    (recordTaskId && ownerTaskId && recordTaskId === ownerTaskId)
    || (recordRequestId && ownerRequestId && recordRequestId === ownerRequestId)
  ) {
    return { classification: 'current', mismatchDimensions: [] };
  }
  return { classification: 'unbound', mismatchDimensions: [] };
}

export function partitionConversationReceiptsByOwnership<T extends ToolExecutionRecord>(
  records: T[],
  owner: ConversationReceiptOwnerIdentity,
): { currentRecords: T[]; staleRecords: T[] } {
  const currentRecords: T[] = [];
  const staleRecords: T[] = [];
  for (const record of records || []) {
    if (classifyConversationReceiptOwnership(record, owner).classification === 'stale') {
      staleRecords.push(record);
    } else {
      currentRecords.push(record);
    }
  }
  return { currentRecords, staleRecords };
}
