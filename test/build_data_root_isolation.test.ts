import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('build-time data-root isolation', () => {
  it('sets a temporary explicit data root before importing runtime tool definitions', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'scripts', 'write-capability-stats.ts'),
      'utf8',
    );
    const isolateAt = source.indexOf(
      'process.env.LUMI_DATA_DIR = isolatedDataRoot',
    );
    const importAt = source.search(/import\((['"]){1}\.\.\/server\/tools\/registry\1\)/);
    const runAt = source.indexOf('await main()');

    expect(isolateAt).toBeGreaterThan(-1);
    expect(importAt).toBeGreaterThan(-1);
    expect(runAt).toBeGreaterThan(isolateAt);
    expect(source).not.toMatch(
      /^import .*server\/tools\/(registry|definitions)/m,
    );
    expect(source).toMatch(
      /fs\.mkdtempSync\(\s*path\.join\(os\.tmpdir\(\),\s*['"]lumicore-capability-stats-['"]\s*\),?\s*\)/,
    );
    expect(source).toContain(
      'fs.rmSync(isolatedDataRoot, { recursive: true, force: true })',
    );
    expect(source.indexOf('process.exit(buildExitCode)')).toBeGreaterThan(
      source.indexOf(
        'fs.rmSync(isolatedDataRoot, { recursive: true, force: true })',
      ),
    );
  });

  it('keeps database lease acquisition lazy until persistence initialization', () => {
    const database = fs.readFileSync(path.join(process.cwd(), 'db_layer.ts'), 'utf8');
    const prepareFunctionAt = database.indexOf('function prepareDatabaseRuntime()');
    const leaseAt = database.indexOf('prepareRuntimeDataRoot();', prepareFunctionAt);
    const initAt = database.indexOf('export function initDatabase()');
    const initPrepareAt = database.indexOf('const dbPath = prepareDatabaseRuntime();', initAt);

    expect(prepareFunctionAt).toBeGreaterThan(-1);
    expect(leaseAt).toBeGreaterThan(prepareFunctionAt);
    expect(initPrepareAt).toBeGreaterThan(initAt);
    expect(database.slice(0, prepareFunctionAt)).not.toContain('prepareRuntimeDataRoot();');
  });
});
