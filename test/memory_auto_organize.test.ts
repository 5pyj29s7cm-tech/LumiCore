import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ db: { memories: [] as any[] }, writes: 0 }));
vi.mock('../db_layer', () => ({ readDB: () => state.db, writeDB: (db: any) => { state.db = db; state.writes++; } }));
vi.mock('../server/memory/store', () => ({ isMemoryAvatarScoped: (memory: any) => Boolean(memory.agentId?.startsWith('memory-avatar:')) }));
import { organizePersonalMemories } from '../server/memory/auto_organize';
beforeEach(() => {
  state.writes = 0;
  state.db = { memories: ['a', 'b', 'c'].map(id => ({ id, userId: 'owner', content: `Owner preference ${id}`, nodeType: 'leaf', updatedAt: 'before' })) };
});
describe('bounded cancellable memory organization', () => {
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
});
