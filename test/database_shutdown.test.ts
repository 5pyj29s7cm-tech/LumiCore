import './helpers';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeDatabase, flushDB, getDatabasePersistenceStatus, initDatabase,
  querySQL, readDB, runSQL, withDatabaseSqlWriteLock, writeDB,
} from '../db_layer';

function setting(key: string, value: string) {
  const db = readDB();
  db.settings.push({ key, value });
  writeDB(db);
}

describe.sequential('database shutdown durability', () => {
  beforeEach(async () => { await initDatabase(); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await runSQL('PRAGMA query_only = OFF');
    await closeDatabase();
  });

  it('propagates write rejection, retains the pending snapshot and saves it on retry', async () => {
    await flushDB();
    await runSQL('PRAGMA query_only = ON');
    setting('shutdown-readonly', 'retained-value');
    await expect(flushDB()).rejects.toThrow(/readonly/i);
    await expect(closeDatabase()).rejects.toThrow(/readonly/i);
    expect(readDB().settings).toContainEqual({ key: 'shutdown-readonly', value: 'retained-value' });
    expect(getDatabasePersistenceStatus()).toMatchObject({ pending: true, degraded: true });
    await runSQL('PRAGMA query_only = OFF');
    await closeDatabase();
    await initDatabase();
    expect(await querySQL('SELECT value FROM settings WHERE key = ?', ['shutdown-readonly']))
      .toEqual([{ value: 'retained-value' }]);
  });

  it('shares concurrent closes and waits for admitted writes before sealing the SQLite handle', async () => {
    await runSQL('CREATE TABLE IF NOT EXISTS shutdown_probe (value TEXT)');
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const admitted = withDatabaseSqlWriteLock(async session => {
      entered();
      await gate;
      await session.run('INSERT INTO shutdown_probe(value) VALUES (?)', ['saved-before-close']);
    });
    await started;
    setting('shutdown-latest', 'final-snapshot');
    const first = closeDatabase();
    const second = closeDatabase();
    expect(first).toBe(second);
    expect(() => writeDB(readDB())).toThrow(/closing/);
    await expect(runSQL('INSERT INTO shutdown_probe(value) VALUES (?)', ['too-late'])).rejects.toThrow(/closing/);
    release();
    await admitted;
    await first;
    await initDatabase();
    expect(await querySQL('SELECT value FROM shutdown_probe')).toEqual([{ value: 'saved-before-close' }]);
    expect(await querySQL('SELECT value FROM settings WHERE key = ?', ['shutdown-latest']))
      .toEqual([{ value: 'final-snapshot' }]);
  });

  it('retains the handle and memory when SQLite close itself fails', async () => {
    setting('shutdown-close-failure', 'still-live');
    vi.spyOn(sqlite3.Database.prototype, 'close').mockImplementationOnce(function (this: sqlite3.Database, callback?: (error: Error | null) => void) {
      queueMicrotask(() => callback?.(new Error('SQLITE_BUSY: statement still active')));
      return this;
    });
    await expect(closeDatabase()).rejects.toThrow(/SQLITE_BUSY/);
    expect(readDB().settings).toContainEqual({ key: 'shutdown-close-failure', value: 'still-live' });
    expect(getDatabasePersistenceStatus().pending).toBe(true);
    await closeDatabase();
    await initDatabase();
    expect(await querySQL('SELECT value FROM settings WHERE key = ?', ['shutdown-close-failure']))
      .toEqual([{ value: 'still-live' }]);
  });
});
