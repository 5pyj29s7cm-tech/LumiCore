import { expect, it } from 'vitest';
import fs from 'node:fs';
import { makeApp } from './helpers';
import { flushDBOrThrow, readDB, writeDB } from '../db_layer';

it('retains the open database until suite teardown even after its HTTP app stops', async () => {
  const app = await makeApp();
  app.cleanup();
  expect(fs.existsSync(String(process.env.LUMI_DATA_DIR))).toBe(true);
  const db = readDB();
  db.users.push({ uid: 'fixture-lifecycle', username: 'fixture', password: 'isolated',
    role: 'admin', balance: 0, createdAt: new Date().toISOString() } as any);
  writeDB(db);
  await expect(flushDBOrThrow()).resolves.toBeUndefined();
});
