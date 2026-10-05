import './helpers';
import { randomUUID } from 'node:crypto';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, commitDatabaseTables, flushDBOrThrow, initDatabase, querySQL, readDatabaseTables, runSQL, withDatabaseSqlWriteLock } from '../db_layer';
import { DOCUMENT_COLLECTION_DEFAULTS, documentCollectionKey, type DatabaseTableName } from '../server/db/table_catalog';

describe.sequential('selected-table SQLite persistence', () => {
  beforeEach(async () => { await initDatabase(); });
  afterEach(async () => { await initDatabase(); await runSQL('PRAGMA query_only = OFF'); await closeDatabase(); });

  it('persists every former transient collection through a real close and reopen', async () => {
    const keys = Object.keys(DOCUMENT_COLLECTION_DEFAULTS) as DatabaseTableName[];
    const session = readDatabaseTables(keys);
    const marker = randomUUID();
    for (const name of keys) session[name] = Array.isArray(DOCUMENT_COLLECTION_DEFAULTS[name]) ? [{ id: marker, userId: 'synthetic-owner' }] : { marker };
    commitDatabaseTables(session); await closeDatabase(); await initDatabase();
    const reopened = readDatabaseTables(keys);
    for (const name of keys) {
      expect(reopened[name]).toEqual(session[name]);
      const rows = await querySQL<{value:string}>('SELECT value FROM settings WHERE key = ?', [documentCollectionKey(name)]);
      expect(JSON.parse(rows[0].value)).toEqual(session[name]);
    }
    const reset = readDatabaseTables(keys);
    for (const name of keys) reset[name] = structuredClone(DOCUMENT_COLLECTION_DEFAULTS[name]);
    commitDatabaseTables(reset); await flushDBOrThrow();
    for (const name of keys) expect(await querySQL('SELECT value FROM settings WHERE key = ?', [documentCollectionKey(name)])).toEqual([]);
  });

  it('keeps unrelated rows, refuses multi-table conflicts atomically, and detaches caller aliases', async () => {
    const key = 'scope-probe-' + randomUUID();
    const first = readDatabaseTables(['settings','contacts']);
    first.settings.push({ key, value: 'stale' }); first.contacts.push({ id: key, userId: 'synthetic-owner' });
    const second = readDatabaseTables(['settings']); second.settings.push({ key, value: 'current' }); commitDatabaseTables(second);
    expect(() => commitDatabaseTables(first)).toThrow('conflicts');
    expect(readDatabaseTables(['contacts']).contacts.some((row: any) => row.id === key)).toBe(false);
    second.settings.find((row: any) => row.key === key).value = 'caller-only';
    await closeDatabase(); await initDatabase();
    expect(await querySQL('SELECT value FROM settings WHERE key = ?', [key])).toEqual([{ value: 'current' }]);
  });

  it('retains a selected-table snapshot after a failed SQLite flush and saves it on retry', async () => {
    const key = 'retry-probe-' + randomUUID(); await flushDBOrThrow(); await runSQL('PRAGMA query_only = ON');
    const session = readDatabaseTables(['settings']); session.settings.push({ key, value: 'pending' }); commitDatabaseTables(session);
    await expect(flushDBOrThrow()).rejects.toThrow(/readonly/i);
    expect(readDatabaseTables(['settings']).settings).toContainEqual({ key, value: 'pending' });
    await runSQL('PRAGMA query_only = OFF'); await closeDatabase(); await initDatabase();
    expect(await querySQL('SELECT value FROM settings WHERE key = ?', [key])).toEqual([{ value: 'pending' }]);
  });

  it('keeps an admitted SQL read ahead of a later replacement transaction', async () => {
    const key = 'read-fence-' + randomUUID();
    await runSQL('INSERT INTO settings(key,value) VALUES (?,?)', [key, 'before']);
    const sql = 'SELECT value FROM settings WHERE key = ? /* read-fence */';
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    const gate = new Promise<void>(done => { release = done; });
    const original = sqlite3.Database.prototype.all;
    const delayed = vi.spyOn(sqlite3.Database.prototype, 'all').mockImplementation(function (this: sqlite3.Database, ...args: any[]) {
      if (args[0] !== sql) return Reflect.apply(original, this, args);
      entered();
      void gate.then(() => Reflect.apply(original, this, args));
      return this;
    });
    let writerEntered = false;
    const observed = querySQL(sql, [key]); await started;
    const replacement = withDatabaseSqlWriteLock(async session => {
      writerEntered = true;
      await session.run('BEGIN IMMEDIATE');
      await session.run('DELETE FROM settings WHERE key = ?', [key]);
      await session.run('INSERT INTO settings(key,value) VALUES (?,?)', [key, 'after']);
      await session.run('COMMIT');
    });
    try {
      await new Promise<void>(done => setImmediate(done));
      expect(writerEntered).toBe(false);
      release();
      expect(await observed).toEqual([{ value: 'before' }]);
      await replacement;
      expect(await querySQL(sql, [key])).toEqual([{ value: 'after' }]);
    } finally {
      release(); await observed; await replacement; delayed.mockRestore();
    }
  });

  it('rejects writes during shutdown without changing the accepted snapshot', async () => {
    const session = readDatabaseTables(['settings']); session.settings.push({ key: 'sealed-' + randomUUID(), value: 'rejected' });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(done => { entered = done; }); const gate = new Promise<void>(done => { release = done; });
    const admitted = withDatabaseSqlWriteLock(async () => { entered(); await gate; }); await started;
    const closing = closeDatabase();
    try { expect(() => commitDatabaseTables(session)).toThrow(/closing/i); }
    finally { release(); await admitted; await closing; }
    await initDatabase(); expect(readDatabaseTables(['settings']).settings.some((row: any) => row.key === session.settings.at(-1).key)).toBe(false);
  });
});
