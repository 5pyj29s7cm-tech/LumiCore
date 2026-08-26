import crypto from 'crypto';
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
const fixture = path.join(repositoryRoot, 'test', 'fixtures', 'data_root_lease_child.ts');
const migrationFixture = path.join(repositoryRoot, 'test', 'fixtures', 'data_root_migration_lease_child.ts');
const tempBase = path.resolve(process.env.LUMI_TEST_TMPDIR || os.tmpdir());
fs.mkdirSync(tempBase, { recursive: true });
const tempRoot = fs.mkdtempSync(path.join(tempBase, 'data-root-lease-'));
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
  // Run the fixture in the exact child process that this test owns. Invoking
  // the tsx CLI here would create a wrapper which then spawns the real Node
  // process and forwards IPC. SIGKILL would terminate only that wrapper on
  // Linux, leaving the lease-owning backend alive and making a valid lease
  // look like a stale-lease recovery failure.
  const child = spawn(process.execPath, ['--import', 'tsx', fixture], {
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

function spawnMigrationCrashOwner(sourceRoot: string, targetRoot: string): ManagedChild {
  let stdout = '';
  let stderr = '';
  const child = spawn(process.execPath, ['--import', 'tsx', migrationFixture], {
    cwd: repositoryRoot,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      VITEST: '',
      LUMI_MIGRATION_SOURCE: sourceRoot,
      LUMI_MIGRATION_TARGET: targetRoot,
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

function waitForMigrationRename(managed: ManagedChild, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`migration fixture did not rename its root: ${managed.stderr() || managed.stdout()}`));
    }, timeoutMs);
    const onMessage = (message: unknown) => {
      if ((message as { type?: string } | null)?.type !== 'renamed') return;
      cleanup();
      resolve();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(
        `migration fixture exited before rename (${code ?? signal}): ${managed.stderr() || managed.stdout()}`,
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

function waitForReady(managed: ManagedChild, timeoutMs = 30_000): Promise<{ pid: number; dataRoot: string }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`backend fixture did not become ready: ${managed.stderr() || managed.stdout()}`));
    }, timeoutMs);
    const onMessage = (message: unknown) => {
      const record = message as { type?: string; pid?: number; dataRoot?: string } | null;
      if (record?.type !== 'ready' || !record.pid || !record.dataRoot) return;
      if (record.pid !== managed.child.pid) {
        cleanup();
        reject(new Error(
          `backend fixture PID ${record.pid} is not the directly managed child PID ${managed.child.pid}`,
        ));
        return;
      }
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
  if (path.dirname(resolvedTempRoot) === tempBase && path.basename(resolvedTempRoot).startsWith('data-root-lease-')) {
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

  it('blocks a live post-rename migration owner and recovers its target-bound lease after a crash', async () => {
    const home = path.join(tempRoot, 'migration-crash-home');
    const sourceRoot = path.join(home, 'LumiOS');
    const targetRoot = path.join(home, 'LumiCore');
    fs.mkdirSync(path.join(sourceRoot, 'data'), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'data', '.migration_skip'), '', { flag: 'wx' });

    const migrating = spawnMigrationCrashOwner(sourceRoot, targetRoot);
    await waitForMigrationRename(migrating);
    expect(fs.existsSync(sourceRoot)).toBe(false);
    expect(fs.existsSync(path.join(targetRoot, 'runtime', 'backend-instance.lock'))).toBe(true);

    const blocked = spawnBackend(targetRoot);
    const blockedExit = await waitForExit(blocked);
    expect(blockedExit.code).not.toBe(0);
    expect(`${blocked.stderr()}\n${blocked.stdout()}`).toContain('DATA_ROOT_LEASE_HELD');

    migrating.child.kill('SIGKILL');
    await waitForExit(migrating);

    const recovered = spawnBackend(targetRoot);
    await waitForReady(recovered);
    const recoveredLease = JSON.parse(fs.readFileSync(
      path.join(targetRoot, 'runtime', 'backend-instance.lock'),
      'utf8',
    )) as { leasePurpose?: string; pid?: number };
    expect(recoveredLease.leasePurpose).toBe('backend');
    expect(recoveredLease.pid).toBe(recovered.child.pid);
    await stopBackend(recovered);
  }, 90_000);

  it('reclaims an old generation when its PID is alive but its process-start identity was reused', async () => {
    const dataRoot = prepareDataRoot('pid-reuse');
    const runtimeDir = path.join(dataRoot, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    const canonicalRoot = fs.realpathSync.native(dataRoot);
    const normalizedRoot = process.platform === 'win32'
      ? path.normalize(canonicalRoot).toLocaleLowerCase('en-US')
      : path.normalize(canonicalRoot);
    const leasePath = path.join(runtimeDir, 'backend-instance.lock');
    fs.writeFileSync(leasePath, `${JSON.stringify({
      version: 1,
      ownerToken: 'R'.repeat(43),
      pid: process.pid,
      hostname: os.hostname().trim().toLocaleLowerCase('en-US'),
      dataRoot: canonicalRoot,
      dataRootDigest: crypto.createHash('sha256').update(normalizedRoot, 'utf8').digest('hex'),
      processStartIdentity: `simulated-reused-pid-${crypto.randomBytes(12).toString('hex')}`,
      acquiredAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });

    const replacement = spawnBackend(dataRoot);
    const replacementReady = await waitForReady(replacement);
    expect(replacementReady.pid).not.toBe(process.pid);
    const replacementLease = JSON.parse(fs.readFileSync(leasePath, 'utf8')) as {
      pid: number;
      processStartIdentity: string;
    };
    expect(replacementLease.pid).toBe(replacementReady.pid);
    expect(replacementLease.processStartIdentity).not.toContain('simulated-reused-pid');
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

  it('rejects a corrupt SQLite store before any schema migration can rewrite it', async () => {
    const dataRoot = prepareDataRoot('corrupt-before-schema');
    const databasePath = path.join(dataRoot, 'data', 'lumi.db');
    const corruptBytes = crypto.randomBytes(4096);
    fs.writeFileSync(databasePath, corruptBytes, { flag: 'wx' });
    const beforeDigest = crypto.createHash('sha256').update(corruptBytes).digest('hex');

    const blocked = spawnBackend(dataRoot);
    const blockedExit = await waitForExit(blocked);
    expect(blockedExit.code).not.toBe(0);
    expect(`${blocked.stderr()}\n${blocked.stdout()}`).toMatch(/SQLITE_NOTADB|file is not a database|quick_check/i);
    const afterBytes = fs.readFileSync(databasePath);
    expect(afterBytes.length).toBe(corruptBytes.length);
    expect(crypto.createHash('sha256').update(afterBytes).digest('hex')).toBe(beforeDigest);
  }, 30_000);
});
