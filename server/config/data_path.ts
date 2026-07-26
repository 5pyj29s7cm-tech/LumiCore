// Centralized data directory resolver.
// All persisted files (DB, keys, config, voice samples, KB) live here.
// Default: ~/LumiOS/data/ — survives code/upgrade overwrites.
// Override: set LUMI_DATA_DIR env var.

import fs from 'fs';
import path from 'path';
import os from 'os';

const ENV_KEY = 'LUMI_DATA_DIR';
const TEST_ROOT_ENV_KEY = 'LUMI_TEST_TMPDIR';

let cachedTestDataRoot: string | null = null;

function testDataRoot(): string {
  if (cachedTestDataRoot) return cachedTestDataRoot;

  const tempBase = process.env[TEST_ROOT_ENV_KEY] || os.tmpdir();
  const root = path.join(tempBase, 'lumi-os-tests', String(process.pid));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // db_layer performs a one-time legacy migration when this marker is absent.
  // Test workers must start empty instead of copying a developer's real data.
  const migrationMarker = path.join(dataDir, '.migration_skip');
  if (!fs.existsSync(migrationMarker)) fs.writeFileSync(migrationMarker, '');

  cachedTestDataRoot = root;
  return root;
}

function defaultDataRoot(): string {
  if (process.env.NODE_ENV === 'test') return testDataRoot();
  return path.join(os.homedir(), 'LumiOS');
}

export function getDataRoot(): string {
  return process.env[ENV_KEY] || defaultDataRoot();
}

export function getDataPath(relativePath: string): string {
  const full = path.join(getDataRoot(), 'data', relativePath);
  const dir = path.dirname(full);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return full;
}

export function getDataDirectory(relativePath: string): string {
  const full = path.join(getDataRoot(), 'data', relativePath);
  if (!fs.existsSync(full)) fs.mkdirSync(full, { recursive: true });
  return full;
}

export function getGeneratedOutputDir(): string {
  return getDataDirectory('generated');
}
