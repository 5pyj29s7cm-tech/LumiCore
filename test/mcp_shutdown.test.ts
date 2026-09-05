import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { attachMcpCallLifecycle } from '../server/mcp/lifecycle';

const fixture = vi.hoisted(() => ({
  key: 'isolated-shutdown-fixture-key',
  probe: vi.fn(),
  stop: vi.fn(),
  close: vi.fn(),
  remoteDevices: {} as Record<string, string>,
}));
vi.mock('../server/config/local_identity', () => ({ getJwtSecret: () => fixture.key }));
vi.mock('../server/org/db', () => ({ getMember: () => null }));
vi.mock('../server/lap/transport', () => ({ attachLAPWebSocket: vi.fn() }));
vi.mock('../server/tools/registry', () => ({ toolRegistry: {} }));
vi.mock('../server/devices', () => ({ deviceRegistry: { registerMcpDevice: vi.fn(), unregisterMcpDevice: vi.fn() } }));
vi.mock('../server/mcp/client', () => ({ mcpManager: { getRemoteDevices: () => fixture.remoteDevices } }));
vi.mock('../server/mcp/ws_transport', async importOriginal => ({
  ...await importOriginal<typeof import('../server/mcp/ws_transport')>(),
  connectMcpServerToRemote: () => ({ stop: fixture.stop, close: fixture.close }),
}));
vi.mock('../server/mcp/lumi_server', () => ({
  createLumiMcpServer: (_llm: unknown, _tools: unknown, _broadcast: unknown, _scope: unknown, lifecycle: any) => {
    const server = new McpServer({ name: 'isolated-runtime-shutdown-fixture', version: '1' });
    attachMcpCallLifecycle(server, lifecycle);
    server.registerTool('probe', { inputSchema: {} }, fixture.probe);
    return server;
  },
  handleMcpSSE: vi.fn(),
  handleMcpMessage: vi.fn(),
}));
import { setupMcpServer } from '../server/runtime/mcp_server';
import { WebSocketServerTransport } from '../server/mcp/ws_transport';

let httpServer: Server;
let endpoint: string;
let shutdown: () => Promise<void>;
const clients: Client[] = [];
const token = jwt.sign({ uid: 'fixture-user', role: 'user' }, fixture.key);

async function start() {
  const app = express();
  httpServer = createServer(app);
  shutdown = setupMcpServer(app, httpServer, { to: () => ({ emit: vi.fn() }) } as any, {} as any, process.cwd());
  httpServer.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  endpoint = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
}

beforeEach(() => {
  fixture.probe.mockReset();
  fixture.stop.mockReset();
  fixture.close.mockReset().mockResolvedValue(undefined);
  fixture.remoteDevices = {};
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await shutdown?.();
  if (httpServer) await new Promise<void>(resolve => httpServer.close(() => resolve()));
});

describe('runtime MCP shutdown handshake', () => {
  it('keeps admitted work alive, synchronously stops new connections and closes only after it settles', async () => {
    let release!: () => void;
    fixture.probe.mockImplementation(() => new Promise(resolve => {
      release = () => resolve({ content: [{ type: 'text', text: 'finished' }] });
    }));
    fixture.remoteDevices = { synthetic: 'ws://synthetic.invalid' };
    await start();
    const socket = new WebSocket(`${endpoint.replace('http:', 'ws:')}/mcp/ws`, { headers: { Authorization: `Bearer ${token}` } });
    await once(socket, 'open');
    const client = new Client({ name: 'synthetic-client', version: '1' });
    clients.push(client);
    await client.connect(new WebSocketServerTransport(socket));
    const response = client.callTool({ name: 'probe', arguments: {} });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    let done = false;
    const pending = shutdown();
    void pending.then(() => { done = true; });
    expect(shutdown()).toBe(pending);
    expect(fixture.stop).toHaveBeenCalled();
    expect(fixture.close).not.toHaveBeenCalled();
    expect(done).toBe(false);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    for (const [path, method] of [['/mcp/sse', 'GET'], ['/mcp/message?sessionId=synthetic', 'POST']]) {
      expect((await fetch(`${endpoint}${path}`, { method, headers: { Authorization: `Bearer ${token}` } })).status).toBe(503);
    }
    const rejected = new WebSocket(`${endpoint.replace('http:', 'ws:')}/mcp/ws`, { headers: { Authorization: `Bearer ${token}` } });
    rejected.on('error', () => undefined);
    const status = await new Promise<number>(resolve => rejected.once('unexpected-response', (_request, res) => { resolve(res.statusCode!); res.resume(); rejected.terminate(); }));
    expect(status).toBe(503);
    release();
    expect(((await response).content as any[])[0].text).toBe('finished');
    await pending;
    expect(done).toBe(true);
    expect(fixture.close).toHaveBeenCalledTimes(1);
    expect(fixture.probe).toHaveBeenCalledTimes(1);
    await shutdown();
    expect(fixture.close).toHaveBeenCalledTimes(1);
  });

  it('reports a transport close failure and retries cleanup on the next shutdown attempt', async () => {
    fixture.remoteDevices = { synthetic: 'ws://synthetic.invalid' };
    fixture.close.mockRejectedValueOnce(new Error('synthetic close failure')).mockResolvedValue(undefined);
    await start();
    await expect(shutdown()).rejects.toThrow('synthetic close failure');
    expect(fixture.stop).toHaveBeenCalledTimes(1);
    await shutdown();
    expect(fixture.close).toHaveBeenCalledTimes(2);
    expect((await fetch(`${endpoint}/mcp/sse`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(503);
  });
});
