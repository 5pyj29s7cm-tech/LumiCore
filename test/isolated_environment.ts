import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

// Every test file gets a fresh database, including suites without helpers.ts.
const temporaryBase = path.resolve(process.env.LUMI_TEST_TMPDIR || os.tmpdir());
const isolatedRoot = fs.mkdtempSync(path.join(temporaryBase, 'lumi-suite-'));
const data = path.join(isolatedRoot, 'data');
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, '.migration_skip'), '');
process.env.LUMI_DATA_DIR = isolatedRoot;

function cleanIsolatedRoot(): void {
  if (path.dirname(isolatedRoot) !== temporaryBase || !path.basename(isolatedRoot).startsWith('lumi-suite-')) {
    throw new Error('Unsafe isolated test root');
  }
  try { fs.rmSync(isolatedRoot, { recursive: true, force: true }); } catch { /* Windows may retain an intentionally mocked handle until exit. */ }
}

afterAll(async () => {
  try {
    const database = await import('../db_layer');
    await database.closeDatabase?.();
  } finally { cleanIsolatedRoot(); }
});
process.once('exit', cleanIsolatedRoot);
