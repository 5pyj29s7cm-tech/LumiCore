import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

vi.mock('../server/config/local_identity', () => ({ getJwtSecret: () => 'remote-fixture-key' }));
vi.mock('../server/org/db', () => ({ getMember: () => null }));
import { connectMcpServerToRemote, WebSocketServerTransport } from '../server/mcp/ws_transport';

let broker: WebSocketServer;
let endpoint: string;
const connections: Array<ReturnType<typeof connectMcpServerToRemote>> = [];
const clients: Array<{ socket: WebSocket; client: Client; ready: Promise<void>; path: string }> = [];
beforeEach(async () => {
  broker = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(broker, 'listening');
  endpoint = `ws://127.0.0.1:${(broker.address() as AddressInfo).port}`;
  broker.on('connection', (socket, request) => {
    const client = new Client({ name: 'synthetic-device', version: '1' });
    const ready = client.connect(new WebSocketServerTransport(socket));
    void ready.catch(() => undefined);
    clients.push({ socket, client, ready, path: request.url || '' });
  });
});
afterEach(async () => {
  await Promise.all(connections.splice(0).map(connection => connection.close()));
  for (const item of clients.splice(0)) { item.socket.terminate(); await item.client.close().catch(() => undefined); }
  await new Promise<void>(resolve => broker.close(() => resolve()));
  vi.restoreAllMocks();
});

function serverFactory(label: string) {
  return () => {
    const mcp = new McpServer({ name: `fixture-${label}`, version: '1' });
    mcp.registerTool('probe', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: label }] }));
    return mcp;
  };
}
async function waitForClients(count: number) {
  await vi.waitFor(() => expect(clients).toHaveLength(count), { timeout: 7000, interval: 10 });
  return clients[count - 1];
}

describe('outbound MCP device connection ownership', () => {
  it('keeps two devices independently initialized and callable with overlapping request ids', async () => {
    connections.push(connectMcpServerToRemote(`${endpoint}/one`, serverFactory('one'), 'one'));
    connections.push(connectMcpServerToRemote(`${endpoint}/two`, serverFactory('two'), 'two'));
    await waitForClients(2);
    await Promise.all(clients.map(item => item.ready));
    const results = await Promise.all(clients.map(async item => ({
      path: item.path, response: await item.client.callTool({ name: 'probe', arguments: {} }),
    })));
    for (const result of results) expect((result.response.content as any[])[0].text).toBe(result.path.slice(1));
  });

  it('reconnects with a fresh server instance and leaves the other device available', async () => {
    const factory = vi.fn(serverFactory('one'));
    connections.push(connectMcpServerToRemote(`${endpoint}/one`, factory, 'one'));
    connections.push(connectMcpServerToRemote(`${endpoint}/two`, serverFactory('two'), 'two'));
    await waitForClients(2);
    await Promise.all(clients.map(item => item.ready));
    const first = clients.find(item => item.path === '/one')!;
    const other = clients.find(item => item.path === '/two')!;
    first.socket.terminate();
    expect(((await other.client.callTool({ name: 'probe', arguments: {} })).content as any[])[0].text).toBe('two');
    const replacement = await waitForClients(3);
    await replacement.ready;
    expect(((await replacement.client.callTool({ name: 'probe', arguments: {} })).content as any[])[0].text).toBe('one');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('closes a failed initialization socket and retries with a new protocol instance', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const factory = vi.fn().mockImplementationOnce(() => { throw new Error('synthetic setup failure'); }).mockImplementation(serverFactory('recovered'));
    connections.push(connectMcpServerToRemote(`${endpoint}/recover`, factory, 'recover'));
    const failed = await waitForClients(1);
    await vi.waitFor(() => expect(failed.socket.readyState).toBe(WebSocket.CLOSED));
    const replacement = await waitForClients(2);
    await replacement.ready;
    expect(((await replacement.client.callTool({ name: 'probe', arguments: {} })).content as any[])[0].text).toBe('recovered');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('stops an open connector without leaving a retry timer', async () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const factory = vi.fn(serverFactory('one'));
    const connection = connectMcpServerToRemote(`${endpoint}/one`, factory, 'one');
    connections.push(connection);
    const item = await waitForClients(1);
    await item.ready;
    timeout.mockClear();
    await connection.close();
    await connection.close();
    expect(timeout.mock.calls.some(([, delay]) => delay === 5000)).toBe(false);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('can stop reconnects while keeping the transport alive for admitted work', async () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const connection = connectMcpServerToRemote(`${endpoint}/drain`, serverFactory('drained'), 'drain');
    connections.push(connection);
    const item = await waitForClients(1);
    await item.ready;
    connection.stop();
    expect(item.socket.readyState).toBe(WebSocket.OPEN);
    expect(((await item.client.callTool({ name: 'probe', arguments: {} })).content as any[])[0].text).toBe('drained');
    timeout.mockClear();
    const closed = once(item.socket, 'close');
    item.socket.terminate();
    await closed;
    await connection.close();
    expect(timeout.mock.calls.some(([, delay]) => delay === 5000)).toBe(false);
  });
});
