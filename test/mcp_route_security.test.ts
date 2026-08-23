import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import { mountMcpRoutes } from '../server/routes/mcp_routes';
import { requireLocalRequest } from '../server/middleware/auth';
import { authenticateMcpUpgradeRequest } from '../server/mcp/auth';
import { setupMcpServer } from '../server/runtime/mcp_server';
import WebSocket from 'ws';

let url: string;
let cleanup: () => void;
let rawMcpUrl: string;

const adminToken = jwt.sign({ uid: 'mcp-admin', username: 'admin', role: 'admin' }, JWT_SECRET);
const userToken = jwt.sign({ uid: 'mcp-user', username: 'user', role: 'user' }, JWT_SECRET);
const otherUserToken = jwt.sign({ uid: 'mcp-other-user', username: 'other', role: 'user' }, JWT_SECRET);

describe('MCP management route security', () => {
  beforeAll(async () => {
    const app = await makeApp();
    url = app.url;
    rawMcpUrl = app.url;
    cleanup = app.cleanup;
    mountMcpRoutes(app.apiRouter);
    const unavailable = () => null;
    setupMcpServer(
      app.app,
      app.server,
      { emit: () => undefined } as any,
      {
        getDeepSeek: unavailable,
        getGemini: unavailable,
        getOpenAI: unavailable,
        getAnthropic: unavailable,
        getQwen: unavailable,
      },
      process.cwd(),
    );
  });

  afterAll(() => cleanup?.());

  it('keeps process-capable MCP configuration local and administrator-only', async () => {
    const anonymous = await fetch(`${url}/api/mcp`, { signal: AbortSignal.timeout(5000) });
    expect(anonymous.status).toBe(401);

    const nonAdminRead = await fetch(`${url}/api/mcp`, {
      headers: { Authorization: `Bearer ${userToken}` },
      signal: AbortSignal.timeout(5000),
    });
    expect(nonAdminRead.status).toBe(403);

    const nonAdminWrite = await fetch(`${url}/api/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        servers: { untrusted: { command: 'node', args: ['untrusted.js'], enabled: true } },
      }),
      signal: AbortSignal.timeout(5000),
    });
    expect(nonAdminWrite.status).toBe(403);

    const localAdmin = await fetch(`${url}/api/mcp`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      signal: AbortSignal.timeout(5000),
    });
    expect(localAdmin.status).toBe(200);
    const body = await localAdmin.json();
    for (const server of body.servers || []) {
      expect(server).not.toHaveProperty('env');
      expect(server).not.toHaveProperty('headers');
      expect(server).not.toHaveProperty('cachedTools');
    }
  });

  it('rejects anonymous and non-admin restart requests before touching a server', async () => {
    const anonymous = await fetch(`${url}/api/mcp/restart/not-configured`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
    expect(anonymous.status).toBe(401);

    const nonAdmin = await fetch(`${url}/api/mcp/restart/not-configured`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      signal: AbortSignal.timeout(5000),
    });
    expect(nonAdmin.status).toBe(403);
  });

  it('keeps remote-device configuration local and administrator-only', async () => {
    const anonymous = await fetch(`${url}/api/remote-devices`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(anonymous.status).toBe(401);

    const nonAdmin = await fetch(`${url}/api/remote-devices`, {
      headers: { Authorization: `Bearer ${userToken}` },
      signal: AbortSignal.timeout(5000),
    });
    expect(nonAdmin.status).toBe(403);

    const localAdmin = await fetch(`${url}/api/remote-devices`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      signal: AbortSignal.timeout(5000),
    });
    expect(localAdmin.status).toBe(200);
    expect(await localAdmin.json()).toHaveProperty('devices');
  });

  it('rejects a non-loopback request at the shared local boundary', () => {
    const status = vi.fn().mockReturnThis();
    const json = vi.fn();
    const next = vi.fn();
    requireLocalRequest(
      { socket: { remoteAddress: '192.0.2.10' } } as any,
      { status, json } as any,
      next,
    );
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('local Lumi desktop client'),
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it('authenticates MCP WebSocket upgrades from headers or desktop cookies, never URL tokens', () => {
    const bearer = authenticateMcpUpgradeRequest({
      headers: { authorization: `Bearer ${userToken}` },
      url: '/mcp/ws',
    } as any);
    expect(bearer).toMatchObject({ uid: 'mcp-user', role: 'user' });

    const cookie = authenticateMcpUpgradeRequest({
      headers: { cookie: `other=value; token=${encodeURIComponent(userToken)}` },
      url: '/mcp/ws',
    } as any);
    expect(cookie).toMatchObject({ uid: 'mcp-user' });

    const queryOnly = authenticateMcpUpgradeRequest({
      headers: {},
      url: `/mcp/ws?token=${encodeURIComponent(userToken)}`,
    } as any);
    expect(queryOnly).toBeNull();
  });

  it('requires authentication on the raw MCP SSE and message endpoints', async () => {
    const sse = await fetch(`${rawMcpUrl}/mcp/sse`, {
      signal: AbortSignal.timeout(5000),
    });
    expect(sse.status).toBe(401);

    const message = await fetch(`${rawMcpUrl}/mcp/message?sessionId=untrusted`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      signal: AbortSignal.timeout(5000),
    });
    expect(message.status).toBe(401);
  });

  it('keeps the authenticated desktop SSE transport available', async () => {
    const controller = new AbortController();
    try {
      const response = await fetch(`${rawMcpUrl}/mcp/sse`, {
        headers: { Authorization: `Bearer ${userToken}` },
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
    } finally {
      controller.abort();
    }
  });

  it('does not let another authenticated user post into an SSE session', async () => {
    const controller = new AbortController();
    try {
      const response = await fetch(`${rawMcpUrl}/mcp/sse`, {
        headers: { Authorization: `Bearer ${userToken}` },
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      expect(reader).toBeTruthy();
      const first = await reader!.read();
      const endpointEvent = new TextDecoder().decode(first.value || new Uint8Array());
      const sessionId = endpointEvent.match(/sessionId=([^\s\r\n]+)/)?.[1];
      expect(sessionId).toBeTruthy();

      const crossUser = await fetch(`${rawMcpUrl}/mcp/message?sessionId=${encodeURIComponent(sessionId!)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${otherUserToken}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        signal: AbortSignal.timeout(5000),
      });
      expect(crossUser.status).toBe(403);
    } finally {
      controller.abort();
    }
  });

  it('rejects an unauthenticated MCP WebSocket upgrade', async () => {
    const wsUrl = `${rawMcpUrl.replace(/^http/, 'ws')}/mcp/ws`;
    const status = await new Promise<number>((resolve, reject) => {
      const client = new WebSocket(wsUrl);
      client.once('unexpected-response', (_request, response) => {
        resolve(response.statusCode || 0);
        response.resume();
      });
      client.once('open', () => {
        client.close();
        reject(new Error('Unauthenticated MCP WebSocket unexpectedly opened'));
      });
      client.once('error', () => undefined);
    });
    expect(status).toBe(401);
  });

  it('accepts an authenticated MCP WebSocket upgrade', async () => {
    const wsUrl = `${rawMcpUrl.replace(/^http/, 'ws')}/mcp/ws`;
    await new Promise<void>((resolve, reject) => {
      const client = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      client.once('open', () => {
        client.close();
        resolve();
      });
      client.once('error', reject);
    });
  });
});
