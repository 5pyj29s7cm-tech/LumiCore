import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { SupervisedProcessResourceMonitor } from '../runtime/process_resource_monitor';

const HOST = '127.0.0.1';
const PORT = 9880;
const IDLE_MS = Math.max(30_000, Number(process.env.GPTSOVITS_IDLE_MS) || 5 * 60_000);
const START_TIMEOUT_MS = Math.max(10_000, Number(process.env.GPTSOVITS_START_TIMEOUT_MS) || 90_000);
// The supervised Windows process tree can briefly peak around 7.3 GiB while
// loading and serving the first request with the bundled v1 checkpoints.
// Keep bounded startup headroom while retaining the independent 12 GiB
// private-memory ceiling and idle reclamation for long-residency control.
const MEMORY_BUDGET_BYTES = Math.max(512, Number(process.env.GPTSOVITS_MEMORY_BUDGET_MB) || 8_192) * 1024 * 1024;
const PRIVATE_MEMORY_BUDGET_BYTES = Math.max(1_024, Number(process.env.GPTSOVITS_PRIVATE_MEMORY_BUDGET_MB) || 12_288) * 1024 * 1024;

let ownedProcess: ChildProcess | null = null;
let startPromise: Promise<void> | null = null;
let ready = false;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let restartCount = 0;
let backoffUntil = 0;
let lastUsedAt = '';
let lastError = '';
const resourceMonitor = new SupervisedProcessResourceMonitor({
  budgetBytes: MEMORY_BUDGET_BYTES,
  privateBudgetBytes: PRIVATE_MEMORY_BUDGET_BYTES,
  intervalMs: 5_000,
  onBudgetExceeded: snapshot => {
    const child = ownedProcess;
    if (!child || child.killed) return;
    restartCount += 1;
    lastError = snapshot.rssBytes > snapshot.budgetBytes
      ? `working set ${snapshot.rssBytes} exceeded budget ${snapshot.budgetBytes}`
      : `private memory ${snapshot.privateBytes} exceeded budget ${snapshot.privateBudgetBytes}`;
    console.warn(`[GPT-SoVITS] ${lastError}; stopping supervised process tree.`);
    backoffUntil = Date.now() + Math.min(5 * 60_000, 2 ** Math.min(restartCount, 8) * 1_000);
    resourceMonitor.stop();
    child.kill();
  },
});

function probeTcp(timeoutMs = 600): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: HOST, port: PORT });
    const finish = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function runtimeFiles(): { root: string; python: string; api: string } | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const roots = [process.cwd(), resourcesPath, resourcesPath ? path.join(resourcesPath, 'resources') : '']
    .filter(Boolean) as string[];
  for (const base of roots) {
    const root = path.resolve(base, 'gpt-sovits-src');
    const python = path.join(root, process.platform === 'win32' ? 'venv/Scripts/python.exe' : 'venv/bin/python3');
    const api = path.join(root, 'api_v2.py');
    if (fs.existsSync(python) && fs.existsSync(api)) return { root, python, api };
  }
  return null;
}

function clearIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

export function markGptSovitsActivity(): void {
  lastUsedAt = new Date().toISOString();
  clearIdleTimer();
  if (!ownedProcess) return;
  idleTimer = setTimeout(() => {
    if (ownedProcess && !ownedProcess.killed) {
      console.log(`[GPT-SoVITS] Idle for ${IDLE_MS}ms; releasing local model process.`);
      ownedProcess.kill();
    }
    ownedProcess = null;
  }, IDLE_MS);
  idleTimer.unref?.();
}

async function waitUntilReady(child: ChildProcess, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('GPT-SoVITS startup was cancelled.');
    if (child.exitCode !== null || child.signalCode !== null || ownedProcess !== child) {
      throw new Error(`GPT-SoVITS exited before becoming ready${lastError ? `: ${lastError}` : '.'}`);
    }
    if (await probeTcp()) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 500);
      timer.unref?.();
    });
  }
  throw new Error(`GPT-SoVITS did not become ready within ${START_TIMEOUT_MS}ms.`);
}

export async function ensureGptSovitsRuntime(signal?: AbortSignal): Promise<void> {
  markGptSovitsActivity();
  if (await probeTcp()) {
    ready = true;
    return;
  }
  if (process.env.GPTSOVITS_API_URL && !process.env.GPTSOVITS_API_URL.includes('127.0.0.1:9880')) {
    return;
  }
  if (Date.now() < backoffUntil) {
    throw new Error(`GPT-SoVITS is in restart backoff: ${lastError || 'previous startup failed'}`);
  }
  if (startPromise) return startPromise;
  startPromise = (async () => {
    const files = runtimeFiles();
    if (!files) throw new Error('Local GPT-SoVITS runtime is not installed.');
    console.log('[GPT-SoVITS] Starting on demand...');
    const child = spawn(files.python, [
      files.api,
      '-a', HOST,
      '-p', String(PORT),
      '-c', 'GPT_SoVITS/configs/tts_infer.yaml',
    ], {
      cwd: files.root,
      env: { ...process.env, PYTHONUTF8: '1' },
      stdio: 'pipe',
      windowsHide: true,
    });
    ownedProcess = child;
    if (child.pid) resourceMonitor.start(child.pid);
    child.stdout?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`[GPT-SoVITS] ${line}`);
    });
    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.warn(`[GPT-SoVITS] ${line}`);
    });
    child.once('error', error => {
      lastError = error.message;
    });
    child.once('exit', code => {
      resourceMonitor.stop();
      ready = false;
      if (ownedProcess === child) ownedProcess = null;
      if (code && code !== 0) {
        restartCount += 1;
        lastError = `process exited with code ${code}`;
        backoffUntil = Date.now() + Math.min(5 * 60_000, 2 ** Math.min(restartCount, 8) * 1_000);
      }
    });
    try {
      await waitUntilReady(child, signal);
      ready = true;
      restartCount = 0;
      backoffUntil = 0;
      lastError = '';
      markGptSovitsActivity();
    } catch (error: any) {
      if (ownedProcess === child && !child.killed) child.kill();
      ownedProcess = null;
      ready = false;
      restartCount += 1;
      lastError = error?.message || String(error);
      backoffUntil = Date.now() + Math.min(5 * 60_000, 2 ** Math.min(restartCount, 8) * 1_000);
      throw error;
    }
  })().finally(() => {
    startPromise = null;
  });
  return startPromise;
}

export function stopGptSovitsRuntime(): void {
  clearIdleTimer();
  resourceMonitor.stop();
  if (ownedProcess && !ownedProcess.killed) ownedProcess.kill();
  ownedProcess = null;
  ready = false;
}

/** Heavy local models are fallback-eligible only after an explicit use warmed them. */
export function isGptSovitsRuntimeReady(): boolean {
  const externalUrl = String(process.env.GPTSOVITS_API_URL || '');
  if (externalUrl && !externalUrl.includes('127.0.0.1:9880')) return true;
  return ready && Boolean(ownedProcess) && !startPromise;
}

export function getGptSovitsRuntimeStatus() {
  return {
    installed: Boolean(runtimeFiles()),
    owned: Boolean(ownedProcess),
    pid: ownedProcess?.pid || null,
    starting: Boolean(startPromise),
    ready,
    idleTimeoutMs: IDLE_MS,
    lastUsedAt,
    restartCount,
    backoffUntil: backoffUntil ? new Date(backoffUntil).toISOString() : '',
    lastError,
    resources: resourceMonitor.status(),
  };
}
