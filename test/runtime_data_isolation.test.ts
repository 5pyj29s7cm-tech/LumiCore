import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const originalDataDir = process.env.LUMI_DATA_DIR;
const originalTestTmpDir = process.env.LUMI_TEST_TMPDIR;
const originalNodeEnv = process.env.NODE_ENV;
const tempRoots: string[] = [];

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.LUMI_DATA_DIR;
  else process.env.LUMI_DATA_DIR = originalDataDir;
  if (originalTestTmpDir === undefined) delete process.env.LUMI_TEST_TMPDIR;
  else process.env.LUMI_TEST_TMPDIR = originalTestTmpDir;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  vi.resetModules();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('runtime data isolation', () => {
  it('resolves persisted data below LUMI_DATA_DIR and outside the source tree', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-data-isolation-'));
    tempRoots.push(dataRoot);
    process.env.LUMI_DATA_DIR = dataRoot;
    vi.resetModules();
    const { getDataDirectory, getDataPath, getGeneratedOutputDir } = await import('../server/config/data_path');
    const persisted = path.resolve(getDataPath(path.join('nested', 'state.json')));
    const directory = path.resolve(getDataDirectory('meeting_audio'));
    const generated = path.resolve(getGeneratedOutputDir());
    expect(persisted.startsWith(`${path.resolve(dataRoot)}${path.sep}`)).toBe(true);
    expect(persisted.startsWith(`${path.resolve(process.cwd())}${path.sep}`)).toBe(false);
    expect(generated.startsWith(`${path.resolve(dataRoot)}${path.sep}`)).toBe(true);
    expect(generated.startsWith(`${path.resolve(process.cwd())}${path.sep}`)).toBe(false);
    expect(directory.startsWith(`${path.resolve(dataRoot)}${path.sep}`)).toBe(true);
  });

  it('starts each test process empty and marks it to skip legacy data migration', async () => {
    const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-test-root-base-'));
    tempRoots.push(tempBase);
    delete process.env.LUMI_DATA_DIR;
    process.env.LUMI_TEST_TMPDIR = tempBase;
    process.env.NODE_ENV = 'test';
    vi.resetModules();

    const { getDataRoot } = await import('../server/config/data_path');
    const root = path.resolve(getDataRoot());
    expect(root.startsWith(`${path.resolve(tempBase)}${path.sep}lumi-core-tests${path.sep}`)).toBe(true);
    expect(fs.existsSync(path.join(root, 'data', '.migration_skip'))).toBe(true);
    expect(fs.readdirSync(path.join(root, 'data'))).toEqual(['.migration_skip']);
  });

  it('moves the legacy LumiOS data root in place and keeps its contents', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-core-migration-'));
    tempRoots.push(home);
    const legacyRoot = path.join(home, 'LumiOS');
    fs.mkdirSync(path.join(legacyRoot, 'data'), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, 'data', 'lumi.db'), 'existing-conversations');

    const {
      migrateLegacyProductDataRoot,
      markLegacyProductDataMigrationVerified,
    } = await import('../server/config/data_path');
    const { claimDataRootForMigration } = await import('../server/runtime/data_root_lease');
    const currentRoot = migrateLegacyProductDataRoot(claimDataRootForMigration, home);

    expect(currentRoot).toBe(path.join(home, 'LumiCore'));
    expect(fs.existsSync(legacyRoot)).toBe(false);
    expect(fs.readFileSync(path.join(currentRoot, 'data', 'lumi.db'), 'utf8')).toBe('existing-conversations');
    expect(fs.existsSync(path.join(currentRoot, 'runtime', 'backend-instance.lock'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(
      path.join(currentRoot, 'runtime', 'product-data-migration.json'),
      'utf8',
    ))).toMatchObject({ version: 1, product: 'LumiCore', migratedFrom: legacyRoot, migratedTo: currentRoot });
    expect(markLegacyProductDataMigrationVerified({
      quickCheck: 'ok',
      userCount: 1,
      conversationCount: 42,
      interactionCount: 703,
    }, currentRoot)).toBe(true);
    expect(JSON.parse(fs.readFileSync(
      path.join(currentRoot, 'runtime', 'product-data-migration-verified.json'),
      'utf8',
    ))).toMatchObject({
      version: 1,
      product: 'LumiCore',
      quickCheck: 'ok',
      userCount: 1,
      conversationCount: 42,
      interactionCount: 703,
    });
    expect(markLegacyProductDataMigrationVerified({
      quickCheck: 'ok',
      userCount: 1,
      conversationCount: 42,
      interactionCount: 703,
    }, currentRoot)).toBe(false);
  });

  it('fails closed when both LumiCore and legacy LumiOS roots contain data', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-core-conflict-'));
    tempRoots.push(home);
    for (const directory of ['LumiCore', 'LumiOS']) {
      fs.mkdirSync(path.join(home, directory), { recursive: true });
      fs.writeFileSync(path.join(home, directory, 'identity.txt'), directory);
    }

    const { migrateLegacyProductDataRoot } = await import('../server/config/data_path');
    expect(() => migrateLegacyProductDataRoot(() => {
      throw new Error('claim must not be attempted for a conflict');
    }, home)).toThrow(/both directories contain data/i);
    expect(fs.readFileSync(path.join(home, 'LumiOS', 'identity.txt'), 'utf8')).toBe('LumiOS');
    expect(fs.readFileSync(path.join(home, 'LumiCore', 'identity.txt'), 'utf8')).toBe('LumiCore');
  });

  it('refuses to migrate while the legacy backend lease is live', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-core-live-lease-'));
    tempRoots.push(home);
    const legacyRoot = path.join(home, 'LumiOS');
    fs.mkdirSync(path.join(legacyRoot, 'data'), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, 'data', 'lumi.db'), 'active');

    const { migrateLegacyProductDataRoot } = await import('../server/config/data_path');
    const { claimDataRootForMigration } = await import('../server/runtime/data_root_lease');
    const activeClaim = claimDataRootForMigration(legacyRoot, path.join(home, 'LumiCore'));
    try {
      expect(() => migrateLegacyProductDataRoot(claimDataRootForMigration, home))
        .toThrow(/already owned by live backend PID/i);
      expect(fs.existsSync(legacyRoot)).toBe(true);
      expect(fs.existsSync(path.join(home, 'LumiCore'))).toBe(false);
    } finally {
      expect(activeClaim.releaseAt(legacyRoot)).toBe(true);
    }
  });

  it('treats blank LUMI_DATA_DIR as default and rejects relative configured roots', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-core-env-'));
    tempRoots.push(home);
    process.env.LUMI_DATA_DIR = '   ';
    vi.resetModules();
    const blankModule = await import('../server/config/data_path');
    expect(blankModule.hasExplicitDataRoot()).toBe(false);
    expect(blankModule.resolveDefaultDataRoot(home)).toBe(path.join(home, 'LumiCore'));

    process.env.LUMI_DATA_DIR = 'relative/data-root';
    expect(() => blankModule.getDataRoot()).toThrow(/absolute path/i);
  });

  it('rejects a symlink or Windows junction at either product-root leaf', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-core-reparse-'));
    tempRoots.push(home);
    const backingLegacy = path.join(home, 'legacy-backing');
    fs.mkdirSync(path.join(backingLegacy, 'data'), { recursive: true });
    fs.writeFileSync(path.join(backingLegacy, 'data', 'lumi.db'), 'do-not-follow');
    fs.symlinkSync(backingLegacy, path.join(home, 'LumiOS'), process.platform === 'win32' ? 'junction' : 'dir');

    const { migrateLegacyProductDataRoot } = await import('../server/config/data_path');
    expect(() => migrateLegacyProductDataRoot(() => {
      throw new Error('unsafe root must be rejected before a lease is claimed');
    }, home)).toThrow(/not a safe directory/i);

    fs.rmSync(path.join(home, 'LumiOS'));
    fs.mkdirSync(path.join(home, 'LumiOS', 'data'), { recursive: true });
    fs.writeFileSync(path.join(home, 'LumiOS', 'data', 'lumi.db'), 'legacy');
    const backingCurrent = path.join(home, 'current-backing');
    fs.mkdirSync(backingCurrent);
    fs.symlinkSync(backingCurrent, path.join(home, 'LumiCore'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => migrateLegacyProductDataRoot(() => {
      throw new Error('unsafe target must be rejected before a lease is claimed');
    }, home)).toThrow(/not a safe directory/i);
  });

  it('rejects SQLite files reached through a symlink or junction data directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-core-sqlite-reparse-'));
    tempRoots.push(root);
    const externalData = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-core-sqlite-backing-'));
    tempRoots.push(externalData);
    fs.symlinkSync(externalData, path.join(root, 'data'), process.platform === 'win32' ? 'junction' : 'dir');
    process.env.LUMI_DATA_DIR = root;
    vi.resetModules();
    const { assertSafeSqliteDataPath } = await import('../server/config/data_path');
    expect(() => assertSafeSqliteDataPath(path.join(root, 'data', 'lumi.db'))).toThrow(/symbolic link or junction/i);
  });

  it('fails closed on a forged existing migration verification receipt', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-core-forged-verification-'));
    tempRoots.push(home);
    const legacyRoot = path.join(home, 'LumiOS');
    fs.mkdirSync(path.join(legacyRoot, 'data'), { recursive: true });
    fs.writeFileSync(path.join(legacyRoot, 'data', 'lumi.db'), 'existing-conversations');

    const {
      migrateLegacyProductDataRoot,
      markLegacyProductDataMigrationVerified,
      preflightProductDataMigrationReceipts,
    } = await import('../server/config/data_path');
    const { claimDataRootForMigration } = await import('../server/runtime/data_root_lease');
    const currentRoot = migrateLegacyProductDataRoot(claimDataRootForMigration, home);
    fs.writeFileSync(
      path.join(currentRoot, 'runtime', 'product-data-migration-verified.json'),
      '{"version":1,"product":"LumiCore"}\n',
      { mode: 0o600 },
    );
    expect(() => preflightProductDataMigrationReceipts(currentRoot))
      .toThrow(/verification receipt is invalid/i);
    expect(() => markLegacyProductDataMigrationVerified({
      quickCheck: 'ok',
      userCount: 1,
      conversationCount: 42,
      interactionCount: 703,
    }, currentRoot)).toThrow(/verification receipt is invalid/i);
  });

  it('keeps explicit data roots isolated from the legacy cwd data importer', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'db_layer.ts'), 'utf8');
    const preflight = fs.readFileSync(
      path.join(process.cwd(), 'server', 'runtime', 'data_root_preflight.ts'),
      'utf8',
    );
    expect(source).toContain('if (!hasExplicitDataRoot()) migrateDataFromOldLocation();');
    expect(preflight).toContain("if (!hasExplicitDataRoot() && process.env.NODE_ENV !== 'test')");
  });

  it('keeps every default generated-output consumer on the centralized data path', () => {
    const consumers = [
      'server.ts',
      'server/tools/definitions/document_tools.ts',
      'server/tools/definitions/image_tools.ts',
      'server/tools/definitions/python_tools.ts',
      'server/tools/definitions/pdf_tools.ts',
      'server/tools/definitions/office_tools.ts',
      'server/tools/definitions/video_tools.ts',
      'server/legal/sources.ts',
      'server/personality/registry.ts',
      'server/regions/packs/cn/legal_tools.ts',
      'server/stt/artifact_paths.ts',
    ];
    for (const consumer of consumers) {
      const source = fs.readFileSync(consumer, 'utf8');
      expect(source).not.toMatch(/process\.cwd\(\).{0,80}lumi_output/);
      expect(source).not.toMatch(/path\.join\(process\.cwd\(\),\s*['"]data['"]/);
      expect(source).toMatch(/get(?:GeneratedOutputDir|DataDirectory|DataPath)/);
    }
  });
});
