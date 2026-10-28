import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import { observeExternalDevices } from '../server/devices/external_observation';
import { mountExternalDeviceRoutes } from '../server/routes/external_device_routes';
import { DESKTOP_SESSION_HEADER, issueDesktopSessionProof } from '../server/config/desktop_bootstrap';
import type { UsbSerialInventoryResult } from '../server/devices/usb_serial_inventory';
import type { PrinterInventoryResult } from '../server/devices/printer_inventory';
import type { LanDiscoveryResult } from '../server/devices/lan_discovery';
import type { NetworkPrinterStatusResult } from '../shared/external_devices';

const observedAt = '2026-10-01T00:00:00.000Z';
const usb: UsbSerialInventoryResult = {
  supported: true, status: 'partial', platform: 'win32', observedAt,
  devices: [{ instanceId: 'USB\\VID_1234&PID_5678\\fixture', category: 'ports_class', instanceEnumerator: 'USB',
    name: 'Observed serial bridge', className: 'Ports', manufacturer: null, status: 'OK', problemCode: 0,
    cimStatus: 'Error', configManagerErrorCode: 28, service: null, hardwareIds: ['USB\\VID_1234&PID_5678'],
    vid: '1234', pid: '5678', portName: 'COM12', portNameSource: 'device_parameters', registryPortName: 'COM12',
    serialPortName: null, driver: { provider: null, version: null, date: null, infName: null, isSigned: null } }],
  errors: [{ code: 'driver_metadata_query_failed', message: 'Fixture metadata denied' }], limitations: ['USB bridge is not an MCP connection'],
};
const printers: PrinterInventoryResult = {
  supported: true, status: 'error', platform: 'win32', observedAt, printers: [], ports: [],
  errors: [{ code: 'queue_query_failed', message: 'Fixture spooler unavailable' }],
};
const lan: LanDiscoveryResult = {
  ok: false, status: 'partial', startedAt: observedAt, finishedAt: observedAt, timeoutMs: 2000,
  interfaces: [{ name: 'fixture-lan', address: '192.168.30.2', netmask: '255.255.255.0' }],
  candidates: [{ id: 'fixture-advertisement', kind: 'printer', protocol: 'mdns', serviceType: '_ipp._tcp.local',
    name: 'Observed printer', addresses: ['192.168.30.20'], port: 631, path: '/ipp/print',
    source: { interfaceName: 'fixture-lan', localAddress: '192.168.30.2', responderAddress: '192.168.30.20' }, paired: false }],
  truncated: false, errors: [{ code: 'ssdp_unavailable', message: 'Fixture SSDP failed' }], limitations: ['Advertisement does not prove control'],
};
const target = { address: '192.168.30.20', port: 631, resourcePath: '/ipp/print' };
const ippFailure: NetworkPrinterStatusResult = {
  ok: false, status: 'unavailable', scope: 'control_center_lan', observedAt, target,
  phase: 'headers', errorCode: 'headers_timeout', error: 'Fixture IPP headers timeout', limitations: ['No print job submitted'],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function nativeIdentity(pid: number) {
  return { schemaVersion: 1 as const, clientKind: 'tauri' as const, pid,
    startedAtUnixMs: Math.floor((Date.now() - 30_000) / 1000) * 1000,
    executablePath: process.platform === 'win32' ? 'C:\\LumiCore\\lumi-core.exe' : '/opt/LumiCore/lumi-core',
    executableSha256: 'a'.repeat(64), binaryHashUnavailable: false, buildId: 'b'.repeat(40),
    buildIdSemantics: 'baseline_commit' as const, sourceFingerprint: 'c'.repeat(64), sourceDirty: false, appVersion: '3.1.0' };
}

describe('external device observation owner', () => {
  it('starts the three sources concurrently and preserves their original partial/error receipts', async () => {
    const u = deferred<UsbSerialInventoryResult>(), p = deferred<PrinterInventoryResult>(), l = deferred<LanDiscoveryResult>();
    const adapters = { usb: vi.fn(() => u.promise), printers: vi.fn(() => p.promise), lan: vi.fn(() => l.promise) };
    const pending = observeExternalDevices(adapters);
    expect(adapters.usb).toHaveBeenCalledTimes(1);
    expect(adapters.printers).toHaveBeenCalledTimes(1);
    expect(adapters.lan).toHaveBeenCalledWith({ timeoutMs: 2000, protocols: ['mdns', 'ssdp'] });
    u.resolve(usb); p.resolve(printers); l.resolve(lan);
    const result = await pending;
    expect(result.usb).toBe(usb); expect(result.printers).toBe(printers); expect(result.lan).toBe(lan);
    expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
  });

  it('keeps an unexpected source failure distinct from an empty successful inventory', async () => {
    const result = await observeExternalDevices({
      usb: vi.fn(() => { throw new Error('Fixture PnP source failed'); }),
      printers: vi.fn(async () => printers), lan: vi.fn(async () => lan),
    });
    expect(result.usb).toMatchObject({ ok: false, status: 'unavailable', errors: [{ code: 'observation_failed', message: 'Fixture PnP source failed' }] });
    expect(result.usb).not.toHaveProperty('devices');
    expect(result.printers).toBe(printers); expect(result.lan).toBe(lan);
  });
});

describe('external device HTTP admission and receipts', () => {
  let url: string, cleanup: () => void, proof: string, otherProof: string;
  const token = jwt.sign({ uid: 'external-reader', username: 'reader', role: 'user' }, JWT_SECRET);
  const otherToken = jwt.sign({ uid: 'external-other', username: 'other', role: 'user' }, JWT_SECRET);
  const adapters = { usb: vi.fn(async () => usb), printers: vi.fn(async () => printers), lan: vi.fn(async () => lan), printerStatus: vi.fn(async () => ippFailure) };
  beforeAll(async () => {
    const app = await makeApp(); url = app.url; cleanup = app.cleanup;
    // Only this loopback fixture overrides its socket address; production uses the actual transport.
    app.apiRouter.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { configurable: true, value: req.get('x-fixture-remote-address') || '127.0.0.1' });
      next();
    });
    mountExternalDeviceRoutes(app.apiRouter, adapters);
    app.apiRouter.get('/devices/:id', (_req, res) => { res.status(418).json({ error: 'generic device route' }); });
    app.apiRouter.use((error: Error, _req: unknown, res: any, _next: unknown) => { res.status(500).json({ error: error.message }); });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    proof = issueDesktopSessionProof('external-reader', nativeIdentity(53101)).proof;
    otherProof = issueDesktopSessionProof('external-other', nativeIdentity(53102)).proof;
  });
  afterAll(() => cleanup?.());
  function headers(sessionProof = proof, auth = token): Record<string, string> {
    return { Authorization: 'Bearer ' + auth, [DESKTOP_SESSION_HEADER]: sessionProof, 'Content-Type': 'application/json' };
  }
  async function request(path: string, requestHeaders: Record<string, string>, method = 'GET', body?: unknown) {
    return fetch(url + '/api' + path, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  }
  function expectNoObservation() {
    expect(adapters.usb).not.toHaveBeenCalled(); expect(adapters.printers).not.toHaveBeenCalled();
    expect(adapters.lan).not.toHaveBeenCalled(); expect(adapters.printerStatus).not.toHaveBeenCalled();
  }

  it('serves a fresh unregistered snapshot to each admitted user without a private cross-user cache', async () => {
    for (const [sessionProof, auth] of [[proof, token], [otherProof, otherToken]]) {
      const response = await request('/devices/external?timeoutMs=8000&protocols=other', headers(sessionProof, auth));
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ usb, printers, lan });
    }
    expect(adapters.usb).toHaveBeenCalledTimes(2); expect(adapters.printers).toHaveBeenCalledTimes(2);
    expect(adapters.lan.mock.calls).toEqual([[{ timeoutMs: 2000, protocols: ['mdns', 'ssdp'] }], [{ timeoutMs: 2000, protocols: ['mdns', 'ssdp'] }]]);
    expect(adapters.printerStatus).not.toHaveBeenCalled();
  });

  it.each([
    ['anonymous', {}, 401],
    ['no desktop proof', { Authorization: 'Bearer ' + token }, 403],
    ['invalid desktop proof', { Authorization: 'Bearer ' + token, [DESKTOP_SESSION_HEADER]: 'x'.repeat(48) }, 403],
    ['invalid auth', { Authorization: 'Bearer invalid' }, 401],
  ])('rejects %s before either observation endpoint runs', async (_label, requestHeaders, status) => {
    const get = await request('/devices/external', requestHeaders as Record<string, string>);
    const post = await request('/devices/external/printer-status', { ...requestHeaders, 'Content-Type': 'application/json' } as Record<string, string>, 'POST', target);
    expect(get.status).toBe(status); expect(post.status).toBe(status); expectNoObservation();
  });

  it('rejects another uid proof on both endpoints', async () => {
    expect((await request('/devices/external', headers(otherProof))).status).toBe(403);
    expect((await request('/devices/external/printer-status', headers(otherProof), 'POST', target)).status).toBe(403);
    expectNoObservation();
  });

  it('rejects an expired desktop proof before source execution', async () => {
    const expiring = issueDesktopSessionProof('external-reader', nativeIdentity(53103)).proof;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
    try { expect((await request('/devices/external', headers(expiring))).status).toBe(403); expectNoObservation(); }
    finally { clock.mockRestore(); }
  });

  it('rejects remote transport even with a valid proof and forged loopback proxy headers', async () => {
    const remote = { ...headers(), 'x-fixture-remote-address': '192.168.30.3', 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' };
    expect((await request('/devices/external', remote)).status).toBe(403);
    expect((await request('/devices/external/printer-status', remote, 'POST', target)).status).toBe(403);
    expectNoObservation();
  });

  it('returns the complete failed IPP receipt instead of dropping its body', async () => {
    const response = await request('/devices/external/printer-status', headers(), 'POST', target);
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(ippFailure);
    expect(adapters.printerStatus).toHaveBeenCalledExactlyOnceWith(target);
    expect(adapters.usb).not.toHaveBeenCalled(); expect(adapters.printers).not.toHaveBeenCalled(); expect(adapters.lan).not.toHaveBeenCalled();
  });

  it.each([null, [], { ...target, print: true }, { address: target.address, port: '631', resourcePath: '/ipp/print' }, { ...target, port: 0 }, { address: target.address, port: 631 }].map(body => ({ body })))('rejects malformed or extra printer parameters: %j', async ({ body }) => {
    const response = await request('/devices/external/printer-status', headers(), 'POST', body);
    expect(response.status).toBe(400); expectNoObservation();
  });

  it('retains the existing trusted-origin boundary on the read-only POST', async () => {
    const response = await request('/devices/external/printer-status', { ...headers(), Origin: 'https://untrusted.example' }, 'POST', target);
    expect(response.status).toBe(403); expectNoObservation();
  });
});
