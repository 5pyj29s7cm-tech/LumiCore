import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { getDataRoot } from '../config/data_path';
import { ensurePrivateRuntimeDirectory, restrictOwnerAccess } from '../config/runtime_file_security';

const LEASE_VERSION = 1;
const MAX_COORDINATION_FILE_BYTES = 8 * 1024;
const MAX_ACQUIRE_ATTEMPTS = 8;
const OWNER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export interface DataRootLeaseRecord {
  version: 1;
  ownerToken: string;
  pid: number;
  hostname: string;
  dataRoot: string;
  dataRootDigest: string;
  processStartIdentity: string;
  acquiredAt: string;
}

interface ReclaimClaimRecord {
  version: 1;
  staleOwnerToken: string;
  claimantToken: string;
  pid: number;
  hostname: string;
  processStartIdentity: string;
  createdAt: string;
}

interface HeldLease {
  record: DataRootLeaseRecord;
  leasePath: string;
  runtimeDir: string;
}

type ProcessProbe =
  | { state: 'alive'; startIdentity: string }
  | { state: 'dead' }
  | { state: 'unknown'; reason: string };

export class DataRootLeaseError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(`[${code}] ${message}`, options);
    this.name = 'DataRootLeaseError';
    this.code = code;
  }
}

let heldLease: HeldLease | null = null;
let exitHookInstalled = false;

function leaseError(code: string, message: string, cause?: unknown): DataRootLeaseError {
  return new DataRootLeaseError(code, message, cause === undefined ? undefined : { cause });
}

function normalizeCanonicalPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function digestDataRoot(canonicalRoot: string): string {
  return crypto.createHash('sha256').update(normalizeCanonicalPath(canonicalRoot), 'utf8').digest('hex');
}

function randomOwnerToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function currentHostname(): string {
  return os.hostname().trim().toLocaleLowerCase('en-US');
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function probeWindowsProcess(pid: number): ProcessProbe {
  const script = [
    'try {',
    `  $p = [System.Diagnostics.Process]::GetProcessById(${pid});`,
    '  [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks);',
    '} catch [System.ArgumentException] {',
    '  exit 3;',
    '} catch {',
    '  [Console]::Error.Write($_.Exception.Message);',
    '  exit 4;',
    '}',
  ].join(' ');
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 16 * 1024,
  });

  if (result.status === 3) return { state: 'dead' };
  const ticks = String(result.stdout || '').trim();
  if (result.status === 0 && /^\d{10,}$/.test(ticks)) {
    return { state: 'alive', startIdentity: `win-start-ticks:${ticks}` };
  }
  return {
    state: 'unknown',
    reason: String(result.error?.message || result.stderr || `PowerShell exited with ${result.status}`).trim(),
  };
}

function probeLinuxProcess(pid: number): ProcessProbe {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return { state: 'unknown', reason: 'invalid /proc process stat' };
    const fieldsAfterCommand = stat.slice(commandEnd + 2).trim().split(/\s+/);
    // /proc/<pid>/stat field 22 is the process start time. The sliced array
    // starts at field 3, so starttime is index 19.
    const startTime = fieldsAfterCommand[19];
    if (!/^\d+$/.test(startTime || '')) {
      return { state: 'unknown', reason: 'missing /proc process start time' };
    }
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (!bootId) return { state: 'unknown', reason: 'missing Linux boot identity' };
    return { state: 'alive', startIdentity: `linux:${bootId}:${startTime}` };
  } catch (error) {
    if (isMissingError(error) || (error as NodeJS.ErrnoException)?.code === 'ESRCH') return { state: 'dead' };
    return { state: 'unknown', reason: (error as Error)?.message || String(error) };
  }
}

function processExists(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function probeDarwinProcess(pid: number): ProcessProbe {
  const initialState = processExists(pid);
  if (initialState === 'dead') return { state: 'dead' };
  if (initialState === 'unknown') return { state: 'unknown', reason: 'unable to probe process' };

  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 16 * 1024,
  });
  const startedAt = String(result.stdout || '').trim().replace(/\s+/g, ' ');
  if (result.status === 0 && startedAt) {
    return { state: 'alive', startIdentity: `darwin-lstart:${startedAt}` };
  }
  const finalState = processExists(pid);
  if (finalState === 'dead') return { state: 'dead' };
  return {
    state: 'unknown',
    reason: String(result.error?.message || result.stderr || `ps exited with ${result.status}`).trim(),
  };
}

function probeProcess(pid: number): ProcessProbe {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown', reason: 'invalid pid' };
  if (process.platform === 'win32') return probeWindowsProcess(pid);
  if (process.platform === 'linux') return probeLinuxProcess(pid);
  if (process.platform === 'darwin') return probeDarwinProcess(pid);
  return { state: 'unknown', reason: `unsupported platform ${process.platform}` };
}

function requireCurrentProcessStartIdentity(): string {
  const probe = probeProcess(process.pid);
  if (probe.state !== 'alive') {
    throw leaseError(
      'DATA_ROOT_LEASE_IDENTITY_UNAVAILABLE',
      `Cannot establish the backend process start identity: ${probe.state === 'unknown' ? probe.reason : 'current process not found'}`,
    );
  }
  return probe.startIdentity;
}

function assertCoordinationFile(pathname: string, kind: string): fs.Stats {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(pathname);
  } catch (error) {
    if (isMissingError(error)) throw error;
    throw leaseError('DATA_ROOT_LEASE_UNREADABLE', `Cannot inspect ${kind}`, error);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw leaseError('DATA_ROOT_LEASE_INVALID', `${kind} must be a regular file`);
  }
  if (metadata.size <= 0 || metadata.size > MAX_COORDINATION_FILE_BYTES) {
    throw leaseError('DATA_ROOT_LEASE_INVALID', `${kind} has an invalid size`);
  }
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw leaseError('DATA_ROOT_LEASE_INVALID', `${kind} is not owner-private`);
  }
  return metadata;
}

function readCoordinationJson(pathname: string, kind: string): unknown {
  assertCoordinationFile(pathname, kind);
  let serialized: string;
  try {
    serialized = fs.readFileSync(pathname, 'utf8');
  } catch (error) {
    throw leaseError('DATA_ROOT_LEASE_UNREADABLE', `Cannot read ${kind}`, error);
  }
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw leaseError('DATA_ROOT_LEASE_INVALID', `${kind} is not valid JSON`, error);
  }
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function readLeaseRecord(leasePath: string): DataRootLeaseRecord {
  const value = readCoordinationJson(leasePath, 'backend data-root lease') as Partial<DataRootLeaseRecord> | null;
  if (
    !value
    || value.version !== LEASE_VERSION
    || !OWNER_TOKEN_PATTERN.test(String(value.ownerToken || ''))
    || !Number.isSafeInteger(value.pid)
    || Number(value.pid) <= 0
    || typeof value.hostname !== 'string'
    || !value.hostname.trim()
    || typeof value.dataRoot !== 'string'
    || !value.dataRoot
    || !/^[a-f0-9]{64}$/.test(String(value.dataRootDigest || ''))
    || typeof value.processStartIdentity !== 'string'
    || value.processStartIdentity.length < 8
    || value.processStartIdentity.length > 512
    || !isIsoTimestamp(value.acquiredAt)
  ) {
    throw leaseError('DATA_ROOT_LEASE_INVALID', 'Backend data-root lease has an invalid schema');
  }
  return value as DataRootLeaseRecord;
}

function readReclaimClaim(claimPath: string): ReclaimClaimRecord {
  const value = readCoordinationJson(claimPath, 'backend lease reclaim claim') as Partial<ReclaimClaimRecord> | null;
  if (
    !value
    || value.version !== LEASE_VERSION
    || !OWNER_TOKEN_PATTERN.test(String(value.staleOwnerToken || ''))
    || !OWNER_TOKEN_PATTERN.test(String(value.claimantToken || ''))
    || !Number.isSafeInteger(value.pid)
    || Number(value.pid) <= 0
    || typeof value.hostname !== 'string'
    || !value.hostname.trim()
    || typeof value.processStartIdentity !== 'string'
    || value.processStartIdentity.length < 8
    || value.processStartIdentity.length > 512
    || !isIsoTimestamp(value.createdAt)
  ) {
    throw leaseError('DATA_ROOT_LEASE_INVALID', 'Backend lease reclaim claim has an invalid schema');
  }
  return value as ReclaimClaimRecord;
}

function recordsHaveSameOwner(left: DataRootLeaseRecord, right: DataRootLeaseRecord): boolean {
  return left.ownerToken === right.ownerToken
    && left.pid === right.pid
    && left.hostname === right.hostname
    && left.dataRootDigest === right.dataRootDigest
    && left.processStartIdentity === right.processStartIdentity;
}

function claimsHaveSameOwner(left: ReclaimClaimRecord, right: ReclaimClaimRecord): boolean {
  return left.staleOwnerToken === right.staleOwnerToken
    && left.claimantToken === right.claimantToken
    && left.pid === right.pid
    && left.hostname === right.hostname
    && left.processStartIdentity === right.processStartIdentity;
}

/** Publish a complete coordination record without ever exposing a partial file. */
function publishExclusive(runtimeDir: string, targetPath: string, value: unknown): boolean {
  const temporaryPath = path.join(
    runtimeDir,
    `.backend-lease-${process.pid}-${crypto.randomBytes(12).toString('hex')}.tmp`,
  );
  const serialized = `${JSON.stringify(value)}\n`;
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, serialized, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    restrictOwnerAccess(temporaryPath);
    try {
      // A hard link is an atomic, no-overwrite publication of the already
      // complete and owner-private inode on all supported desktop filesystems.
      fs.linkSync(temporaryPath, targetPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
      throw leaseError(
        'DATA_ROOT_LEASE_UNSUPPORTED',
        'The Lumi data root must support atomic local hard links for its backend lease',
        error,
      );
    }
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
  }
}

function assertRecordMatchesRoot(record: DataRootLeaseRecord, canonicalRoot: string, rootDigest: string): void {
  if (
    record.hostname.toLocaleLowerCase('en-US') !== currentHostname()
    || normalizeCanonicalPath(record.dataRoot) !== normalizeCanonicalPath(canonicalRoot)
    || record.dataRootDigest !== rootDigest
  ) {
    throw leaseError(
      'DATA_ROOT_LEASE_SCOPE_MISMATCH',
      'Existing backend lease is not verifiably bound to this host and canonical Lumi data root',
    );
  }
}

function classifyLeaseOwner(record: DataRootLeaseRecord): 'live' | 'stale' {
  const probe = probeProcess(record.pid);
  if (probe.state === 'unknown') {
    throw leaseError(
      'DATA_ROOT_LEASE_OWNER_UNREADABLE',
      `Cannot verify existing backend process ${record.pid}: ${probe.reason}`,
    );
  }
  if (probe.state === 'dead') return 'stale';
  return probe.startIdentity === record.processStartIdentity ? 'live' : 'stale';
}

function removeOwnedClaim(claimPath: string, expected: ReclaimClaimRecord): boolean {
  let current: ReclaimClaimRecord;
  try {
    current = readReclaimClaim(claimPath);
  } catch (error) {
    if (isMissingError(error)) return false;
    return false;
  }
  if (!claimsHaveSameOwner(current, expected)) return false;
  try {
    fs.rmSync(claimPath);
    return true;
  } catch {
    return false;
  }
}

function acquireReclaimClaim(
  runtimeDir: string,
  staleOwnerToken: string,
  processStartIdentity: string,
): { path: string; record: ReclaimClaimRecord } {
  const claimPath = path.join(runtimeDir, `.backend-instance-reclaim-${staleOwnerToken}.lock`);
  const record: ReclaimClaimRecord = {
    version: LEASE_VERSION,
    staleOwnerToken,
    claimantToken: randomOwnerToken(),
    pid: process.pid,
    hostname: currentHostname(),
    processStartIdentity,
    createdAt: new Date().toISOString(),
  };

  if (publishExclusive(runtimeDir, claimPath, record)) return { path: claimPath, record };

  const existing = readReclaimClaim(claimPath);
  if (existing.staleOwnerToken !== staleOwnerToken || existing.hostname.toLocaleLowerCase('en-US') !== currentHostname()) {
    throw leaseError('DATA_ROOT_LEASE_RECLAIM_UNREADABLE', 'Existing lease reclaim claim is outside this host scope');
  }
  const probe = probeProcess(existing.pid);
  if (probe.state === 'unknown') {
    throw leaseError(
      'DATA_ROOT_LEASE_RECLAIM_UNREADABLE',
      `Cannot verify lease reclaimer ${existing.pid}: ${probe.reason}`,
    );
  }
  if (probe.state === 'alive' && probe.startIdentity === existing.processStartIdentity) {
    throw leaseError('DATA_ROOT_LEASE_RECLAIMING', 'Another process is safely reclaiming the stale backend lease');
  }

  // A claimant crashed before completing recovery. Rename its exact path out
  // of the way, then create a fresh no-overwrite claim. Any concurrent winner
  // causes this process to fail closed and retry from the top-level loop.
  const quarantinePath = path.join(
    runtimeDir,
    `.backend-instance-dead-reclaimer-${existing.claimantToken}-${crypto.randomBytes(6).toString('hex')}`,
  );
  let quarantineCanBeRemoved = false;
  try {
    fs.renameSync(claimPath, quarantinePath);
    const moved = readReclaimClaim(quarantinePath);
    if (!claimsHaveSameOwner(moved, existing)) {
      try {
        fs.linkSync(quarantinePath, claimPath);
        quarantineCanBeRemoved = true;
      } catch {}
      throw leaseError('DATA_ROOT_LEASE_RECLAIM_UNREADABLE', 'Lease reclaim ownership changed during recovery');
    }
    quarantineCanBeRemoved = true;
    if (!publishExclusive(runtimeDir, claimPath, record)) {
      throw leaseError('DATA_ROOT_LEASE_RECLAIMING', 'Another process won stale-lease recovery');
    }
    return { path: claimPath, record };
  } catch (error) {
    if (isMissingError(error)) {
      if (publishExclusive(runtimeDir, claimPath, record)) return { path: claimPath, record };
      throw leaseError('DATA_ROOT_LEASE_RECLAIMING', 'Another process won stale-lease recovery', error);
    }
    throw error;
  } finally {
    if (quarantineCanBeRemoved) {
      try { fs.rmSync(quarantinePath, { force: true }); } catch {}
    }
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    releaseDataRootLease();
  });
}

/**
 * Acquire the sole backend lease for the canonical Lumi data root. This is
 * intentionally synchronous so importing db_layer cannot migrate or open the
 * database before ownership has been established.
 */
export function acquireDataRootLease(): DataRootLeaseRecord {
  const requestedRoot = path.resolve(getDataRoot());
  fs.mkdirSync(requestedRoot, { recursive: true, mode: 0o700 });
  const requestedMetadata = fs.lstatSync(requestedRoot);
  if (!requestedMetadata.isDirectory()) {
    throw leaseError('DATA_ROOT_LEASE_INVALID_ROOT', 'Lumi data root must resolve to a directory');
  }

  const runtimeDir = ensurePrivateRuntimeDirectory(path.join(requestedRoot, 'runtime'));
  const canonicalRoot = fs.realpathSync.native(path.dirname(runtimeDir));
  const rootDigest = digestDataRoot(canonicalRoot);
  const leasePath = path.join(runtimeDir, 'backend-instance.lock');
  const processStartIdentity = requireCurrentProcessStartIdentity();

  if (heldLease) {
    if (heldLease.record.dataRootDigest === rootDigest) return heldLease.record;
    throw leaseError('DATA_ROOT_LEASE_ALREADY_OWNED', 'This process already owns a different Lumi data root');
  }

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const candidate: DataRootLeaseRecord = {
      version: LEASE_VERSION,
      ownerToken: randomOwnerToken(),
      pid: process.pid,
      hostname: currentHostname(),
      dataRoot: canonicalRoot,
      dataRootDigest: rootDigest,
      processStartIdentity,
      acquiredAt: new Date().toISOString(),
    };
    if (publishExclusive(runtimeDir, leasePath, candidate)) {
      heldLease = { record: candidate, leasePath, runtimeDir };
      installExitHook();
      return candidate;
    }

    let existing: DataRootLeaseRecord;
    try {
      existing = readLeaseRecord(leasePath);
    } catch (error) {
      if (isMissingError(error)) continue;
      throw error;
    }
    assertRecordMatchesRoot(existing, canonicalRoot, rootDigest);
    if (classifyLeaseOwner(existing) === 'live') {
      throw leaseError(
        'DATA_ROOT_LEASE_HELD',
        `Lumi data root is already owned by live backend PID ${existing.pid} (acquired ${existing.acquiredAt})`,
      );
    }

    const claim = acquireReclaimClaim(runtimeDir, existing.ownerToken, processStartIdentity);
    let quarantinePath = '';
    let quarantineCanBeRemoved = false;
    try {
      // Re-read only after winning the claim. A competing reclaimer may have
      // replaced the stale generation between our first read and claim.
      let confirmed: DataRootLeaseRecord;
      try {
        confirmed = readLeaseRecord(leasePath);
      } catch (error) {
        if (isMissingError(error)) continue;
        throw error;
      }
      if (!recordsHaveSameOwner(confirmed, existing)) continue;
      assertRecordMatchesRoot(confirmed, canonicalRoot, rootDigest);
      if (classifyLeaseOwner(confirmed) === 'live') {
        throw leaseError('DATA_ROOT_LEASE_HELD', `Backend PID ${confirmed.pid} became live during lease recovery`);
      }

      quarantinePath = path.join(
        runtimeDir,
        `.backend-instance-stale-${confirmed.ownerToken}-${crypto.randomBytes(6).toString('hex')}`,
      );
      try {
        fs.renameSync(leasePath, quarantinePath);
      } catch (error) {
        if (isMissingError(error)) continue;
        throw leaseError('DATA_ROOT_LEASE_RECLAIM_FAILED', 'Cannot quarantine the stale backend lease', error);
      }
      const moved = readLeaseRecord(quarantinePath);
      if (!recordsHaveSameOwner(moved, confirmed)) {
        try {
          fs.linkSync(quarantinePath, leasePath);
          quarantineCanBeRemoved = true;
        } catch {}
        throw leaseError('DATA_ROOT_LEASE_RECLAIM_FAILED', 'Backend lease ownership changed during recovery');
      }
      quarantineCanBeRemoved = true;
      // Loop back through atomic publication. Another process may legally win
      // the empty lease path; in that case its live record will be honored.
    } finally {
      if (quarantinePath && quarantineCanBeRemoved) {
        try { fs.rmSync(quarantinePath, { force: true }); } catch {}
      }
      removeOwnedClaim(claim.path, claim.record);
    }
  }

  throw leaseError('DATA_ROOT_LEASE_CONTENTION', 'Could not acquire the Lumi data-root lease after bounded retries');
}

/** Release only the exact generation created and still owned by this process. */
export function releaseDataRootLease(): boolean {
  const owned = heldLease;
  if (!owned) return false;

  let current: DataRootLeaseRecord;
  try {
    current = readLeaseRecord(owned.leasePath);
  } catch {
    heldLease = null;
    return false;
  }
  if (!recordsHaveSameOwner(current, owned.record)) {
    heldLease = null;
    return false;
  }

  const releasePath = path.join(
    owned.runtimeDir,
    `.backend-instance-release-${owned.record.ownerToken}-${crypto.randomBytes(6).toString('hex')}`,
  );
  try {
    fs.renameSync(owned.leasePath, releasePath);
    const moved = readLeaseRecord(releasePath);
    if (!recordsHaveSameOwner(moved, owned.record)) {
      try { fs.linkSync(releasePath, owned.leasePath); } catch {}
      return false;
    }
    fs.rmSync(releasePath);
    return true;
  } catch {
    return false;
  } finally {
    heldLease = null;
  }
}

export function getDataRootLeasePath(): string {
  return path.join(getDataRoot(), 'runtime', 'backend-instance.lock');
}
