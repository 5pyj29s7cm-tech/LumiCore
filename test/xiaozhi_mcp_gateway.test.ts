import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { XiaozhiMcpGateway, type XiaozhiGatewayOptions } from '../server/devices/xiaozhi_mcp_gateway';

type Pairing = ReturnType<XiaozhiMcpGateway['createPairing']>;
const knownId = '02:00:00:00:00:42';
const knownClientId = 'synthetic-firmware-client';
const servers: Server[] = [], gateways: XiaozhiMcpGateway[] = [], sockets: WebSocket[] = [], clients: Client[] = [];
const listen = async () => {
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, origin: `http://127.0.0.1:${(server.address() as any).port}` };
};
async function harness(options: Partial<XiaozhiGatewayOptions> = {}) {
  const device = await listen(), bridge = await listen();
  const gateway = new XiaozhiMcpGateway({ localBaseUrl: bridge.origin, ...options }); gateways.push(gateway);
  gateway.attachUpgrade(device.server, { kind: 'device' }); gateway.attachUpgrade(bridge.server, { kind: 'mcp' });
  const pair = gateway.createPairing({ ownerUid: 'owner-a', deviceId: knownId, clientId: knownClientId, publicBaseUrl: device.origin });
  return { gateway, pair, device, bridge };
}
const credentials = (pair: Pairing) => ({ token: new URL(pair.otaUrl).searchParams.get('token')!, deviceId: knownId, clientId: knownClientId });
const track = (socket: WebSocket) => { sockets.push(socket); socket.on('error', () => {}); return socket; };
async function until(check: () => boolean) { for (let index = 0; index < 100; index++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Condition did not settle'); }
function nextMessage(socket: WebSocket) { return new Promise<any>(resolve => socket.once('message', bytes => resolve(JSON.parse(bytes.toString())))); }
async function rejectedUpgrade(url: string, headers?: Record<string, string>) {
  const socket = track(new WebSocket(url, { headers }));
  return new Promise<number>((resolve, reject) => {
    socket.once('unexpected-response', (request, response) => { const code = response.statusCode!; response.destroy(); request.destroy(); resolve(code); });
    socket.once('open', () => reject(new Error('Unexpected successful upgrade')));
  });
}
async function fakeDevice(gateway: XiaozhiMcpGateway, pair: Pairing, autoReply = true, identity = { deviceId: knownId, clientId: knownClientId }) {
  const bootstrap = gateway.bootstrap(pair.id, { ...credentials(pair), ...identity });
  const socket = track(new WebSocket(bootstrap.websocket.url, { headers: { Authorization: 'Bearer ' + bootstrap.websocket.token, 'Device-Id': identity.deviceId, 'Client-Id': identity.clientId } }));
  const requests: any[] = []; let sessionId = '';
  const respond = (payload: any) => socket.send(JSON.stringify({ type: 'mcp', session_id: sessionId, payload }));
  socket.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.type === 'hello') { sessionId = message.session_id; return; }
    if (message.type !== 'mcp') return;
    const payload = message.payload; requests.push(payload);
    if (!autoReply || payload.id === undefined) return;
    let result: any;
    if (payload.method === 'initialize') result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'Synthetic device tools', version: '9.7.3' } };
    else if (payload.method === 'tools/list') result = { tools: [{ name: 'example.read_status', description: 'Synthetic status read', inputSchema: { type: 'object', properties: {} } }] };
    else result = { content: [{ type: 'text', text: JSON.stringify({ receivedArguments: payload.params.arguments }) }], isError: false };
    respond({ jsonrpc: '2.0', id: payload.id, result });
  });
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'hello', version: 1, features: { mcp: true }, transport: 'websocket', audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } }));
  await until(() => Boolean(sessionId));
  return { socket, requests, respond, bootstrap, get sessionId() { return sessionId; } };
}
async function sdkClient(gateway: XiaozhiMcpGateway, pair: Pairing) {
  const client = new Client({ name: 'existing-sdk-client-fixture', version: '1.0' }, { capabilities: {} }); clients.push(client);
  await client.connect(new WebSocketClientTransport(new URL(gateway.getMcpUrl(pair.id, 'owner-a')))); return client;
}
afterEach(async () => {
  sockets.splice(0).forEach(socket => socket.terminate());
  await Promise.all(clients.splice(0).map(client => client.close().catch(() => {})));
  await Promise.all(gateways.splice(0).map(gateway => gateway.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe('Xiaozhi device MCP wire gateway', () => {
  it('returns only the supported WebSocket bootstrap, requires a secret as well as the known identity, and does not expose credentials in status', async () => {
    const { gateway, pair } = await harness(); const privateBinding = gateway.getPrivateBindings()[0];
    const bootstrap = gateway.bootstrap(pair.id, credentials(pair));
    expect(Object.keys(bootstrap)).toEqual(['websocket']); expect(bootstrap.websocket.version).toBe(1);
    expect(bootstrap).not.toHaveProperty('mqtt'); expect(bootstrap).not.toHaveProperty('firmware'); expect(bootstrap).not.toHaveProperty('activation');
    expect(() => gateway.bootstrap(pair.id, { ...credentials(pair), token: 'not-authorized' })).toThrow('authentication failed');
    expect(() => gateway.bootstrap(pair.id, { ...credentials(pair), deviceId: '02:00:00:00:00:99' })).toThrow('authentication failed');
    expect(() => gateway.bootstrap(pair.id, { ...credentials(pair), clientId: 'other-client' })).toThrow('authentication failed');
    expect(() => gateway.getMcpUrl(pair.id, 'another-owner')).toThrow('not found');
    const publicJson = JSON.stringify(gateway.publicStatus());
    for (const value of [privateBinding.bootstrapSecret, privateBinding.deviceSecret, privateBinding.bridgeSecret, pair.otaUrl, pair.mcpUrl]) expect(publicJson).not.toContain(value);
    expect(gateway.publicStatus(pair.id)).toMatchObject({ ownerUid: 'owner-a', state: 'pending', connected: false, audioSupported: false });
    expect(new Set([privateBinding.bootstrapSecret, privateBinding.deviceSecret, privateBinding.bridgeSecret]).size).toBe(3);
  });

  it('performs real device hello and existing SDK initialize/list/call over separate loopback servers without fabricated tools', async () => {
    const ready = vi.fn(); const { gateway, pair } = await harness({ onDeviceReady: ready });
    const device = await fakeDevice(gateway, pair); const client = await sdkClient(gateway, pair);
    const inventory = await client.listTools(); expect(inventory.tools[0].name).toBe('example.read_status');
    const receipt = await client.callTool({ name: 'example.read_status', arguments: { nonce: 'preserve-this-value', zero: 0, enabled: false } });
    expect(receipt.content).toEqual([{ type: 'text', text: JSON.stringify({ receivedArguments: { nonce: 'preserve-this-value', zero: 0, enabled: false } }) }]);
    expect(device.requests.find(item => item.method === 'tools/call').params.name).toBe('example.read_status');
    expect(ready).toHaveBeenCalledOnce(); expect(ready.mock.calls[0][0]).toMatchObject({ connected: true, state: 'active', ownerUid: 'owner-a' });
    expect(gateway.publicStatus(pair.id)?.connected).toBe(true);
  });

  it('rejects wrong device credentials, bridge-token confusion and a disconnected device before an MCP connection', async () => {
    const { gateway, pair } = await harness(); const bootstrap = gateway.bootstrap(pair.id, credentials(pair));
    expect(await rejectedUpgrade(pair.mcpUrl)).toBe(503);
    expect(await rejectedUpgrade(bootstrap.websocket.url, { Authorization: 'Bearer wrong', 'Device-Id': knownId, 'Client-Id': knownClientId })).toBe(401);
    expect(await rejectedUpgrade(bootstrap.websocket.url, { Authorization: 'Bearer ' + bootstrap.websocket.token, 'Device-Id': 'different-device', 'Client-Id': knownClientId })).toBe(401);
    await fakeDevice(gateway, pair);
    const wrongBridge = new URL(pair.mcpUrl); wrongBridge.searchParams.set('token', bootstrap.websocket.token);
    expect(await rejectedUpgrade(wrongBridge.href)).toBe(401);
    expect(gateway.publicStatus(pair.id)?.connected).toBe(true);
  });

  it('isolates duplicate client request identifiers and routes reversed device replies to their exact clients', async () => {
    const { gateway, pair } = await harness(); const device = await fakeDevice(gateway, pair, false);
    const a = track(new WebSocket(pair.mcpUrl, 'mcp')), b = track(new WebSocket(pair.mcpUrl, 'mcp'));
    await Promise.all([once(a, 'open'), once(b, 'open')]); const aReply = nextMessage(a), bReply = nextMessage(b);
    a.send(JSON.stringify({ jsonrpc: '2.0', id: 'same-id', method: 'tools/list', params: { cursor: 'a' } }));
    b.send(JSON.stringify({ jsonrpc: '2.0', id: 'same-id', method: 'tools/list', params: { cursor: 'b' } }));
    await until(() => device.requests.length === 2); expect(device.requests[0].id).not.toBe(device.requests[1].id);
    for (const request of [...device.requests].reverse()) device.respond({ jsonrpc: '2.0', id: request.id, result: { tools: [], nextCursor: request.params.cursor } });
    expect(await aReply).toEqual({ jsonrpc: '2.0', id: 'same-id', result: { tools: [], nextCursor: 'a' } });
    expect(await bReply).toEqual({ jsonrpc: '2.0', id: 'same-id', result: { tools: [], nextCursor: 'b' } });
  });

  it('preserves a device error with the legacy missing code in a valid MCP error response', async () => {
    const { gateway, pair } = await harness(); const device = await fakeDevice(gateway, pair, false);
    const socket = track(new WebSocket(pair.mcpUrl, 'mcp')); await once(socket, 'open'); const reply = nextMessage(socket);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 57, method: 'tools/call', params: { name: 'unsupported.tool', arguments: {} } }));
    await until(() => device.requests.length === 1); device.respond({ jsonrpc: '2.0', id: device.requests[0].id, error: { message: 'Original device failure' } });
    expect(await reply).toEqual({ jsonrpc: '2.0', id: 57, error: { code: -32000, message: 'Original device failure' } });
  });

  it('reports a timed-out action as unknown and never automatically replays it', async () => {
    const { gateway, pair } = await harness({ requestTimeoutMs: 30 }); const device = await fakeDevice(gateway, pair, false);
    const socket = track(new WebSocket(pair.mcpUrl, 'mcp')); await once(socket, 'open'); const reply = nextMessage(socket);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'example.action', arguments: {} } }));
    const failure = await reply; expect(failure.error.message).toMatch(/outcome may be unknown/); expect(failure.error.message).toMatch(/not replayed/);
    await new Promise(resolve => setTimeout(resolve, 50)); expect(device.requests.filter(item => item.method === 'tools/call')).toHaveLength(1);
  });

  it('reports device disconnection, closes the old MCP transport and does not replay pending actions on a replacement session', async () => {
    const disconnected = vi.fn(); const { gateway, pair } = await harness({ onDeviceDisconnected: disconnected }); const device = await fakeDevice(gateway, pair, false);
    const socket = track(new WebSocket(pair.mcpUrl, 'mcp')); await once(socket, 'open'); const reply = nextMessage(socket);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'example.action', arguments: {} } }));
    await until(() => device.requests.length === 1); device.socket.close(); expect((await reply).error.message).toMatch(/outcome may be unknown/);
    await until(() => gateway.publicStatus(pair.id)?.connected === false); expect(disconnected).toHaveBeenCalledOnce();
    const replacement = await fakeDevice(gateway, pair); await new Promise(resolve => setTimeout(resolve, 20));
    expect(replacement.requests).toHaveLength(0); expect(gateway.publicStatus(pair.id)?.connected).toBe(true);
  });

  it('expires an unused enrollment but retains revocable active credentials across time and private-state restore', async () => {
    let now = Date.now(); const { gateway, pair, bridge } = await harness({ now: () => now });
    const pendingRecord = gateway.getPrivateBindings(); now += 300001;
    expect(() => gateway.bootstrap(pair.id, credentials(pair))).toThrow('authentication failed'); expect(gateway.publicStatus(pair.id)?.state).toBe('expired');
    now -= 300001; await fakeDevice(gateway, pair); const activeRecord = gateway.getPrivateBindings();
    now += 3600000; expect(gateway.bootstrap(pair.id, credentials(pair))).toHaveProperty('websocket');
    const restored = new XiaozhiMcpGateway({ localBaseUrl: bridge.origin, bindings: activeRecord, now: () => now }); gateways.push(restored);
    expect(restored.publicStatus(pair.id)).toMatchObject({ state: 'active', connected: false, ownerUid: 'owner-a' });
    expect(restored.bootstrap(pair.id, credentials(pair))).toEqual(gateway.bootstrap(pair.id, credentials(pair)));
    const expired = new XiaozhiMcpGateway({ localBaseUrl: bridge.origin, bindings: pendingRecord, now: () => now }); gateways.push(expired);
    expect(() => expired.bootstrap(pair.id, credentials(pair))).toThrow('authentication failed');
    restored.revoke(pair.id, 'owner-a'); expect(() => restored.bootstrap(pair.id, credentials(pair))).toThrow('authentication failed');
  });

  it('leaves unrelated and wrong-channel upgrade paths untouched for the owning server', async () => {
    const { gateway, pair, bridge } = await harness();
    bridge.server.on('upgrade', (_request, socket) => { if (!socket.destroyed) socket.end('HTTP/1.1 418 Other Owner\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); });
    expect(await rejectedUpgrade(bridge.origin.replace('http:', 'ws:') + '/socket.io/?EIO=4')).toBe(418);
    expect(await rejectedUpgrade(gateway.bootstrap(pair.id, credentials(pair)).websocket.url.replace(new URL(pair.otaUrl).origin.replace('http:', 'ws:'), bridge.origin.replace('http:', 'ws:')))).toBe(418);
  });

  it('does not bind a malformed hello and rejects a mismatched session envelope without fabricating a tool response', async () => {
    const { gateway, pair } = await harness(); const bootstrap = gateway.bootstrap(pair.id, credentials(pair));
    const bad = track(new WebSocket(bootstrap.websocket.url, { headers: { Authorization: 'Bearer ' + bootstrap.websocket.token, 'Device-Id': knownId, 'Client-Id': knownClientId } }));
    await once(bad, 'open'); const badClosed = once(bad, 'close'); bad.send(JSON.stringify({ type: 'hello', transport: 'websocket', features: { mcp: false } }));
    expect((await badClosed)[0]).toBe(1008); expect(gateway.publicStatus(pair.id)?.state).toBe('pending');
    const device = await fakeDevice(gateway, pair); const closed = once(device.socket, 'close');
    device.socket.send(JSON.stringify({ type: 'mcp', session_id: 'wrong-session', payload: { jsonrpc: '2.0', id: 1, result: {} } }));
    expect((await closed)[0]).toBe(1008); await until(() => gateway.publicStatus(pair.id)?.connected === false);
  });

  it('ignores binary audio without retaining or forwarding it as MCP and survives an activation callback failure', async () => {
    const errors = vi.fn(); const { gateway, pair } = await harness({ onDeviceReady: async () => { throw new Error('Runtime registration unavailable'); }, onLifecycleError: errors });
    const device = await fakeDevice(gateway, pair); device.socket.send(Buffer.from([1, 2, 3]));
    await until(() => errors.mock.calls.length === 1); expect(errors.mock.calls[0][0]).toBe('device_ready');
    expect(gateway.publicStatus(pair.id)?.audioSupported).toBe(false); const client = await sdkClient(gateway, pair);
    expect((await client.listTools()).tools).toHaveLength(1);
  });

  it('runs a synchronous owning-server source guard before device authentication or upgrade', async () => {
    const device = await listen(), bridge = await listen(); const guard = vi.fn(() => false);
    const gateway = new XiaozhiMcpGateway({ localBaseUrl: bridge.origin }); gateways.push(gateway);
    gateway.attachUpgrade(device.server, { kind: 'device', authorizeRequest: guard });
    const pair = gateway.createPairing({ ownerUid: 'owner-a', deviceId: knownId, clientId: knownClientId, publicBaseUrl: device.origin });
    const bootstrap = gateway.bootstrap(pair.id, credentials(pair));
    expect(await rejectedUpgrade(bootstrap.websocket.url, { Authorization: 'Bearer ' + bootstrap.websocket.token, 'Device-Id': knownId, 'Client-Id': knownClientId })).toBe(403);
    expect(guard).toHaveBeenCalledOnce(); expect(gateway.publicStatus(pair.id)?.connected).toBe(false);
  });

  it('rolls back private in-memory changes on a synchronous persistence failure without claiming a completed revoke', async () => {
    let fail = false; const save = vi.fn(() => { if (fail) throw new Error('Private binding persistence unavailable'); });
    const { gateway, pair } = await harness({ onBindingsChanged: save }); await fakeDevice(gateway, pair);
    fail = true; expect(() => gateway.revoke(pair.id, 'owner-a')).toThrow('persistence unavailable');
    expect(gateway.publicStatus(pair.id)).toMatchObject({ connected: true, state: 'active' });
    expect(gateway.bootstrap(pair.id, credentials(pair))).toHaveProperty('websocket');
    const count = gateway.getPrivateBindings().length;
    expect(() => gateway.createPairing({ ownerUid: 'owner-a', deviceId: 'other-known-device', publicBaseUrl: 'http://127.0.0.1:12345' })).toThrow('persistence unavailable');
    expect(gateway.getPrivateBindings()).toHaveLength(count);
  });

  it('requires the first authenticated device hello to finish inside the pairing window', async () => {
    let now = Date.now(); const { gateway, pair } = await harness({ now: () => now }); const bootstrap = gateway.bootstrap(pair.id, credentials(pair));
    const socket = track(new WebSocket(bootstrap.websocket.url, { headers: { Authorization: 'Bearer ' + bootstrap.websocket.token, 'Device-Id': knownId, 'Client-Id': knownClientId } }));
    await once(socket, 'open'); now += 300001; const closed = once(socket, 'close');
    socket.send(JSON.stringify({ type: 'hello', transport: 'websocket', features: { mcp: true } }));
    expect((await closed)[0]).toBe(1008); expect(gateway.publicStatus(pair.id)).toMatchObject({ state: 'expired', connected: false });
  });

  it('does not let a replaced socket close event retire the current device session', async () => {
    const { gateway, pair } = await harness(); const first = await fakeDevice(gateway, pair);
    const second = await fakeDevice(gateway, pair); await until(() => first.socket.readyState === WebSocket.CLOSED);
    expect(gateway.publicStatus(pair.id)?.connected).toBe(true);
    const client = await sdkClient(gateway, pair); expect((await client.listTools()).tools[0].name).toBe('example.read_status');
    expect(second.requests.some(request => request.method === 'initialize')).toBe(true);
  });

  it('keeps concurrent requests and credentials isolated between two bound devices', async () => {
    const { gateway, pair, device: listener } = await harness(); const first = await fakeDevice(gateway, pair, false);
    const identity = { deviceId: '02:00:00:00:00:43', clientId: 'second-client' };
    const pairB = gateway.createPairing({ ownerUid: 'owner-a', ...identity, publicBaseUrl: listener.origin });
    const second = await fakeDevice(gateway, pairB, false, identity);
    const a = track(new WebSocket(pair.mcpUrl, 'mcp')), b = track(new WebSocket(pairB.mcpUrl, 'mcp'));
    await Promise.all([once(a, 'open'), once(b, 'open')]); const aReply = nextMessage(a), bReply = nextMessage(b);
    for (const socket of [a, b]) socket.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }));
    await until(() => first.requests.length === 1 && second.requests.length === 1);
    second.respond({ jsonrpc: '2.0', id: second.requests[0].id, result: { tools: [], nextCursor: 'second-device' } });
    first.respond({ jsonrpc: '2.0', id: first.requests[0].id, result: { tools: [], nextCursor: 'first-device' } });
    expect((await aReply).result.nextCursor).toBe('first-device'); expect((await bReply).result.nextCursor).toBe('second-device');
    expect(() => gateway.bootstrap(pairB.id, credentials(pair))).toThrow('authentication failed');
  });
});
