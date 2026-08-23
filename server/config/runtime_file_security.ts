import fs from 'fs';
import { execFileSync } from 'child_process';

let cachedWindowsUserSid = '';
const restrictedRuntimeDirectories = new Set<string>();

function getWindowsUserSid(): string {
  if (cachedWindowsUserSid) return cachedWindowsUserSid;
  const output = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const match = output.match(/"(S-\d+(?:-\d+)+)"\s*$/m);
  if (!match) throw new Error('Unable to resolve the current Windows user SID');
  cachedWindowsUserSid = match[1];
  return cachedWindowsUserSid;
}

/** Restrict a runtime handoff/lease path to the current OS user and administrators. */
export function restrictOwnerAccess(target: string, mode = 0o600): void {
  try { fs.chmodSync(target, mode); } catch {}
  if (process.platform !== 'win32') return;
  const userSid = getWindowsUserSid();
  const fullControl = mode === 0o700 ? '(OI)(CI)(F)' : '(F)';
  execFileSync('icacls.exe', [
    target,
    '/inheritance:r',
    '/grant:r',
    `*${userSid}:${fullControl}`,
    `*S-1-5-18:${fullControl}`,
    `*S-1-5-32-544:${fullControl}`,
  ], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

/**
 * Ensure runtime coordination files cannot be redirected through a symlink and
 * are private to the local Lumi owner. The resolved path is returned so callers
 * can bind records to the actual data root instead of a path alias.
 */
export function ensurePrivateRuntimeDirectory(runtimeDir: string): string {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const metadata = fs.lstatSync(runtimeDir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Lumi runtime path must be a real directory');
  }

  const resolvedRuntimeDir = fs.realpathSync.native(runtimeDir);
  try { fs.chmodSync(resolvedRuntimeDir, 0o700); } catch {}
  if (!restrictedRuntimeDirectories.has(resolvedRuntimeDir)) {
    restrictOwnerAccess(resolvedRuntimeDir, 0o700);
    restrictedRuntimeDirectories.add(resolvedRuntimeDir);
  }
  return resolvedRuntimeDir;
}
