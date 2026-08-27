import { describe, expect, it } from 'vitest';
import {
  formalNativeClientIdentityFingerprint,
  selectFormalNativeClientDevice,
  selectFormalNativeClientEvidence,
} from '../scripts/lib/formal-native-client-binding.mjs';

const STARTED_AT = Date.UTC(2026, 7, 27, 1, 2, 3);
const BUILD_ID = 'a'.repeat(40);

function device(overrides: Record<string, unknown> = {}) {
  const identity = {
    schemaVersion: 1,
    clientKind: 'tauri',
    pid: 456,
    startedAtUnixMs: STARTED_AT,
    executablePath: 'D:\\LumiCore\\LumiCore.exe',
    executableSha256: 'b'.repeat(64),
    binaryHashUnavailable: false,
    buildId: BUILD_ID,
    buildIdSemantics: 'baseline_commit',
    sourceFingerprint: 'c'.repeat(64),
    sourceDirty: false,
    appVersion: '1.2.3',
    trustLevel: 'proof_bound_local_claim',
    osAttested: false,
    webviewProfileTrustLevel: 'unbound',
    ...((overrides.nativeClientIdentity as Record<string, unknown>) || {}),
  };
  return {
    id: 'formal-tauri-device',
    type: 'desktop',
    status: 'online',
    socketId: 'socket-1',
    ...overrides,
    nativeClientIdentity: identity,
  };
}

const expected = { pid: 456, startedAt: new Date(STARTED_AT + 321).toISOString(), buildId: BUILD_ID };

describe('formal native client binding', () => {
  it('selects exactly one clean, hashed, proof-bound Tauri process and reports honest trust', () => {
    const result = selectFormalNativeClientDevice([device()], expected);
    expect(result).toMatchObject({
      ok: true,
      deviceId: 'formal-tauri-device',
      trustLevel: 'proof_bound_local_claim',
      osAttested: false,
      webviewProfileTrustLevel: 'unbound',
    });
    expect(result.identityFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.identityFingerprint).toBe(formalNativeClientIdentityFingerprint(result.identity));
    expect(selectFormalNativeClientEvidence([device()], expected)).toMatchObject({
      ok: true,
      evidence: {
        clientKind: 'tauri',
        deviceId: 'formal-tauri-device',
        identitySource: 'authenticated_devices_registry_proof_bound_tauri',
        identityVerified: true,
        sourceDirty: false,
        binaryHashUnavailable: false,
        trustLevel: 'proof_bound_local_claim',
        osAttested: false,
        webviewProfileTrustLevel: 'unbound',
        webviewProfileBound: false,
        formalAcceptanceEligible: false,
      },
    });
  });

  it('never accepts the local acceptance harness as the product client', () => {
    const result = selectFormalNativeClientDevice([
      device({ nativeClientIdentity: { clientKind: 'local_acceptance_harness' } }),
    ], expected);
    expect(result).toMatchObject({ ok: false, code: 'native_device_not_tauri' });
  });

  it('rejects stale, dirty, unhashed, offline, and ambiguous Tauri identities', () => {
    expect(selectFormalNativeClientDevice([
      device({ nativeClientIdentity: { startedAtUnixMs: STARTED_AT - 1_000 } }),
    ], expected)).toMatchObject({ ok: false, code: 'formal_native_client_not_found' });
    expect(selectFormalNativeClientDevice([
      device({ nativeClientIdentity: { sourceDirty: true } }),
    ], expected)).toMatchObject({ ok: false, code: 'native_device_source_dirty' });
    expect(selectFormalNativeClientDevice([
      device({ nativeClientIdentity: { executableSha256: null, binaryHashUnavailable: true } }),
    ], expected)).toMatchObject({ ok: false, code: 'native_device_binary_hash_unavailable' });
    expect(selectFormalNativeClientDevice([device({ status: 'offline' })], expected))
      .toMatchObject({ ok: false, code: 'native_device_not_online' });
    expect(selectFormalNativeClientDevice([device(), device({ id: 'duplicate', socketId: 'socket-2' })], expected))
      .toMatchObject({ ok: false, code: 'formal_native_client_ambiguous' });
  });

  it('rejects incomplete expectations instead of falling back to any desktop', () => {
    expect(selectFormalNativeClientDevice([device()], { pid: 456, buildId: BUILD_ID }))
      .toMatchObject({ ok: false, code: 'formal_native_client_expectation_invalid' });
  });
});
