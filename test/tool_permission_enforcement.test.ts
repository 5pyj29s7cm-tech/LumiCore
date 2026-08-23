import './helpers';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';
import type { ToolPermission } from '../server/tools/types';

function registryWith(permission: ToolPermission): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: `permission_${permission}`,
    description: 'Permission enforcement probe.',
    parameters: { type: 'object', properties: {} },
    permission,
    securityLevel: 'safe',
    handler: async () => 'ok',
  });
  return registry;
}

describe('tool registry permission enforcement', () => {
  it('allows public tools but blocks externally sourced anonymous user tools', async () => {
    await expect(registryWith('public').execute('permission_public', {}, {
      source: 'public-http-probe',
    })).resolves.toBe('ok');

    await expect(registryWith('user').execute('permission_user', {}, {
      userId: 'anonymous',
      source: 'legal-direct-tool',
    })).rejects.toThrow(/authenticated user/i);

    await expect(registryWith('user').execute('permission_user', {}, {
      userId: 'authenticated-user',
      source: 'legal-direct-tool',
      localExecution: false,
    })).rejects.toThrow(/authenticated user/i);

    await expect(registryWith('user').execute('permission_user', {}, {
      userId: 'authenticated-user',
      source: 'legal-direct-tool',
      authenticated: true,
      localExecution: false,
    })).resolves.toBe('ok');
  });

  it('requires a verified administrator identity for admin tools', async () => {
    const registry = registryWith('admin');
    await expect(registry.execute('permission_admin', {}, {
      userId: 'ordinary-user',
      source: 'mcp_chat',
    })).rejects.toThrow(/administrator permission/i);

    await expect(registry.execute('permission_admin', {}, {
      userId: 'claimed-admin',
      source: 'mcp_chat',
      authRole: 'admin',
    } as any)).rejects.toThrow(/administrator permission/i);

    await expect(registry.execute('permission_admin', {}, {
      userId: 'verified-admin',
      source: 'mcp_chat',
      authenticated: true,
      authRole: 'admin',
    } as any)).resolves.toBe('ok');
  });

  it('keeps system tools behind an explicit trusted-system context', async () => {
    const registry = registryWith('system');
    await expect(registry.execute('permission_system', {}, {
      userId: 'verified-admin',
      source: 'mcp_chat',
      authenticated: true,
      authRole: 'admin',
    } as any)).rejects.toThrow(/trusted system permission/i);

    await expect(registry.execute('permission_system', {}, {
      source: 'scheduler',
      systemExecution: true,
    } as any)).resolves.toBe('ok');
  });

  it('does not register user-configured MCP adapters as anonymous public tools', () => {
    const mcpRegistrySource = readFileSync(path.resolve(process.cwd(), 'server/mcp/index.ts'), 'utf8');
    expect(mcpRegistrySource).toContain("permission: 'user'");
    expect(mcpRegistrySource).not.toContain("permission: 'public'");
  });
});
