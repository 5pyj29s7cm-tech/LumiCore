import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  db: { memories: [] as any[], memoryAssociations: [] as any[], reminders: [] as any[] },
  allowed: undefined as string[] | undefined, selections: [] as string[][], writes: 0,
}));
vi.mock('../db_layer', async () => {
  const { withTableDatabaseMock } = await import('./helpers/table_database_mock');
  const database = withTableDatabaseMock({
    readDB: () => state.db,
    writeDB: (db: typeof state.db) => { state.db = db; state.writes++; },
  });
  return { ...database, readDatabaseTables: (keys: string[]) => {
    state.selections.push([...keys]);
    if (state.allowed && keys.some(key => !state.allowed!.includes(key))) throw new Error('Unrelated table is unavailable');
    return database.readDatabaseTables(keys);
  } };
});
import {
  decayMemoryAssociations, initMemoryAssociations, getAssociatedMemories,
  markConsolidated, resolveMemoryConflict, queryMemories, upsertPendingReminder,
} from '../server/memory/store';
import { listMemoryRows, updateMemoryRow, listReminderRows, updateReminderRow } from '../server/memory/repository';
const scope = { userId: 'owner', domain: 'personal' as const, orgId: '' };
const memory = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, userId: 'owner', type: 'fact', content: 'synthetic source ' + id, keywords: [id], confidence: .8,
  sourceInteractionId: 'synthetic-owner-fixture', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  lastRetrievedAt: null, retrieveCount: 0, tier: 'episodic', perspective: 'owner_trait', importance: .4,
  parentId: null, agentId: '', nodeType: 'leaf', domain: 'personal', orgId: '', ...overrides,
});
const edge = (strength = .4) => ({ userId: 'owner', memA: 'a', memB: 'b', strength });
beforeEach(() => {
  state.allowed = undefined; state.selections = []; state.writes = 0;
  state.db = { memories: [memory('a'), memory('b')], memoryAssociations: [], reminders: [] };
  initMemoryAssociations();
  state.selections = [];
});
describe('memory ownership and association persistence', () => {
  it('persists strength decay even when neither association node is deleted', () => {
    state.db.memoryAssociations = [edge()]; initMemoryAssociations();
    expect(decayMemoryAssociations('owner')).toBe(0);
    expect(state.db.memoryAssociations).toEqual([edge(.38)]);
    expect(state.writes).toBe(1);
  });
  it('removes a persisted edge as soon as its strength falls below the recall threshold', () => {
    state.db.memoryAssociations = [edge(.26)]; initMemoryAssociations();
    expect(decayMemoryAssociations('owner')).toBe(0);
    expect(state.db.memoryAssociations).toEqual([]);
    initMemoryAssociations();
    expect(getAssociatedMemories('a', 'owner', .1)).toEqual([]);
  });
  it('replaces the association graph when the persisted rows are reloaded', () => {
    state.db.memoryAssociations = [edge()]; initMemoryAssociations();
    expect(getAssociatedMemories('a', 'owner').map(row => row.id)).toEqual(['b']);
    state.db.memoryAssociations = []; initMemoryAssociations();
    expect(getAssociatedMemories('a', 'owner')).toEqual([]);
  });
  it('does not disclose another user through a stale association identifier', () => {
    state.db.memories[1].userId = 'other-owner';
    state.db.memoryAssociations = [edge()]; initMemoryAssociations();
    expect(getAssociatedMemories('a', 'owner')).toEqual([]);
  });
  it('does not resolve a conflict by selecting foreign evidence recorded in an old relation', () => {
    state.db.memories.push(memory('foreign', { userId: 'other-owner' }));
    state.db.memories[0].conflict = { status: 'unresolved', relatedMemoryIds: ['b', 'foreign'], detectedAt: 'synthetic' };
    const before = structuredClone(state.db);
    expect(() => resolveMemoryConflict({ ...scope, memoryId: 'a', resolution: 'prefer_one', chosenMemoryId: 'foreign' })).toThrow('outside');
    expect(state.db).toEqual(before); expect(state.writes).toBe(0);
  });
  it('consolidates only children in the exact owner, organization and avatar lane of the parent', () => {
    const parent = memory('parent', { nodeType: 'branch', agentId: 'lumi-agent' });
    state.db.memories = [parent, memory('same', { agentId: 'lumi-agent' }),
      memory('foreign', { userId: 'other-owner', agentId: 'lumi-agent' }),
      memory('work', { domain: 'work', orgId: 'company', agentId: 'lumi-agent' }),
      memory('other-lane', { agentId: 'other-agent' })];
    markConsolidated(['same', 'foreign', 'work', 'other-lane'], parent.id);
    expect(state.db.memories.filter(row => row.parentId).map(row => row.id)).toEqual(['same']);
    expect(state.db.memories.find(row => row.id === 'same')?.importance).toBeCloseTo(.6);
    expect(state.db.memories.find(row => row.id === 'foreign')?.importance).toBe(.4);
  });
  it('refuses a missing consolidation parent without changing any child', () => {
    const before = structuredClone(state.db);
    expect(() => markConsolidated(['a'], 'missing')).toThrow(RangeError);
    expect(state.db).toEqual(before); expect(state.writes).toBe(0);
  });
  it('refuses a consolidation cycle atomically rather than saving a broken tree', () => {
    state.db.memories.push(memory('parent', { parentId: 'a', nodeType: 'branch' }));
    const before = structuredClone(state.db);
    expect(() => markConsolidated(['b', 'a'], 'parent')).toThrow(RangeError);
    expect(state.db).toEqual(before); expect(state.writes).toBe(0);
  });
  it('recall and owned memory edits do not depend on reminder or association snapshots', () => {
    state.allowed = ['memories'];
    expect(queryMemories({ userId: 'owner', recordRetrieval: false }).map(row => row.id)).toHaveLength(2);
    expect(listMemoryRows(scope)).toHaveLength(2);
    expect(updateMemoryRow(scope, 'a', draft => { draft.content = 'changed'; })?.content).toBe('changed');
    expect(state.selections.every(keys => keys.length === 1 && keys[0] === 'memories')).toBe(true);
  });
  it('reminder creation and edits do not depend on memory or association snapshots', () => {
    state.allowed = ['reminders'];
    const input = { userId: 'owner', content: 'synthetic reminder', dueAt: null, sourceInteractionId: 'synthetic-reminder' };
    const first = upsertPendingReminder(input);
    expect(first.created).toBe(true);
    expect(upsertPendingReminder({ ...input, content: 'updated' }).created).toBe(false);
    expect(listReminderRows(scope)).toHaveLength(1);
    expect(updateReminderRow(scope, first.reminder.id, row => { row.content = 'owned edit'; })?.content).toBe('owned edit');
    expect(state.selections.every(keys => keys.length === 1 && keys[0] === 'reminders')).toBe(true);
    expect(state.db.reminders).toHaveLength(1);
  });
});
