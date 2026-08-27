import './helpers';
import { describe, expect, it, vi } from 'vitest';
import {
  deviceRegistry,
  nativeClientIdentitiesEqual,
  nativeClientIdentitySha256,
  normalizeNativeClientIdentity,
} from '../server/devices';
import { registerDeviceHandlers } from '../server/socket/device';
import { buildSocketNativeRequestBinding } from '../server/socket/native_request_binding';
import { getPreferredDesktopSocketId } from '../server/socket/desktop_relay';

const nowMs = Math.floor(Date.now() / 1_000) * 1_000;
const claim = {
  schemaVersion: 1 as const,
  clientKind: 'tauri' as const,
  pid: 42_001,
  startedAtUnixMs: nowMs - 30_000,
  executablePath: process.platform === 'win32'
    ? 'C:\\Program Files\\LumiCore\\lumi-core.exe'
    : '/Applications/LumiCore.app/Contents/MacOS/lumi-core',
  executableSha256: 'd'.repeat(64),
  binaryHashUnavailable: false,
  buildId: 'a'.repeat(40),
  buildIdSemantics: 'baseline_commit' as const,
  sourceFingerprint: 'e'.repeat(64),
  sourceDirty: false,
  appVersion: '3.1.0',
};

function socketHarness(options: {
  id: string;
  userId: string;
  trusted?: boolean;
  boundIdentity?: ReturnType<typeof normalizeNativeClientIdentity>;
  fingerprint?: string;
}) {
  const handlers = new Map<string, (...args: any[]) => void>();
  const emitted: Array<{ event: string; payload: any }> = [];
  const socket = {
    id: options.id,
    data: {
      authenticatedUserId: options.userId,
      authenticatedOrgId: '',
      trustedLocalExecution: options.trusted === true,
      nativeClientIdentity: options.boundIdentity || null,
      executionSessionId: '9'.repeat(64),
    },
    handshake: {
      auth: { fingerprint: options.fingerprint || `${options.id}-fingerprint` },
      address: '127.0.0.1',
    },
    on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler),
    emit: (event: string, payload: any) => emitted.push({ event, payload }),
    join: vi.fn(),
  } as any;
  registerDeviceHandlers(socket, () => options.userId, {} as any);
  return { socket, handlers, emitted };
}

describe('native client process identity', () => {
  it('normalizes a bounded native claim and derives one canonical ISO timestamp', () => {
    const normalized = normalizeNativeClientIdentity(claim, { nowMs });
    expect(normalized).toEqual({
      ...claim,
      buildId: claim.buildId.toLowerCase(),
      startedAt: new Date(claim.startedAtUnixMs).toISOString(),
      trustLevel: 'proof_bound_local_claim',
      osAttested: false,
      webviewProfileTrustLevel: 'unbound',
    });
    expect(nativeClientIdentitiesEqual(normalized, claim)).toBe(true);
    expect(normalizeNativeClientIdentity({
      ...claim,
      executableSha256: null,
      binaryHashUnavailable: true,
    }, { nowMs })).toMatchObject({
      executableSha256: null,
      binaryHashUnavailable: true,
      osAttested: false,
    });
  });

  it('accepts Windows and POSIX absolute executable paths on every server OS', () => {
    expect(normalizeNativeClientIdentity({
      ...claim,
      executablePath: 'C:\\Program Files\\LumiCore\\lumi-core.exe',
    }, { nowMs })).not.toBeNull();
    expect(normalizeNativeClientIdentity({
      ...claim,
      executablePath: '/Applications/LumiCore.app/Contents/MacOS/lumi-core',
    }, { nowMs })).not.toBeNull();
    expect(normalizeNativeClientIdentity({
      ...claim,
      executablePath: 'relative/lumi-core',
    }, { nowMs })).toBeNull();
  });

  it('derives one stable identity hash from both the wire claim and normalized registry identity', () => {
    const normalized = normalizeNativeClientIdentity(claim, { nowMs });
    const reorderedClaim = Object.fromEntries(Object.entries(claim).reverse());
    const expected = nativeClientIdentitySha256(claim);
    expect(expected).toMatch(/^[a-f0-9]{64}$/u);
    expect(nativeClientIdentitySha256(normalized)).toBe(expected);
    expect(nativeClientIdentitySha256(reorderedClaim)).toBe(expected);
    expect(nativeClientIdentitySha256({ ...claim, pid: claim.pid + 1 })).not.toBe(expected);
    expect(nativeClientIdentitySha256({
      ...normalized,
      trustLevel: 'forged',
    })).toBe('');
  });

  it.each([
    ['wrong schema', { ...claim, schemaVersion: 2 }],
    ['zero pid', { ...claim, pid: 0 }],
    ['fractional pid', { ...claim, pid: 2.5 }],
    ['future timestamp', { ...claim, startedAtUnixMs: nowMs + 10 * 60 * 1_000 }],
    ['relative executable', { ...claim, executablePath: 'lumi-core.exe' }],
    ['oversized executable', { ...claim, executablePath: `C:\\${'x'.repeat(2_100)}.exe` }],
    ['control character', { ...claim, executablePath: `${claim.executablePath}\nforged` }],
    ['short build id', { ...claim, buildId: 'a'.repeat(12) }],
    ['wrong build semantics', { ...claim, buildIdSemantics: 'binary_identity' }],
    ['bad source fingerprint', { ...claim, sourceFingerprint: 'f'.repeat(63) }],
    ['mismatched unavailable hash', { ...claim, executableSha256: null }],
    ['unknown client kind', { ...claim, clientKind: 'browser' }],
    ['invalid version', { ...claim, appVersion: 'latest' }],
    ['unknown field', { ...claim, injected: 'value' }],
  ])('rejects %s instead of truncating or accepting it', (_label, value) => {
    expect(normalizeNativeClientIdentity(value, { nowMs })).toBeNull();
  });

  it('registers a verified desktop only when its claim matches the proof-bound identity', () => {
    const userId = `native-identity-valid-${Date.now()}`;
    const bound = normalizeNativeClientIdentity(claim, { nowMs });
    const { socket, handlers, emitted } = socketHarness({
      id: 'native-identity-valid-socket',
      userId,
      trusted: true,
      boundIdentity: bound,
    });

    handlers.get('device:register')?.({
      name: 'LumiCore Desktop',
      type: 'desktop',
      osInfo: process.platform,
      nativeClientIdentity: claim,
    });

    expect(emitted).toEqual([]);
    expect(socket.join).toHaveBeenCalledTimes(1);
    expect(deviceRegistry.getUserDevices(userId)).toHaveLength(1);
    expect(deviceRegistry.getUserDevices(userId)[0].nativeClientIdentity).toEqual(bound);
    expect(deviceRegistry.getUserDevices(userId)[0].id).toContain(
      `_native_${nativeClientIdentitySha256(bound)}`,
    );
    expect(deviceRegistry.getUserDevices(userId)[0].id).not.toContain(String(claim.pid));
    expect(deviceRegistry.getUserDevices(userId)[0].id).not.toContain(String(claim.startedAtUnixMs));
    expect(buildSocketNativeRequestBinding(socket)).toEqual({
      nativeDeviceId: deviceRegistry.getUserDevices(userId)[0].id,
      executionSessionId: '9'.repeat(64),
      nativeClientIdentitySha256: nativeClientIdentitySha256(bound),
    });
  });

  it('never emits a native request binding before exact trusted Tauri registration', () => {
    const userId = `native-request-binding-${Date.now()}`;
    const bound = normalizeNativeClientIdentity(claim, { nowMs });
    const unregistered = socketHarness({
      id: 'native-request-binding-unregistered',
      userId,
      trusted: true,
      boundIdentity: bound,
    });
    expect(buildSocketNativeRequestBinding(unregistered.socket)).toBeNull();

    const untrusted = socketHarness({
      id: 'native-request-binding-untrusted',
      userId: `${userId}-untrusted`,
      trusted: false,
      boundIdentity: bound,
    });
    untrusted.socket.data.lumiDeviceId = deviceRegistry.register(
      `${userId}-untrusted`,
      untrusted.socket.id,
      { type: 'desktop', nativeClientIdentity: bound },
    ).id;
    expect(buildSocketNativeRequestBinding(untrusted.socket)).toBeNull();

    const wrongSocket = socketHarness({
      id: 'native-request-binding-wrong-socket',
      userId: `${userId}-wrong-socket`,
      trusted: true,
      boundIdentity: bound,
    });
    wrongSocket.socket.data.lumiDeviceId = deviceRegistry.register(
      `${userId}-wrong-socket`,
      'another-socket-id',
      { type: 'desktop', nativeClientIdentity: bound },
    ).id;
    expect(buildSocketNativeRequestBinding(wrongSocket.socket)).toBeNull();
  });

  it('does not let a proof-bound native socket downgrade its registered target to web', () => {
    const userId = `native-identity-downgrade-${Date.now()}`;
    const native = socketHarness({
      id: 'native-identity-downgrade-socket',
      userId,
      trusted: true,
      boundIdentity: normalizeNativeClientIdentity(claim, { nowMs }),
    });
    native.handlers.get('device:register')?.({ name: 'Not a desktop', type: 'web' });
    expect(deviceRegistry.getUserDevices(userId)).toEqual([]);
    expect(native.emitted).toContainEqual({
      event: 'device:registration_error',
      payload: expect.objectContaining({ code: 'NATIVE_DESKTOP_REGISTRATION_REQUIRED' }),
    });
  });

  it('rejects a changed claim even on a trusted-local socket', () => {
    const userId = `native-identity-mismatch-${Date.now()}`;
    const { socket, handlers, emitted } = socketHarness({
      id: 'native-identity-mismatch-socket',
      userId,
      trusted: true,
      boundIdentity: normalizeNativeClientIdentity(claim, { nowMs }),
    });

    handlers.get('device:register')?.({
      name: 'Forged native process',
      type: 'desktop',
      nativeClientIdentity: { ...claim, pid: claim.pid + 1 },
    });

    expect(socket.join).not.toHaveBeenCalled();
    expect(deviceRegistry.getUserDevices(userId)).toEqual([]);
    expect(emitted).toContainEqual({
      event: 'device:registration_error',
      payload: expect.objectContaining({ code: 'NATIVE_CLIENT_IDENTITY_MISMATCH' }),
    });
  });

  it('never promotes a local acceptance harness into a desktop relay target', () => {
    const userId = `native-identity-harness-${Date.now()}`;
    const harnessClaim = { ...claim, clientKind: 'local_acceptance_harness' as const };
    const { socket, handlers, emitted } = socketHarness({
      id: 'native-identity-harness-socket',
      userId,
      trusted: true,
      boundIdentity: normalizeNativeClientIdentity(harnessClaim, { nowMs }),
    });

    handlers.get('device:register')?.({
      name: 'Acceptance harness impersonation',
      type: 'desktop',
      nativeClientIdentity: harnessClaim,
    });

    expect(socket.join).not.toHaveBeenCalled();
    expect(deviceRegistry.getUserDevices(userId)).toEqual([]);
    expect(emitted).toContainEqual({
      event: 'device:registration_error',
      payload: expect.objectContaining({ code: 'NATIVE_CLIENT_IDENTITY_MISMATCH' }),
    });
  });

  it('rejects identity injection from web but preserves ordinary web registration', () => {
    const forgedUserId = `native-identity-web-forged-${Date.now()}`;
    const forged = socketHarness({
      id: 'native-identity-web-forged-socket',
      userId: forgedUserId,
    });
    forged.handlers.get('device:register')?.({
      name: 'Forged Web Client',
      type: 'web',
      nativeClientIdentity: claim,
    });
    expect(deviceRegistry.getUserDevices(forgedUserId)).toEqual([]);
    expect(forged.emitted).toContainEqual({
      event: 'device:registration_error',
      payload: expect.objectContaining({ code: 'NATIVE_CLIENT_IDENTITY_NOT_ALLOWED' }),
    });

    const webUserId = `native-identity-web-compatible-${Date.now()}`;
    const web = socketHarness({ id: 'native-identity-web-compatible-socket', userId: webUserId });
    web.handlers.get('device:register')?.({ name: 'Web Browser', type: 'web' });
    expect(deviceRegistry.getUserDevices(webUserId)).toHaveLength(1);
    expect(deviceRegistry.getUserDevices(webUserId)[0]).toMatchObject({
      type: 'web',
      nativeClientIdentity: null,
    });
  });

  it('cannot overwrite a native instance with a spoofed same-fingerprint web socket', () => {
    const userId = `native-identity-fingerprint-${Date.now()}`;
    const fingerprint = 'shared-device-fingerprint';
    const desktop = socketHarness({
      id: 'native-identity-fingerprint-desktop',
      userId,
      trusted: true,
      boundIdentity: normalizeNativeClientIdentity(claim, { nowMs }),
      fingerprint,
    });
    desktop.handlers.get('device:register')?.({
      name: 'LumiCore Desktop',
      type: 'desktop',
      nativeClientIdentity: claim,
    });
    expect(getPreferredDesktopSocketId(userId)).toBe(desktop.socket.id);

    const web = socketHarness({
      id: 'native-identity-fingerprint-web',
      userId,
      fingerprint,
    });
    web.handlers.get('device:register')?.({ name: 'Web Browser', type: 'web' });

    expect(deviceRegistry.getUserDevices(userId)).toHaveLength(2);
    expect(deviceRegistry.getUserDevices(userId).find(device => device.type === 'web')).toMatchObject({
      type: 'web',
      socketId: web.socket.id,
      nativeClientIdentity: null,
    });
    expect(getPreferredDesktopSocketId(userId)).toBe(desktop.socket.id);
  });

  it('keeps two same-name native instances distinct, even with one browser fingerprint', () => {
    const userId = `native-identity-two-instances-${Date.now()}`;
    const fingerprint = 'shared-native-fingerprint';
    const firstClaim = { ...claim, pid: 52_001, startedAtUnixMs: nowMs - 60_000 };
    const secondClaim = { ...claim, pid: 52_002, startedAtUnixMs: nowMs - 30_000 };
    for (const [index, instanceClaim] of [firstClaim, secondClaim].entries()) {
      const instance = socketHarness({
        id: `native-two-instance-${index}`,
        userId,
        trusted: true,
        boundIdentity: normalizeNativeClientIdentity(instanceClaim, { nowMs }),
        fingerprint,
      });
      instance.handlers.get('device:register')?.({
        name: 'Identical LumiCore Desktop',
        type: 'desktop',
        nativeClientIdentity: instanceClaim,
      });
    }

    const devices = deviceRegistry.getUserDevices(userId);
    expect(devices).toHaveLength(2);
    expect(new Set(devices.map(device => device.id)).size).toBe(2);
    expect(devices.map(device => device.nativeClientIdentity?.pid).sort()).toEqual([52_001, 52_002]);
  });
});
