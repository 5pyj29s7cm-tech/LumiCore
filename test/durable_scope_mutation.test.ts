import './helpers';
import { beforeAll, expect, it, vi } from 'vitest';
import { closeDatabase, flushDBOrThrow, initDatabase, readDB } from '../db_layer';
import { mutationScopeKey, readScopedDeletionReceipt, recordScopedDeletionReceipt, runSerializedMutation } from '../server/persistence/durable_scope_mutation';

beforeAll(initDatabase);
const scope = { userId: 'receipt-owner', domain: 'work' as const, orgId: 'receipt-org' };

it('serializes every caller after failure while allowing unrelated owners to continue', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const order: string[] = [];
  const first = runSerializedMutation('owner-one', async () => { order.push('first'); await gate; throw new Error('failed save'); });
  const failure = first.catch(error => error.message);
  const second = runSerializedMutation('owner-one', async () => { order.push('second'); return 2; });
  expect(await runSerializedMutation('owner-two', () => 3)).toBe(3);
  expect(order).toEqual(['first']); release();
  expect(await failure).toBe('failed save'); expect(await second).toBe(2);
  expect(order).toEqual(['first', 'second']);
  expect(await runSerializedMutation('owner-one', () => 4)).toBe(4);
});

it('persists deletion metadata across reopen without sharing it with another owner, organization or resource type', async () => {
  recordScopedDeletionReceipt(scope, 'memory', 'synthetic-resource', { success: true, count: 1 });
  await flushDBOrThrow(); await closeDatabase(); await initDatabase();
  expect(readScopedDeletionReceipt(scope, 'memory', 'synthetic-resource')).toEqual({ success: true, count: 1 });
  expect(readScopedDeletionReceipt({ ...scope, userId: 'another' }, 'memory', 'synthetic-resource')).toBeNull();
  expect(readScopedDeletionReceipt({ ...scope, orgId: 'another-org' }, 'memory', 'synthetic-resource')).toBeNull();
  expect(readScopedDeletionReceipt(scope, 'conversation', 'synthetic-resource')).toBeNull();
  expect(mutationScopeKey({ ...scope, domain: 'personal', orgId: '' })).not.toBe(mutationScopeKey(scope));
});

it('bounds the receipt bucket to 1000 recent non-content entries and expires retry evidence after 30 days', () => {
  const owner = { userId: 'retention-owner', domain: 'personal' as const, orgId: '' };
  const clock = vi.spyOn(Date, 'now');
  const start = 1_800_000_000_000;
  try {
    for (let index = 0; index < 1002; index++) {
      clock.mockReturnValue(start);
      recordScopedDeletionReceipt(owner, 'memory', `synthetic-${index}`, { success: true });
    }
    expect(readScopedDeletionReceipt(owner, 'memory', 'synthetic-0')).toBeNull();
    expect(readScopedDeletionReceipt(owner, 'memory', 'synthetic-1001')).toEqual({ success: true });
    const buckets = readDB().settings.filter((row: any) => row.key.startsWith('scoped_deletion_receipts_'));
    expect(Math.max(...buckets.map((row: any) => Object.keys(JSON.parse(row.value)).length))).toBe(1000);
    expect(buckets.some((row: any) => row.value.includes('synthetic-1001'))).toBe(false);
    clock.mockReturnValue(start + 31 * 24 * 60 * 60 * 1000);
    expect(readScopedDeletionReceipt(owner, 'memory', 'synthetic-1001')).toBeNull();
  } finally { clock.mockRestore(); }
});
