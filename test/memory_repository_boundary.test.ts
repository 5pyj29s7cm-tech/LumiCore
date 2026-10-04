import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ db: { memories: [] as any[], reminders: [] as any[] }, refuse: false, writes: 0 }));
vi.mock('../db_layer', () => ({ readDB: () => state.db, writeDB: (db: any) => {
  if (state.refuse) throw new Error('storage refused'); state.db = db; state.writes++;
} }));
import { getMemoryRow, listMemoryRows, listReminderRows, updateMemoryRow, updateReminderRow, removeReminderRow } from '../server/memory/repository';
import { moveNode, ensureBranch } from '../server/memory/tree';
const owner = { userId: 'owner', domain: 'personal' as const, orgId: '' };
beforeEach(() => {
  state.refuse = false; state.writes = 0;
  state.db = { memories: [
    { id: 'a', userId: 'owner', content: 'old', keywords: ['old'], parentId: null },
    { id: 'b', userId: 'owner', content: 'child', parentId: 'a' },
    { id: 'foreign', userId: 'other', content: 'private', parentId: null },
    { id: 'work', userId: 'owner', domain: 'work', orgId: 'company', parentId: null },
    { id: 'avatar', userId: 'owner', agentId: 'memory_avatar_frozen', content: 'topic', nodeType: 'branch', parentId: null },
  ], reminders: [{ id: 'r', userId: 'owner', content: 'reminder' }, { id: 'private-r', userId: 'other' }] };
});
describe('owned memory and reminder storage boundary', () => {
  it('returns detached owned values and leaves live rows unchanged when a write is refused', () => {
    const before = state.db, row = before.memories[0];
    const copy = getMemoryRow(owner, 'a')!; copy.keywords.push('copy');
    expect(row.keywords).toEqual(['old']);
    state.refuse = true;
    expect(() => updateMemoryRow(owner, 'a', draft => { draft.content = 'rejected'; draft.keywords.push('rejected'); })).toThrow('storage refused');
    expect(() => updateReminderRow(owner, 'r', draft => { draft.content = 'rejected'; })).toThrow('storage refused');
    expect(state.db).toBe(before); expect(row.content).toBe('old'); expect(row.keywords).toEqual(['old']);
    expect(state.db.reminders[0].content).toBe('reminder'); expect(state.writes).toBe(0);
  });
  it('blocks foreign domains, owners, frozen avatars, and ownership changes', () => {
    expect(listMemoryRows(owner).map(row => row.id)).toEqual(['a', 'b']);
    expect(listReminderRows(owner).map(row => row.id)).toEqual(['r']);
    for (const id of ['foreign', 'work', 'avatar']) expect(updateMemoryRow(owner, id, draft => { draft.content = 'wrong'; })).toBeUndefined();
    expect(removeReminderRow(owner, 'private-r')).toBe(false);
    expect(() => updateMemoryRow(owner, 'a', draft => { draft.userId = 'other'; })).toThrow('identity');
    expect(state.writes).toBe(0);
  });
  it('uses the same parent, lane and cycle checks for tree moves and ordinary edits', () => {
    for (const parentId of ['foreign', 'work', 'avatar', 'missing', 'a', 'b']) {
      expect(moveNode('a', parentId, owner)).toBe(false);
      expect(() => updateMemoryRow(owner, 'a', draft => { draft.parentId = parentId; })).toThrow(RangeError);
    }
    expect(state.writes).toBe(0); expect(state.db.memories[0].parentId).toBeNull();
    expect(moveNode('b', null, owner)).toBe(true);
    expect(state.db.memories[1].parentId).toBeNull();
  });
  it('keeps callback and returned aliases detached and does not reuse a frozen avatar branch', () => {
    let callbackRow: any;
    const saved = updateMemoryRow(owner, 'a', draft => { callbackRow = draft; draft.content = 'saved'; })!;
    callbackRow.content = 'late callback'; saved.content = 'late result';
    expect(getMemoryRow(owner, 'a')?.content).toBe('saved');
    const branch = ensureBranch('owner', 'topic');
    expect(branch.id).not.toBe('avatar'); expect(branch.agentId).toBe('');
    expect(ensureBranch('owner', 'topic').id).toBe(branch.id);
  });
});
