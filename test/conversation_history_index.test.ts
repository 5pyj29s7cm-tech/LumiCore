import { afterEach, describe, expect, it, vi } from 'vitest';
import * as database from '../db_layer';
import { listConversationReceiptHistory, listConversationPreviewMessages } from '../server/conversation/history_repository';
afterEach(() => vi.restoreAllMocks());
const origin = Date.parse('2026-10-04T00:00:00Z');
const row = (id: string, role: string, message: string, offset: number, extra = {}) => ({ id, userId: 'owner', conversationId: 'scope', role, message, timestamp: new Date(origin + offset).toISOString(), ...extra });

describe('indexed legacy conversation history', () => {
  it('loads a full history page from one snapshot while retaining per-conversation limits and detachment', () => {
    const rows: any[] = Array.from({ length: 40 }, (_, n) => ['a', 'b', 'foreign'].map(conversationId => row(conversationId + n, 'user', conversationId, n * 3000, { conversationId, nested: { value: n } }))).flat();
    const read = vi.spyOn(database, 'readDatabaseTables').mockReturnValue({ interactions: rows } as any);
    const page = listConversationPreviewMessages(['a', 'b', 'empty'], 12);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(['interactions']);
    expect([...page.keys()]).toEqual(['a', 'b', 'empty']);
    expect(page.get('a')!.map(row => row.id)).toEqual(Array.from({ length: 12 }, (_, n) => 'a' + (n + 28)));
    expect(page.get('b')).toHaveLength(12);
    expect(page.get('empty')).toEqual([]);
    page.get('a')![0].nested.value = 99;
    expect(rows.find(row => row.id === 'a28')!.nested.value).toBe(28);
    read.mockClear();
    expect(listConversationPreviewMessages([]).size).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });
  it('preserves the strict two-second boundary, user/assistant role rules and foreign conversation isolation', () => {
    const rows = [row('combined', 'user', 'question', 0, { response: 'answer' }), row('outside', 'assistant', 'answer', 2000), row('foreign', 'user', 'question', 1, { conversationId: 'other' })];
    vi.spyOn(database, 'readDatabaseTables').mockReturnValue({ interactions: rows } as any);
    expect(listConversationReceiptHistory('scope').map(item => item.id)).toEqual(['combined', 'outside']);
    rows.push(row('inside', 'assistant', 'answer', 1999));
    expect(listConversationReceiptHistory('scope').map(item => item.id)).toEqual(['inside', 'outside']);
  });
  it('keeps route sequence and insertion ties while removing combined rows at large history sizes', () => {
    const rows = Array.from({ length: 1200 }, (_, n) => [
      row('legacy-' + n, 'user', 'question-' + n, n * 3000, { response: 'answer-' + n }),
      row('user-' + n, 'user', 'question-' + n, n * 3000, { routeSequence: 1 }),
      row('assistant-' + n, 'assistant', 'answer-' + n, n * 3000, { routeSequence: 2 }),
    ]).flat();
    vi.spyOn(database, 'readDatabaseTables').mockReturnValue({ interactions: rows } as any);
    const visible = listConversationReceiptHistory('scope', 4);
    expect(visible.map(item => item.id)).toEqual(['user-1198', 'assistant-1198', 'user-1199', 'assistant-1199']);
    expect(listConversationReceiptHistory('scope', 10_000)).toHaveLength(2400);
  });
  it('retains malformed timestamp rows without using them as duplicate evidence and detaches nested records', () => {
    const rows: any[] = [row('legacy', 'user', 'question', 0, { response: 'answer', toolCalls: [{ arguments: { path: 'original' } }] }),
      { ...row('malformed', 'assistant', 'answer', 0), timestamp: 'invalid' }];
    vi.spyOn(database, 'readDatabaseTables').mockReturnValue({ interactions: rows } as any);
    const visible = listConversationReceiptHistory('scope');
    expect(visible.map(item => item.id)).toEqual(['legacy', 'malformed']);
    visible[0].toolCalls[0].arguments.path = 'mutated';
    expect(rows[0].toolCalls![0].arguments.path).toBe('original');
  });
});
