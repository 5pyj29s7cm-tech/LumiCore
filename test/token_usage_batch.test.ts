import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ db: { tokenUsage: [] as any[] }, reject: false, read: vi.fn(), commit: vi.fn() }));
vi.mock('../db_layer', () => ({
  readDatabaseTables: state.read.mockImplementation(() => structuredClone(state.db)),
  commitDatabaseTables: state.commit.mockImplementation(next => { if (state.reject) throw new Error('refused'); state.db = next; }),
}));
import { recordTokenUsageBatch, recordTokenUsage } from '../server/llm/token_tracker';
const usage = { provider: 'relay', model: 'reasoning', promptTokens: 1, completionTokens: 2, totalTokens: 3 };
beforeEach(() => { state.db = { tokenUsage: [{ userId: 'other', id: 'old' }] }; state.reject = false; vi.clearAllMocks(); });
describe('atomic model-segment token accounting', () => {
  it('preserves every provider call, owner and mode with one table read and one commit', () => {
    expect(recordTokenUsageBatch('owner', [usage, { ...usage, provider: 'local', model: 'fallback', totalTokens: 4 }], 'request', 'voice')).toBe(7);
    expect(state.read).toHaveBeenCalledExactlyOnceWith(['tokenUsage']);
    expect(state.commit).toHaveBeenCalledTimes(1);
    expect(state.db.tokenUsage).toHaveLength(3);
    expect(state.db.tokenUsage[0]).toEqual({ userId: 'other', id: 'old' });
    expect(state.db.tokenUsage.slice(1)).toMatchObject([
      { ...usage, userId: 'owner', interactionId: 'request', mode: 'voice' },
      { ...usage, provider: 'local', model: 'fallback', totalTokens: 4, userId: 'owner', interactionId: 'request', mode: 'voice' },
    ]);
    expect(new Set(state.db.tokenUsage.slice(1).map(row => row.id)).size).toBe(2);
  });
  it('does not open a table or write a row for empty and zero-token batches', () => {
    expect(recordTokenUsageBatch('owner', [], 'request')).toBe(0);
    expect(recordTokenUsageBatch('owner', [{ ...usage, promptTokens: 0, completionTokens: 0, totalTokens: 0 }], 'request')).toBe(0);
    recordTokenUsage('owner', 'relay', 'model', undefined, 'request');
    expect(state.read).not.toHaveBeenCalled(); expect(state.commit).not.toHaveBeenCalled();
  });
  it('leaves the complete batch absent when its persistence is refused', () => {
    const before = structuredClone(state.db); state.reject = true;
    expect(() => recordTokenUsageBatch('owner', [usage, usage], 'request')).toThrow('refused');
    expect(state.db).toEqual(before); expect(state.commit).toHaveBeenCalledTimes(1);
  });
  it('retains legacy per-call interaction IDs and single-record mode behavior', () => {
    const id = vi.fn().mockReturnValueOnce('first').mockReturnValueOnce('second');
    recordTokenUsageBatch('owner', [usage, usage], id, 'voice');
    expect(state.db.tokenUsage.slice(1).map(row => row.interactionId)).toEqual(['first', 'second']);
    recordTokenUsage('anonymous', 'relay', 'model', usage, 'single');
    expect(state.db.tokenUsage.at(-1)).toMatchObject({ userId: 'anonymous', provider: 'relay', model: 'model', interactionId: 'single', mode: 'chat' });
  });
});
