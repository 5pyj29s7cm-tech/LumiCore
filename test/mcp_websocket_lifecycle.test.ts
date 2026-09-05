import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import jwt from 'jsonwebtoken';
import { WebSocket, type WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const fixture = vi.hoisted(() => ({
  key: 'mcp-lifecycle-synthetic-signing-key',
  member: { status: 'active', role: 'member' } as { status: string; role: string } | null,
  getMember: vi.fn(),
}));
vi.mock('../server/config/local_identity', () => ({ getJwtSecret: () => fixture.key }));
vi.mock('../server/org/db', () => ({ getMember: (...args: unknown[]) => fixture.getMember(...args) }));
import { attachMcpWebSocket } from '../server/mcp/ws_transport';

let server: Server;
let websocketServer: WebSocketServer;
let client: WebSocket;
let calls: number;

async function request(id: number, method: string, params?: unknown) {
  const response = new Promise<any>((resolve, reject) => {
    const onMessage = (data: Buffer) => {
      const message = JSON.parse(data.toString());
      if (message.id !== id) return;
      client.off('message', onMessage);
      client.off('close', onClose);
      resolve(message);
    };
    const onClose = () => { client.off('message', onMessage); reject(new Error('Socket closed before response')); };
    client.on('message', onMessage);
    client.once('close', onClose);
  });
  client.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return response;
}

beforeEach(async () => {
  fixture.member = { status: 'active', role: 'member' };
  fixture.getMember.mockReset().mockImplementation(() => fixture.member);
  calls = 0;
  server = createServer();
  websocketServer = attachMcpWebSocket(server, (transport) => {
    const mcp = new McpServer({ name: 'isolated-lifecycle-fixture', version: '1' });
    mcp.registerTool('probe', { inputSchema: {} }, async () => {
      calls += 1;
      return { content: [{ type: 'text', text: 'synthetic result' }] };
    });
    void mcp.connect(transport);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const token = jwt.sign({ uid: 'fixture-user', role: 'user', orgId: 'fixture-org' }, fixture.key, { expiresIn: '1h' });
  client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/ws`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await once(client, 'open');
  await request(1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
  client.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  expect((await request(2, 'tools/call', { name: 'probe', arguments: {} })).result.content[0].text).toBe('synthetic result');
});

afterEach(async () => {
  vi.restoreAllMocks();
  client?.terminate();
  websocketServer?.clients.forEach(socket => socket.terminate());
  await new Promise<void>(resolve => websocketServer.close(() => resolve()));
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe('MCP WebSocket authorization during an established session', () => {
  it('keeps a valid long-lived session callable and checks membership again', async () => {
    const checks = fixture.getMember.mock.calls.length;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
    expect((await request(3, 'tools/call', { name: 'probe', arguments: {} })).result.content[0].text).toBe('synthetic result');
    expect(calls).toBe(2);
    expect(fixture.getMember.mock.calls.length).toBeGreaterThan(checks);
  });

  it.each(['removed', 'suspended', 'downgraded', 'expired'] as const)('closes before tool dispatch when the caller is %s', async (change) => {
    if (change === 'removed') fixture.member = null;
    if (change === 'suspended') fixture.member = { status: 'suspended', role: 'member' };
    if (change === 'downgraded') fixture.member = { status: 'active', role: 'viewer' };
    if (change === 'expired') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60_000);
    const closed = once(client, 'close');
    client.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'probe', arguments: {} } }));
    const [code] = await closed;
    expect(code).toBe(1008);
    expect(calls).toBe(1);
  });
});
