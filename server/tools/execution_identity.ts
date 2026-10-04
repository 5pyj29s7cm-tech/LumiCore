import type { ToolExecutionIdentity } from './types';

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
