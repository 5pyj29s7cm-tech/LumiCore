import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ db: { memories: [] as any[] }, writes: 0 }));
vi.mock('../db_layer', async (...databaseMockArgs: any[]) => { const mocked = await ((() => ({ readDB: () => state.db, writeDB: (db: any) => { state.db = db; state.writes++; } })) as any)(...databaseMockArgs); const { withTableDatabaseMock } = await import("./helpers/table_database_mock"); return withTableDatabaseMock(mocked); });
import { organizePersonalMemories, organizeMemories } from '../server/memory/auto_organize';
beforeEach(() => {
  state.writes = 0;
  state.db = { memories: ['a', 'b', 'c'].map(id => ({ id, userId: 'owner', content: `Owner preference ${id}`, nodeType: 'leaf', updatedAt: 'before' })) };
});
describe('bounded cancellable memory organization', () => {
  it('keeps ordinary agent memories under parents from the same lane', async () => {
    state.db.memories.find(row => row.id === 'b').agentId = 'ordinary-agent';
    const result = await organizePersonalMemories('owner', async () => JSON.stringify({ branches: [{ title: 'Preferences', memoryIds: ['a', 'b', 'c'] }] }), new AbortController().signal);
    expect(result).toMatchObject({ branches: 2, assigned: 3 });
    for (const memory of state.db.memories.filter(row => row.nodeType !== 'branch')) {
      const parent = state.db.memories.find(row => row.id === memory.parentId);
      expect(parent).toBeDefined();
      expect(parent.agentId || '').toBe(memory.agentId || '');
    }
  });
  it('never writes a late model result after cancellation', async () => {
    const controller = new AbortController();
    await expect(organizePersonalMemories('owner', async (_prompt, signal) => {
      expect(signal).toBe(controller.signal); controller.abort();
      return JSON.stringify({ branches: [{ title: 'Preferences', memoryIds: ['a', 'b', 'c'] }] });
    }, controller.signal)).rejects.toThrow();
    expect(state.writes).toBe(0);
    expect(state.db.memories.every(memory => !memory.parentId)).toBe(true);
  });
  it('uses only current, unchanged orphan memories belonging to the owner', async () => {
    state.db.memories.push({ id: 'foreign', userId: 'someone-else', content: 'private', nodeType: 'leaf' });
    await organizePersonalMemories('owner', async () => {
      state.db.memories.find(memory => memory.id === 'b').parentId = 'manually-arranged';
      state.db.memories.find(memory => memory.id === 'c').content = 'edited during planning';
      return JSON.stringify({ branches: [{ title: 'Preferences', memoryIds: ['a', 'a', 'b', 'c', 'foreign', 'missing'] }] });
    }, new AbortController().signal);
    expect(state.db.memories.find(memory => memory.id === 'a').parentId).toBeTruthy();
    expect(state.db.memories.find(memory => memory.id === 'b').parentId).toBe('manually-arranged');
    expect(state.db.memories.find(memory => memory.id === 'c').parentId).toBeUndefined();
    expect(state.db.memories.find(memory => memory.id === 'foreign').parentId).toBeUndefined();
  });
  it('organizes only the current work scope and keeps personal, other-company and frozen rows untouched', async () => {
    state.db.memories.push(...['w1', 'w2', 'w3'].map(id => ({ id, userId: 'owner', domain: 'work', orgId: 'company', content: id, updatedAt: 'before' })));
    state.db.memories.push({ id: 'avatar', userId: 'owner', domain: 'work', orgId: 'company', agentId: 'memory_avatar_frozen', content: 'frozen' });
    state.db.memories.push({ id: 'other-company', userId: 'owner', domain: 'work', orgId: 'other', content: 'private' });
    const result = await organizeMemories({ userId: 'owner', domain: 'work', orgId: 'company' }, async () =>
      JSON.stringify({ branches: [{ title: 'Work', memoryIds: ['w1', 'w1', 'w2', 'w3', 'a', 'avatar', 'other-company'] }] }), new AbortController().signal);
    expect(result).toMatchObject({ branches: 1, assigned: 3 });
    expect(state.db.memories.filter(row => row.parentId).map(row => row.id)).toEqual(['w1', 'w2', 'w3']);
  });
});
