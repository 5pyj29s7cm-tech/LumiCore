import './helpers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const persistence = vi.hoisted(() => ({ flush: vi.fn<() => Promise<void>>() }));
vi.mock('../db_layer', async importOriginal => ({
  ...await importOriginal<typeof import('../db_layer')>(),
  flushDBOrThrow: persistence.flush,
}));
import { initDatabase, readDB, writeDB, runSQL, querySQL } from '../db_layer';
import { createOrg, addMember } from '../server/org/db';
import { registerOrganizationDevice } from '../server/org/resource_acl';
import { getBranchSyncReceipt, persistBranchSyncBatch, waitForBranchSyncCommits } from '../server/org/branch_sync';

let realFlush: () => Promise<void>;
let sequence = 0;
let orgId = '';
let userId = '';
let branchId = '';
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function input(batchId: string, content = 'synthetic work') {
  return {
    authenticatedUserId: userId, authenticatedOrgId: orgId, authenticatedBranchId: branchId,
    payload: {
      orgId, branchId, batchId,
      memories: [{ id: batchId, userId, orgId, domain: 'work', content, keywords: [],
        createdAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z' }],
      interactions: [],
    },
  };
}
async function untilFlush() {
  for (let count = 0; count < 20 && !persistence.flush.mock.calls.length; count += 1) await Promise.resolve();
  expect(persistence.flush).toHaveBeenCalled();
}

beforeAll(async () => {
  const actual = await vi.importActual<typeof import('../db_layer')>('../db_layer');
  realFlush = actual.flushDBOrThrow;
  await initDatabase();
});
beforeEach(async () => {
  sequence += 1;
  userId = `branch-commit-user-${sequence}`;
  branchId = `branch-commit-device-${sequence}`;
  orgId = createOrg('Synthetic commit test', `branch-commit-${sequence}`, userId).id;
  addMember(orgId, userId, 'member');
  registerOrganizationDevice({ orgId, userId, branchId });
  await realFlush();
  persistence.flush.mockReset().mockImplementation(realFlush);
});
afterEach(async () => {
  await runSQL('PRAGMA query_only = OFF');
  await realFlush();
});

describe('organization branch commit isolation', () => {
  it('hides pending receipts, waits for duplicate requests, and preserves immutable batch identity', async () => {
    const gate = deferred();
    persistence.flush.mockImplementationOnce(async () => { await gate.promise; await realFlush(); });
    const batch = input('pending-success');
    const first = persistBranchSyncBatch(batch);
    await untilFlush();
    let duplicateSettled = false;
    const duplicate = persistBranchSyncBatch(batch).then(value => { duplicateSettled = true; return value; });
    await Promise.resolve();
    expect(duplicateSettled).toBe(false);
    expect(getBranchSyncReceipt(batch.payload)).toBeNull();
    await expect(persistBranchSyncBatch(input('pending-success', 'changed body'))).rejects.toMatchObject({ statusCode: 409 });
    gate.resolve();
    const [original, replay] = await Promise.all([first, duplicate]);
    expect(replay).toMatchObject({ receiptId: original.receiptId, verified: true, replayed: true });
    expect(getBranchSyncReceipt(batch.payload)).toMatchObject({ receiptId: original.receiptId });
    expect(persistence.flush).toHaveBeenCalledTimes(1);
    const persisted = await querySQL<{ value: string }>('SELECT value FROM settings WHERE key = ?', ['org.branch.sync.ledger.v1']);
    expect(JSON.parse(persisted[0].value).batches[`${orgId}:${branchId}:pending-success`].receiptId).toBe(original.receiptId);
  });

  it('returns the same failure to duplicates and never publishes a failed receipt', async () => {
    const gate = deferred();
    persistence.flush.mockImplementationOnce(() => gate.promise);
    const batch = input('pending-failure');
    const first = persistBranchSyncBatch(batch);
    await untilFlush();
    const duplicate = persistBranchSyncBatch(batch);
    const result = Promise.allSettled([first, duplicate]);
    let drained = false;
    const drain = waitForBranchSyncCommits().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.reject(new Error('synthetic disk failure'));
    expect((await result).map(item => item.status)).toEqual(['rejected', 'rejected']);
    await drain;
    expect(getBranchSyncReceipt(batch.payload)).toBeNull();
    expect(readDB().memories.some((row: any) => row.orgId === orgId)).toBe(false);
    const retry = await persistBranchSyncBatch(batch);
    expect(retry).toMatchObject({ verified: true, replayed: false, inserted: 1 });
  });

  it('preserves independent other-user memory, settings and audit writes when a batch fails', async () => {
    const gate = deferred();
    persistence.flush.mockImplementationOnce(() => gate.promise);
    const pending = persistBranchSyncBatch(input('independent-failure'));
    await untilFlush();
    const data = readDB();
    const otherMemory = { ...input('other-owner').payload.memories[0], userId: 'other-user', orgId: '', domain: 'personal', type: 'episodic', confidence: 0.8, sourceInteractionId: '' };
    data.memories.push(otherMemory);
    data.settings.push({ key: 'branch-commit-independent', value: 'keep' });
    // Ordinary writers may copy the table while retaining the ledger value.
    data.settings = data.settings.map((setting: any) => ({ ...setting }));
    const otherAudit = { id: 'independent-audit', orgId, userId: 'other-user', action: 'synthetic', resourceType: '', resourceId: '', details: '{}', timestamp: new Date().toISOString() };
    data.auditLog.push(otherAudit);
    writeDB(data);
    const result = Promise.allSettled([pending]);
    gate.reject(new Error('synthetic disk failure'));
    expect((await result)[0].status).toBe('rejected');
    expect(readDB().memories).toContain(otherMemory);
    expect(readDB().settings).toContainEqual({ key: 'branch-commit-independent', value: 'keep' });
    expect(readDB().auditLog).toContain(otherAudit);
    expect(getBranchSyncReceipt(input('independent-failure').payload)).toBeNull();
    expect(readDB().memories.some((row: any) => row.orgId === orgId && row.userId === userId)).toBe(false);
    await realFlush();
    expect(await querySQL('SELECT value FROM settings WHERE key = ?', ['branch-commit-independent'])).toEqual([{ value: 'keep' }]);
  });

  it('restores its own replaced row on failure but preserves a newer in-place edit', async () => {
    const originalInput = input('same-record', 'previous committed content');
    const original = await persistBranchSyncBatch(originalInput);
    const targetId = original.items[0].targetId;
    const update = { ...input('update-own', 'failed update'), payload: { ...input('update-own', 'failed update').payload,
      memories: [{ ...originalInput.payload.memories[0], content: 'failed update' }] } };
    persistence.flush.mockRejectedValueOnce(new Error('synthetic disk failure'));
    await expect(persistBranchSyncBatch(update)).rejects.toThrow('synthetic disk failure');
    expect(readDB().memories.find((row: any) => row.id === targetId).content).toBe('previous committed content');

    const gate = deferred();
    persistence.flush.mockClear().mockImplementationOnce(() => gate.promise);
    const pending = persistBranchSyncBatch({ ...update, payload: { ...update.payload, batchId: 'newer-edit' } });
    await untilFlush();
    const current = readDB().memories.find((row: any) => row.id === targetId);
    current.content = 'newer user edit must survive';
    writeDB(readDB());
    const result = Promise.allSettled([pending]);
    gate.reject(new Error('synthetic disk failure'));
    await result;
    expect(readDB().memories.find((row: any) => row.id === targetId).content).toBe('newer user edit must survive');
  });

  it('serializes different batches and continues the queue after a failed predecessor', async () => {
    const gate = deferred();
    persistence.flush.mockImplementationOnce(() => gate.promise);
    const first = persistBranchSyncBatch(input('serialized-failed'));
    await untilFlush();
    const second = persistBranchSyncBatch(input('serialized-success'));
    await Promise.resolve();
    expect(persistence.flush).toHaveBeenCalledTimes(1);
    const result = Promise.allSettled([first, second]);
    gate.reject(new Error('synthetic disk failure'));
    expect((await result).map(item => item.status)).toEqual(['rejected', 'fulfilled']);
    expect(getBranchSyncReceipt(input('serialized-failed').payload)).toBeNull();
    expect(getBranchSyncReceipt(input('serialized-success').payload)).toMatchObject({ verified: true });
  });

  it('compensates a real SQLite write rejection without leaving a success receipt', async () => {
    await runSQL('PRAGMA query_only = ON');
    const batch = input('real-readonly');
    await expect(persistBranchSyncBatch(batch)).rejects.toThrow(/readonly|read-only/i);
    expect(getBranchSyncReceipt(batch.payload)).toBeNull();
    expect(readDB().memories.some((row: any) => row.orgId === orgId)).toBe(false);
    await runSQL('PRAGMA query_only = OFF');
    expect(await persistBranchSyncBatch(batch)).toMatchObject({ verified: true, inserted: 1 });
  });
});
