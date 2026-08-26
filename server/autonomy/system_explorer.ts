import os from "os";
import fs from "fs";
import path from "path";
import { readDB, writeDB } from "../../db_layer";
import { isAppDiscoveryNoise } from "../../shared/system_apps";
import {
  runHostProbeCommand,
  runWindowsPowerShellJson,
} from "../adapters/host_probe";
import {
  CN_COMMUNICATION_APP_PATTERN,
  CN_FINANCE_APP_PATTERN,
  CN_SYSTEM_EXPLORER_PROMPTS,
} from "../regions/packs/cn/system_explorer_prompts";

export interface SystemSnapshot {
  id: string;
  timestamp: string;
  type: "first_boot" | "daily_scan";
  hardware: HardwareProfile;
  software: SoftwareProfile;
  filesystem: FilesystemOverview;
  network: NetworkProfile;
  peripherals?: PeripheralProfile;
  runtimes?: RuntimeProfile;
  capabilityProfile?: ComputerCapabilityProfile;
  inspectionPolicy?: SystemInspectionPolicy;
  changeSummary?: string;
  computerScope: "lumi_server_host";
}

export interface PeripheralProfile {
  displays: Array<{
    name: string;
    width?: number;
    height?: number;
    refreshHz?: number;
    adapterMemoryGB?: number;
  }>;
  audioDevices: string[];
  cameras: string[];
  printers: string[];
  usbDevices: string[];
  battery?: {
    present: boolean;
    chargePercent?: number;
    status?: string;
  };
  computer?: {
    manufacturer?: string;
    model?: string;
    chassis?: string;
  };
}

export interface RuntimeProfile {
  git?: string;
  node?: string;
  python?: string;
  powershell?: string;
  docker?: string;
  wslDistributions: string[];
  localAiRuntimes: string[];
}

export interface ComputerCapabilityOpportunity {
  id: string;
  label: string;
  ready: boolean;
  confidence: number;
  evidence: string[];
  suggestedPrompts: Array<{ zh: string; en: string }>;
}

export interface ComputerCapabilityProfile {
  version: 1;
  generatedAt: string;
  opportunities: ComputerCapabilityOpportunity[];
  firstQuestions: Array<{ zh: string; en: string }>;
  evidenceGaps: string[];
}

export interface SystemInspectionPolicy {
  version: 1;
  fileContentsRead: false;
  fileNamesPersisted: false;
  browserHistoryRead: false;
  credentialsRead: false;
  uniqueHardwareIdsPersisted: false;
  collectedCategories: string[];
}

export interface SystemExplorationConsent {
  version: 1;
  status: 'granted' | 'declined' | 'legacy_local_scan' | 'not_decided';
  updatedAt?: string;
  grantedByUserId?: string;
}

export interface HardwareProfile {
  platform: string;
  arch: string;
  hostname: string;
  cpus: { model: string; cores: number; threads: number };
  totalMemoryGB: number;
  gpus: string[];
  disks: { name: string; totalGB: number; freeGB: number; fsType: string }[];
}

export interface SoftwareProfile {
  osVersion: string;
  installedApps: string[];
  appDiscovery?: AppDiscoveryStats;
  startupPrograms: string[];
  nodeVersion?: string;
  pythonVersion?: string;
  runningServices: string[];
}

export interface AppDiscoveryStats {
  registryEntries: number;
  startMenuShortcuts: number;
  desktopShortcuts: number;
  commonFolderEntries: number;
  pathExecutables: number;
  applicationBundles?: number;
  scannedRoots: string[];
  limitReached: boolean;
}

export interface FilesystemOverview {
  homeDir: string;
  desktopFiles: number;
  documentsFiles: number;
  downloadsFiles: number;
  totalUserFiles: number;
  largeDirs: { path: string; sizeMB: number }[];
  fileCountScope: "desktop_documents_downloads";
  fileCountMaxDepth: number;
}

export interface NetworkProfile {
  hostname: string;
  interfaces: string[];
  ipAddresses: string[];
}

function exec(cmd: string): string {
  return runHostProbeCommand(cmd);
}

const APP_SCAN_LIMIT = 1500;
const SHORTCUT_EXTENSIONS = new Set([".lnk", ".url", ".appref-ms"]);
const EXECUTABLE_EXTENSIONS = new Set([".exe", ".cmd", ".bat"]);
const NOISE_APP_NAME = /^(uninstall|uninstaller|update|updater|help|readme|license|licence|setup|install|repair|crash|logs?)$/i;
const NOISE_APP_SEGMENT = /\b(uninstall|uninstaller|updater|readme|license|licence|crash handler|diagnostic|telemetry)\b/i;

function uniqueExistingDirs(paths: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const raw of paths) {
    if (!raw) continue;
    const dir = path.normalize(raw);
    if (seen.has(dir.toLowerCase())) continue;
    try {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      seen.add(dir.toLowerCase());
      dirs.push(dir);
    } catch {}
  }
  return dirs;
}

function cleanAppName(raw: string): string | null {
  let name = raw.trim();
  if (!name) return null;
  name = name.replace(/\.(lnk|url|appref-ms|exe|cmd|bat)$/i, "");
  name = name.replace(/\s*-\s*Shortcut$/i, "");
  name = name.replace(/\s*\(\d+\)$/i, "");
  name = name.replace(/\s+/g, " ").trim();
  if (name.length < 2) return null;
  if (NOISE_APP_NAME.test(name) || NOISE_APP_SEGMENT.test(name) || isAppDiscoveryNoise(name)) return null;
  return name;
}

function appKey(name: string): string {
  return name.toLowerCase().replace(/[\s._()[\]{}-]+/g, "");
}

function mergeApps(...sources: string[][]): string[] {
  const map = new Map<string, string>();
  for (const source of sources) {
    for (const raw of source) {
      const name = cleanAppName(raw);
      if (!name) continue;
      const key = appKey(name);
      const existing = map.get(key);
      if (!existing || name.length > existing.length) map.set(key, name);
      if (map.size >= APP_SCAN_LIMIT) return [...map.values()].sort((a, b) => a.localeCompare(b));
    }
  }
  return [...map.values()].sort((a, b) => a.localeCompare(b));
}

function getDesktopDirs(): string[] {
  const home = os.homedir();
  return uniqueExistingDirs([
    path.join(home, "Desktop"),
    path.join(home, "OneDrive", "Desktop"),
    process.env.PUBLIC ? path.join(process.env.PUBLIC, "Desktop") : undefined,
    process.env.ONEDRIVE ? path.join(process.env.ONEDRIVE, "Desktop") : undefined,
    process.env.ONEDRIVECONSUMER ? path.join(process.env.ONEDRIVECONSUMER, "Desktop") : undefined,
  ]);
}

function getStartMenuDirs(): string[] {
  return uniqueExistingDirs([
    process.env.ProgramData ? path.join(process.env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs") : undefined,
    process.env.APPDATA ? path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs") : undefined,
  ]);
}

function getDriveRoots(): string[] {
  if (os.platform() !== "win32") return ["/"];
  const disks = getDiskInfo();
  return uniqueExistingDirs(disks.map(d => `${d.name}:\\`));
}

function getCommonAppRoots(): string[] {
  const driveRoots = getDriveRoots();
  const rootNames = [
    "Program Files",
    "Program Files (x86)",
    "Program Files (Arm)",
    "Applications",
    "Apps",
    "PortableApps",
    "Portable Apps",
    "Programs",
    "Software",
    "Tools",
    "DevTools",
  ];
  const roots: Array<string | undefined> = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramW6432,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps") : undefined,
    path.join(os.homedir(), "scoop", "apps"),
    ...driveRoots.flatMap(root => rootNames.map(name => path.join(root, name))),
  ];
  return uniqueExistingDirs(roots);
}

function collectShortcutNames(roots: string[], maxDepth: number, maxEntries: number): string[] {
  const names: string[] = [];
  let visited = 0;
  for (const root of roots) {
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length > 0 && names.length < maxEntries && visited < maxEntries * 8) {
      const { dir, depth } = stack.pop()!;
      visited++;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < maxDepth) {
          stack.push({ dir: fullPath, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!SHORTCUT_EXTENSIONS.has(ext)) continue;
        const name = cleanAppName(path.basename(entry.name, ext));
        if (name) names.push(name);
        if (names.length >= maxEntries) break;
      }
    }
  }
  return names;
}

function collectCommonFolderApps(roots: string[], maxEntries: number): string[] {
  const names: string[] = [];
  let visited = 0;
  const skipDirs = new Set(["node_modules", "$recycle.bin", "system volume information", "temp", "tmp", "cache", "logs"]);
  for (const root of roots) {
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length > 0 && names.length < maxEntries && visited < maxEntries * 10) {
      const { dir, depth } = stack.pop()!;
      visited++;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < 2 && !skipDirs.has(entry.name.toLowerCase())) {
            stack.push({ dir: fullPath, depth: depth + 1 });
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (EXECUTABLE_EXTENSIONS.has(ext)) {
            const cleaned = cleanAppName(path.basename(entry.name, ext));
            if (cleaned) names.push(cleaned);
          }
        }
        if (names.length >= maxEntries) break;
      }
    }
  }
  return names;
}

function collectPathExecutables(maxEntries: number): string[] {
  const pathEnv = process.env.PATH || "";
  const dirs = uniqueExistingDirs(pathEnv.split(path.delimiter));
  const names: string[] = [];
  const skip = /\\windows\\|\\system32\\|\\syswow64\\/i;
  for (const dir of dirs) {
    if (skip.test(`${dir}\\`)) continue;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!EXECUTABLE_EXTENSIONS.has(ext)) continue;
      const cleaned = cleanAppName(path.basename(entry.name, ext));
      if (cleaned) names.push(cleaned);
      if (names.length >= maxEntries) return names;
    }
  }
  return names;
}

function getMacApplicationRoots(): string[] {
  return uniqueExistingDirs([
    '/Applications',
    '/System/Applications',
    path.join(os.homedir(), 'Applications'),
  ]);
}

export function collectMacApplicationBundles(roots: string[], maxEntries: number): string[] {
  const names: string[] = [];
  const seenPaths = new Set<string>();
  for (const root of roots) {
    const stack = [{ dir: root, depth: 0 }];
    while (stack.length > 0 && names.length < maxEntries) {
      const { dir, depth } = stack.pop()!;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(dir, entry.name);
        const pathKey = fullPath.toLocaleLowerCase();
        if (seenPaths.has(pathKey)) continue;
        seenPaths.add(pathKey);
        if (/\.app$/i.test(entry.name)) {
          const name = cleanAppName(entry.name.replace(/\.app$/i, ''));
          if (name) names.push(name);
          continue;
        }
        if (depth < 3) stack.push({ dir: fullPath, depth: depth + 1 });
        if (names.length >= maxEntries) break;
      }
    }
  }
  return names;
}

function getRegistryInstalledApps(): string[] {
  const apps: string[] = [];
  const out = exec(`powershell -NoProfile -Command "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* 2>$null | Where-Object { $_.DisplayName } | Select-Object -ExpandProperty DisplayName -First 1000"`);
  if (out) {
    for (const line of out.split("\n")) {
      const t = line.trim();
      if (t) apps.push(t);
    }
  }
  return apps;
}

function getInstalledApps(): { apps: string[]; discovery: AppDiscoveryStats } {
  if (os.platform() === 'darwin') {
    const roots = getMacApplicationRoots();
    const applicationBundles = collectMacApplicationBundles(roots, APP_SCAN_LIMIT);
    const pathExecutables = collectPathExecutables(250);
    const apps = mergeApps(applicationBundles, pathExecutables);
    return {
      apps,
      discovery: {
        registryEntries: 0,
        startMenuShortcuts: 0,
        desktopShortcuts: 0,
        commonFolderEntries: 0,
        pathExecutables: pathExecutables.length,
        applicationBundles: applicationBundles.length,
        scannedRoots: roots,
        limitReached: apps.length >= APP_SCAN_LIMIT,
      },
    };
  }

  const registryApps = getRegistryInstalledApps();
  const startMenuDirs = getStartMenuDirs();
  const desktopDirs = getDesktopDirs();
  const commonRoots = getCommonAppRoots();
  const startMenuApps = collectShortcutNames(startMenuDirs, 6, 600);
  const desktopApps = collectShortcutNames(desktopDirs, 2, 300);
  const commonFolderApps = collectCommonFolderApps(commonRoots, 900);
  const pathExecutables = collectPathExecutables(250);
  const apps = mergeApps(registryApps, startMenuApps, desktopApps, commonFolderApps, pathExecutables);
  return {
    apps,
    discovery: {
      registryEntries: registryApps.length,
      startMenuShortcuts: startMenuApps.length,
      desktopShortcuts: desktopApps.length,
      commonFolderEntries: commonFolderApps.length,
      pathExecutables: pathExecutables.length,
      scannedRoots: [...startMenuDirs, ...desktopDirs, ...commonRoots].slice(0, 80),
      limitReached: apps.length >= APP_SCAN_LIMIT,
    },
  };
}

function getStartupPrograms(): string[] {
  if (os.platform() === 'darwin') {
    const roots = uniqueExistingDirs([
      path.join(os.homedir(), 'Library', 'LaunchAgents'),
      '/Library/LaunchAgents',
      '/Library/LaunchDaemons',
    ]);
    return mergeApps(...roots.map((root) => {
      try {
        return fs.readdirSync(root)
          .filter(name => /\.plist$/i.test(name))
          .map(name => name.replace(/\.plist$/i, ''));
      } catch {
        return [];
      }
    })).slice(0, 300);
  }
  const out = exec(`powershell -NoProfile -Command "Get-CimInstance Win32_StartupCommand 2>$null | Select-Object -ExpandProperty Name"`);
  return out ? out.split("\n").map(l => l.trim()).filter(Boolean) : [];
}

function getRunningServices(): string[] {
  if (os.platform() === 'darwin') {
    const out = exec('launchctl list');
    return out
      .split('\n')
      .slice(1)
      .map(line => line.trim().split(/\s+/).slice(2).join(' '))
      .filter(Boolean)
      .slice(0, 100);
  }
  const out = exec(`powershell -NoProfile -Command "Get-Service 2>$null | Where-Object { $_.Status -eq 'Running' } | Select-Object -ExpandProperty DisplayName -First 100"`);
  return out ? out.split("\n").map(l => l.trim()).filter(Boolean) : [];
}

function getGPUInfo(): string[] {
  const gpus: string[] = [];
  const output = os.platform() === 'win32'
    ? exec(`powershell -NoProfile -Command "Get-CimInstance Win32_VideoController 2>$null | Where-Object { $_.Name } | Select-Object -ExpandProperty Name"`)
    : os.platform() === 'darwin'
      ? exec("system_profiler SPDisplaysDataType | awk -F': ' '/Chipset Model/{print $2}'")
      : exec("lspci 2>/dev/null | grep -Ei 'vga|3d|display'");
  if (output) {
    for (const line of output.split("\n")) {
      const t = line.trim();
      if (t && !gpus.includes(t)) gpus.push(t);
    }
  }
  return gpus;
}

function getDiskInfo(): SystemSnapshot["hardware"]["disks"] {
  const disks: SystemSnapshot["hardware"]["disks"] = [];
  const out = os.platform() === 'win32'
    ? exec(`powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' 2>$null | Select-Object DeviceID,FileSystem,Size,FreeSpace | ConvertTo-Json -Compress"`)
    : '';
  try {
    const parsed = JSON.parse(out);
    for (const d of (Array.isArray(parsed) ? parsed : [parsed])) {
      disks.push({
        name: String(d.DeviceID || d.Name || '').replace(/:$/, ''),
        totalGB: Math.round((Number(d.Size || 0) / (1024 ** 3)) * 10) / 10,
        freeGB: Math.round((Number(d.FreeSpace || 0) / (1024 ** 3)) * 10) / 10,
        fsType: d.FileSystem || 'unknown',
      });
    }
  } catch {}
  if (disks.length === 0 && os.platform() !== 'win32') {
    const df = exec("df -Pk 2>/dev/null");
    for (const line of df.split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6 || !/^\d+$/.test(parts[1])) continue;
      disks.push({
        name: parts.slice(5).join(' '),
        totalGB: Math.round((Number(parts[1]) / 1024 / 1024) * 10) / 10,
        freeGB: Math.round((Number(parts[3]) / 1024 / 1024) * 10) / 10,
        fsType: 'unknown',
      });
    }
  }
  return disks;
}

function getNetworkInfo(): NetworkProfile {
  const interfaces = os.networkInterfaces();
  const names: string[] = [];
  const ips: string[] = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    if (addrs) {
      names.push(name);
      for (const a of addrs) {
        if (a.family === "IPv4" && !a.internal) ips.push(a.address);
      }
    }
  }
  return { hostname: os.hostname(), interfaces: names, ipAddresses: ips };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayValue(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

function boundedUniqueText(values: unknown[], limit = 80): string[] {
  const byKey = new Map<string, string>();
  for (const value of values) {
    const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    if (!text) continue;
    const key = text.toLocaleLowerCase();
    if (!byKey.has(key)) byKey.set(key, text);
    if (byKey.size >= limit) break;
  }
  return Array.from(byKey.values());
}

function finitePositive(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function normalizeWindowsPeripheralProbe(value: unknown): PeripheralProfile {
  const probe = recordValue(value);
  const displays = arrayValue(probe.displays).map(item => {
    const display = recordValue(item);
    const adapterBytes = finitePositive(display.AdapterRAM);
    return {
      name: String(display.Name || '').trim(),
      ...(finitePositive(display.CurrentHorizontalResolution)
        ? { width: Math.trunc(Number(display.CurrentHorizontalResolution)) }
        : {}),
      ...(finitePositive(display.CurrentVerticalResolution)
        ? { height: Math.trunc(Number(display.CurrentVerticalResolution)) }
        : {}),
      ...(finitePositive(display.CurrentRefreshRate)
        ? { refreshHz: Math.trunc(Number(display.CurrentRefreshRate)) }
        : {}),
      ...(adapterBytes
        ? { adapterMemoryGB: Math.round((adapterBytes / (1024 ** 3)) * 10) / 10 }
        : {}),
    };
  }).filter(display => display.name).slice(0, 12);
  const batteryRecord = recordValue(arrayValue(probe.battery)[0]);
  const chargePercent = finitePositive(batteryRecord.EstimatedChargeRemaining);
  const computer = recordValue(probe.computer);
  return {
    displays,
    audioDevices: boundedUniqueText(arrayValue(probe.audio).map(item => recordValue(item).Name)),
    cameras: boundedUniqueText(arrayValue(probe.cameras).map(item => recordValue(item).FriendlyName || recordValue(item).Name)),
    printers: boundedUniqueText(arrayValue(probe.printers).map(item => recordValue(item).Name)),
    usbDevices: boundedUniqueText(arrayValue(probe.usb).map(item => recordValue(item).FriendlyName || recordValue(item).Name), 120),
    battery: {
      present: Object.keys(batteryRecord).length > 0,
      ...(chargePercent !== undefined ? { chargePercent: Math.min(100, Math.round(chargePercent)) } : {}),
      ...(batteryRecord.BatteryStatus !== undefined
        ? { status: String(batteryRecord.BatteryStatus) }
        : {}),
    },
    computer: {
      ...(computer.Manufacturer ? { manufacturer: String(computer.Manufacturer).trim().slice(0, 180) } : {}),
      ...(computer.Model ? { model: String(computer.Model).trim().slice(0, 180) } : {}),
      ...(computer.PCSystemType !== undefined ? { chassis: String(computer.PCSystemType) } : {}),
    },
  };
}

function scanWindowsPeripherals(): PeripheralProfile {
  const probe = runWindowsPowerShellJson([
    '$ErrorActionPreference = "SilentlyContinue"',
    '$result = [ordered]@{}',
    '$result.displays = @(Get-CimInstance Win32_VideoController | Where-Object { $_.Name -and $_.Name -notmatch "Idd|Indirect|Mirror|Virtual" } | Select-Object Name,AdapterRAM,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate)',
    '$result.audio = @(Get-CimInstance Win32_SoundDevice | Where-Object Name | Select-Object Name)',
    '$result.cameras = @(Get-PnpDevice -PresentOnly | Where-Object { $_.Class -in @("Camera","Image") } | Select-Object FriendlyName)',
    '$result.printers = @(Get-CimInstance Win32_Printer | Where-Object Name | Select-Object Name)',
    '$result.usb = @(Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like "USB*" -and $_.FriendlyName } | Select-Object -First 120 FriendlyName)',
    '$result.battery = @(Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus)',
    '$result.computer = Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,PCSystemType',
    '$result | ConvertTo-Json -Depth 5 -Compress',
  ].join('\n'), 15_000);
  return normalizeWindowsPeripheralProbe(probe);
}

function collectMacProfilerNames(value: unknown, keys: Set<string>, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectMacProfilerNames(item, keys, output);
    return;
  }
  const record = recordValue(value);
  if (!Object.keys(record).length) return;
  for (const [key, child] of Object.entries(record)) {
    if (keys.has(key) && typeof child === 'string') output.push(child);
    if (child && typeof child === 'object') collectMacProfilerNames(child, keys, output);
  }
}

function scanMacPeripherals(): PeripheralProfile {
  let profiler: unknown = null;
  try {
    const raw = exec('system_profiler SPDisplaysDataType SPAudioDataType SPCameraDataType SPPrintersDataType SPUSBDataType SPPowerDataType SPHardwareDataType -json');
    profiler = raw ? JSON.parse(raw) : null;
  } catch {}
  const displayNames: string[] = [];
  const audioNames: string[] = [];
  const cameraNames: string[] = [];
  const printerNames: string[] = [];
  const usbNames: string[] = [];
  const profilerRecord = recordValue(profiler);
  collectMacProfilerNames(profilerRecord.SPDisplaysDataType, new Set(['_name', 'sppci_model']), displayNames);
  collectMacProfilerNames(profilerRecord.SPAudioDataType, new Set(['_name']), audioNames);
  collectMacProfilerNames(profilerRecord.SPCameraDataType, new Set(['_name']), cameraNames);
  collectMacProfilerNames(profilerRecord.SPPrintersDataType, new Set(['_name']), printerNames);
  collectMacProfilerNames(profilerRecord.SPUSBDataType, new Set(['_name']), usbNames);
  return {
    displays: boundedUniqueText(displayNames, 12).map(name => ({ name })),
    audioDevices: boundedUniqueText(audioNames),
    cameras: boundedUniqueText(cameraNames),
    printers: boundedUniqueText(printerNames),
    usbDevices: boundedUniqueText(usbNames, 120),
  };
}

function scanLinuxPeripherals(): PeripheralProfile {
  const displayNames = exec("lspci 2>/dev/null | grep -Ei 'vga|3d|display'").split('\n');
  const usb = exec('lsusb 2>/dev/null').split('\n');
  const audio = exec("pactl list short sinks 2>/dev/null | awk '{print $2}'").split('\n');
  const cameras = exec("find /sys/class/video4linux -maxdepth 2 -name name -print -exec cat {} \\; 2>/dev/null").split('\n')
    .filter(line => line && !line.startsWith('/'));
  return {
    displays: boundedUniqueText(displayNames, 12).map(name => ({ name })),
    audioDevices: boundedUniqueText(audio),
    cameras: boundedUniqueText(cameras),
    printers: boundedUniqueText(exec('lpstat -p 2>/dev/null').split('\n').map(line => line.replace(/^printer\s+/, '').split(/\s+/)[0])),
    usbDevices: boundedUniqueText(usb, 120),
  };
}

function scanPeripheralProfile(): PeripheralProfile {
  if (os.platform() === 'win32') return scanWindowsPeripherals();
  if (os.platform() === 'darwin') return scanMacPeripherals();
  return scanLinuxPeripherals();
}

function cleanVersion(value: string): string | undefined {
  const line = String(value || '').split(/\r?\n/).map(item => item.trim()).find(Boolean);
  return line ? line.slice(0, 180) : undefined;
}

function scanRuntimeProfile(installedApps: string[]): RuntimeProfile {
  const lowerApps = installedApps.join('\n').toLocaleLowerCase();
  const localAiRuntimes = [
    /\bollama\b/.test(lowerApps) ? 'Ollama' : '',
    /\blm\s*studio\b/.test(lowerApps) ? 'LM Studio' : '',
    /\bjan\b/.test(lowerApps) ? 'Jan' : '',
    /\bchatbox\b/.test(lowerApps) ? 'Chatbox' : '',
  ].filter(Boolean);
  const wslOutput = os.platform() === 'win32' ? exec('wsl.exe -l -q 2>$null') : '';
  return {
    git: cleanVersion(exec('git --version 2>&1')),
    node: cleanVersion(process.version || exec('node --version 2>&1')),
    python: cleanVersion(exec('python --version 2>&1') || exec('python3 --version 2>&1')),
    powershell: os.platform() === 'win32'
      ? cleanVersion(exec('powershell -NoProfile -NonInteractive -Command "$PSVersionTable.PSVersion.ToString()"'))
      : cleanVersion(exec('pwsh -NoProfile -NonInteractive -Command "$PSVersionTable.PSVersion.ToString()" 2>/dev/null')),
    docker: cleanVersion(exec('docker --version 2>&1')),
    wslDistributions: boundedUniqueText(wslOutput.replace(/\u0000/g, '').split(/\r?\n/), 20),
    localAiRuntimes: boundedUniqueText(localAiRuntimes),
  };
}

function scanUserDirectories(): FilesystemOverview {
  const home = os.homedir();
  const desktopDirs = getDesktopDirs();
  const desktop = desktopDirs[0] || path.join(home, "Desktop");
  const docs = path.join(home, "Documents");
  const downloads = path.join(home, "Downloads");

  function countFiles(dir: string, maxDepth = 2, maxEntries = 100_000): number {
    try {
      let files = 0;
      let visited = 0;
      const stack = [{ dir, depth: 0 }];
      while (stack.length > 0 && visited < maxEntries) {
        const current = stack.pop()!;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          visited++;
          if (entry.isFile()) files++;
          else if (entry.isDirectory() && !entry.isSymbolicLink() && current.depth < maxDepth) {
            stack.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
          }
          if (visited >= maxEntries) break;
        }
      }
      return files;
    } catch { return 0; }
  }

  function getDirSizeMB(dir: string, maxDepth = 2, maxEntries = 50_000): number {
    try {
      let total = 0;
      let visited = 0;
      const stack = [{ dir, depth: 0 }];
      while (stack.length > 0 && visited < maxEntries) {
        const current = stack.pop()!;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch {}
        for (const e of entries) {
          visited++;
          const fp = path.join(current.dir, e.name);
          if (e.isFile()) {
            try { total += fs.statSync(fp).size; } catch {}
          } else if (e.isDirectory() && !e.isSymbolicLink() && current.depth < maxDepth) {
            stack.push({ dir: fp, depth: current.depth + 1 });
          }
          if (visited >= maxEntries) break;
        }
      }
      return Math.round(total / (1024 * 1024));
    } catch { return 0; }
  }

  const largeDirs: { path: string; sizeMB: number }[] = [];
  for (const dir of [home, desktop, docs, downloads]) {
    const size = getDirSizeMB(dir);
    if (size > 100) largeDirs.push({ path: dir, sizeMB: size });
  }

  const desktopFiles = desktopDirs.reduce((sum, dir) => sum + countFiles(dir), 0);
  const documentsFiles = countFiles(docs);
  const downloadsFiles = countFiles(downloads);
  return {
    homeDir: home,
    desktopFiles,
    documentsFiles,
    downloadsFiles,
    totalUserFiles: desktopFiles + documentsFiles + downloadsFiles,
    largeDirs,
    fileCountScope: 'desktop_documents_downloads',
    fileCountMaxDepth: 2,
  };
}

function getPhysicalCoreCount(logicalThreads: number): number {
  let detected = 0;
  if (os.platform() === 'win32') {
    detected = Number(exec(`powershell -NoProfile -Command "(Get-CimInstance Win32_Processor 2>$null | Measure-Object -Property NumberOfCores -Sum).Sum"`));
  } else if (os.platform() === 'darwin') {
    detected = Number(exec('sysctl -n hw.physicalcpu'));
  } else {
    const pairs = new Set(exec("lscpu -p=Core,Socket 2>/dev/null").split('\n').filter(line => line && !line.startsWith('#')));
    detected = pairs.size;
  }
  return Number.isFinite(detected) && detected > 0 ? detected : logicalThreads;
}

function scanHardwareProfile(): HardwareProfile {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || "Unknown";
  return {
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    cpus: { model: cpuModel, cores: getPhysicalCoreCount(cpus.length), threads: cpus.length },
    totalMemoryGB: Math.round((os.totalmem() / (1024 * 1024 * 1024)) * 10) / 10,
    gpus: getGPUInfo(),
    disks: getDiskInfo(),
  };
}

function scanSoftwareProfile(): SoftwareProfile {
  const discovered = getInstalledApps();
  return {
    osVersion: `${os.type()} ${os.release()}`,
    installedApps: discovered.apps,
    appDiscovery: discovered.discovery,
    startupPrograms: getStartupPrograms(),
    nodeVersion: process.version || undefined,
    pythonVersion: exec("python --version 2>&1") || exec("python3 --version 2>&1") || undefined,
    runningServices: getRunningServices(),
  };
}

function matchingApps(installedApps: string[], pattern: RegExp, limit = 8): string[] {
  return installedApps.filter(app => pattern.test(app)).slice(0, limit);
}

export function deriveComputerCapabilityProfile(
  snapshot: Pick<SystemSnapshot, 'timestamp' | 'hardware' | 'software' | 'peripherals' | 'runtimes'>,
): ComputerCapabilityProfile {
  const apps = snapshot.software.installedApps || [];
  const runtimes = snapshot.runtimes;
  const opportunities: ComputerCapabilityOpportunity[] = [];
  const add = (opportunity: ComputerCapabilityOpportunity) => opportunities.push({
    ...opportunity,
    evidence: boundedUniqueText(opportunity.evidence, 12),
  });

  add({
    id: 'desktop_organization',
    label: 'Desktop organization and local assistance',
    ready: true,
    confidence: 0.95,
    evidence: [snapshot.software.osVersion, `${snapshot.hardware.disks.length} local disk(s)`],
    suggestedPrompts: [
      { zh: CN_SYSTEM_EXPLORER_PROMPTS.desktopOrganization[0], en: 'Tell me the three most useful things to organize or optimize on this computer.' },
      { zh: CN_SYSTEM_EXPLORER_PROMPTS.desktopOrganization[1], en: 'Inventory Desktop, Documents, and Downloads, but propose a plan before changing files.' },
    ],
  });

  const officeApps = matchingApps(apps, /(?:microsoft\s*365|office|word|excel|powerpoint|outlook|wps|libreoffice|numbers|pages|keynote)/i);
  add({
    id: 'office_documents',
    label: 'Documents, spreadsheets, and presentations',
    ready: officeApps.length > 0,
    confidence: officeApps.length > 0 ? 0.92 : 0.45,
    evidence: officeApps,
    suggestedPrompts: [
      { zh: CN_SYSTEM_EXPLORER_PROMPTS.officeDocuments[0], en: 'Based on my office apps, tell me which document and spreadsheet jobs you can do.' },
      { zh: CN_SYSTEM_EXPLORER_PROMPTS.officeDocuments[1], en: 'Turn this material into a delivery-ready document and give me the file plus verification.' },
    ],
  });

  const communicationApps = matchingApps(
    apps,
    new RegExp(`(?:wechat|wecom|feishu|dingtalk|teams|slack|telegram|discord|zoom|tencent\\s*meeting)|${CN_COMMUNICATION_APP_PATTERN.source}`, 'i'),
  );
  add({
    id: 'communication_workflows',
    label: 'Communication and meeting workflows',
    ready: communicationApps.length > 0,
    confidence: communicationApps.length > 0 ? 0.9 : 0.35,
    evidence: communicationApps,
    suggestedPrompts: [
      { zh: CN_SYSTEM_EXPLORER_PROMPTS.communicationWorkflows[0], en: 'Review my communication and meeting apps and design a message and meeting workflow.' },
      { zh: CN_SYSTEM_EXPLORER_PROMPTS.communicationWorkflows[1], en: 'For my next meeting, take notes, organize actions, and ask before sending anything.' },
    ],
  });

  const developerApps = matchingApps(apps, /(?:visual\s*studio|vscode|cursor|jetbrains|pycharm|webstorm|intellij|xcode|android\s*studio|git|docker|postman)/i);
  const developerRuntimeEvidence = boundedUniqueText([
    ...developerApps,
    runtimes?.git,
    runtimes?.node,
    runtimes?.python,
    runtimes?.docker,
    ...(runtimes?.wslDistributions || []).map(value => `WSL ${value}`),
  ]);
  add({
    id: 'software_development',
    label: 'Software development and repository work',
    ready: developerRuntimeEvidence.length > 0,
    confidence: developerRuntimeEvidence.length >= 2 ? 0.94 : developerRuntimeEvidence.length ? 0.72 : 0.25,
    evidence: developerRuntimeEvidence,
    suggestedPrompts: [
      { zh: CN_SYSTEM_EXPLORER_PROMPTS.softwareDevelopment[0], en: 'Audit my current project, report risks first, then fix and test the approved scope.' },
      { zh: CN_SYSTEM_EXPLORER_PROMPTS.softwareDevelopment[1], en: 'Check whether this development environment is complete and list workflows that can be automated.' },
    ],
  });

  const creativeApps = matchingApps(apps, /(?:photoshop|illustrator|after\s*effects|premiere|davinci|figma|sketch|blender|cinema\s*4d|autocad|revit|solidworks|rhino|3ds\s*max|canva)/i);
  add({
    id: 'creative_design',
    label: 'Design, media, and CAD workflows',
    ready: creativeApps.length > 0,
    confidence: creativeApps.length > 0 ? 0.9 : 0.25,
    evidence: creativeApps,
    suggestedPrompts: [
      { zh: CN_SYSTEM_EXPLORER_PROMPTS.creativeDesign[0], en: 'Based on my design apps, give me a workflow from brief to delivery files.' },
      { zh: CN_SYSTEM_EXPLORER_PROMPTS.creativeDesign[1], en: 'Check which apps and assets this design task needs and tell me what is missing first.' },
    ],
  });

  const financeApps = matchingApps(
    apps,
    new RegExp(`(?:quickbooks|xero|sage|invoice|accounting|erp|excel|wps)|${CN_FINANCE_APP_PATTERN.source}`, 'i'),
  );
  add({
    id: 'finance_and_operations',
    label: 'Finance and operational data workflows',
    ready: financeApps.length > 0,
    confidence: financeApps.length > 0 ? 0.78 : 0.25,
    evidence: financeApps,
    suggestedPrompts: [
      { zh: CN_SYSTEM_EXPLORER_PROMPTS.financeAndOperations[0], en: 'Based on my finance and spreadsheet apps, identify reconciliation, reporting, and analysis that can be semi-automated.' },
    ],
  });

  const localAiEvidence = boundedUniqueText([
    ...(runtimes?.localAiRuntimes || []),
    ...matchingApps(apps, /(?:ollama|lm\s*studio|jan|chatbox|stable\s*diffusion|comfyui)/i),
    ...snapshot.hardware.gpus,
  ]);
  add({
    id: 'local_ai',
    label: 'Local AI and private model workloads',
    ready: Boolean(runtimes?.localAiRuntimes?.length),
    confidence: runtimes?.localAiRuntimes?.length ? 0.9 : snapshot.hardware.gpus.length ? 0.55 : 0.2,
    evidence: localAiEvidence,
    suggestedPrompts: [
      { zh: CN_SYSTEM_EXPLORER_PROMPTS.localAi[0], en: 'Assess which local models this computer can run and explain the privacy, speed, and quality trade-offs.' },
    ],
  });

  const peripheralEvidence = boundedUniqueText([
    ...(snapshot.peripherals?.cameras || []).map(value => `Camera: ${value}`),
    ...(snapshot.peripherals?.audioDevices || []).map(value => `Audio: ${value}`),
    ...(snapshot.peripherals?.printers || []).map(value => `Printer: ${value}`),
    ...(snapshot.peripherals?.displays || []).map(value => `Display: ${value.name}`),
  ], 16);
  add({
    id: 'device_and_voice',
    label: 'Voice, camera, display, and peripheral workflows',
    ready: peripheralEvidence.length > 0,
    confidence: peripheralEvidence.length > 0 ? 0.82 : 0.3,
    evidence: peripheralEvidence,
    suggestedPrompts: [
      { zh: CN_SYSTEM_EXPLORER_PROMPTS.deviceAndVoice[0], en: 'Check which Lumi features my microphone, camera, and displays support, and ask only when permission is needed.' },
    ],
  });

  opportunities.sort((left, right) => (
    Number(right.ready) - Number(left.ready)
    || right.confidence - left.confidence
    || left.id.localeCompare(right.id)
  ));
  const firstQuestions = [
    { zh: CN_SYSTEM_EXPLORER_PROMPTS.firstQuestion, en: 'What can you do on this computer now? Separate verified, needs setup, and unavailable.' },
    ...opportunities
      .filter(item => item.ready)
      .flatMap(item => item.suggestedPrompts)
      .slice(0, 5),
  ];
  const evidenceGaps = [
    snapshot.peripherals?.cameras.length ? '' : 'camera_not_detected_or_not_enumerable',
    snapshot.peripherals?.audioDevices.length ? '' : 'audio_device_not_detected_or_not_enumerable',
    runtimes?.localAiRuntimes.length ? '' : 'local_ai_runtime_not_detected',
    apps.length >= APP_SCAN_LIMIT ? 'application_inventory_limit_reached' : '',
  ].filter(Boolean);
  return {
    version: 1,
    generatedAt: snapshot.timestamp,
    opportunities,
    firstQuestions,
    evidenceGaps,
  };
}

export function getSystemInspectionPolicy(): SystemInspectionPolicy {
  return {
    version: 1,
    fileContentsRead: false,
    fileNamesPersisted: false,
    browserHistoryRead: false,
    credentialsRead: false,
    uniqueHardwareIdsPersisted: false,
    collectedCategories: [
      'operating_system',
      'cpu_memory_gpu',
      'local_disks',
      'installed_application_names',
      'startup_and_running_service_names',
      'developer_runtime_versions',
      'display_audio_camera_printer_usb_names',
      'network_interface_names_and_addresses',
      'bounded_directory_counts_and_sizes',
    ],
  };
}

function enrichSystemSnapshot(snapshot: SystemSnapshot): SystemSnapshot {
  snapshot.peripherals = scanPeripheralProfile();
  snapshot.runtimes = scanRuntimeProfile(snapshot.software.installedApps);
  snapshot.inspectionPolicy = getSystemInspectionPolicy();
  snapshot.capabilityProfile = deriveComputerCapabilityProfile(snapshot);
  return snapshot;
}

export function collectFirstBootSnapshot(): SystemSnapshot {
  return enrichSystemSnapshot({
    id: `explore_${Date.now()}`,
    timestamp: new Date().toISOString(),
    type: "first_boot",
    computerScope: 'lumi_server_host',
    hardware: scanHardwareProfile(),
    software: scanSoftwareProfile(),
    filesystem: scanUserDirectories(),
    network: getNetworkInfo(),
    changeSummary: `Initial exploration complete. ${os.hostname()} — ${os.cpus()[0]?.model || "Unknown CPU"} — ${Math.round(os.totalmem() / (1024 ** 3))}GB RAM`,
  });

  // Profession detection — what does this user do?
}

export function persistFirstBootExploration(snapshot: SystemSnapshot): SystemSnapshot {
  if (!isSystemExplorationAllowed()) {
    throw new Error('Local computer exploration requires an explicit local-admin grant.');
  }
  // Persist
  const db = readDB();
  if (!(db as any).systemSnapshots) (db as any).systemSnapshots = [];
  (db as any).systemSnapshots.push(snapshot);

  // Mark exploration complete
  if (!(db as any).systemFlags) (db as any).systemFlags = {};
  (db as any).systemFlags.firstBootExplored = true;
  (db as any).systemFlags.lastDailyScan = snapshot.timestamp;

  writeDB(db);

  console.log(`[Explorer] First-boot complete. Host: ${snapshot.hardware.hostname}, Apps: ${snapshot.software.installedApps.length}, Disks: ${snapshot.hardware.disks.length}`);
  return snapshot;
}

export function runFirstBootExploration(): SystemSnapshot {
  if (!isSystemExplorationAllowed()) {
    throw new Error('Local computer exploration requires an explicit local-admin grant.');
  }
  console.log("[Explorer] First-boot exploration starting...");
  return persistFirstBootExploration(collectFirstBootSnapshot());
}

export function runDailyScan(): SystemSnapshot | null {
  if (!isSystemExplorationAllowed()) {
    console.log('[Explorer] Scan skipped because local computer exploration is not authorized.');
    return null;
  }
  console.log("[Explorer] Daily scan starting...");

  return persistDailyExploration(collectFirstBootSnapshot());
}

/** Persist an already-collected worker snapshot as a daily refresh. */
export function persistDailyExploration(collected: SystemSnapshot): SystemSnapshot {
  if (!isSystemExplorationAllowed()) {
    throw new Error('Local computer exploration requires an explicit local-admin grant.');
  }
  const db = readDB();
  const lastSnapshot = ((db as any).systemSnapshots || [])
    .filter((s: SystemSnapshot) => s.type === "daily_scan")
    .sort((a: SystemSnapshot, b: SystemSnapshot) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
  const timestamp = collected.timestamp || new Date().toISOString();
  const snapshot: SystemSnapshot = {
    ...collected,
    id: `scan_${Date.now()}`,
    timestamp,
    type: 'daily_scan',
    computerScope: 'lumi_server_host',
    inspectionPolicy: collected.inspectionPolicy || getSystemInspectionPolicy(),
    changeSummary: undefined,
  };
  if (!snapshot.capabilityProfile) {
    snapshot.capabilityProfile = deriveComputerCapabilityProfile(snapshot);
  }

  // Compute changes from last scan
  if (lastSnapshot) {
    const changes: string[] = [];

    const memDelta = snapshot.hardware.totalMemoryGB - lastSnapshot.hardware.totalMemoryGB;
    if (Math.abs(memDelta) > 0.5) changes.push(`Memory ${memDelta > 0 ? '+' : ''}${memDelta.toFixed(1)}GB`);

    const newApps = snapshot.software.installedApps.filter(a => !lastSnapshot.software.installedApps.includes(a));
    const removedApps = lastSnapshot.software.installedApps.filter(a => !snapshot.software.installedApps.includes(a));
    if (newApps.length > 0) changes.push(`${newApps.length} new app(s): ${newApps.slice(0, 5).join(", ")}`);
    if (removedApps.length > 0) changes.push(`${removedApps.length} removed app(s): ${removedApps.slice(0, 3).join(", ")}`);

    const diskDeltas = snapshot.hardware.disks.filter(d => {
      const prev = lastSnapshot.hardware.disks.find(p => p.name === d.name);
      return prev && Math.abs(d.freeGB - prev.freeGB) > 2;
    });
    for (const d of diskDeltas) {
      const prev = lastSnapshot.hardware.disks.find(p => p.name === d.name)!;
      const delta = d.freeGB - prev.freeGB;
      changes.push(`${d.name}: disk free ${delta > 0 ? '+' : ''}${delta.toFixed(1)}GB (${d.freeGB.toFixed(1)}GB free)`);
    }

    if (snapshot.filesystem.totalUserFiles !== lastSnapshot.filesystem.totalUserFiles) {
      const delta = snapshot.filesystem.totalUserFiles - lastSnapshot.filesystem.totalUserFiles;
      changes.push(`User files ${delta > 0 ? '+' : ''}${delta} (total: ${snapshot.filesystem.totalUserFiles})`);
    }

    snapshot.changeSummary = changes.length > 0 ? changes.join(" | ") : "No significant changes since last scan";
  } else {
    snapshot.changeSummary = "First daily scan — baseline established";
  }

  // Persist
  if (!(db as any).systemSnapshots) (db as any).systemSnapshots = [];
  (db as any).systemSnapshots.push(snapshot);

  // Keep max 90 daily snapshots
  const dailyScans = (db as any).systemSnapshots.filter((s: SystemSnapshot) => s.type === "daily_scan");
  if (dailyScans.length > 90) {
    const oldest = dailyScans.sort((a: SystemSnapshot, b: SystemSnapshot) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())[0];
    (db as any).systemSnapshots = (db as any).systemSnapshots.filter((s: SystemSnapshot) => s.id !== oldest.id);
  }

  if (!(db as any).systemFlags) (db as any).systemFlags = {};
  (db as any).systemFlags.lastDailyScan = snapshot.timestamp;

  writeDB(db);

  console.log(`[Explorer] Daily scan complete. ${snapshot.changeSummary}`);
  return snapshot;
}

export function getLatestExploration(): SystemSnapshot | null {
  const db = readDB();
  const snapshots = (db as any).systemSnapshots || [];
  return snapshots.sort((a: SystemSnapshot, b: SystemSnapshot) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0] || null;
}

export function getExplorationHistory(limit = 30): SystemSnapshot[] {
  const db = readDB();
  return ((db as any).systemSnapshots || [])
    .sort((a: SystemSnapshot, b: SystemSnapshot) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit);
}

export function isFirstBootComplete(): boolean {
  const db = readDB();
  return !!((db as any).systemFlags?.firstBootExplored);
}

export function getSystemExplorationConsent(): SystemExplorationConsent {
  const db = readDB();
  const stored = (db as any).systemFlags?.systemExplorationConsent;
  if (stored?.version === 1 && (stored.status === 'granted' || stored.status === 'declined')) {
    return {
      version: 1,
      status: stored.status,
      ...(typeof stored.updatedAt === 'string' ? { updatedAt: stored.updatedAt } : {}),
      ...(typeof stored.grantedByUserId === 'string'
        ? { grantedByUserId: stored.grantedByUserId }
        : {}),
    };
  }
  // Existing installations completed this local-only scan before consent was
  // versioned. Preserve their current profile without silently treating a new
  // installation as authorized.
  if ((db as any).systemFlags?.firstBootExplored) {
    return { version: 1, status: 'legacy_local_scan' };
  }
  return { version: 1, status: 'not_decided' };
}

export function setSystemExplorationConsent(
  granted: boolean,
  grantedByUserId: string,
): SystemExplorationConsent {
  const db = readDB();
  if (!(db as any).systemFlags) (db as any).systemFlags = {};
  const consent: SystemExplorationConsent = {
    version: 1,
    status: granted ? 'granted' : 'declined',
    updatedAt: new Date().toISOString(),
    ...(granted ? { grantedByUserId: String(grantedByUserId || '').trim().slice(0, 180) } : {}),
  };
  (db as any).systemFlags.systemExplorationConsent = consent;
  writeDB(db);
  return consent;
}

export function isSystemExplorationAllowed(): boolean {
  const consent = getSystemExplorationConsent();
  return consent.status === 'granted' || consent.status === 'legacy_local_scan';
}
