import os from "os";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { readDB, writeDB } from "../../db_layer";
import { isAppDiscoveryNoise } from "../../shared/system_apps";
import { detectProfession, saveProfessionProfile } from "./professions";

export interface SystemSnapshot {
  id: string;
  timestamp: string;
  type: "first_boot" | "daily_scan";
  hardware: HardwareProfile;
  software: SoftwareProfile;
  filesystem: FilesystemOverview;
  network: NetworkProfile;
  changeSummary?: string;
  computerScope: "lumi_server_host";
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
  try { return execSync(cmd, { encoding: "utf8", timeout: 15000, windowsHide: true }).trim(); }
  catch { return ""; }
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

export function collectFirstBootSnapshot(): SystemSnapshot {
  return {
    id: `explore_${Date.now()}`,
    timestamp: new Date().toISOString(),
    type: "first_boot",
    computerScope: 'lumi_server_host',
    hardware: scanHardwareProfile(),
    software: scanSoftwareProfile(),
    filesystem: scanUserDirectories(),
    network: getNetworkInfo(),
    changeSummary: `Initial exploration complete. ${os.hostname()} — ${os.cpus()[0]?.model || "Unknown CPU"} — ${Math.round(os.totalmem() / (1024 ** 3))}GB RAM`,
  };

  // Profession detection — what does this user do?
}

export function persistFirstBootExploration(snapshot: SystemSnapshot): SystemSnapshot {
  let professionSummary = '';
  try {
    const profiles = detectProfession(snapshot.software.installedApps);
    if (profiles.length > 0) {
      saveProfessionProfile(profiles);
      professionSummary = ` | Professions: ${profiles.map(p => `${p.profession}(${Math.round(p.confidence * 100)}%)`).join(', ')}`;
      console.log(`[Explorer] Detected professions:`, profiles.map(p => `${p.profession} (${Math.round(p.confidence * 100)}%)`).join(', '));
    }
  } catch (err) { console.warn('[Explorer] Profession detection failed:', (err as Error).message); }

  // Persist
  const db = readDB();
  if (!(db as any).systemSnapshots) (db as any).systemSnapshots = [];
  (db as any).systemSnapshots.push(snapshot);

  // Mark exploration complete
  if (!(db as any).systemFlags) (db as any).systemFlags = {};
  (db as any).systemFlags.firstBootExplored = true;
  (db as any).systemFlags.lastDailyScan = snapshot.timestamp;

  writeDB(db);

  console.log(`[Explorer] First-boot complete. Host: ${snapshot.hardware.hostname}, Apps: ${snapshot.software.installedApps.length}, Disks: ${snapshot.hardware.disks.length}${professionSummary}`);
  return snapshot;
}

export function runFirstBootExploration(): SystemSnapshot {
  console.log("[Explorer] First-boot exploration starting...");
  return persistFirstBootExploration(collectFirstBootSnapshot());
}

export function runDailyScan(): SystemSnapshot | null {
  console.log("[Explorer] Daily scan starting...");

  const db = readDB();
  const lastSnapshot = ((db as any).systemSnapshots || [])
    .filter((s: SystemSnapshot) => s.type === "daily_scan")
    .sort((a: SystemSnapshot, b: SystemSnapshot) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

  const snapshot: SystemSnapshot = {
    id: `scan_${Date.now()}`,
    timestamp: new Date().toISOString(),
    type: "daily_scan",
    computerScope: 'lumi_server_host',
    hardware: scanHardwareProfile(),
    software: scanSoftwareProfile(),
    filesystem: scanUserDirectories(),
    network: getNetworkInfo(),
  };

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
