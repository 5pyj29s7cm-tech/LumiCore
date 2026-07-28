import fs from 'node:fs';
import path from 'node:path';

export interface SystemExplorationWorkerInvocation {
  executable: string;
  args: string[];
  cwd: string;
  kind: 'packaged' | 'source';
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
  const packagedWorker = path.join(runtimeDir, 'system-explorer-worker.mjs');
  if (fs.existsSync(packagedWorker)) {
    return {
      executable: nodeExecutable,
      args: [packagedWorker],
      cwd: runtimeDir,
      kind: 'packaged',
    };
  }

  const sourceWorker = path.join(runtimeDir, 'server', 'autonomy', 'system_explorer_worker.ts');
  const tsxCli = path.join(runtimeDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (fs.existsSync(sourceWorker) && fs.existsSync(tsxCli)) {
    return {
      executable: nodeExecutable,
      args: [tsxCli, sourceWorker],
      cwd: runtimeDir,
      kind: 'source',
    };
  }

  throw new Error(
    `system exploration worker unavailable under ${runtimeDir}; refusing to run the blocking scan in the backend process`,
  );
}
