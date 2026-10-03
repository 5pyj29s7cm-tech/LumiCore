import { createHash } from 'node:crypto';

export interface BranchSyncPayload {
  orgId: string;
  branchId: string;
  batchId: string;
  memories?: unknown[];
  interactions?: unknown[];
}

export interface BranchSyncItemReceipt {
  kind: 'memory' | 'interaction';
  sourceId: string;
  targetId: string;
  digest: string;
  outcome: 'inserted' | 'updated' | 'unchanged';
}

export interface BranchSyncReceipt {
  version: 1;
  receiptId: string;
  orgId: string;
  branchId: string;
  batchId: string;
  payloadDigest: string;
  verified: true;
  accepted: number;
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: number;
  replayed: boolean;
  items: BranchSyncItemReceipt[];
  persistedAt: string;
}

export function canonicalizeBranchSyncValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeBranchSyncValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter(key => !key.startsWith('_synced'))
      .sort()
      .map(key => [key, canonicalizeBranchSyncValue((value as Record<string, unknown>)[key])]),
  );
}

export function branchSyncDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalizeBranchSyncValue(value))).digest('hex');
}
