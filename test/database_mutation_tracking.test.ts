import './helpers';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, commitDatabaseTables, readDatabaseTables, flushDBOrThrow, getDatabasePersistenceStatus, initDatabase, querySQL, readDB, writeDB } from '../db_layer';
import { cloneDatabaseValue } from '../server/db/snapshot_changes';

const stamp = '2026-10-01T00:00:00.000Z';
describe.sequential('tracked database writes', () => {
  beforeEach(async () => {
    await initDatabase();
    const state = readDB();
    state.memories = Array.from({ length: 1100 }, (_, i) => ({ id: 'tracked-' + i, userId: 'owner', type: 'fact', content: 'original', keywords: ['seed'], createdAt: stamp, updatedAt: stamp }));
    state.settings = Array.from({ length: 1100 }, (_, i) => ({ key: 'tracked-' + i, value: 'original' }));
    writeDB(state); await flushDBOrThrow(); await closeDatabase(); await initDatabase();
  });
  afterEach(async () => { vi.restoreAllMocks(); await closeDatabase(); });

  it('persists selected-table edits sparsely without retaining draft aliases', async () => {
    const staged = readDatabaseTables(['memories', 'settings']);
    const row = staged.memories[512]; row.content = 'bounded edit';
    commitDatabaseTables(staged); await flushDBOrThrow();
    expect(getDatabasePersistenceStatus().lastComparedRows).toBe(1);
    expect(getDatabasePersistenceStatus().lastFlushTables).toEqual(['memories']);
    row.content = 'uncommitted caller alias';
    writeDB(readDB()); await flushDBOrThrow();
    expect(getDatabasePersistenceStatus().lastComparedRows).toBe(0);
    expect(getDatabasePersistenceStatus().lastScannedRows).toBe(0);
    expect(await querySQL('SELECT content FROM memories WHERE id=?', [row.id])).toEqual([{ content: 'bounded edit' }]);
    staged.memories.push({ ...row, id: 'bounded-new', content: 'new row' });
    commitDatabaseTables(staged); await flushDBOrThrow();
    expect(getDatabasePersistenceStatus().lastComparedRows).toBe(2);
    await closeDatabase(); await initDatabase();
    expect(readDB().memories.find((item: any) => item.id === 'bounded-new').content).toBe('new row');
  });

  it('retains tracking for adopted raw root aliases after bounded commits', async () => {
    const raw = cloneDatabaseValue(readDB()); writeDB(raw); await flushDBOrThrow();
    const staged = readDatabaseTables(['memories']); staged.memories[512].content = 'bounded edit';
    commitDatabaseTables(staged); await flushDBOrThrow();
    raw.memories[512].content = 'retained raw root alias';
    writeDB(readDB()); await flushDBOrThrow();
    expect(await querySQL('SELECT content FROM memories WHERE id=?', ['tracked-512'])).toEqual([{ content: 'retained raw root alias' }]);
  });

  it('compares no unchanged rows, one edited nested row, and one edited setting', async () => {
    const state = readDB();
    writeDB(state); await flushDBOrThrow();
    expect(getDatabasePersistenceStatus().lastComparedRows).toBe(0);
    const row = state.memories[512];
    row.keywords.push('nested'); delete row.content;
    // Repair before saving: a deleted optional field must still be tracked.
    row.content = 'updated';
    writeDB(state); await flushDBOrThrow();
    expect(getDatabasePersistenceStatus().lastComparedRows).toBe(1);
    expect(await querySQL('SELECT content,keywords FROM memories WHERE id=?', [row.id])).toEqual([{ content: 'updated', keywords: '["seed","nested"]' }]);
    state.settings[512].value = 'setting update'; writeDB(state); await flushDBOrThrow();
    expect(getDatabasePersistenceStatus().lastComparedRows).toBe(1);
    await closeDatabase(); await initDatabase();
    expect(readDB().settings.find((item: any) => item.key === 'tracked-512').value).toBe('setting update');
  });

  it('tracks removal, primary-key changes, and replacement by an equivalent object', async () => {
    const state = readDB(), id = state.memories[512].id;
    const replacement = { ...state.memories[512] };
    state.memories[512] = replacement; writeDB(state); await flushDBOrThrow();
    expect(getDatabasePersistenceStatus().lastFlushTables).toEqual([]);
    replacement.content = 'external alias'; replacement.id = 'changed-key';
    state.memories.length = 1090; writeDB(state); await flushDBOrThrow();
    expect(await querySQL('SELECT id FROM memories WHERE id=?', [id])).toEqual([]);
    expect(await querySQL("SELECT content FROM memories WHERE id='changed-key'")).toEqual([{ content: 'external alias' }]);
    expect(await querySQL('SELECT COUNT(*) AS n FROM memories')).toEqual([{ n: 1090 }]);
  });

  it('retains dirty rows on rollback and captures another mutation during the SQL await', async () => {
    const state = readDB(), row = state.memories[512];
    row.content = 'first'; state.settings.push({ key: 'tracked-0', value: 'duplicate' });
    writeDB(state); await expect(flushDBOrThrow()).rejects.toThrow(/UNIQUE|constraint/);
    expect((await querySQL('SELECT content FROM memories WHERE id=?', [row.id]))[0].content).toBe('original');
    state.settings.pop();
    const run = sqlite3.Database.prototype.run; let observed = false;
    vi.spyOn(sqlite3.Database.prototype, 'run').mockImplementation(function(this: sqlite3.Database, ...args: any[]) {
      if (String(args[0]).startsWith('BEGIN') && !observed) { observed = true; row.keywords.push('during await'); writeDB(state); }
      return (run as any).apply(this, args);
    });
    writeDB(state); await flushDBOrThrow();
    expect((await querySQL('SELECT keywords FROM memories WHERE id=?', [row.id]))[0].keywords).toBe('["seed"]');
    await flushDBOrThrow();
    expect(getDatabasePersistenceStatus().lastComparedRows).toBe(1);
    expect((await querySQL('SELECT keywords FROM memories WHERE id=?', [row.id]))[0].keywords).toBe('["seed","during await"]');
  });

  it('detects retained raw arrays and nested raw aliases without rechecking unrelated loaded rows', async () => {
    const state = readDB(), alias = ['external'], id = state.memories[512].id;
    state.memories[512].keywords = alias;
    writeDB(state); await flushDBOrThrow(); alias.push('later');
    writeDB(state); await flushDBOrThrow();
    expect(getDatabasePersistenceStatus().lastComparedRows).toBe(1);
    const settings = [...state.settings]; state.settings = settings;
    writeDB(state); await flushDBOrThrow();
    settings.push({ key: 'retained-array', value: 'durable' });
    writeDB(state); await flushDBOrThrow();
    expect(await querySQL("SELECT value FROM settings WHERE key='retained-array'")).toEqual([{ value: 'durable' }]);
    expect((await querySQL('SELECT keywords FROM memories WHERE id=?', [id]))[0].keywords).toBe('["external","later"]');
  });

  it('tracks descriptor edits and virtual system rows without scanning settings', async () => {
    const state = readDB();
    const id = state.memories[512].id, nested = Object.getOwnPropertyDescriptor(state.memories[512], 'keywords')!.value;
    Object.defineProperty(nested, '0', { value: 'descriptor' });
    state.systemFlags = { ready: true }; state.systemSnapshots = [{ id: 'snapshot' }];
    writeDB(state); await flushDBOrThrow();
    expect(getDatabasePersistenceStatus().lastComparedRows).toBe(3);
    delete state.systemFlags.ready; state.systemSnapshots.length = 0;
    writeDB(state); await flushDBOrThrow();
    expect(await querySQL("SELECT key FROM settings WHERE key IN ('__lumi_system_flags','__lumi_system_snapshots')")).toEqual([]);
    expect((await querySQL('SELECT keywords FROM memories WHERE id=?', [id]))[0].keywords).toBe('["descriptor"]');
  });

  it('keeps filtered arrays tracked and isolates stale database roots', async () => {
    const old = readDB(), filtered = old.memories.filter((row: any) => row.id !== 'tracked-0');
    old.memories = filtered; writeDB(old); await flushDBOrThrow();
    const added = { ...filtered[0], id: 'filter-new', content: 'retained filtered array' };
    filtered.push(added); writeDB(old); await flushDBOrThrow();
    expect(getDatabasePersistenceStatus().lastScannedRows).toBe(0);
    expect(getDatabasePersistenceStatus().lastComparedRows).toBe(1);
    const replacement = cloneDatabaseValue(old); replacement.settings = [{ key: 'new-root', value: 'new' }];
    writeDB(replacement); await flushDBOrThrow();
    expect(old.settings.some((item: any) => item.key === 'new-root')).toBe(false);
    old.settings.push({ key: 'stale-root', value: 'old' });
    writeDB(readDB()); await flushDBOrThrow();
    expect(await querySQL("SELECT key FROM settings WHERE key='stale-root'")).toEqual([]);
    writeDB(old); await flushDBOrThrow();
    expect(await querySQL("SELECT key FROM settings WHERE key='stale-root'")).toEqual([{ key: 'stale-root' }]);
  });

  it('clones database views and preserves undefined, cycles, maps and sparse arrays', () => {
    const row = readDB().memories[512], value: any = { row, missing: undefined, list: new Array(3), map: new Map([[row, row]]) };
    value.self = value;
    const copied = cloneDatabaseValue(value);
    expect(copied).not.toBe(value); expect(copied.self).toBe(copied);
    expect(copied.row).toEqual(row); expect(copied.row).not.toBe(row);
    expect([...copied.map.keys()][0]).toBe(copied.row);
    expect('missing' in copied).toBe(true); expect(0 in copied.list).toBe(false);
    expect(() => cloneDatabaseValue({ fn: () => {} })).toThrow();
  });
});
