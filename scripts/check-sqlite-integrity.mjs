import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';

const configuredRoot = String(process.env.LUMI_DATA_DIR || '').trim();
const defaultDatabasePath = path.join(configuredRoot || path.join(os.homedir(), 'LumiCore'), 'data', 'lumi.db');
const databasePath = path.resolve(process.argv[2] || defaultDatabasePath);
if (!existsSync(databasePath)) {
  console.error(`[sqlite-check] database not found: ${databasePath}`);
  process.exit(2);
}

const db = await new Promise((resolve, reject) => {
  const handle = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY, error => {
    if (error) return reject(error);
    // A running Lumi instance writes short transactions frequently. Wait for
    // those writers instead of reporting a healthy live database as broken.
    handle.configure('busyTimeout', 15_000);
    resolve(handle);
  });
});

function all(sql) {
  return new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
}

try {
  const integrity = await all('PRAGMA integrity_check');
  const foreignKeys = await all('PRAGMA foreign_key_check');
  const [pageCountRow] = await all('PRAGMA page_count');
  const [pageSizeRow] = await all('PRAGMA page_size');
  const [freeListRow] = await all('PRAGMA freelist_count');
  const pageCount = Number(pageCountRow?.page_count || 0);
  const pageSize = Number(pageSizeRow?.page_size || 0);
  const freePages = Number(freeListRow?.freelist_count || 0);
  const storage = {
    pageCount,
    pageSize,
    freePages,
    allocatedBytes: pageCount * pageSize,
    reusableBytes: freePages * pageSize,
    reusableRatio: pageCount > 0 ? Number((freePages / pageCount).toFixed(4)) : 0,
  };
  const integrityOk = integrity.length === 1 && String(integrity[0].integrity_check || '').toLowerCase() === 'ok';
  console.log(JSON.stringify({ databasePath, integrity, foreignKeyViolations: foreignKeys, storage }, null, 2));
  if (!integrityOk || foreignKeys.length > 0) process.exitCode = 1;
} finally {
  await new Promise(resolve => db.close(() => resolve()));
}
