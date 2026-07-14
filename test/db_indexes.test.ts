import './helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sqlite3 from 'sqlite3';
import { flushDB, initDatabase, readDB, writeDB } from '../db_layer';
import { getDataPath } from '../server/config/data_path';

function readIndexNames(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(getDataPath('lumi.db'));
    database.all(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name`,
      (error, rows: Array<{ name: string }>) => {
        database.close();
        if (error) reject(error);
        else resolve(rows.map(row => row.name));
      },
    );
  });
}

function readInteractionColumns(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(getDataPath('lumi.db'));
    database.all(
      'PRAGMA table_info(interactions)',
      (error, rows: Array<{ name: string }>) => {
        database.close();
        if (error) reject(error);
        else resolve(rows.map(row => row.name));
      },
    );
  });
}

describe('SQLite persistence indexes', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  afterAll(async () => {
    await flushDB();
  });

  it('recreates performance indexes after an atomic full snapshot write', async () => {
    const db = readDB();
    if (!db.settings) db.settings = [];
    db.settings.push({ key: `index-test-${Date.now()}`, value: '1' });
    writeDB(db);
    await flushDB();

    const indexes = await readIndexNames();
    expect(indexes).toEqual(expect.arrayContaining([
      'idx_interactions_user_conv',
      'idx_memories_user_type_tier',
      'idx_org_memberships_user_status',
      'idx_org_kb_articles_org_category',
    ]));
  });

  it('persists external message correlation fields across atomic snapshot writes', async () => {
    const columns = await readInteractionColumns();
    expect(columns).toEqual(expect.arrayContaining([
      'externalMessageId',
      'routeSequence',
      'receivedAt',
    ]));
  });
});
