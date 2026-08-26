import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { restrictOwnerAccess } from '../config/runtime_file_security';

const MAX_DPAPI_VALUE_CHARS = 16 * 1024;
const restrictedPrivateDirectories = new Set<string>();

export interface PrivateKeyProtectionAdapter {
  protectKey(key: Buffer): string;
  unprotectKey(value: string): Buffer;
}

export interface PrivateFilePersistenceAdapter {
  ensurePrivateDirectory(directory: string, requirePosixMode: boolean): void;
  writeTextAtomic(target: string, value: string, mode: number, requirePosixMode: boolean): void;
}

function runDpapi(script: string, input: string): string {
  if (process.platform !== 'win32') {
    throw new Error('Windows DPAPI is unavailable on this host.');
  }
  const output = execFileSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      // Secret key material is passed only through stdin. It is never exposed
      // in argv, the environment, or a temporary plaintext file.
      input,
    },
  ).trim();
  if (
    !output
    || output.length > MAX_DPAPI_VALUE_CHARS
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(output)
  ) throw new Error('Windows DPAPI returned an invalid protected value.');
  return output;
}

const PROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$raw=[Convert]::FromBase64String([Console]::In.ReadToEnd())',
  '$protected=[Security.Cryptography.ProtectedData]::Protect($raw,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($protected))',
].join(';');

const UNPROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$raw=[Convert]::FromBase64String([Console]::In.ReadToEnd())',
  '$plain=[Security.Cryptography.ProtectedData]::Unprotect($raw,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($plain))',
].join(';');

export const windowsDpapiKeyProtectionAdapter: PrivateKeyProtectionAdapter = {
  protectKey(key: Buffer): string {
    if (!Buffer.isBuffer(key) || key.length !== 32) {
      throw new Error('DPAPI private key must contain exactly 32 bytes.');
    }
    return runDpapi(PROTECT_SCRIPT, key.toString('base64'));
  },

  unprotectKey(value: string): Buffer {
    const protectedValue = String(value || '').trim();
    if (
      !protectedValue
      || protectedValue.length > MAX_DPAPI_VALUE_CHARS
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(protectedValue)
    ) throw new Error('DPAPI protected value is invalid.');
    const decoded = Buffer.from(runDpapi(UNPROTECT_SCRIPT, protectedValue), 'base64');
    if (decoded.length !== 32) throw new Error('DPAPI private key has an invalid length.');
    return decoded;
  },
};

function enforcePrivateMode(target: string, mode: number, requirePosixMode: boolean): void {
  const metadata = fs.lstatSync(target);
  if (metadata.isSymbolicLink()) throw new Error('Private persistence path must not be a symbolic link.');
  if (requirePosixMode) {
    fs.chmodSync(target, mode);
    if ((fs.statSync(target).mode & 0o777) !== mode) {
      throw new Error(`Private persistence path does not have mode ${mode.toString(8)}.`);
    }
    return;
  }
  // On Windows chmod is not an access-control boundary. Use the shared ACL
  // infrastructure so only the current user, SYSTEM, and administrators can
  // read the protected key or encrypted handoff file.
  restrictOwnerAccess(target, mode);
}

function fsyncDirectory(directory: string, requirePosixMode: boolean): void {
  if (!requirePosixMode) return;
  const directoryHandle = fs.openSync(directory, 'r');
  try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
}

function ensurePrivateDirectory(directory: string, requirePosixMode: boolean): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Private persistence directory must be a real directory.');
  }
  const resolved = fs.realpathSync.native(directory);
  if (requirePosixMode || !restrictedPrivateDirectories.has(resolved)) {
    enforcePrivateMode(directory, 0o700, requirePosixMode);
    restrictedPrivateDirectories.add(resolved);
  }
}

export const hostPrivateFilePersistenceAdapter: PrivateFilePersistenceAdapter = {
  ensurePrivateDirectory,

  writeTextAtomic(target: string, value: string, mode: number, requirePosixMode: boolean): void {
    const directory = path.dirname(target);
    // Call the implementation directly so this adapter remains safe when the
    // method is injected or invoked without an object receiver.
    ensurePrivateDirectory(directory, requirePosixMode);
    const temporary = path.join(
      directory,
      `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    let handle: number | null = null;
    try {
      handle = fs.openSync(temporary, 'wx', mode);
      fs.writeFileSync(handle, value, { encoding: 'utf8' });
      fs.fsyncSync(handle);
      fs.closeSync(handle);
      handle = null;
      enforcePrivateMode(temporary, mode, requirePosixMode);
      fs.renameSync(temporary, target);
      // Rename preserves the inode/file ACL. POSIX verifies the final mode as
      // an extra fail-closed check; Windows avoids a redundant icacls process.
      if (requirePosixMode) enforcePrivateMode(target, mode, true);
      else if (fs.lstatSync(target).isSymbolicLink()) {
        throw new Error('Private persistence target must not be a symbolic link.');
      }
      fsyncDirectory(directory, requirePosixMode);
    } finally {
      try { if (handle !== null) fs.closeSync(handle); } catch {}
      try { fs.unlinkSync(temporary); } catch {}
    }
  },
};
