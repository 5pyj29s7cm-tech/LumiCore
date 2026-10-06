import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = process.cwd();
const require = createRequire(import.meta.url);
let fixture = '';
function write(file: string, content: string) {
  const target = path.join(fixture, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function gate() {
  return spawnSync(process.execPath, ['scripts/check-architecture-boundaries.mjs'], {
    cwd: fixture, encoding: 'utf8', windowsHide: true, timeout: 30_000,
  });
}
function sharedConsumer() {
  write('server/cognition/consumer.ts', "import { message } from '../regions/messages/example';\nexport const output = message;\n");
}

describe('regional resource architecture boundary', () => {
  beforeAll(() => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-regional-boundary-'));
    execFileSync('git', ['init', '--quiet'], { cwd: fixture, windowsHide: true });
    const script = fs.readFileSync(path.join(root, 'scripts/check-architecture-boundaries.mjs'), 'utf8')
      .replace("import ts from 'typescript';", 'import ts from ' + JSON.stringify(pathToFileURL(require.resolve('typescript')).href) + ';');
    write('scripts/check-architecture-boundaries.mjs', script);
    write('architecture/import-boundaries.json', JSON.stringify({ allowedDatabaseImporters: [] }));
    write('server/regions/messages/example.ts', "export const message = 'shared message';\n");
    write('server/regions/packs/cn.ts', "export const message = 'concrete pack';\n");
  });
  afterAll(() => {
    const resolved = path.resolve(fixture);
    if (!fixture || !resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
      || !path.basename(resolved).startsWith('lumi-regional-boundary-')) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  it('accepts a shared message consumer without granting a concrete pack dependency', () => {
    sharedConsumer();
    const result = gate();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });
  it('rejects a concrete capability-pack import in core cognition', () => {
    write('server/cognition/consumer.ts', "import { message } from '../regions/packs/cn';\nexport const output = message;\n");
    const result = gate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('core cognition must consume shared regional contracts');
  });
  it('rejects reintroducing a second server/i18n resource owner', () => {
    sharedConsumer();
    write('server/i18n/example.ts', "export const message = 'duplicate owner';\n");
    const result = gate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('server/i18n duplicates the regional message resource owner');
  });
});
