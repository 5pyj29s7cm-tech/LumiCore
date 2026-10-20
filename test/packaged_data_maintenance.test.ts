import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { assertLegacyLegalDataMerged } from '../server/config/data_path';

const run = promisify(execFile), repository = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-maintenance-upgrade-'));
const home = path.join(scratch, 'home'), source = path.join(home, 'LumiCore-Legal'), target = path.join(home, 'LumiCore');
const artifactRoot = path.resolve(repository, '.codex-run', 'packaged-maintenance-' + crypto.randomUUID());
const entry = path.join(artifactRoot, 'maintenance', 'merge-legal-data-root.mjs');
const childEnvironment = { ...process.env, NODE_ENV: 'test', LUMI_ENFORCE_DATA_ROOT_LEASE: '1', LUMI_DATA_DIR: source };
const digest = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const cli = (...args: string[]) => run(process.execPath, [entry, ...args], { cwd: scratch, env: childEnvironment, windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024 });

beforeAll(async () => {
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(artifactRoot, { recursive: true });
  // Fixture setup uses the app schema; the shipped entry below needs no tsx or source files.
  const fixture = path.join(artifactRoot, 'seed.cjs');
  const fixtureSource = '(async()=>{const d=await import(' + JSON.stringify(pathToFileURL(path.resolve(repository,'db_layer.ts')).href) + ');await d.initDatabase();await d.runSQL("INSERT INTO settings(key,value) VALUES (?,?)",["upgrade_fixture",JSON.stringify({original:"full original record; tail retained"})]);await d.closeDatabase();const l=await import(' + JSON.stringify(pathToFileURL(path.resolve(repository,'server/runtime/data_root_lease.ts')).href) + ');if(!l.releaseDataRootLease())throw Error("fixture lease was not released");})().catch(e=>{console.error(e);process.exitCode=1});';
  fs.writeFileSync(fixture, fixtureSource);
  await run(process.execPath, ['--import', pathToFileURL(path.resolve(repository, 'node_modules/tsx/dist/loader.mjs')).href, fixture], { cwd: repository, env: childEnvironment, windowsHide: true, timeout: 25000 });
  fs.mkdirSync(path.join(source, 'data', 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(source, 'data', 'fixtures', 'original.txt'), 'LUMI-UPGRADE-FIXTURE\nfull original record; tail retained\n');
  await build({ entryPoints: [path.join(repository, 'scripts/merge-legal-data-root.ts')], outfile: entry, bundle: true, platform: 'node', format: 'esm', external: ['sqlite3', 'sharp', '@img/sharp-win32-x64', '@img/sharp-libvips-win32-x64', 'lightningcss', 'playwright-core', '@larksuiteoapi/node-sdk', 'typescript', 'pdf-parse'], banner: { js: "import { createRequire as __lumiCreateRequire } from 'module'; const require = __lumiCreateRequire(import.meta.url);" } });
}, 40000);
afterAll(() => {
  if (path.dirname(scratch) !== path.resolve(os.tmpdir()) || !path.basename(scratch).startsWith('lumi-maintenance-upgrade-')) throw Error('Unsafe fixture cleanup');
  if (!artifactRoot.startsWith(path.resolve(repository, '.codex-run') + path.sep) || !path.basename(artifactRoot).startsWith('packaged-maintenance-')) throw Error('Unsafe artifact cleanup');
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.rmSync(artifactRoot, { recursive: true, force: true });
});

it('ships an executable ESM maintenance entry and upgrades a legacy-only profile through reviewed steps', async () => {
  const sourceDatabase = path.join(source, 'data', 'lumi.db'), sourceBefore = digest(sourceDatabase);
  const plan = path.join(scratch, 'reviewed-plan.json');
  await expect(cli('--source-root', source, '--target-root', target, '--plan', plan)).rejects.toThrow();
  expect(fs.existsSync(target)).toBe(false);
  await cli('--source-root', source, '--target-root', target, '--initialize-target');
  expect(digest(sourceDatabase)).toBe(sourceBefore);
  expect(() => assertLegacyLegalDataMerged(home, target)).toThrow(/reviewed merge/);
  const empty = new DatabaseSync(path.join(target, 'data', 'lumi.db'), { readOnly: true });
  try { expect(empty.prepare('SELECT value FROM settings WHERE key=?').get('upgrade_fixture')).toBeUndefined(); } finally { empty.close(); }
  await cli('--source-root', source, '--target-root', target, '--plan', plan, '--resolve-known-conflicts');
  const reviewed = JSON.parse(fs.readFileSync(plan, 'utf8'));
  expect(reviewed.conflicts).toEqual([]); expect(reviewed.deferred).toEqual([]);
  expect(fs.existsSync(path.join(target, 'data', 'fixtures', 'original.txt'))).toBe(false);
  await cli('--source-root', source, '--target-root', target, '--plan', plan, '--apply', '--backup-dir', path.join(scratch, 'backup'));
  expect(digest(sourceDatabase)).toBe(sourceBefore);
  expect(fs.readFileSync(path.join(target, 'data', 'fixtures', 'original.txt'), 'utf8')).toBe('LUMI-UPGRADE-FIXTURE\nfull original record; tail retained\n');
  const migrated = new DatabaseSync(path.join(target, 'data', 'lumi.db'), { readOnly: true });
  try { expect(migrated.prepare('SELECT value FROM settings WHERE key=?').get('upgrade_fixture')).toMatchObject({ value: JSON.stringify({ original: 'full original record; tail retained' }) }); expect(migrated.prepare('PRAGMA quick_check').get()).toMatchObject({ quick_check: 'ok' }); } finally { migrated.close(); }
  expect(() => assertLegacyLegalDataMerged(home, target)).not.toThrow();
  expect(fs.existsSync(path.join(scratch, 'backup', 'legal-source.sqlite'))).toBe(true);
  expect(fs.existsSync(path.join(scratch, 'backup', 'shared-before.sqlite'))).toBe(true);
}, 90000);

it('never initializes over existing data or combines initialization with applying a merge', async () => {
  const database = path.join(target, 'data', 'lumi.db'), before = digest(database);
  await expect(cli('--source-root', source, '--target-root', target, '--initialize-target')).rejects.toThrow();
  expect(digest(database)).toBe(before);
  await expect(cli('--source-root', source, '--target-root', target, '--initialize-target', '--apply')).rejects.toThrow();
  expect(digest(database)).toBe(before);
});
