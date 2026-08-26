import fs from 'fs';
import path from 'path';
import { claimDataRootForMigration } from '../../server/runtime/data_root_lease';

const sourceRoot = path.resolve(String(process.env.LUMI_MIGRATION_SOURCE || ''));
const targetRoot = path.resolve(String(process.env.LUMI_MIGRATION_TARGET || ''));
if (!process.env.LUMI_MIGRATION_SOURCE || !process.env.LUMI_MIGRATION_TARGET) {
  throw new Error('Migration lease fixture requires source and target roots.');
}

// Intentionally never release this claim. The parent terminates the process to
// simulate a crash after the atomic product-root rename and before lease
// release. A later backend must recover this exact target-bound generation.
claimDataRootForMigration(sourceRoot, targetRoot);
fs.renameSync(sourceRoot, targetRoot);
if (typeof process.send === 'function') {
  process.send({ type: 'renamed', pid: process.pid, sourceRoot, targetRoot });
}
setInterval(() => undefined, 1_000);
