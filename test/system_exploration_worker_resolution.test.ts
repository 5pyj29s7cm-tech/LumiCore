import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSystemExplorationWorker } from '../server/runtime/system_exploration_worker';

describe('system exploration worker resolution', () => {
  const temporaryRoots: string[] = [];

  function temporaryRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-system-explorer-'));
    temporaryRoots.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers the packaged JavaScript worker', () => {
    const root = temporaryRoot();
    const worker = path.join(root, 'system-explorer-worker.mjs');
    fs.writeFileSync(worker, '');

    expect(resolveSystemExplorationWorker(root, 'node-test')).toEqual({
      executable: 'node-test',
      args: [worker],
      cwd: root,
      kind: 'packaged',
    });
  });

  it('uses tsx to isolate source-mode exploration', () => {
    const root = temporaryRoot();
    const worker = path.join(root, 'server', 'autonomy', 'system_explorer_worker.ts');
    const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    fs.mkdirSync(path.dirname(worker), { recursive: true });
    fs.mkdirSync(path.dirname(tsx), { recursive: true });
    fs.writeFileSync(worker, '');
    fs.writeFileSync(tsx, '');

    expect(resolveSystemExplorationWorker(root, 'node-test')).toEqual({
      executable: 'node-test',
      args: [tsx, worker],
      cwd: root,
      kind: 'source',
    });
  });

  it('fails closed instead of running the blocking scan in-process', () => {
    const root = temporaryRoot();

    expect(() => resolveSystemExplorationWorker(root, 'node-test')).toThrow(
      /refusing to run the blocking scan in the backend process/,
    );
  });
});
