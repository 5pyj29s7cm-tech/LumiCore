import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import { registerFileOpsTools } from '../server/tools/definitions/file_ops';

describe('autonomous report storage', () => {
  let previousDataRoot: string | undefined;
  let testRoot: string;
  let dataRoot: string;
  let workRoot: string;

  beforeEach(() => {
    previousDataRoot = process.env.LUMI_DATA_DIR;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-autonomy-reports-'));
    dataRoot = path.join(testRoot, 'user-data');
    workRoot = path.join(testRoot, 'workspace');
    fs.mkdirSync(workRoot, { recursive: true });
    process.env.LUMI_DATA_DIR = dataRoot;
  });

  afterEach(() => {
    if (previousDataRoot === undefined) delete process.env.LUMI_DATA_DIR;
    else process.env.LUMI_DATA_DIR = previousDataRoot;
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  function createRegistry(): ToolRegistry {
    const registry = new ToolRegistry();
    registerFileOpsTools(registry);
    return registry;
  }

  it('redirects autonomous relative writes into the dedicated report directory', async () => {
    const registry = createRegistry();
    const expected = path.join(
      dataRoot,
      'data',
      'autonomy',
      'reports',
      'memory_clues',
      'architecture.md',
    );

    const result = await registry.execute('write_file', {
      path: path.join('memory_clues', 'architecture.md'),
      content: 'private memory report',
    }, {
      cwd: workRoot,
      autonomous: true,
      userConfirmed: true,
    });

    expect(result).toContain(expected);
    expect(fs.readFileSync(expected, 'utf8')).toBe('private memory report');
    expect(fs.existsSync(path.join(workRoot, 'memory_clues', 'architecture.md'))).toBe(false);
  });

  it('redirects autonomous absolute workspace writes without flattening safe subdirectories', async () => {
    const registry = createRegistry();
    const requested = path.join(workRoot, 'reviews', 'activity.md');
    const expected = path.join(dataRoot, 'data', 'autonomy', 'reports', 'reviews', 'activity.md');

    await registry.execute('write_file', {
      path: requested,
      content: 'activity report',
    }, {
      cwd: workRoot,
      autonomous: true,
      userConfirmed: true,
    });

    expect(fs.readFileSync(expected, 'utf8')).toBe('activity report');
    expect(fs.existsSync(requested)).toBe(false);
  });

  it('keeps foreground user-directed writes at the requested path', async () => {
    const registry = createRegistry();
    const requested = path.join(workRoot, 'user-note.md');

    await registry.execute('write_file', {
      path: requested,
      content: 'user note',
    }, {
      cwd: workRoot,
      autonomous: false,
      userConfirmed: true,
    });

    expect(fs.readFileSync(requested, 'utf8')).toBe('user note');
  });
});
