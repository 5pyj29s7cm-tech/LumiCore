import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getLatestExploration,
  getSystemExplorationConsent,
  type ComputerCapabilityOpportunity,
} from '../autonomy/system_explorer';
import { runWindowsPowerShellJson } from '../adapters/host_probe';

interface DesktopEntry {
  name: string;
  type: 'file' | 'folder' | 'shortcut' | 'other';
  path: string;
  modifiedAt: string;
}

interface RunningProcess {
  name: string;
  pid: number;
  /** Cumulative processor time reported by Get-Process; this is not CPU%. */
  cpuTimeSeconds?: number | null;
  memoryMB?: number | null;
}

interface ForegroundWindow {
  title: string;
  processName?: string;
  pid?: number;
}

interface DesktopAwarenessSnapshot {
  capturedAt: number;
  platform: string;
  hostname: string;
  homeDir: string;
  desktopDirs: string[];
  desktopEntryCount: number;
  desktopEntries: DesktopEntry[];
  foregroundWindow: ForegroundWindow | null;
  runningProcesses: RunningProcess[];
  systemProfile: ReturnType<typeof getLatestExploration>;
}

const CACHE_MS = 30_000;
const DESKTOP_ENTRY_LIMIT = 24;
const PROCESS_LIMIT = 24;

let cachedSnapshot: DesktopAwarenessSnapshot | null = null;

function getSystemProfile(): ReturnType<typeof getLatestExploration> {
  try {
    return getLatestExploration();
  } catch {
    return null;
  }
}

function explorationAuthorizedForUser(userId: string): boolean {
  try {
    const consent = getSystemExplorationConsent();
    if (consent.status !== 'granted') return false;
    const grantedBy = String(consent.grantedByUserId || '').trim();
    return Boolean(grantedBy && grantedBy === String(userId || '').trim());
  } catch {
    return false;
  }
}

function uniqueExistingDirs(paths: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const raw of paths) {
    if (!raw) continue;
    const normalized = path.normalize(raw);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    try {
      if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) continue;
      seen.add(key);
      dirs.push(normalized);
    } catch {}
  }
  return dirs;
}

function getDesktopDirs(): string[] {
  const home = os.homedir();
  return uniqueExistingDirs([
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),
    process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : undefined,
    process.env.ONEDRIVE ? path.join(process.env.ONEDRIVE, 'Desktop') : undefined,
    process.env.ONEDRIVECONSUMER ? path.join(process.env.ONEDRIVECONSUMER, 'Desktop') : undefined,
  ]);
}

function classifyEntry(entry: fs.Dirent, fullPath: string): DesktopEntry['type'] {
  if (entry.isDirectory()) return 'folder';
  if (entry.isFile()) {
    const ext = path.extname(fullPath).toLowerCase();
    if (ext === '.lnk' || ext === '.url' || ext === '.appref-ms') return 'shortcut';
    return 'file';
  }
  return 'other';
}

function listDesktopEntries(dirs: string[]): { entries: DesktopEntry[]; count: number } {
  const entries: DesktopEntry[] = [];
  let count = 0;
  for (const dir of dirs) {
    let dirEntries: fs.Dirent[] = [];
    try {
      dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    count += dirEntries.length;
    for (const entry of dirEntries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        entries.push({
          name: entry.name,
          type: classifyEntry(entry, fullPath),
          path: fullPath,
          modifiedAt: stat.mtime.toISOString(),
        });
      } catch {}
    }
  }

  entries.sort((a, b) => {
    const timeDelta = new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime();
    if (timeDelta !== 0) return timeDelta;
    return a.name.localeCompare(b.name);
  });

  return { entries: entries.slice(0, DESKTOP_ENTRY_LIMIT), count };
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getForegroundWindow(): ForegroundWindow | null {
  const script = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LumiForegroundWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@
$handle = [LumiForegroundWindow]::GetForegroundWindow()
$titleBuilder = New-Object System.Text.StringBuilder 512
[LumiForegroundWindow]::GetWindowText($handle, $titleBuilder, $titleBuilder.Capacity) | Out-Null
[uint32]$processId = 0
[LumiForegroundWindow]::GetWindowThreadProcessId($handle, [ref]$processId) | Out-Null
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
[PSCustomObject]@{
  title = $titleBuilder.ToString()
  processName = if ($process) { $process.ProcessName } else { $null }
  pid = [int]$processId
} | ConvertTo-Json -Compress
`;
  const value = runWindowsPowerShellJson(script, 2200) as ForegroundWindow | null;
  if (!value || (!value.title && !value.processName)) return null;
  return {
    title: String(value.title || '').trim(),
    processName: value.processName ? String(value.processName) : undefined,
    pid: Number.isFinite(Number(value.pid)) ? Number(value.pid) : undefined,
  };
}

function getRunningProcesses(): RunningProcess[] {
  const script = `
Get-Process |
  Sort-Object @{Expression = 'WorkingSet64'; Descending = $true} |
  Select-Object -First ${PROCESS_LIMIT} @{Name='name'; Expression={$_.ProcessName}}, @{Name='pid'; Expression={$_.Id}}, @{Name='cpuTimeSeconds'; Expression={ if ($_.CPU -ne $null) { [math]::Round($_.CPU, 1) } else { $null } }}, @{Name='memoryMB'; Expression={ [math]::Round($_.WorkingSet64 / 1MB, 1) }} |
  ConvertTo-Json -Compress
`;
  const raw = asArray(runWindowsPowerShellJson(script, 2800) as any);
  return raw
    .map((item: any) => ({
      name: String(item?.name || '').trim(),
      pid: Number(item?.pid),
      cpuTimeSeconds: item?.cpuTimeSeconds == null ? null : Number(item.cpuTimeSeconds),
      memoryMB: item?.memoryMB == null ? null : Number(item.memoryMB),
    }))
    .filter(item => item.name && Number.isFinite(item.pid))
    .slice(0, PROCESS_LIMIT);
}

function getDesktopAwarenessSnapshot(): DesktopAwarenessSnapshot {
  const now = Date.now();
  if (cachedSnapshot && now - cachedSnapshot.capturedAt < CACHE_MS) {
    return cachedSnapshot;
  }

  const desktopDirs = getDesktopDirs();
  const { entries, count } = listDesktopEntries(desktopDirs);
  cachedSnapshot = {
    capturedAt: now,
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    hostname: os.hostname(),
    homeDir: os.homedir(),
    desktopDirs,
    desktopEntryCount: count,
    desktopEntries: entries,
    foregroundWindow: getForegroundWindow(),
    runningProcesses: getRunningProcesses(),
    systemProfile: getSystemProfile(),
  };
  return cachedSnapshot;
}

function formatAge(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

function summarizeEntries(entries: DesktopEntry[]): string {
  if (!entries.length) return 'none visible in known desktop folders';
  return entries
    .slice(0, 16)
    .map(entry => `${entry.name} (${entry.type})`)
    .join(', ');
}

function summarizeProcesses(processes: RunningProcess[]): string {
  if (!processes.length) return 'unavailable';
  return processes
    .slice(0, 16)
    .map(process => {
      const memory = process.memoryMB == null ? '' : `, ${Math.round(process.memoryMB)}MB`;
      return `${process.name}#${process.pid}${memory}`;
    })
    .join(', ');
}

function summarizeApps(apps: string[] | undefined): string {
  if (!apps?.length) return 'not scanned yet';
  return `${apps.length} known; examples: ${apps.slice(0, 24).join(', ')}`;
}

export function formatComputerCapabilityProfileForPrompt(userId: string): string {
  if (!explorationAuthorizedForUser(userId)) {
    return [
      '### Authorized Computer Capability Profile',
      '- Local computer exploration has not been authorized for this user. Do not infer installed software, hardware, files, peripherals, or personalized workflows.',
      '- Explain what Lumi can do generically, and offer the transparent local-computer scan from onboarding/System Explorer if the user wants personalized suggestions.',
    ].join('\n');
  }
  const profile = getSystemProfile();
  if (!profile?.capabilityProfile) {
    return [
      '### Authorized Computer Capability Profile',
      '- Exploration is authorized, but no verified capability profile is available yet. Offer to run or refresh the local scan; do not guess machine facts.',
    ].join('\n');
  }
  const ready = profile.capabilityProfile.opportunities.filter(item => item.ready);
  const needsSetup = profile.capabilityProfile.opportunities.filter(item => !item.ready);
  const line = (item: ComputerCapabilityOpportunity) => (
    `${item.label} [${item.ready ? 'verified-ready' : 'needs-setup'}, confidence=${item.confidence.toFixed(2)}]${item.evidence.length ? ` evidence=${item.evidence.slice(0, 5).join(', ')}` : ' evidence=none'}`
  );
  return [
    '### Authorized Computer Capability Profile',
    `- Snapshot: ${profile.timestamp}; scope=${profile.computerScope}; OS=${profile.software.osVersion}; CPU=${profile.hardware.cpus.model}; memory=${profile.hardware.totalMemoryGB}GB; GPUs=${profile.hardware.gpus.slice(0, 4).join(', ') || 'none reported'}`,
    `- Verified-ready: ${ready.length ? ready.map(line).join(' | ') : 'none'}`,
    `- Needs setup or more evidence: ${needsSetup.length ? needsSetup.map(line).join(' | ') : 'none'}`,
    `- Evidence gaps: ${profile.capabilityProfile.evidenceGaps.join(', ') || 'none reported'}`,
    '- Answer “what can you do here?” from these verified facts. Separate ready, needs setup, and unavailable/unknown; never infer the user profession from app names alone.',
  ].join('\n');
}

export function formatDesktopAwarenessForPrompt(userId: string): string {
  if (!explorationAuthorizedForUser(userId)) {
    return [
      '### Local Machine And Desktop Awareness Boundary',
      '- Host exploration is not authorized for this user. No host desktop listing, foreground-window probe, process inventory, or persisted system profile was read for this prompt.',
      '- Use user-scoped live client state and explicit relay tools only when the current request and execution policy permit them. Offer the transparent local scan if personalized computer guidance would help.',
    ].join('\n');
  }
  const snapshot = getDesktopAwarenessSnapshot();
  const profile = snapshot.systemProfile;
  const profileAge = profile?.timestamp ? formatAge(Date.now() - new Date(profile.timestamp).getTime()) : 'not available';
  const foreground = snapshot.foregroundWindow
    ? `${snapshot.foregroundWindow.processName || 'unknown app'}${snapshot.foregroundWindow.title ? ` - ${snapshot.foregroundWindow.title}` : ''}${snapshot.foregroundWindow.pid ? ` (#${snapshot.foregroundWindow.pid})` : ''}`
    : 'unavailable';

  return [
    '### Local Machine, Desktop, And Background Runtime Awareness',
    'Treat the native desktop and operating system as shared territory that belongs to Lumi and the user. Keep three separate maps: local machine identity and files/apps, visible desktop state, and background/resident runtime state.',
    'Local machine awareness means host OS, user home, known desktop folders, installed/launchable apps, files, startup entries, services, and running processes as reported by the desktop relay. Do not guess these facts when a refresh tool can inspect them.',
    'Visible desktop awareness means foreground window, screen pixels, accessible UI controls, cursor/input focus, and existing logged-in app/browser sessions. Use the desktop/screen/UIA/vision tools to refresh perception before claiming what is on screen or where to click/type.',
    'Background runtime awareness means whether the Lumi client/server are actually running, hidden to tray/background, launched at login, healthy, and allowed to run confirmed autonomous workflows. A hidden window, a live backend process, and an autonomous workflow are different states; verify with client_get_state or client_health_check before promising background continuity.',
    'This is a bounded recent snapshot, not omniscience. When the user asks what is on the screen, what is open, what is running, or asks for visual identification, refresh perception rather than saying the reasoning model cannot see.',
    'Observation boundary: reading current window, running processes, desktop listings, system info, screenshots, OCR, and vision analysis are perception. Changing files/apps/settings, keyboard/mouse control, shell commands, messaging, capture/recording, or destructive actions still follows confirmation and mode rules.',
    `- Snapshot age: ${formatAge(Date.now() - snapshot.capturedAt)}`,
    `- Host: ${snapshot.hostname}; platform=${snapshot.platform}; home=${snapshot.homeDir}`,
    `- Known desktop folders: ${snapshot.desktopDirs.join(', ') || 'none found'}`,
    `- Desktop items: total=${snapshot.desktopEntryCount}; recent=${summarizeEntries(snapshot.desktopEntries)}`,
    `- Foreground window: ${foreground}`,
    `- Running processes: ${summarizeProcesses(snapshot.runningProcesses)}`,
    `- System exploration profile: age=${profileAge}; installedApps=${summarizeApps(profile?.software.installedApps)}`,
    `- Startup programs: ${profile?.software.startupPrograms?.slice(0, 16).join(', ') || 'not scanned yet'}`,
    `- Running services: ${profile?.software.runningServices?.slice(0, 16).join(', ') || 'not scanned yet'}`,
    profile?.filesystem
      ? `- File overview: desktop=${profile.filesystem.desktopFiles}, documents=${profile.filesystem.documentsFiles}, downloads=${profile.filesystem.downloadsFiles}, userFiles=${profile.filesystem.totalUserFiles}`
      : '- File overview: not scanned yet',
    '',
    formatComputerCapabilityProfileForPrompt(userId),
  ].join('\n');
}
