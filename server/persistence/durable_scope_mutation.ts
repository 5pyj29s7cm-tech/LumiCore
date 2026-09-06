import { createHash } from 'node:crypto';
import { readDB, writeDB } from '../../db_layer';

export interface MutationScope {
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
}

const pendingMutations = new Map<string, Promise<unknown>>();

export function mutationScopeKey(scope: MutationScope): string {
  return JSON.stringify([scope.userId, scope.domain, scope.orgId]);
}

/** Each caller gets its own turn, including after a prior persistence failure. */
export function runSerializedMutation<T>(key: string, mutate: () => T | Promise<T>): Promise<T> {
  const previous = pendingMutations.get(key) || Promise.resolve();
  const pending = previous.catch(() => {}).then(mutate);
  pendingMutations.set(key, pending);
  void pending.finally(() => {
    if (pendingMutations.get(key) === pending) pendingMutations.delete(key);
  }).catch(() => {});
  return pending;
}

// These are retry receipts, not content or authority to recreate a resource.
// A scope keeps at most 1,000 deletes for 30 days; older unknown IDs retain the
// endpoint's normal not-found semantics. Resource lifecycle fences are separate.
const RECEIPT_LIMIT = 1000;
const RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
type DeletionReceipt = { deletedAt: number; result: Record<string, unknown> };
type DeletionReceipts = Record<string, DeletionReceipt>;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const receiptKey = (scope: MutationScope) => `scoped_deletion_receipts_${digest(mutationScopeKey(scope))}`;
const resourceKey = (kind: string, resourceId: string) => digest(JSON.stringify([kind, resourceId]));

function readReceipts(scope: MutationScope): DeletionReceipts {
  const value = (readDB().settings || []).find((row: any) => row.key === receiptKey(scope))?.value;
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function readScopedDeletionReceipt<T extends Record<string, unknown>>(
  scope: MutationScope, kind: string, resourceId: string,
): T | null {
  const receipt = readReceipts(scope)[resourceKey(kind, resourceId)];
  if (!receipt || !Number.isFinite(receipt.deletedAt) || receipt.deletedAt < Date.now() - RECEIPT_RETENTION_MS) return null;
  return receipt.result as T;
}

/** Include only small non-content result metadata, e.g. deletion counts/IDs. */
export function recordScopedDeletionReceipt(
  scope: MutationScope, kind: string, resourceId: string, result: Record<string, unknown>,
): void {
  const now = Date.now();
  const receipts = readReceipts(scope);
  const resource = resourceKey(kind, resourceId);
  delete receipts[resource];
  receipts[resource] = { deletedAt: now, result };
  const retained = Object.fromEntries(Object.entries(receipts).reverse()
    .filter(([, receipt]) => Number.isFinite(receipt.deletedAt) && receipt.deletedAt >= now - RECEIPT_RETENTION_MS)
    .sort((a, b) => b[1].deletedAt - a[1].deletedAt)
    .slice(0, RECEIPT_LIMIT).reverse());
  const db = readDB();
  db.settings ||= [];
  const key = receiptKey(scope);
  const row = db.settings.find((item: any) => item.key === key);
  const value = JSON.stringify(retained);
  if (row) row.value = value;
  else db.settings.push({ key, value });
  writeDB(db);
}
