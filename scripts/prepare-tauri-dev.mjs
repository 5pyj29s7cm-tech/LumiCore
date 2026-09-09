import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEBUG_EXES = [
  path.join(PROJECT_ROOT, 'src-tauri', 'target', 'debug', 'lumi-core.exe'),
  path.join(PROJECT_ROOT, 'src-tauri', 'target', 'debug', 'lumi-os.exe'),
];
const SUPPORTED_CLIENT_EXE_NAMES = new Set(['lumi-core.exe', 'lumi-os.exe']);
const CLEAN_ENABLED = process.env.LUMI_TAURI_DEV_CLEAN_STALE_CLIENTS !== '0';

export function normalizeWinPath(value) {
  return String(value || '').replace(/\//g, '\\').toLowerCase();
}

/** @param {string | string[]} [debugExe] */
export function isProjectDebugClient(processInfo, debugExe = DEBUG_EXES) {
  const name = String(processInfo?.Name || processInfo?.name || '').toLowerCase();
  if (!SUPPORTED_CLIENT_EXE_NAMES.has(name)) return false;

  const exe = normalizeWinPath(processInfo?.ExecutablePath || processInfo?.executablePath || '');
  const expected = (Array.isArray(debugExe) ? debugExe : [debugExe]).map(normalizeWinPath);
  return expected.includes(exe);
}

export function collectProcessTreePids(processes, rootPids) {
  const byParent = new Map();
  for (const proc of processes) {
    const pid = Number(proc.ProcessId ?? proc.processId);
    const parent = Number(proc.ParentProcessId ?? proc.parentProcessId);
    if (!Number.isFinite(pid) || !Number.isFinite(parent)) continue;
    const list = byParent.get(parent) || [];
    list.push(pid);
    byParent.set(parent, list);
  }

  const out = [];
  const seen = new Set();
  const visit = pid => {
    if (!Number.isFinite(pid) || seen.has(pid)) return;
    seen.add(pid);
    for (const child of byParent.get(pid) || []) visit(child);
    out.push(pid);
  };

  for (const pid of rootPids) visit(Number(pid));
  return out;
}

/** @param {string | string[]} [debugExe] */
export function collectStaleClientPids(processes, debugExe = DEBUG_EXES) {
  const roots = processes
    .filter(proc => isProjectDebugClient(proc, debugExe))
    .map(proc => Number(proc.ProcessId ?? proc.processId))
    .filter(pid => Number.isFinite(pid) && pid > 0 && pid !== process.pid);

  return collectProcessTreePids(processes, roots);
}

function readWindowsProcesses() {
  const command = [
    '$ErrorActionPreference = "Stop";',
    'Get-CimInstance Win32_Process',
    '| Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine',
    '| ConvertTo-Json -Compress',
  ].join(' ');

  const raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();

  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export function assertNoRunningDebugClients(processes, debugExe = DEBUG_EXES) {
  const clients = processes.filter(proc => isProjectDebugClient(proc, debugExe));
  if (clients.length) {
    const pids = clients.map(proc => proc.ProcessId ?? proc.processId).join(', ');
    throw new Error(`Lumi development client is still running (PID ${pids}). Close it through the client so pending work is saved, then retry. Dev startup does not force-terminate active clients.`);
  }
}

export function main() {
  if (process.platform !== 'win32') return;
  if (!CLEAN_ENABLED) {
    console.log('[tauri-dev] Stale Lumi desktop client cleanup disabled.');
    return;
  }

  const processes = readWindowsProcesses();
  assertNoRunningDebugClients(processes);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
