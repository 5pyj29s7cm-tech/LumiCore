import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectSystemSnapshotInWorker,
  isSystemExplorationWorkerRunning,
  resolveSystemExplorationWorker,
  resolveSystemExplorationRuntimeDir,
  SystemExplorationAlreadyRunningError,
} from '../server/runtime/system_exploration_worker';

describe('system exploration worker resolution', () => {
  const temporaryRoots: string[] = [];

  function temporaryRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-system-explorer-'));
    temporaryRoots.push(root);
    return root;
  }

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it('finds the packaged worker from the runtime metadata directory when cwd is not the bundle directory', () => {
    const unrelatedRoot = temporaryRoot();
    const packagedRoot = temporaryRoot();
    const worker = path.join(packagedRoot, 'system-explorer-worker.mjs');
    fs.writeFileSync(worker, '');
    vi.stubEnv('LUMI_RUNTIME_META_FILE', path.join(packagedRoot, 'runtime-meta.json'));

    expect(resolveSystemExplorationRuntimeDir(unrelatedRoot)).toBe(packagedRoot);
    expect(resolveSystemExplorationWorker(packagedRoot, 'node-test')).toEqual({
      executable: 'node-test',
      args: [worker],
      cwd: packagedRoot,
      kind: 'packaged',
    });
  });

  it('fails closed instead of running the blocking scan in-process', () => {
    const root = temporaryRoot();

    expect(() => resolveSystemExplorationWorker(root, 'node-test')).toThrow(
      /refusing to run the blocking scan in the backend process/,
    );
  });

  it('isolates collection, validates the receipt, and rejects overlapping scans', async () => {
    const root = temporaryRoot();
    const outputDir = path.join(root, 'runtime-output');
    const worker = path.join(root, 'system-explorer-worker.mjs');
    fs.writeFileSync(worker, '');
    const snapshot = {
      id: 'explore_test',
      timestamp: '2026-08-26T00:00:00.000Z',
      type: 'first_boot',
      computerScope: 'lumi_server_host',
      hardware: {
        platform: 'win32',
        arch: 'x64',
        hostname: 'test-host',
        cpus: { model: 'Test CPU', cores: 8, threads: 16 },
        totalMemoryGB: 32,
        gpus: [],
        disks: [],
      },
      software: {
        osVersion: 'Windows Test',
        installedApps: [],
        startupPrograms: [],
        runningServices: [],
      },
      filesystem: {
        homeDir: 'C:\\Users\\test',
        desktopFiles: 0,
        documentsFiles: 0,
        downloadsFiles: 0,
        totalUserFiles: 0,
        largeDirs: [],
        fileCountScope: 'desktop_documents_downloads',
        fileCountMaxDepth: 2,
      },
      network: { hostname: 'test-host', interfaces: [], ipAddresses: [] },
      inspectionPolicy: {
        version: 1,
        fileContentsRead: false,
        fileNamesPersisted: false,
        browserHistoryRead: false,
        credentialsRead: false,
        uniqueHardwareIdsPersisted: false,
        collectedCategories: [],
      },
    };
    const fakeSpawn = vi.fn((_executable: string, args: readonly string[]) => {
      const child = new EventEmitter() as any;
      child.exitCode = null;
      child.stderr = new EventEmitter();
      child.stderr.setEncoding = vi.fn();
      child.kill = vi.fn();
      queueMicrotask(() => {
        fs.writeFileSync(args.at(-1)!, JSON.stringify(snapshot), 'utf8');
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
      return child;
    }) as unknown as typeof spawn;

    const operation = collectSystemSnapshotInWorker(root, {
      outputDir,
      nodeExecutable: 'node-test',
      spawnProcess: fakeSpawn,
    });
    expect(isSystemExplorationWorkerRunning()).toBe(true);
    expect(() => collectSystemSnapshotInWorker(root)).toThrow(SystemExplorationAlreadyRunningError);

    await expect(operation).resolves.toMatchObject({ id: 'explore_test', inspectionPolicy: { version: 1 } });
    expect(isSystemExplorationWorkerRunning()).toBe(false);
    expect(fs.readdirSync(outputDir)).toEqual([]);
  });

  it('keeps the scheduled daily scan off the backend event loop', () => {
    const schedulerSource = fs.readFileSync(
      path.join(process.cwd(), 'server', 'scheduler.ts'),
      'utf8',
    );
    const dailyScan = schedulerSource.slice(
      schedulerSource.indexOf("id: 'daily_system_scan'"),
      schedulerSource.indexOf("id: 'daily_system_scan'") + 2_500,
    );

    expect(dailyScan).toContain('await collectSystemSnapshotInWorker(');
    expect(dailyScan).toContain('persistDailyExploration(collected)');
    expect(dailyScan).not.toContain('runDailyScan(');
  });
});
