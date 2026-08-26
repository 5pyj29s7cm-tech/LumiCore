import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('runtime data migration entry boundary', () => {
  it('migrates the default root before dynamically importing the application graph', () => {
    const entry = source('server/runtime/server_entry.ts');
    const prepareAt = entry.indexOf('prepareRuntimeDataRoot()');
    const serverImportAt = entry.indexOf("await import('../../server')");

    expect(prepareAt).toBeGreaterThan(-1);
    expect(serverImportAt).toBeGreaterThan(prepareAt);
    expect(entry).not.toMatch(/^import .*\.\.\/\.\.\/server['"]/m);
  });

  it('has one process-local migration owner with a db-layer fallback', () => {
    const preflight = source('server/runtime/data_root_preflight.ts');
    const database = source('db_layer.ts');

    expect(preflight).toContain('migrateLegacyProductDataRoot(claimDataRootForMigration)');
    expect(preflight).toContain('if (runtimeDataRootPrepared) return;');
    expect(preflight.indexOf('acquireDataRootLease()'))
      .toBeLessThan(preflight.indexOf('preflightProductDataMigrationReceipts()'));
    expect(database).toContain('prepareRuntimeDataRoot();');
    expect(database).not.toContain('migrateLegacyProductDataRoot(');
  });

  it('uses the ordered entry in both supervised source and packaged runtimes', () => {
    const launcher = source('launcher.ts');
    const build = source('scripts/build-server.mjs');
    const packageJson = source('package.json');
    const reliability = source('scripts/runtime-reliability.mjs');

    expect(launcher).toContain("path.join(__dirname, 'server', 'runtime', 'server_entry.ts')");
    expect(build).toContain("entryPoints: ['server/runtime/server_entry.ts']");
    expect(build).not.toContain("entryPoints: ['server.ts']");
    expect(packageJson).toContain('"dev:direct": "tsx server/runtime/server_entry.ts"');
    expect(reliability).toContain("sourceEntry: path.join(root, 'server', 'runtime', 'server_entry.ts')");
  });
});
