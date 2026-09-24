import './helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, flushDBOrThrow, initDatabase, querySQL, readDB, runSQL, writeDB } from '../db_layer';

describe.sequential('snapshot batch persistence', () => {
  beforeEach(async () => { await initDatabase(); });
  afterEach(async () => { await closeDatabase(); });

  it('preserves every row and exact Unicode/quoted content across restart', async () => {
    const state = readDB();
    const original = [...state.settings];
    const rows = Array.from({ length: 2500 }, (_, index) => ({ key: `batch-restart-${index}`, value: `第${index}行 'quoted'\n原文` }));
    state.settings.push(...rows);
    writeDB(state);
    await flushDBOrThrow();
    await closeDatabase();
    await initDatabase();
    try {
      expect((await querySQL<{ key: string; value: string }>("SELECT key,value FROM settings WHERE key LIKE 'batch-restart-%' ORDER BY key")))
        .toEqual([...rows].sort((a,b) => a.key.localeCompare(b.key)));
    } finally {
      const restored = readDB(); restored.settings = original; writeDB(restored); await flushDBOrThrow();
    }
  });

  it('rolls back the entire snapshot on a middle-row constraint failure and supports retry', async () => {
    const state = readDB();
    const original = [...state.settings];
    state.settings.push({ key: 'batch-durable-base', value: 'original' });
    writeDB(state); await flushDBOrThrow();
    const durable = [...state.settings];
    const rows = Array.from({ length: 1200 }, (_, index) => ({ key: `batch-retry-${index}`, value: `${index}` }));
    state.settings = [...durable, ...rows.slice(0,600), rows[12], ...rows.slice(600)];
    writeDB(state);
    try {
      await expect(flushDBOrThrow()).rejects.toThrow(/UNIQUE|constraint/i);
      expect(await querySQL("SELECT value FROM settings WHERE key='batch-durable-base'"))
        .toEqual([{ value: 'original' }]);
      expect(await querySQL("SELECT key FROM settings WHERE key LIKE 'batch-retry-%'"))
        .toEqual([]);
      state.settings = [...durable, ...rows]; writeDB(state); await flushDBOrThrow();
      expect(await querySQL("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'batch-retry-%'"))
        .toEqual([{ n: 1200 }]);
    } finally {
      state.settings = original; writeDB(state); await flushDBOrThrow();
    }
  });

  it('changes only the inserted, edited and deleted chat rows and preserves indexes and restart data', async () => {
    const state = readDB();
    const original = [...state.interactions];
    const rows = Array.from({ length: 250 }, (_, index) => ({ id: `delta-chat-${index}`, userId: 'delta-user', message: `原文${index}`, role: 'user', timestamp: new Date().toISOString() }));
    state.interactions.push(...rows); writeDB(state); await flushDBOrThrow();
    await runSQL('CREATE TABLE delta_audit (action TEXT, id TEXT)');
    for (const [action, ref] of [['INSERT','NEW'], ['UPDATE','NEW'], ['DELETE','OLD']]) {
      await runSQL(`CREATE TRIGGER delta_${action} AFTER ${action} ON interactions BEGIN INSERT INTO delta_audit VALUES ('${action}', ${ref}.id); END`);
    }
    try {
      state.interactions.find((row: any) => row.id === 'delta-chat-12').message = '已修改的原文';
      state.interactions = state.interactions.filter((row: any) => row.id !== 'delta-chat-13');
      state.interactions.push({ ...rows[0], id: 'delta-chat-new', message: '新消息' });
      writeDB(state); await flushDBOrThrow();
      expect(await querySQL('SELECT action,id FROM delta_audit ORDER BY action')).toEqual([
        { action: 'DELETE', id: 'delta-chat-13' }, { action: 'INSERT', id: 'delta-chat-new' }, { action: 'UPDATE', id: 'delta-chat-12' },
      ]);
      await closeDatabase(); await initDatabase();
      expect(await querySQL("SELECT message FROM interactions WHERE id='delta-chat-12'"))
        .toEqual([{ message: '已修改的原文' }]);
      expect(await querySQL("SELECT id FROM interactions WHERE id='delta-chat-13'"))
        .toEqual([]);
      expect((await querySQL("PRAGMA index_list('interactions')")).length).toBeGreaterThan(1);
    } finally {
      for (const action of ['INSERT','UPDATE','DELETE']) await runSQL(`DROP TRIGGER IF EXISTS delta_${action}`);
      await runSQL('DROP TABLE IF EXISTS delta_audit');
      const restored = readDB(); restored.interactions = original; writeDB(restored); await flushDBOrThrow();
    }
  });

  it('rolls back partial hot-table updates and does not advance fingerprints before a successful retry', async () => {
    const state = readDB();
    const original = [...state.interactions];
    const base = { id: 'delta-rollback-base', userId: 'delta-user', message: 'old', timestamp: new Date().toISOString() };
    state.interactions.push(base); writeDB(state); await flushDBOrThrow();
    base.message = 'new';
    const invalid = { ...base, id: 'delta-rollback-invalid', timestamp: undefined as string | undefined };
    state.interactions.push(invalid); writeDB(state);
    try {
      await expect(flushDBOrThrow()).rejects.toThrow(/NOT NULL|constraint/i);
      expect(await querySQL("SELECT message FROM interactions WHERE id='delta-rollback-base'"))
        .toEqual([{ message: 'old' }]);
      invalid.timestamp = new Date().toISOString(); writeDB(state); await flushDBOrThrow();
      expect(await querySQL("SELECT message FROM interactions WHERE id='delta-rollback-base'"))
        .toEqual([{ message: 'new' }]);
      expect(await querySQL("SELECT COUNT(*) AS n FROM interactions WHERE id LIKE 'delta-rollback-%'"))
        .toEqual([{ n: 2 }]);
    } finally {
      state.interactions = original; writeDB(state); await flushDBOrThrow();
    }
  });
});
