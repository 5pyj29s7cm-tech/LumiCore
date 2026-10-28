import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { Duplex } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { ToolRegistry } from '../server/tools/registry';
import { mcpManager, registerConnectedSkillTools, unregisterServerTools } from '../server/mcp';
import { XiaozhiDeviceService, type XiaozhiServiceOptions } from '../server/devices/xiaozhi_service';
import { EncryptedXiaozhiRepository, type XiaozhiBindingRepository } from '../server/devices/xiaozhi_repository';
import type { XiaozhiPrivateBinding } from '../server/devices/xiaozhi_mcp_gateway';
const services: XiaozhiDeviceService[] = [];
const sockets: WebSocket[] = [];
const directories: string[] = [];
afterEach(async () => { for (const socket of sockets.splice(0)) socket.terminate(); await Promise.all(services.splice(0).map(service => service.close())); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const owner = 'owner-fixture', deviceId = 'aa:bb:cc:dd:ee:ff', clientId = 'board-fixture';
const physicalFixture = { name: 'test-only-loopback-transport', address: '127.0.0.1', netmask: '255.0.0.0' };
function fixture(extra: XiaozhiServiceOptions = {}) {
  let rows: XiaozhiPrivateBinding[] = []; const registry = new ToolRegistry();
  const repository: XiaozhiBindingRepository = { load: () => structuredClone(rows), save: next => { rows = structuredClone(next); } };
  const disconnectServer = vi.fn((name: string) => mcpManager.disconnectServer(name));
  const registerTools = vi.fn((name, tools, options) => registerConnectedSkillTools(name, tools, { ...options, registry }));
  const service = new XiaozhiDeviceService({ repository, interfaces: async () => [physicalFixture], lanPort: 0,
    registerTools, unregisterTools: name => unregisterServerTools(name, registry), disconnectServer, ...extra });
  services.push(service); return { service, registry, repository, registerTools, disconnectServer, rows: () => structuredClone(rows) };
}
async function pair(service: XiaozhiDeviceService) { return service.createPairing(owner, { deviceId, clientId, localAddress: physicalFixture.address }); }
async function bootstrap(service: XiaozhiDeviceService) { const configuration = await pair(service); const response = await fetch(configuration.otaUrl, { method: 'POST', headers: { 'Device-Id': deviceId, 'Client-Id': clientId, 'Content-Type': 'application/json' }, body: JSON.stringify({ fixtureSensitiveMetadata: 'discard-do-not-store' }) });
  expect(response.status).toBe(200); return { configuration, body: await response.json() as any }; }
async function device(service: XiaozhiDeviceService, options: { silent?: boolean; tools?: string[] } = {}) {
  const { configuration, body } = await bootstrap(service); const seen: any[] = []; let session = '';
  const socket = new WebSocket(body.websocket.url, { headers: { Authorization: 'Bearer ' + body.websocket.token, 'Device-Id': deviceId, 'Client-Id': clientId } }); sockets.push(socket);
  socket.on('error', () => undefined);
  socket.on('message', bytes => { const message = JSON.parse(bytes.toString()); if (message.type === 'hello') { session = message.session_id; return; } if (message.type !== 'mcp') return;
    seen.push(message.payload); if (options.silent) return;
    const rpc = message.payload; if (rpc.id === undefined) return; let result: unknown;
    if (rpc.method === 'initialize') result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'offline-xiaozhi-fixture', version: '1' } };
    else if (rpc.method === 'tools/list') { const names = options.tools ?? ['self.get_device_status', 'self.set_volume']; const index = rpc.params?.cursor === 'second' ? 1 : 0;
      result = { tools: names.slice(index, index + 1).map(name => ({ name, description: 'Actual fixture declaration ' + name, inputSchema: { type: 'object', properties: {} } })), ...(index === 0 && names.length > 1 ? { nextCursor: 'second' } : {}) }; }
    else { result = { content: [{ type: 'text', text: 'fixture-only' }] }; }
    socket.send(JSON.stringify({ type: 'mcp', session_id: session, payload: { jsonrpc: '2.0', id: rpc.id, result } }));
  });
  await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'hello', transport: 'websocket', features: { mcp: true } }));
  return { socket, configuration, body, seen };
}

describe('dedicated Xiaozhi runtime service (loopback fixture only; no hardware or model)', () => {
  it('keeps bootstrap private/scoped and exposes only device bootstrap and exact channel paths', async () => {
    const f = fixture(); const { configuration, body } = await bootstrap(f.service);
    expect(Object.keys(body)).toEqual(['websocket']); expect(Object.keys(body.websocket).sort()).toEqual(['token', 'url', 'version']);
    const snapshot = await f.service.list(owner); expect(snapshot.devices).toMatchObject([{ id: configuration.id, state: 'pending', connected: false, toolState: 'disconnected', toolCount: 0, audioSupported: false }]);
    expect(JSON.stringify(snapshot)).not.toMatch(/otaUrl|mcpUrl|bootstrapSecret|bridgeSecret|deviceSecret|discard-do-not-store/);
    expect((await f.service.list('another-owner')).devices).toEqual([]);
    await expect(f.service.getPairingConfiguration(configuration.id, 'another-owner')).rejects.toMatchObject({ statusCode: 404 });
    await expect(f.service.revoke(configuration.id, 'another-owner')).rejects.toMatchObject({ statusCode: 404 });
    const wrong = await fetch(configuration.otaUrl, { headers: { 'Device-Id': deviceId, 'Client-Id': 'wrong-board' } }); expect(wrong.status).toBe(401);
    expect((await fetch(new URL('/api/devices', configuration.otaUrl))).status).toBe(404);
    expect((await fetch(new URL('/api/devices/xiaozhi/mcp/' + configuration.id, configuration.otaUrl))).status).toBe(404);
    const correctGet = await fetch(configuration.otaUrl, { headers: { 'Device-Id': deviceId, 'Client-Id': clientId } }); expect(correctGet.status).toBe(200);
    expect(JSON.stringify(f.rows())).not.toContain('discard-do-not-store');
  });
  it('rejects non-selected interfaces before listening or persisting and reports a real dedicated port conflict', async () => {
    const f = fixture(); await expect(f.service.createPairing(owner, { deviceId, localAddress: '0.0.0.0' })).rejects.toMatchObject({ statusCode: 400 }); expect(f.rows()).toEqual([]);
    expect((await f.service.list(owner)).listener.state).toBe('stopped');
    const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve)); const port = (occupied.address() as any).port;
    try { const blocked = fixture({ lanPort: port }); await expect(pair(blocked.service)).rejects.toMatchObject({ code: 'EADDRINUSE' }); expect(blocked.rows()).toEqual([]); expect((await blocked.service.list(owner)).listener.state).toBe('error'); }
    finally { await new Promise<void>(resolve => occupied.close(() => resolve())); }
  });
  it('runs the real standard SDK initialize and full paginated catalogue before publishing actual declarations', async () => {
    const f = fixture(); const d = await device(f.service);
    await vi.waitFor(async () => expect((await f.service.list(owner)).devices[0]).toMatchObject({ connected: true, toolState: 'registered', toolCount: 2, toolError: null }));
    expect(d.seen.filter(rpc => rpc.method === 'tools/list').map(rpc => rpc.params?.cursor)).toEqual([undefined, 'second']);
    expect(f.registerTools).toHaveBeenCalledTimes(1); const [serverName, tools, options] = f.registerTools.mock.calls[0];
    expect(serverName).toMatch(/^xiaozhi-[a-f0-9]{64}$/); expect(tools.map((tool: any) => tool.rawName)).toEqual(['self.get_device_status', 'self.set_volume']);
    expect(options.serverConfig).toMatchObject({ source: 'external', transport: 'ws', runtimeOwnerUid: owner }); expect(new URL(options.serverConfig.url).hostname).toBe('127.0.0.1');
    expect(f.registry.list().map(tool => tool.name).sort()).toEqual(tools.map((tool: any) => tool.name).sort());
    const second = tools[1]; const wrongContext = { authenticated: true, userId: 'another-owner', localExecution: true, executionBoundary: 'trusted_local' as const, userConfirmed: true };
    await expect(f.registry.execute(second.name, {}, wrongContext)).rejects.toThrow(/owner|owning|local/i);
    const result = await f.registry.execute(second.name, {}, { ...wrongContext, userId: owner });
    expect(result).toContain('fixture-only'); expect(d.seen.filter(rpc => rpc.method === 'tools/call')).toHaveLength(1);
    d.socket.close(); await vi.waitFor(async () => expect((await f.service.list(owner)).devices[0]).toMatchObject({ connected: false, toolState: 'disconnected', toolCount: 0 }));
    expect(f.registry.list()).toHaveLength(0); expect(f.disconnectServer).toHaveBeenCalled();
  });
  it('shows catalogue errors rather than inventing callable tools after an accepted device hello', async () => {
    const f = fixture(); await device(f.service, { tools: ['../not-a-protocol-tool'] });
    await vi.waitFor(async () => expect((await f.service.list(owner)).devices[0]).toMatchObject({ connected: true, toolState: 'error', toolCount: 0, toolError: 'Invalid MCP tool name' })); expect(f.registry.list()).toHaveLength(0);
  });
  it('never publishes a late catalogue after revoke and closes both dedicated listeners when the last binding is revoked', async () => {
    let release!: (value: any) => void; const pending = new Promise<any>(resolve => { release = resolve; });
    const fakeClient = { connect: vi.fn(async () => undefined), listTools: vi.fn(() => pending), close: vi.fn(async () => undefined) };
    const f = fixture({ createClient: () => fakeClient as any }); const d = await device(f.service, { silent: true });
    await vi.waitFor(() => expect(fakeClient.listTools).toHaveBeenCalledTimes(1));
    const revoked = f.service.revoke(d.configuration.id, owner); await vi.waitFor(() => expect(f.rows()).toEqual([]));
    release({ tools: [{ name: 'self.get_device_status', inputSchema: { type: 'object', properties: {} } }] }); await revoked;
    expect(f.registerTools).not.toHaveBeenCalled(); expect(f.registry.list()).toHaveLength(0); expect((await f.service.list(owner)).listener.state).toBe('stopped');
    expect(fakeClient.close).toHaveBeenCalled(); expect((await f.service.list(owner)).devices).toEqual([]);
  });
  it('applies the same LAN source check before device websocket upgrade even when the private binding is valid', async () => {
    const f = fixture(); const { configuration, body } = await bootstrap(f.service); const runtime = (f.service as any).runtime;
    const writes: string[] = []; const stream = new Duplex({ read() {}, write(chunk, _encoding, callback) { writes.push(chunk.toString()); callback(); } });
    runtime.lan.emit('upgrade', { url: '/api/devices/xiaozhi/device/' + configuration.id, socket: { remoteAddress: '203.0.113.9' }, headers: { authorization: 'Bearer ' + body.websocket.token, 'device-id': deviceId, 'client-id': clientId } }, stream, Buffer.alloc(0));
    await new Promise(resolve => setImmediate(resolve)); expect(writes.join('')).toContain('403'); expect((await f.service.list(owner)).devices[0].connected).toBe(false); stream.destroy();
  });

  it('restores the same encrypted pairing on the saved physical address after a full service close and restart', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lumi-xiaozhi-runtime-')); directories.push(directory);
    const repository = new EncryptedXiaozhiRepository({ filePath: path.join(directory, 'private.enc.json'), secret: () => 'fixture-installation' });
    const first = fixture({ repository }); const original = await pair(first.service); const originalPort = (await first.service.list(owner)).listener.port!;
    await first.service.close(); const second = fixture({ repository, lanPort: originalPort }); await second.service.startSaved();
    expect((await second.service.list(owner)).devices).toMatchObject([{ id: original.id, connected: false, state: 'pending', toolCount: 0 }]);
    const restored = await second.service.getPairingConfiguration(original.id, owner); expect(restored.otaUrl).toBe(original.otaUrl);
    expect(new URL(restored.mcpUrl).searchParams.get('token')).toBe(new URL(original.mcpUrl).searchParams.get('token'));
    expect((await second.service.list('another-owner')).devices).toEqual([]);
    await second.service.revoke(original.id, owner); expect(repository.load()).toEqual([]); expect((await second.service.list(owner)).listener.state).toBe('stopped');
  });
  it('closes newly opened listeners if the first pairing cannot be durably saved', async () => {
    const save = vi.fn(() => { throw new Error('fixture durable save failed'); });
    const f = fixture({ repository: { load: () => [], save } }); await expect(pair(f.service)).rejects.toThrow('fixture durable save failed');
    expect(save).toHaveBeenCalledTimes(1); expect((await f.service.list(owner))).toMatchObject({ devices: [], listener: { state: 'stopped' } });
  });
  it('preserves an unrestorable store and reports the failure without an empty overwrite or listener', async () => {
    const save = vi.fn(); const f = fixture({ repository: { load: () => { throw new Error('encrypted restore failed; file preserved'); }, save } });
    await expect(f.service.startSaved()).rejects.toThrow(/preserved/); const result = await f.service.list(owner);
    expect(result).toMatchObject({ devices: [], errors: [{ code: 'restore_failed', message: 'encrypted restore failed; file preserved' }], listener: { state: 'error', localAddress: null, port: null } });
    await expect(pair(f.service)).rejects.toThrow(/preserved/); expect(save).not.toHaveBeenCalled();
  });
});
