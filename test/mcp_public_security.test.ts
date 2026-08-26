import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mayReceiveMcpHealthUpdate,
  normalizeRemoteDeviceConfig,
  projectMcpServerHealth,
  projectRemoteDeviceConfig,
  publicMcpToolFailure,
  sanitizeMcpEndpoint,
} from '../server/mcp/public_security';

const source = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('MCP public security projections', () => {
  it('never returns connector userinfo, opaque query values, or fragments', () => {
    const endpoint = 'wss://alice:private-password@example.test/device?session=opaque-secret&api_key=sk-private-value#private-fragment';
    const projected = sanitizeMcpEndpoint(endpoint)!;
    expect(projected).toContain('wss://example.test/device');
    expect(projected).toContain('session=%5Bconfigured%5D');
    expect(projected).toContain('api_key=%5Bconfigured%5D');
    for (const secret of ['alice', 'private-password', 'opaque-secret', 'sk-private-value', 'private-fragment']) {
      expect(projected).not.toContain(secret);
    }

    expect(projectRemoteDeviceConfig({ office: endpoint })).toEqual({ office: projected });
  });

  it('accepts only bounded WebSocket remote-device maps', () => {
    expect(normalizeRemoteDeviceConfig({ office: 'wss://device.example/mcp' })).toEqual({
      office: 'wss://device.example/mcp',
    });
    expect(normalizeRemoteDeviceConfig({ office: 'https://device.example/mcp' })).toBeNull();
    expect(normalizeRemoteDeviceConfig({ ' office ': 'wss://device.example/mcp' })).toBeNull();
    expect(normalizeRemoteDeviceConfig([])).toBeNull();
  });

  it('projects health without raw internal failures and targets only local administrators', () => {
    const health = projectMcpServerHealth({
      private: {
        status: 'failed',
        consecutiveCrashes: 3,
        lastError: 'spawn failed authorization: Bearer private-runtime-token at C:\\private\\runtime',
      },
    });
    const payload = JSON.stringify(health);
    expect(payload).not.toContain('private-runtime-token');
    expect(payload).not.toContain('C:\\private\\runtime');
    expect(health.private.lastError).toContain('local runtime logs');

    expect(mayReceiveMcpHealthUpdate({ authenticatedRole: 'admin', trustedLocalExecution: true })).toBe(true);
    expect(mayReceiveMcpHealthUpdate({ authenticatedRole: 'admin', trustedLocalExecution: false })).toBe(false);
    expect(mayReceiveMcpHealthUpdate({ authenticatedRole: 'user', trustedLocalExecution: true })).toBe(false);
  });

  it('uses fixed public MCP failures and does not broadcast raw prompts, tool arguments, or errors', () => {
    const publicFailure = publicMcpToolFailure();
    expect(publicFailure).not.toContain('private-runtime-token');

    const lumiServer = source('server/mcp/lumi_server.ts');
    expect(lumiServer).not.toContain('message: message.slice');
    expect(lumiServer).not.toContain('task: task.slice');
    expect(lumiServer).not.toContain("bc('agent:tool_call', { correlationId: cid, name: record.name, arguments:");
    expect(lumiServer).not.toContain('error: err.message');

    const client = source('server/mcp/client.ts');
    expect(client).not.toContain("this.ioRef.emit('mcp:health_update'");
    expect(client).toContain('mayReceiveMcpHealthUpdate(socket?.data)');
  });
});
