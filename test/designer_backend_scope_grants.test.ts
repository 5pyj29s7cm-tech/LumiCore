import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)
      || !path.basename(root).startsWith('lumi-design-grants-')) throw new Error('Unsafe fixture path');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function check(source: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-design-grants-')); roots.push(root);
  execFileSync('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
  const write = (file: string, text: string) => {
    const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text);
  };
  const baseline = JSON.parse(fs.readFileSync('architecture/import-boundaries.json', 'utf8'));
  write('architecture/import-boundaries.json', JSON.stringify({ allowedDatabaseImporters: [],
    approvedTableImporters: { 'server/design/projects.ts': baseline.approvedTableImporters['server/design/projects.ts'] } }));
  write('scripts/check-architecture-boundaries.mjs', fs.readFileSync('scripts/check-architecture-boundaries.mjs', 'utf8')
    .replace("import ts from 'typescript';", 'import ts from ' + JSON.stringify(pathToFileURL(require.resolve('typescript')).href) + ';'));
  write('server/design/projects.ts', source);
  return spawnSync(process.execPath, ['scripts/check-architecture-boundaries.mjs'], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
}
it('allows the reviewed literal project table subset', () => {
  const result = check("import {readDatabaseTables,commitDatabaseTables} from '../../db_layer'; const db=readDatabaseTables(['interiorProjects']); commitDatabaseTables(db);");
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
});
it.each([
  ["import {readDatabaseTables} from '../../db_layer'; readDatabaseTables(['users']);", 'unrelated table'],
  ["import {readDatabase} from '../../db_layer'; readDatabase();", 'whole database'],
  ["import {execSQL} from '../../db_layer'; execSQL('DELETE FROM users');", 'raw SQL'],
  ["import {readDatabaseTables} from '../../db_layer'; const tables=['interiorProjects']; readDatabaseTables(tables);", 'dynamic table selection'],
])('keeps the new grant from allowing %s (%s)', (source) => {
  const result = check(source);
  expect(result.error).toBeUndefined(); expect(result.status).toBe(1);
  expect(result.stderr).toContain('Architecture scope violations');
});

