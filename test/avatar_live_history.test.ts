import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, querySQL, flushDBOrThrow, readDB, writeDB } from '../db_layer';
import { acknowledgeLivePlayback, listLiveHistory, saveLiveTurn } from '../server/memory_avatar/live_history';

describe('durable public live history', () => {
  beforeAll(async () => { await initDatabase(); });
  it('keeps generated and spoken receipts distinct across database snapshot writes', async () => {
    const turn = { requestId: 'live-history-one', nickname: 'Viewer', comment: 'Hello', reply: 'Hello there.', createdAt: new Date().toISOString() };
    await saveLiveTurn('owner', 'avatar', turn);
    expect(await listLiveHistory('owner', 'avatar')).toEqual([{ ...turn, spokenAt: null }]);
    const db = readDB(); db.settings.push({ key: 'live-history-snapshot', value: '1' }); writeDB(db); await flushDBOrThrow();
    expect(await acknowledgeLivePlayback('other', 'avatar', turn.requestId)).toBe(false);
    expect(await acknowledgeLivePlayback('owner', 'avatar', turn.requestId)).toBe(true);
    const first = (await listLiveHistory('owner', 'avatar'))[0];
    expect(first.spokenAt).toBeTruthy();
    await saveLiveTurn('owner', 'avatar', { ...turn, reply: 'Must not overwrite' });
    await acknowledgeLivePlayback('owner', 'avatar', turn.requestId);
    const rows = await querySQL<any>('SELECT * FROM avatar_live_turns WHERE userId=?', ['owner']);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject(first);
    expect(await listLiveHistory('other', 'avatar')).toEqual([]);
  });
});
