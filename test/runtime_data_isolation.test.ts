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
    expect(root.startsWith(`${path.resolve(tempBase)}${path.sep}lumi-os-tests${path.sep}`)).toBe(true);
    expect(fs.existsSync(path.join(root, 'data', '.migration_skip'))).toBe(true);
    expect(fs.readdirSync(path.join(root, 'data'))).toEqual(['.migration_skip']);
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
