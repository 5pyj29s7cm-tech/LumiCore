import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { SystemSnapshot } from '../autonomy/system_explorer';

export interface SystemExplorationWorkerInvocation {
  executable: string;
  args: string[];
  cwd: string;
  kind: 'packaged' | 'source';
}

export interface SystemExplorationWorkerOptions {
  outputDir?: string;
  timeoutMs?: number;
  nodeExecutable?: string;
  spawnProcess?: typeof spawn;
}

export class SystemExplorationAlreadyRunningError extends Error {
  readonly code = 'system_exploration_already_running';

  constructor() {
    super('A local computer exploration scan is already running.');
    this.name = 'SystemExplorationAlreadyRunningError';
  }
}

let activeWorker: ChildProcess | null = null;
let activeOperation: Promise<SystemSnapshot> | null = null;

function runtimeCandidates(preferredRuntimeDir: string): string[] {
  const candidates = [
    process.env.LUMI_RUNTIME_META_FILE
      ? path.dirname(process.env.LUMI_RUNTIME_META_FILE)
      : '',
    preferredRuntimeDir,
    process.cwd(),
    path.join(process.cwd(), 'dist-server'),
  ];
  const seen = new Set<string>();
  return candidates.flatMap(candidate => {
    if (!candidate) return [];
    const resolved = path.resolve(candidate);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return [];
    seen.add(key);
    return [resolved];
  });
}

function hasWorker(runtimeDir: string): boolean {
  return fs.existsSync(path.join(runtimeDir, 'system-explorer-worker.mjs'))
    || (
      fs.existsSync(path.join(runtimeDir, 'server', 'autonomy', 'system_explorer_worker.ts'))
      && fs.existsSync(path.join(runtimeDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'))
    );
}

export function resolveSystemExplorationRuntimeDir(
  preferredRuntimeDir = process.cwd(),
): string {
  const runtimeDir = runtimeCandidates(preferredRuntimeDir).find(hasWorker);
  if (runtimeDir) return runtimeDir;
  throw new Error(
    `system exploration worker unavailable under ${runtimeCandidates(preferredRuntimeDir).join(', ')}; refusing to run the blocking scan in the backend process`,
  );
}

/**
 * Resolve a worker that can perform the synchronous host scan outside the
 * backend event loop. There is deliberately no in-process fallback: registry,
 * disk, and directory discovery can take long enough to make health and tool
 * endpoints unavailable.
 */
export function resolveSystemExplorationWorker(
  runtimeDir: string,
  nodeExecutable = process.execPath,
): SystemExplorationWorkerInvocation {
  const resolvedRuntimeDir = path.resolve(runtimeDir);
  const packagedWorker = path.join(resolvedRuntimeDir, 'system-explorer-worker.mjs');
  if (fs.existsSync(packagedWorker)) {
    return {
      executable: nodeExecutable,
      args: [packagedWorker],
      cwd: resolvedRuntimeDir,
      kind: 'packaged',
    };
  }

  const sourceWorker = path.join(resolvedRuntimeDir, 'server', 'autonomy', 'system_explorer_worker.ts');
  const tsxCli = path.join(resolvedRuntimeDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (fs.existsSync(sourceWorker) && fs.existsSync(tsxCli)) {
    return {
      executable: nodeExecutable,
      args: [tsxCli, sourceWorker],
      cwd: resolvedRuntimeDir,
      kind: 'source',
    };
  }

  throw new Error(
    `system exploration worker unavailable under ${resolvedRuntimeDir}; refusing to run the blocking scan in the backend process`,
  );
}

function isValidSystemSnapshot(value: unknown): value is SystemSnapshot {
  const snapshot = value as Partial<SystemSnapshot> | null;
  return Boolean(
    snapshot
    && snapshot.type === 'first_boot'
    && snapshot.computerScope === 'lumi_server_host'
    && typeof snapshot.id === 'string'
    && typeof snapshot.timestamp === 'string'
    && snapshot.hardware?.hostname
    && Array.isArray(snapshot.software?.installedApps)
    && snapshot.filesystem
    && snapshot.network
    && snapshot.inspectionPolicy?.version === 1,
  );
}

async function runSystemExplorationWorker(
  runtimeDir: string,
  options: SystemExplorationWorkerOptions,
): Promise<SystemSnapshot> {
  const worker = resolveSystemExplorationWorker(runtimeDir, options.nodeExecutable);
  const outputDir = options.outputDir
    || path.join(process.env.LUMI_DATA_DIR || runtimeDir, 'runtime');
  await fs.promises.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const outputPath = path.join(
    outputDir,
    `system-exploration-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}.json`,
  );
  const spawnProcess = options.spawnProcess || spawn;
  const timeoutMs = Math.max(1, options.timeoutMs ?? 120_000);
  let stderr = '';

  try {
    const child = spawnProcess(worker.executable, [...worker.args, outputPath], {
      cwd: worker.cwd,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, LUMI_SYSTEM_EXPLORATION_WORKER: '1' },
    });
    activeWorker = child;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => {
      if (stderr.length < 16_384) stderr += String(chunk).slice(0, 16_384 - stderr.length);
    });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`system exploration worker timed out after ${timeoutMs} milliseconds`));
      }, timeoutMs);
      if (typeof (timeout as any).unref === 'function') (timeout as any).unref();
      child.once('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    });
    if (exit.code !== 0) {
      throw new Error(
        `system exploration worker exited with ${exit.code ?? exit.signal}: ${stderr.trim() || 'no diagnostics'}`,
      );
    }

    const parsed = JSON.parse(await fs.promises.readFile(outputPath, 'utf8')) as unknown;
    if (!isValidSystemSnapshot(parsed)) {
      throw new Error('system exploration worker returned an invalid snapshot');
    }
    return parsed;
  } finally {
    activeWorker = null;
    await fs.promises.rm(outputPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Run the host inspection outside the backend event loop. Bootstrap and HTTP
 * refreshes share this coordinator so a slow probe cannot overlap another
 * probe or make health/chat endpoints wait on synchronous registry/disk I/O.
 */
export function collectSystemSnapshotInWorker(
  runtimeDir: string,
  options: SystemExplorationWorkerOptions = {},
): Promise<SystemSnapshot> {
  if (activeOperation) throw new SystemExplorationAlreadyRunningError();
  const operation = runSystemExplorationWorker(runtimeDir, options);
  activeOperation = operation;
  void operation.finally(() => {
    if (activeOperation === operation) activeOperation = null;
  }).catch(() => undefined);
  return operation;
}

export function isSystemExplorationWorkerRunning(): boolean {
  return activeOperation !== null;
}

export function stopSystemExplorationWorker(): void {
  if (activeWorker && activeWorker.exitCode === null) activeWorker.kill('SIGTERM');
}
