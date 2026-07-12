/**
 * LumiOS Watchdog Launcher
 *
 * Spawns server.ts as a child process and manages lifecycle:
 * - Exit code 42 → restart (self-upgrade)
 * - Crash (non-zero, non-42) → restart with backoff, max 3 retries
 * - 3 consecutive crash failures → git reset --hard + abort
 * - SIGINT/SIGTERM → clean shutdown (forward to child, exit 0)
 */

import { spawn, ChildProcess, execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.join(__dirname, 'server.ts');
const TSX_CLI = path.join(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const UPGRADE_EXIT_CODE = 42;
const MAX_CRASH_RETRIES = 3;
const CRASH_WINDOW_MS = 60_000; // 1 minute
const BACKOFF_BASE_MS = 2000;
const SERVER_PORT = Number.parseInt(process.env.PORT || '', 10) || 3000;
const HMR_PORT = Number.parseInt(process.env.LUMI_HMR_PORT || '', 10) || 24678;
const AUTO_KILL_OLD_PROCESS = process.env.LUMI_AUTO_KILL_OLD_PROCESS !== '0';

let crashTimestamps: number[] = [];

function pruneOldCrashes() {
  const now = Date.now();
  crashTimestamps = crashTimestamps.filter(t => now - t < CRASH_WINDOW_MS);
}

function consecutiveCrashes(): number {
  pruneOldCrashes();
  return crashTimestamps.length;
}

async function handleFatalCrashes() {
  console.error(`[Launcher] ${MAX_CRASH_RETRIES} crashes in ${CRASH_WINDOW_MS / 1000}s — ABORTING.`);
  console.error('[Launcher] Manual intervention required. Check the server logs above.');
  console.error('[Launcher] No automatic rollback performed — git state is preserved.');
  process.exit(1);
}

function readCommandOutput(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return '';
  }
}

function findListeningPids(port: number): number[] {
  if (!Number.isFinite(port) || port <= 0) return [];

  if (process.platform === 'win32') {
    const output = readCommandOutput('netstat.exe', ['-ano', '-p', 'tcp']);
    const pids = new Set<number>();
    for (const line of output.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[3] !== 'LISTENING') continue;
      const pid = Number(parts[4]);
      if (Number.isFinite(pid) && (parts[1] || '').endsWith(`:${port}`)) {
        pids.add(pid);
      }
    }
    return [...pids];
  }

  const output = readCommandOutput('lsof', [`-tiTCP:${port}`, '-sTCP:LISTEN']);
  return output
    .split(/\s+/)
    .map(pid => Number(pid))
    .filter(pid => Number.isFinite(pid));
}

function getProcessCommandLine(pid: number): string {
  if (process.platform === 'win32') {
    return readCommandOutput('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
    ]).trim();
  }
  return readCommandOutput('ps', ['-p', String(pid), '-o', 'args=']).trim();
}

function isCurrentProjectProcess(commandLine: string): boolean {
  const normalizedCommand = commandLine.replace(/\//g, '\\').toLowerCase();
  const normalizedRoot = __dirname.replace(/\//g, '\\').toLowerCase();
  return normalizedCommand.includes(normalizedRoot)
    && (normalizedCommand.includes('server.ts') || normalizedCommand.includes('launcher.ts') || normalizedCommand.includes('tsx'));
}

function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  process.kill(pid, 'SIGTERM');
}

function clearStaleProjectPortOwners(): void {
  const ports = [...new Set([SERVER_PORT, HMR_PORT].filter(port => Number.isFinite(port) && port > 0))];
  const handled = new Set<number>();

  for (const port of ports) {
    for (const pid of findListeningPids(port)) {
      if (pid === process.pid || handled.has(pid)) continue;
      handled.add(pid);

      const commandLine = getProcessCommandLine(pid);
      if (!commandLine || !isCurrentProjectProcess(commandLine)) {
        console.warn(`[Launcher] Port ${port} is occupied by PID ${pid}; not killing because it is not this project.`);
        if (commandLine) console.warn(`[Launcher] Owner: ${commandLine}`);
        continue;
      }

      if (!AUTO_KILL_OLD_PROCESS) {
        console.warn(`[Launcher] Port ${port} is occupied by old LumiOS PID ${pid}; auto-kill disabled.`);
        continue;
      }

      console.warn(`[Launcher] Port ${port} is occupied by old LumiOS PID ${pid}; terminating it before restart.`);
      killProcessTree(pid);
    }
  }
}

let currentChild: ChildProcess | null = null;

function scheduleServerRestart(delayMs: number): void {
  setTimeout(() => {
    currentChild = restartServer();
  }, delayMs);
}

function restartServer(): ChildProcess {
  clearStaleProjectPortOwners();
  console.log(`[Launcher] Starting server: tsx ${path.basename(SERVER_SCRIPT)}`);

  const child = spawn(process.execPath, [TSX_CLI, SERVER_SCRIPT], {
    cwd: __dirname,
    stdio: 'inherit',
    shell: false,
  });

  child.on('exit', async (code, signal) => {
    console.log(`[Launcher] Server exited — code=${code}, signal=${signal}`);

    if (signal === 'SIGINT' || signal === 'SIGTERM') {
      console.log('[Launcher] Clean shutdown. Goodbye.');
      process.exit(0);
    }

    if (code === UPGRADE_EXIT_CODE) {
      console.log('[Launcher] Upgrade restart — launching new version...');
      crashTimestamps = []; // reset crash counter on successful upgrade
      scheduleServerRestart(500);
      return;
    }

    // Crash or unexpected exit
    crashTimestamps.push(Date.now());
    const crashes = consecutiveCrashes();

    if (crashes >= MAX_CRASH_RETRIES) {
      console.error(`[Launcher] ${MAX_CRASH_RETRIES} crashes in ${CRASH_WINDOW_MS / 1000}s. Rolling back...`);
      await handleFatalCrashes();
      crashTimestamps = [];
      scheduleServerRestart(1000);
      return;
    }

    const delay = BACKOFF_BASE_MS * Math.pow(2, crashes - 1);
    console.log(`[Launcher] Crash ${crashes}/${MAX_CRASH_RETRIES} — restarting in ${delay / 1000}s...`);
    scheduleServerRestart(delay);
  });

  return child;
}

// Forward signals to child
currentChild = restartServer();

process.on('SIGINT', () => {
  console.log('[Launcher] SIGINT — forwarding to server...');
  if (currentChild && !currentChild.killed) {
    currentChild.kill('SIGINT');
  }
});

process.on('SIGTERM', () => {
  console.log('[Launcher] SIGTERM — forwarding to server...');
  if (currentChild && !currentChild.killed) {
    currentChild.kill('SIGTERM');
  }
});
