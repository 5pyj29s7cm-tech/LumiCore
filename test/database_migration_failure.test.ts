import './helpers';
import sqlite3 from 'sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { initDatabase, requireDatabaseStartupQuickCheck } from '../db_layer';

describe('real startup schema migration failure', () => {
  it('rejects an unexpected ALTER failure and can retry after the failure is removed', async () => {
    const original = sqlite3.Database.prototype.run;
    const spy = vi.spyOn(sqlite3.Database.prototype, 'run').mockImplementation(function (this: sqlite3.Database, sql: string, ...args: any[]) {
      if (sql.startsWith('ALTER TABLE users ADD COLUMN phone')) {
        const callback = args.at(-1);
        return original.call(this, 'SELECT 1', () => callback(new Error('SQLITE_BUSY: synthetic migration failure')));
      }
      return original.apply(this, [sql, ...args] as any);
    } as any);
    try {
      await expect(initDatabase()).rejects.toThrow('synthetic migration failure');
      expect(() => requireDatabaseStartupQuickCheck()).toThrow();
    } finally { spy.mockRestore(); }
    await initDatabase();
    expect(requireDatabaseStartupQuickCheck()).toBe('ok');
  });
});
