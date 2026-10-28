import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import { mountXiaozhiDeviceRoutes } from '../server/routes/xiaozhi_device_routes';
import { DESKTOP_SESSION_HEADER, issueDesktopSessionProof } from '../server/config/desktop_bootstrap';

describe('local device gateway management', () => {
  let url: string, cleanup: () => void, proof: string;
  const uid = 'gateway-owner';
  const admin = jwt.sign({ uid, role: 'admin', username: 'owner' }, JWT_SECRET);
  const ordinary = jwt.sign({ uid, role: 'user', username: 'member' }, JWT_SECRET);
  const configuration = { id: 'fixture-device', expiresAt: '2026-10-28T12:00:00Z',
    otaUrl: 'http://192.168.30.2:17840/bootstrap?token=synthetic-device-secret',
    mcpUrl: 'ws://127.0.0.1:43210/mcp?token=synthetic-bridge-secret' };
  const service = { list: vi.fn(async () => ({ devices: [], errors: [], listener: { state: 'stopped' as const, localAddress: null, port: null } })),
    createPairing: vi.fn(async () => configuration), getPairingConfiguration: vi.fn(async () => configuration), revoke: vi.fn(async () => {}) };
  const interfaces = vi.fn(async () => [{ name: 'physical fixture', address: '192.168.30.2', netmask: '255.255.255.0' }]);
  const input = { deviceId: 'fixture-device-id', localAddress: '192.168.30.2' };
  beforeAll(async () => {
    const app = await makeApp(); url = app.url; cleanup = app.cleanup;
    app.apiRouter.use((req, _res, next) => {
      Object.defineProperty(req.socket, 'remoteAddress', { configurable: true, value: req.get('x-fixture-remote-address') || '127.0.0.1' }); next();
    });
    mountXiaozhiDeviceRoutes(app.apiRouter, service, interfaces);
    proof = issueDesktopSessionProof(uid, { schemaVersion: 1, clientKind: 'tauri', pid: 54501,
      startedAtUnixMs: Date.now() - 10000, executablePath: process.platform === 'win32' ? 'C:\\LumiCore\\lumi-core.exe' : '/opt/lumi-core',
      executableSha256: 'a'.repeat(64), binaryHashUnavailable: false, buildId: 'b'.repeat(40),
      buildIdSemantics: 'baseline_commit', sourceFingerprint: 'c'.repeat(64), sourceDirty: false, appVersion: '3.1.0' }).proof;
  });
  beforeEach(() => vi.clearAllMocks());
  afterAll(() => cleanup?.());
  function headers(auth = admin, session = proof) { return { Authorization: 'Bearer ' + auth, [DESKTOP_SESSION_HEADER]: session, 'Content-Type': 'application/json' }; }
  function request(path = '', method = 'GET', h: Record<string, string> = headers(), body?: unknown) {
    return fetch(url + '/api/devices/xiaozhi' + path, { method, headers: h,
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  }
  it.each([
    ['anonymous', {}, 401], ['ordinary account', { Authorization: 'Bearer ' + ordinary }, 403],
    ['no proof', { Authorization: 'Bearer ' + admin }, 403],
  ])('rejects %s before reading or starting a gateway', async (_label, h, expected) => {
    expect((await request('', 'GET', h)).status).toBe(expected);
    expect((await request('/pairings', 'POST', h, input)).status).toBe(expected);
    expect(service.list).not.toHaveBeenCalled(); expect(service.createPairing).not.toHaveBeenCalled();
  });
  it('rejects remote transport even with a signed current local proof', async () => {
    const h = { ...headers(), 'x-fixture-remote-address': '192.168.30.40', 'x-forwarded-for': '127.0.0.1' };
    expect((await request('/pairings', 'POST', h, input)).status).toBe(403); expect(service.createPairing).not.toHaveBeenCalled();
  });
  it('uses the current uid and keeps private bridge credentials out of management replies', async () => {
    const created = await request('/pairings', 'POST', headers(), input);
    expect(created.status).toBe(201); expect(created.headers.get('cache-control')).toBe('no-store');
    expect(await created.json()).toEqual({ id: configuration.id, expiresAt: configuration.expiresAt, otaUrl: configuration.otaUrl });
    expect(service.createPairing).toHaveBeenCalledWith(uid, input);
    const privateView = await request('/pairings/fixture-device/configuration');
    expect(await privateView.text()).not.toContain('synthetic-bridge-secret');
    expect(service.getPairingConfiguration).toHaveBeenCalledWith('fixture-device', uid);
    expect((await request('/pairings/fixture-device', 'DELETE')).status).toBe(200);
    expect(service.revoke).toHaveBeenCalledWith('fixture-device', uid);
  });
  it('rejects caller-supplied owner and endpoints before any pairing is saved', async () => {
    for (const body of [{ ...input, ownerUid: 'other' }, { ...input, publicBaseUrl: 'http://elsewhere' }, { ...input, deviceId: '' }]) {
      expect((await request('/pairings', 'POST', headers(), body)).status).toBe(400);
    }
    expect(service.createPairing).not.toHaveBeenCalled();
  });
  it('preserves a real service error instead of claiming an empty connected list', async () => {
    service.list.mockRejectedValueOnce(new Error('Encrypted binding could not be read'));
    const response = await request(); expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Encrypted binding could not be read' });
  });
});
