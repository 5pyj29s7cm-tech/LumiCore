import { createHash } from 'node:crypto';
import type { ToolExecutionIdentity, ToolExecutionRecord } from './types';

export const EXECUTION_IDENTITY_FIELDS = [
  'resolutionId', 'taskId', 'requestId', 'turnRowId', 'externalMessageId', 'turnId',
] as const;

/** Copy explicit identities only; a legacy turnId never implies another ID. */
export function toolExecutionIdentity(source?: ToolExecutionIdentity): ToolExecutionIdentity {
  const identity: ToolExecutionIdentity = {};
  for (const field of EXECUTION_IDENTITY_FIELDS) {
    const value = source?.[field];
    if (typeof value === 'string' && value) identity[field] = value;
  }
  return identity;
}

/** Default local call identity; provider IDs are scoped to their selecting assistant batch. */
export function defaultLocalToolExecutionKey(record: Pick<ToolExecutionRecord, 'id' | 'name' | 'taskId' | 'requestId' | 'modelRoutingReceiptId'>): string {
  if (!record.id || !record.requestId) return '';
  return createHash('sha256').update(JSON.stringify([
    record.taskId || '', record.requestId, record.name, record.id,
    ...(record.modelRoutingReceiptId ? [record.modelRoutingReceiptId] : []),
  ])).digest('hex');
}
