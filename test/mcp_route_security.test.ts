import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import { mountMcpRoutes } from '../server/routes/mcp_routes';
import { mcpManager } from '../server/mcp';
import { requireLocalRequest } from '../server/middleware/auth';
import { authenticateMcpUpgradeRequest } from '../server/mcp/auth';
import { setupMcpServer } from '../server/runtime/mcp_server';
import {
  DESKTOP_SESSION_HEADER,
  issueDesktopSessionProof,
} from '../server/config/desktop_bootstrap';
import WebSocket from 'ws';

let url: string;
let cleanup: () => void;
let rawMcpUrl: string;

const adminToken = jwt.sign({ uid: 'mcp-admin', username: 'admin', role: 'admin' }, JWT_SECRET);
const userToken = jwt.sign({ uid: 'mcp-user', username: 'user', role: 'user' }, JWT_SECRET);
const otherUserToken = jwt.sign({ uid: 'mcp-other-user', username: 'other', role: 'user' }, JWT_SECRET);

function nativeIdentity(pid: number) {
  const startedAtUnixMs = Math.floor((Date.now() - 30_000) / 1_000) * 1_000;
  return {
    schemaVersion: 1 as const,
    clientKind: 'tauri' as const,
    pid,
    startedAtUnixMs,
    executablePath: process.platform === 'win32' ? 'C:\\LumiCore\\lumi-core.exe' : '/opt/LumiCore/lumi-core',
    executableSha256: 'a'.repeat(64),
    binaryHashUnavailable: false,
    buildId: 'b'.repeat(40),
    buildIdSemantics: 'baseline_commit' as const,
    sourceFingerprint: 'c'.repeat(64),
    sourceDirty: false,
    appVersion: '3.1.0',
  };
}

describe('MCP management route security', () => {
  let adminDesktopSessionProof = '';

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
    adminDesktopSessionProof = issueDesktopSessionProof(
      'mcp-admin',
      nativeIdentity(52_101),
    ).proof;
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

  it('requires a native desktop session proof for every MCP runtime mutation', async () => {
    const cases = [
      {
        path: '/api/mcp',
        method: 'POST',
        body: { servers: { proof_probe: { command: 'node', enabled: false } } },
      },
      {
        path: '/api/mcp/proof_probe',
        method: 'PUT',
        body: { config: { command: 'node', enabled: false } },
      },
      { path: '/api/mcp/proof_probe', method: 'DELETE' },
      { path: '/api/mcp/proof_probe/state', method: 'POST', body: { enabled: false } },
      { path: '/api/mcp/restart/proof_probe', method: 'POST' },
      { path: '/api/remote-devices', method: 'PUT', body: { devices: {} } },
    ];
    for (const testCase of cases) {
      const response = await fetch(`${url}${testCase.path}`, {
        method: testCase.method,
        headers: {
          ...(testCase.body ? { 'Content-Type': 'application/json' } : {}),
          Authorization: `Bearer ${adminToken}`,
        },
        ...(testCase.body ? { body: JSON.stringify(testCase.body) } : {}),
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        error: 'A valid native desktop session proof is required for MCP runtime changes.',
      });
    }
  });

  it('does not expose restart internals to the local administrator response', async () => {
    const restart = vi.spyOn(mcpManager, 'restartServer').mockRejectedValueOnce(
      new Error('spawn failed api_key=sk-private-restart-secret at C:\\private\\mcp'),
    );
    const response = await fetch(`${url}/api/mcp/restart/not-configured-security-probe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        [DESKTOP_SESSION_HEADER]: adminDesktopSessionProof,
      },
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload).toEqual({ error: 'MCP server restart failed' });
    expect(JSON.stringify(payload)).not.toContain('not-configured-security-probe');
    expect(JSON.stringify(payload)).not.toContain('sk-private-restart-secret');
    restart.mockRestore();
  });

  it('rejects invalid transport config before persistence', async () => {
    const response = await fetch(`${url}/api/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        [DESKTOP_SESSION_HEADER]: adminDesktopSessionProof,
      },
      body: JSON.stringify({
        mode: 'merge',
        servers: {
          insecure_remote: {
            enabled: true,
            transport: 'http',
            url: 'http://provider.example/mcp',
          },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'MCP configuration update failed' });
  });

  it('returns a non-200 per-service failure when live activation rolls back', async () => {
    let config: Record<string, any> = {};
    const getConfig = vi.spyOn(mcpManager, 'getConfig').mockImplementation(() => structuredClone(config));
    const saveConfig = vi.spyOn(mcpManager, 'saveConfig').mockImplementation(next => {
      config = structuredClone(next);
    });
    const restart = vi.spyOn(mcpManager, 'restartServer').mockRejectedValue(
      new Error('synthetic activation failure'),
    );
    const disconnect = vi.spyOn(mcpManager, 'disconnectServer').mockResolvedValue();
    const connected = vi.spyOn(mcpManager, 'getConnectedServers').mockReturnValue([]);
    try {
      const response = await fetch(`${url}/api/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
          [DESKTOP_SESSION_HEADER]: adminDesktopSessionProof,
        },
        body: JSON.stringify({
          mode: 'merge',
          servers: {
            failing_server: {
              command: 'node',
              args: ['server.js'],
              enabled: true,
              source: 'external',
              transport: 'stdio',
            },
          },
        }),
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        ok: false,
        mode: 'merge',
        services: [{
          serverName: 'failing_server',
          action: 'rolled_back',
          configured: false,
          usable: false,
          error: expect.stringContaining('synthetic activation failure'),
        }],
      });
      expect(config).toEqual({});
    } finally {
      getConfig.mockRestore();
      saveConfig.mockRestore();
      restart.mockRestore();
      disconnect.mockRestore();
      connected.mockRestore();
    }
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

  it('rejects non-WebSocket remote-device endpoints before persisting them', async () => {
    const response = await fetch(`${url}/api/remote-devices`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        [DESKTOP_SESSION_HEADER]: adminDesktopSessionProof,
      },
      body: JSON.stringify({ devices: { unsafe: 'https://example.test/not-a-websocket' } }),
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid devices config' });
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
