import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { afterAll, describe, expect, it } from 'vitest';

interface ManagedChild {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
}

const repositoryRoot = process.cwd();
const tsxCli = path.join(repositoryRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const fixture = path.join(repositoryRoot, 'test', 'fixtures', 'data_root_lease_child.ts');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-data-root-lease-'));
const children = new Set<ManagedChild>();

function prepareDataRoot(name: string): string {
  const dataRoot = path.join(tempRoot, name);
  const dataDirectory = path.join(dataRoot, 'data');
  fs.mkdirSync(dataDirectory, { recursive: true });
  // Prevent the production one-time legacy migration from copying repository
  // data into this intentionally isolated integration-test root.
  fs.writeFileSync(path.join(dataDirectory, '.migration_skip'), '', { flag: 'wx' });
  return dataRoot;
}

function spawnBackend(dataRoot: string): ManagedChild {
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, [tsxCli, fixture], {
    cwd: repositoryRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      VITEST: '',
      LUMI_ENFORCE_DATA_ROOT_LEASE: '1',
      LUMI_DATA_DIR: dataRoot,
    },
  });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', chunk => { stdout += String(chunk); });
  child.stderr?.on('data', chunk => { stderr += String(chunk); });
  const managed = { child, stdout: () => stdout, stderr: () => stderr };
  children.add(managed);
  child.once('exit', () => children.delete(managed));
  return managed;
}

function waitForReady(managed: ManagedChild, timeoutMs = 30_000): Promise<{ pid: number; dataRoot: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`backend fixture did not become ready: ${managed.stderr() || managed.stdout()}`));
    }, timeoutMs);
    const onMessage = (message: unknown) => {
      const record = message as { type?: string; pid?: number; dataRoot?: string } | null;
      if (record?.type !== 'ready' || !record.pid || !record.dataRoot) return;
      cleanup();
      resolve({ pid: record.pid, dataRoot: record.dataRoot });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(
        `backend fixture exited before ready (${code ?? signal}): ${managed.stderr() || managed.stdout()}`,
      ));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      managed.child.off('message', onMessage);
      managed.child.off('exit', onExit);
    };
    managed.child.on('message', onMessage);
    managed.child.on('exit', onExit);
  });
}

function waitForExit(managed: ManagedChild, timeoutMs = 15_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    if (managed.child.exitCode !== null || managed.child.signalCode !== null) {
      resolve({ code: managed.child.exitCode, signal: managed.child.signalCode });
      return;
    }
    const timeout = setTimeout(() => {
      managed.child.off('exit', onExit);
      reject(new Error(`backend fixture did not exit: ${managed.stderr() || managed.stdout()}`));
    }, timeoutMs);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    };
    managed.child.once('exit', onExit);
  });
}

async function stopBackend(managed: ManagedChild): Promise<void> {
  if (managed.child.exitCode !== null || managed.child.signalCode !== null) return;
  if (managed.child.connected) managed.child.send({ type: 'shutdown' });
  try {
    await waitForExit(managed);
  } catch {
    managed.child.kill('SIGKILL');
    await waitForExit(managed).catch(() => undefined);
  }
}

afterAll(async () => {
  await Promise.all([...children].map(child => stopBackend(child)));
  const resolvedTempRoot = path.resolve(tempRoot);
  if (resolvedTempRoot.startsWith(path.resolve(os.tmpdir())) && path.basename(resolvedTempRoot).startsWith('lumi-data-root-lease-')) {
    fs.rmSync(resolvedTempRoot, { recursive: true, force: true });
  }
});

describe.sequential('cross-process Lumi data-root lease', () => {
  it('rejects a second backend for the same root while allowing a different root', async () => {
    const rootA = prepareDataRoot('root-a');
    const rootB = prepareDataRoot('root-b');
    const first = spawnBackend(rootA);
    await waitForReady(first);

    const duplicate = spawnBackend(rootA);
    const duplicateExit = await waitForExit(duplicate);
    expect(duplicateExit.code).not.toBe(0);
    expect(`${duplicate.stderr()}\n${duplicate.stdout()}`).toContain('DATA_ROOT_LEASE_HELD');

    const independent = spawnBackend(rootB);
    const independentReady = await waitForReady(independent);
    expect(path.resolve(independentReady.dataRoot)).toBe(path.resolve(rootB));

    await Promise.all([stopBackend(first), stopBackend(independent)]);
  }, 60_000);

  it('reclaims a lease only after its exact owning process has died', async () => {
    const dataRoot = prepareDataRoot('crash-recovery');
    const crashed = spawnBackend(dataRoot);
    const crashedReady = await waitForReady(crashed);
    const leasePath = path.join(dataRoot, 'runtime', 'backend-instance.lock');
    const crashedLease = JSON.parse(fs.readFileSync(leasePath, 'utf8')) as {
      pid: number;
      processStartIdentity: string;
      dataRootDigest: string;
    };
    expect(crashedLease.pid).toBe(crashedReady.pid);
    expect(crashedLease.processStartIdentity).toBeTruthy();
    expect(crashedLease.dataRootDigest).toMatch(/^[a-f0-9]{64}$/);

    crashed.child.kill('SIGKILL');
    await waitForExit(crashed);
    expect(fs.existsSync(leasePath)).toBe(true);

    const replacement = spawnBackend(dataRoot);
    const replacementReady = await waitForReady(replacement);
    expect(replacementReady.pid).not.toBe(crashedReady.pid);
    const replacementLease = JSON.parse(fs.readFileSync(leasePath, 'utf8')) as { pid: number };
    expect(replacementLease.pid).toBe(replacementReady.pid);
    await stopBackend(replacement);
    expect(fs.existsSync(leasePath)).toBe(false);
  }, 60_000);

  it('does not delete a lease generation whose owner token was replaced', async () => {
    const dataRoot = prepareDataRoot('owner-only-release');
    const owner = spawnBackend(dataRoot);
    await waitForReady(owner);
    const leasePath = path.join(dataRoot, 'runtime', 'backend-instance.lock');
    const tampered = JSON.parse(fs.readFileSync(leasePath, 'utf8')) as { ownerToken: string };
    tampered.ownerToken = 'Z'.repeat(43);
    fs.writeFileSync(leasePath, `${JSON.stringify(tampered)}\n`, 'utf8');

    await stopBackend(owner);
    expect(fs.existsSync(leasePath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(leasePath, 'utf8')).ownerToken).toBe(tampered.ownerToken);

    // The former owner is now dead, so a new process may validate and reclaim
    // the surviving generation instead of the old process deleting it blindly.
    const replacement = spawnBackend(dataRoot);
    await waitForReady(replacement);
    await stopBackend(replacement);
    expect(fs.existsSync(leasePath)).toBe(false);
  }, 60_000);

  it('fails closed on an invalid or unreadable lease instead of guessing ownership', async () => {
    const dataRoot = prepareDataRoot('invalid-lock');
    const runtimeDir = path.join(dataRoot, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'backend-instance.lock'), '{not-json}\n', { mode: 0o600 });

    const blocked = spawnBackend(dataRoot);
    const blockedExit = await waitForExit(blocked);
    expect(blockedExit.code).not.toBe(0);
    expect(`${blocked.stderr()}\n${blocked.stdout()}`).toMatch(/DATA_ROOT_LEASE_(?:INVALID|UNREADABLE)/);
  }, 30_000);
});
