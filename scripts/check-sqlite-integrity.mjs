import { existsSync } from 'node:fs';
import path from 'node:path';
import sqlite3 from 'sqlite3';

const databasePath = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !existsSync(databasePath)) {
  console.error(`[sqlite-check] database not found: ${databasePath}`);
  process.exit(2);
}

const db = await new Promise((resolve, reject) => {
  const handle = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(handle));
});

function all(sql) {
  return new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
}

try {
  const integrity = await all('PRAGMA integrity_check');
  const foreignKeys = await all('PRAGMA foreign_key_check');
  const integrityOk = integrity.length === 1 && String(integrity[0].integrity_check || '').toLowerCase() === 'ok';
  console.log(JSON.stringify({ databasePath, integrity, foreignKeyViolations: foreignKeys }, null, 2));
  if (!integrityOk || foreignKeys.length > 0) process.exitCode = 1;
} finally {
  await new Promise(resolve => db.close(() => resolve()));
}
