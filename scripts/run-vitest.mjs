import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempBase = path.resolve(process.env.LUMI_TEST_TMPDIR || os.tmpdir());
const runName = `lumi-vitest-${process.pid}-${Date.now().toString(36)}`;
const runRoot = path.join(tempBase, runName);
const vitestCli = path.resolve('node_modules', 'vitest', 'vitest.mjs');

if (!fs.existsSync(vitestCli)) {
  throw new Error(`Vitest CLI not found: ${vitestCli}`);
}
fs.mkdirSync(runRoot, { recursive: true });

function cleanupRunRoot() {
  const resolved = path.resolve(runRoot);
  if (path.dirname(resolved) !== tempBase || !path.basename(resolved).startsWith('lumi-vitest-')) {
    throw new Error(`Refusing to remove unsafe Vitest directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

let exitCode = 1;
try {
  exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vitestCli, 'run', ...process.argv.slice(2)], {
      cwd: process.cwd(),
      env: { ...process.env, LUMI_TEST_TMPDIR: runRoot },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
} finally {
  cleanupRunRoot();
}

process.exitCode = exitCode;
