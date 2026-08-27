import crypto from 'node:crypto';
import path from 'node:path';
import type {
  NativeClientIdentity,
  NativeClientIdentityClaim,
} from '../../shared/native_client_identity';

const MIN_PROCESS_STARTED_AT_MS = Date.UTC(2000, 0, 1);
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_EXECUTABLE_PATH_LENGTH = 2_048;
const MAX_APP_VERSION_LENGTH = 64;
const BUILD_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const APP_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isAbsoluteExecutablePath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

/**
 * Strictly validates the small, versioned native identity envelope. Values
 * outside these bounds are rejected rather than truncated so the registry can
 * never claim it has verified a value different from the native process.
 */
export function normalizeNativeClientIdentity(
  value: unknown,
  options: { nowMs?: number } = {},
): NativeClientIdentity | null {
  if (!isPlainRecord(value)) return null;
  const allowedKeys = new Set([
    'schemaVersion',
    'clientKind',
    'pid',
    'startedAtUnixMs',
    'executablePath',
    'executableSha256',
    'binaryHashUnavailable',
    'buildId',
    'buildIdSemantics',
    'sourceFingerprint',
    'sourceDirty',
    'appVersion',
  ]);
  const keys = Object.keys(value);
  if (keys.length !== allowedKeys.size || keys.some(key => !allowedKeys.has(key))) return null;
  if (value.schemaVersion !== 1) return null;
  const clientKind = value.clientKind;
  if (clientKind !== 'tauri' && clientKind !== 'local_acceptance_harness') return null;

  const pid = value.pid;
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0 || Number(pid) > 0xffff_ffff) return null;

  const startedAtUnixMs = value.startedAtUnixMs;
  const nowMs = options.nowMs ?? Date.now();
  if (
    !Number.isSafeInteger(startedAtUnixMs)
    || Number(startedAtUnixMs) < MIN_PROCESS_STARTED_AT_MS
    || Number(startedAtUnixMs) > nowMs + MAX_CLOCK_SKEW_MS
  ) return null;

  const executableSha256 = value.executableSha256;
  const binaryHashUnavailable = value.binaryHashUnavailable;
  if (typeof binaryHashUnavailable !== 'boolean') return null;
  if (binaryHashUnavailable) {
    if (executableSha256 !== null) return null;
  } else if (typeof executableSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(executableSha256)) {
    return null;
  }

  const executablePath = typeof value.executablePath === 'string' ? value.executablePath : '';
  if (
    !executablePath
    || executablePath !== executablePath.trim()
    || executablePath.length > MAX_EXECUTABLE_PATH_LENGTH
    || /[\u0000-\u001f\u007f]/.test(executablePath)
    || !isAbsoluteExecutablePath(executablePath)
  ) return null;

  const rawBuildId = typeof value.buildId === 'string' ? value.buildId : '';
  if (rawBuildId !== rawBuildId.trim()) return null;
  const buildId = rawBuildId.toLowerCase();
  if (!BUILD_ID_PATTERN.test(buildId)) return null;
  if (value.buildIdSemantics !== 'baseline_commit') return null;

  const sourceFingerprint = typeof value.sourceFingerprint === 'string'
    ? value.sourceFingerprint.toLowerCase()
    : '';
  if (!/^[a-f0-9]{64}$/.test(sourceFingerprint) || typeof value.sourceDirty !== 'boolean') return null;

  const appVersion = typeof value.appVersion === 'string' ? value.appVersion : '';
  if (
    !appVersion
    || appVersion !== appVersion.trim()
    || appVersion.length > MAX_APP_VERSION_LENGTH
    || !APP_VERSION_PATTERN.test(appVersion)
  ) return null;

  return {
    schemaVersion: 1,
    clientKind,
    pid: Number(pid),
    startedAtUnixMs: Number(startedAtUnixMs),
    startedAt: new Date(Number(startedAtUnixMs)).toISOString(),
    executablePath,
    executableSha256: typeof executableSha256 === 'string'
      ? executableSha256.toLowerCase()
      : null,
    binaryHashUnavailable,
    buildId,
    buildIdSemantics: 'baseline_commit',
    sourceFingerprint,
    sourceDirty: value.sourceDirty,
    appVersion,
    trustLevel: 'proof_bound_local_claim',
    osAttested: false,
    webviewProfileTrustLevel: 'unbound',
  };
}

export function nativeClientIdentitiesEqual(
  left: NativeClientIdentity | NativeClientIdentityClaim | null | undefined,
  right: NativeClientIdentity | NativeClientIdentityClaim | null | undefined,
): boolean {
  return Boolean(
    left
    && right
    && left.schemaVersion === right.schemaVersion
    && left.clientKind === right.clientKind
    && left.pid === right.pid
    && left.startedAtUnixMs === right.startedAtUnixMs
    && left.executablePath === right.executablePath
    && left.executableSha256 === right.executableSha256
    && left.binaryHashUnavailable === right.binaryHashUnavailable
    && left.buildId === right.buildId
    && left.buildIdSemantics === right.buildIdSemantics
    && left.sourceFingerprint === right.sourceFingerprint
    && left.sourceDirty === right.sourceDirty
    && left.appVersion === right.appVersion,
  );
}

function normalizeStoredNativeClientIdentity(value: unknown): NativeClientIdentity | null {
  const direct = normalizeNativeClientIdentity(value);
  if (direct) return direct;
  if (!isPlainRecord(value)) return null;

  const storedKeys = new Set([
    'schemaVersion',
    'clientKind',
    'pid',
    'startedAtUnixMs',
    'startedAt',
    'executablePath',
    'executableSha256',
    'binaryHashUnavailable',
    'buildId',
    'buildIdSemantics',
    'sourceFingerprint',
    'sourceDirty',
    'appVersion',
    'trustLevel',
    'osAttested',
    'webviewProfileTrustLevel',
  ]);
  const keys = Object.keys(value);
  if (keys.length !== storedKeys.size || keys.some(key => !storedKeys.has(key))) return null;
  if (
    value.trustLevel !== 'proof_bound_local_claim'
    || value.osAttested !== false
    || value.webviewProfileTrustLevel !== 'unbound'
  ) return null;

  const claim: NativeClientIdentityClaim = {
    schemaVersion: value.schemaVersion as 1,
    clientKind: value.clientKind as NativeClientIdentityClaim['clientKind'],
    pid: value.pid as number,
    startedAtUnixMs: value.startedAtUnixMs as number,
    executablePath: value.executablePath as string,
    executableSha256: value.executableSha256 as string | null,
    binaryHashUnavailable: value.binaryHashUnavailable as boolean,
    buildId: value.buildId as string,
    buildIdSemantics: value.buildIdSemantics as 'baseline_commit',
    sourceFingerprint: value.sourceFingerprint as string,
    sourceDirty: value.sourceDirty as boolean,
    appVersion: value.appVersion as string,
  };
  const normalized = normalizeNativeClientIdentity(claim);
  if (!normalized || value.startedAt !== normalized.startedAt) return null;
  return normalized;
}

function stableIdentityValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableIdentityValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value as Record<string, unknown>)
    .sort()
    .map(key => [key, stableIdentityValue((value as Record<string, unknown>)[key])]));
}

/** Non-secret fingerprint used to bind persisted request evidence to one claim. */
export function nativeClientIdentitySha256(value: unknown): string {
  // Socket state and the device registry contain the normalized identity,
  // while bootstrap input contains the smaller wire claim. Both must produce
  // the exact same request-binding fingerprint. The strict wire normalizer
  // deliberately rejects the server-added trust fields, so validate that
  // stored envelope separately instead of silently returning an empty hash.
  const identity = normalizeStoredNativeClientIdentity(value);
  if (!identity) return '';
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableIdentityValue(identity)), 'utf8')
    .digest('hex');
}

export interface NativeRequestBinding {
  nativeDeviceId: string;
  executionSessionId: string;
  nativeClientIdentitySha256: string;
}

/**
 * Normalizes only a complete request provenance tuple. A partial tuple is
 * evidence-corrupting, so callers must persist either all three values or
 * none of them.
 */
export function normalizeNativeRequestBinding(value: unknown): NativeRequestBinding | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const nativeDeviceId = typeof candidate.nativeDeviceId === 'string'
    ? candidate.nativeDeviceId
    : '';
  const executionSessionId = typeof candidate.executionSessionId === 'string'
    ? candidate.executionSessionId.toLowerCase()
    : '';
  const nativeClientIdentityDigest = typeof candidate.nativeClientIdentitySha256 === 'string'
    ? candidate.nativeClientIdentitySha256.toLowerCase()
    : '';
  if (
    !nativeDeviceId
    || nativeDeviceId !== nativeDeviceId.trim()
    || nativeDeviceId.length > 512
    || /[\u0000-\u001f\u007f]/u.test(nativeDeviceId)
    || !/^[a-f0-9]{64}$/u.test(executionSessionId)
    || !/^[a-f0-9]{64}$/u.test(nativeClientIdentityDigest)
  ) return null;
  return {
    nativeDeviceId,
    executionSessionId,
    nativeClientIdentitySha256: nativeClientIdentityDigest,
  };
}
