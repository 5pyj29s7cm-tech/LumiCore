import type sqlite3 from 'sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { createTables } from '../server/db/startup';

// The fake reports the same DDL failure through each sqlite API. Seed writes
// must never begin when canvas creation was rejected by SQLite.
describe('startup schema durability boundary', () => {
  it('rejects a canvas DDL error before publishing or seeding the database', async () => {
    const failure = new Error('SQLITE_IOERR: canvas DDL rejected');
    const query = vi.fn(async () => [{ cnt: 1 }]);
    const seedRun = vi.fn(async () => undefined);
    const db = {
      run(sql: string, callback?: (error: Error | null) => void) {
        queueMicrotask(() => callback?.(sql.includes('canvas_sessions') ? failure : null));
        return this;
      },
      exec(sql: string, callback: (error: Error | null) => void) {
        queueMicrotask(() => callback(sql.includes('canvas_sessions') ? failure : null));
        return this;
      },
    } as unknown as sqlite3.Database;
    await expect(createTables(db, { query: query as any, run: seedRun })).rejects.toThrow('canvas DDL rejected');
    expect(query).not.toHaveBeenCalled();
    expect(seedRun).not.toHaveBeenCalled();
  });
});
