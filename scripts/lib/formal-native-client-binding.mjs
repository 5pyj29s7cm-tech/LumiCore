import crypto from 'node:crypto';
import path from 'node:path';

const SHA256_RE = /^[a-f0-9]{64}$/iu;
const BUILD_ID_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu;

function normalizedStartMs(value) {
  const milliseconds = typeof value === 'number' ? value : Date.parse(String(value || ''));
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) return 0;
  return Math.floor(milliseconds / 1_000) * 1_000;
}

function normalizedExpected(value = {}) {
  return {
    pid: Math.trunc(Number(value.pid) || 0),
    startedAtUnixMs: normalizedStartMs(value.startedAtUnixMs ?? value.startedAt ?? value.startAt),
    buildId: String(value.buildId || '').trim().toLowerCase(),
  };
}

function stableIdentityProjection(identity) {
  return {
    schemaVersion: Number(identity.schemaVersion),
    clientKind: String(identity.clientKind || ''),
    pid: Number(identity.pid),
    startedAtUnixMs: Number(identity.startedAtUnixMs),
    executablePath: String(identity.executablePath || ''),
    executableSha256: identity.executableSha256 === null
      ? null
      : String(identity.executableSha256 || '').toLowerCase(),
    binaryHashUnavailable: identity.binaryHashUnavailable === true,
    buildId: String(identity.buildId || '').toLowerCase(),
    buildIdSemantics: String(identity.buildIdSemantics || ''),
    sourceFingerprint: String(identity.sourceFingerprint || '').toLowerCase(),
    sourceDirty: identity.sourceDirty === true,
    appVersion: String(identity.appVersion || ''),
    trustLevel: String(identity.trustLevel || ''),
    osAttested: identity.osAttested === true,
    webviewProfileTrustLevel: String(identity.webviewProfileTrustLevel || ''),
  };
}

function validateCandidate(device, expected, options) {
  if (!device || !String(device.id || '') || device.type !== 'desktop'
    || device.status !== 'online' || !String(device.socketId || '')) {
    return { ok: false, code: 'native_device_not_online' };
  }
  const identity = stableIdentityProjection(device.nativeClientIdentity || {});
  if (identity.schemaVersion !== 1 || identity.clientKind !== 'tauri') {
    return { ok: false, code: 'native_device_not_tauri' };
  }
  if (identity.trustLevel !== 'proof_bound_local_claim'
    || identity.osAttested !== false
    || identity.webviewProfileTrustLevel !== 'unbound') {
    return { ok: false, code: 'native_device_trust_semantics_invalid' };
  }
  if (identity.pid !== expected.pid
    || identity.startedAtUnixMs !== expected.startedAtUnixMs
    || identity.buildId !== expected.buildId) {
    return { ok: false, code: 'native_device_process_identity_mismatch' };
  }
  if (!path.isAbsolute(identity.executablePath)
    || identity.buildIdSemantics !== 'baseline_commit'
    || !SHA256_RE.test(identity.sourceFingerprint)
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(identity.appVersion)) {
    return { ok: false, code: 'native_device_identity_invalid' };
  }
  if (options.requireCleanSource !== false && identity.sourceDirty) {
    return { ok: false, code: 'native_device_source_dirty' };
  }
  if (identity.binaryHashUnavailable) {
    if (identity.executableSha256 !== null || options.requireExecutableHash !== false) {
      return { ok: false, code: 'native_device_binary_hash_unavailable' };
    }
  } else if (!SHA256_RE.test(String(identity.executableSha256 || ''))) {
    return { ok: false, code: 'native_device_binary_hash_invalid' };
  }
  return { ok: true, identity };
}

/**
 * Binds a formal run to one already-connected Tauri instance. The Node
 * acceptance harness is deliberately excluded even though it has its own
 * loopback bootstrap session.
 */
export function selectFormalNativeClientDevice(devices, expectedValue, options = {}) {
  const expected = normalizedExpected(expectedValue);
  if (!Number.isInteger(expected.pid) || expected.pid <= 0
    || !expected.startedAtUnixMs
    || !BUILD_ID_RE.test(expected.buildId)) {
    return { ok: false, code: 'formal_native_client_expectation_invalid' };
  }
  const candidates = [];
  const rejectionCodes = [];
  for (const device of Array.isArray(devices) ? devices : []) {
    const checked = validateCandidate(device, expected, options);
    if (checked.ok) candidates.push({ device, identity: checked.identity });
    else rejectionCodes.push(checked.code);
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      code: rejectionCodes.includes('native_device_process_identity_mismatch')
        ? 'formal_native_client_not_found'
        : rejectionCodes[0] || 'formal_native_client_not_found',
    };
  }
  if (candidates.length !== 1) return { ok: false, code: 'formal_native_client_ambiguous' };
  const selected = candidates[0];
  const fingerprint = formalNativeClientIdentityFingerprint(selected.identity);
  return {
    ok: true,
    code: '',
    deviceId: String(selected.device.id || ''),
    socketId: String(selected.device.socketId || ''),
    identity: selected.identity,
    identityFingerprint: fingerprint,
    trustLevel: 'proof_bound_local_claim',
    osAttested: false,
    webviewProfileTrustLevel: 'unbound',
  };
}

export function formalNativeClientIdentityFingerprint(identity) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stableIdentityProjection(identity || {})), 'utf8')
    .digest('hex');
}

/**
 * Produce the exact restricted evidence projection consumed by formal runners.
 * Operator supplied PID/start/build values are selection expectations only;
 * every field below comes from the authenticated /devices registry record.
 */
export function selectFormalNativeClientEvidence(devices, expectedValue, options = {}) {
  const selected = selectFormalNativeClientDevice(devices, expectedValue, options);
  if (!selected.ok) return selected;
  const identity = selected.identity;
  return {
    ...selected,
    evidence: {
      ...identity,
      startedAt: new Date(identity.startedAtUnixMs).toISOString(),
      deviceId: selected.deviceId,
      identityFingerprint: selected.identityFingerprint,
      identitySource: 'authenticated_devices_registry_proof_bound_tauri',
      identityVerified: true,
      registryStatus: 'online',
      trustLevel: 'proof_bound_local_claim',
      osAttested: false,
      webviewProfileTrustLevel: 'unbound',
      webviewProfileBound: false,
      formalAcceptanceEligible: false,
    },
  };
}
