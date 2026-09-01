import { describe, expect, it } from 'vitest';
import {
  activateInstalledSkill,
  mcpRegistryToolName,
  mcpServerConfigFingerprint,
  recoverServerTools,
  updateMCPConfig,
  validateMCPServerConfig,
} from '../server/mcp';
import type { MCPServerConfig, MCPToolDef } from '../server/mcp';
import { ToolRegistry } from '../server/tools/registry';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function stdio(command: string, rawToolName: string, enabled = true): MCPServerConfig {
  return {
    command,
    args: [rawToolName],
    enabled,
    source: 'external',
    transport: 'stdio',
  };
}

function tool(serverName: string, rawName: string): MCPToolDef {
  return {
    serverName,
    rawName,
    name: mcpRegistryToolName(serverName, rawName),
    description: `${serverName}:${rawName}`,
    inputSchema: { type: 'object', properties: {} },
  };
}

class FakeMcpManager {
  config: Record<string, MCPServerConfig>;
  connected = new Set<string>();
  disconnectCalls: string[] = [];
  restartCalls: string[] = [];

  constructor(config: Record<string, MCPServerConfig>) {
    this.config = clone(config);
  }

  getConfig() { return clone(this.config); }
  saveConfig(next: Record<string, MCPServerConfig>) { this.config = clone(next); }
  getConnectedServers() { return Array.from(this.connected); }

  async disconnectServer(name: string) {
    this.disconnectCalls.push(name);
    this.connected.delete(name);
  }

  async restartServer(name: string): Promise<MCPToolDef[]> {
    this.restartCalls.push(name);
    const config = this.config[name];
    if (!config?.enabled) return [];
    if (String(config.command).startsWith('fail')) {
      throw new Error(`synthetic activation failure for ${name}`);
    }
    this.connected.add(name);
    return [tool(name, String(config.args?.[0] || 'action'))];
  }

  beginSkillActivation(name: string) {
    this.config[name] = { ...this.config[name], enabled: true, installationState: 'pending' };
    return clone(this.config[name]);
  }

  commitSkillActivation(name: string) {
    this.config[name] = { ...this.config[name], enabled: true, installationState: 'active' };
  }

  uninstallSkill(name: string) {
    delete this.config[name];
  }
}

describe('MCP config reconciliation', () => {
  it('strictly validates names, transports, commands and remote URLs', () => {
    expect(() => validateMCPServerConfig('__proto__', stdio('node', 'action'))).toThrow();
    expect(() => validateMCPServerConfig('empty', { enabled: true, transport: 'stdio', command: '' })).toThrow();
    expect(() => validateMCPServerConfig('remote', {
      enabled: true,
      transport: 'http',
      url: 'http://provider.example/mcp',
    })).toThrow(/TLS/);
    expect(validateMCPServerConfig('local_http', {
      enabled: true,
      transport: 'http',
      url: 'http://127.0.0.1:9911/mcp',
    })).toMatchObject({ transport: 'http', url: 'http://127.0.0.1:9911/mcp' });
  });

  it('never turns a legacy or mutable package runner into an enabled MCP runtime', async () => {
    const legacy = {
      command: 'npx',
      args: ['-y', '@playwright/mcp@0.0.79'],
      enabled: false,
      source: 'external' as const,
      transport: 'stdio' as const,
    };
    expect(validateMCPServerConfig('legacy_playwright', legacy)).toMatchObject({ enabled: false });
    expect(() => validateMCPServerConfig('legacy_playwright', { ...legacy, enabled: true }))
      .toThrow(/online npx|immutable staged/i);
    expect(validateMCPServerConfig('local_pinned', {
      command: 'npx',
      args: ['--no-install', 'approved-local-cli'],
      enabled: true,
      source: 'external',
      transport: 'stdio',
    })).toMatchObject({ enabled: true });
    for (const [command, args] of [
      ['npm', ['exec', 'mutable-package']],
      ['pnpm', ['dlx', 'mutable-package']],
      ['yarn', ['dlx', 'mutable-package']],
      ['bunx', ['mutable-package']],
    ] as const) {
      expect(() => validateMCPServerConfig('mutable_runner', {
        command,
        args: [...args],
        enabled: true,
        source: 'external',
        transport: 'stdio',
      })).toThrow(/package-manager|immutable staged/i);
    }

    const manager = new FakeMcpManager({ legacy_playwright: legacy });
    const registry = new ToolRegistry();
    await expect(updateMCPConfig({
      legacy_playwright: { ...legacy, enabled: true },
    }, {
      mode: 'merge',
      manager: manager as any,
      registry,
    })).rejects.toThrow(/online npx|immutable staged/i);
    expect(manager.config.legacy_playwright.enabled).toBe(false);
    expect(manager.restartCalls).toEqual([]);
  });

  it('binds cached declarations to the exact config fingerprint', () => {
    const first = stdio('node', 'one');
    const second = stdio('node', 'two');
    expect(mcpServerConfigFingerprint(first)).not.toBe(mcpServerConfigFingerprint(second));
    expect(mcpServerConfigFingerprint({
      ...first,
      cachedTools: [tool('demo', 'stale')],
      cachedToolsFingerprint: 'untrusted',
      toolCount: 1,
    })).toBe(mcpServerConfigFingerprint(first));
  });

  it('adds and live-registers an enabled server', async () => {
    const manager = new FakeMcpManager({});
    const registry = new ToolRegistry();
    const result = await updateMCPConfig({ added_server: stdio('node', 'fresh_action') }, {
      mode: 'merge',
      manager: manager as any,
      registry,
    });

    expect(result.ok).toBe(true);
    expect(result.services).toEqual([expect.objectContaining({
      serverName: 'added_server',
      action: 'added',
      configured: true,
      registered: true,
      usable: true,
      toolCount: 1,
    })]);
    expect(registry.get('mcp_added_server_fresh_action')).toBeTruthy();
  });

  it('keeps a pending install disabled until live inventory and manifest activation commit', async () => {
    const pending = {
      ...stdio('node', 'approved_action', false),
      installationState: 'pending' as const,
    };
    const manager = new FakeMcpManager({ approved_skill: pending });
    const registry = new ToolRegistry();

    const activation = await activateInstalledSkill('approved_skill', {
      manager: manager as any,
      registry,
    });

    expect(activation).toMatchObject({ usable: true, toolCount: 1 });
    expect(manager.getConfig().approved_skill).toMatchObject({
      enabled: true,
      installationState: 'active',
    });
    expect(registry.get('mcp_approved_skill_approved_action')).toBeTruthy();
  });

  it('distinguishes replace from merge semantics', async () => {
    const existing = stdio('node', 'existing_action', false);
    const manager = new FakeMcpManager({ existing_server: existing });
    const registry = new ToolRegistry();

    const merged = await updateMCPConfig({ merged_server: stdio('node', 'merged_action', false) }, {
      mode: 'merge',
      manager: manager as any,
      registry,
    });
    expect(merged.ok).toBe(true);
    expect(manager.getConfig()).toHaveProperty('existing_server');

    const replaced = await updateMCPConfig({ replacement: stdio('node', 'replacement_action', false) }, {
      mode: 'replace',
      manager: manager as any,
      registry,
    });
    expect(replaced.ok).toBe(true);
    expect(manager.getConfig()).toEqual({ replacement: stdio('node', 'replacement_action', false) });
    expect(replaced.services).toEqual(expect.arrayContaining([
      expect.objectContaining({ serverName: 'existing_server', action: 'deleted' }),
      expect.objectContaining({ serverName: 'merged_server', action: 'deleted' }),
      expect.objectContaining({ serverName: 'replacement', action: 'disabled' }),
    ]));
  });

  it('withdraws the exact old inventory before activating a changed config', async () => {
    const oldConfig = stdio('node', 'old_action');
    const manager = new FakeMcpManager({ sales_ops: oldConfig });
    const registry = new ToolRegistry();
    await recoverServerTools('sales_ops', [tool('sales_ops', 'old_action')], registry, oldConfig);

    const result = await updateMCPConfig({ sales_ops: stdio('node', 'new_action') }, {
      mode: 'merge',
      manager: manager as any,
      registry,
    });

    expect(result.ok).toBe(true);
    expect(manager.disconnectCalls).toContain('sales_ops');
    expect(registry.get('mcp_sales_ops_old_action')).toBeUndefined();
    expect(registry.get('mcp_sales_ops_new_action')).toBeTruthy();
    expect(result.services[0]).toMatchObject({ action: 'changed', usable: true });
  });

  it('disconnects and unregisters disabled and deleted servers', async () => {
    const disabledConfig = stdio('node', 'disable_action');
    const deletedConfig = stdio('node', 'delete_action');
    const manager = new FakeMcpManager({
      disable_me: disabledConfig,
      delete_me: deletedConfig,
    });
    manager.connected.add('disable_me');
    manager.connected.add('delete_me');
    const registry = new ToolRegistry();
    await recoverServerTools('disable_me', [tool('disable_me', 'disable_action')], registry, disabledConfig);
    await recoverServerTools('delete_me', [tool('delete_me', 'delete_action')], registry, deletedConfig);

    const disabled = await updateMCPConfig({
      disable_me: stdio('node', 'disable_action', false),
    }, { mode: 'merge', manager: manager as any, registry });
    expect(disabled.services[0]).toMatchObject({ action: 'disabled', usable: false, registered: false });
    expect(registry.get('mcp_disable_me_disable_action')).toBeUndefined();

    const deleted = await updateMCPConfig({}, {
      mode: 'merge',
      removeNames: ['delete_me'],
      manager: manager as any,
      registry,
    });
    expect(deleted.services[0]).toMatchObject({ action: 'deleted', configured: false, registered: false });
    expect(manager.getConfig()).not.toHaveProperty('delete_me');
    expect(registry.get('mcp_delete_me_delete_action')).toBeUndefined();
  });

  it('rolls back a failed change and reports a non-success result', async () => {
    const oldConfig = stdio('node', 'old_action');
    const manager = new FakeMcpManager({ stable_server: oldConfig });
    const registry = new ToolRegistry();
    await recoverServerTools('stable_server', [tool('stable_server', 'old_action')], registry, oldConfig);

    const result = await updateMCPConfig({ stable_server: stdio('fail-new', 'new_action') }, {
      mode: 'merge',
      manager: manager as any,
      registry,
    });

    expect(result.ok).toBe(false);
    expect(result.services[0]).toMatchObject({
      action: 'rolled_back',
      configured: true,
      registered: true,
      usable: true,
      error: expect.stringContaining('synthetic activation failure'),
    });
    expect(manager.getConfig().stable_server).toEqual(oldConfig);
    expect(registry.get('mcp_stable_server_old_action')).toBeTruthy();
    expect(registry.get('mcp_stable_server_new_action')).toBeUndefined();
  });

  it('fails closed by disabling when both activation and rollback fail', async () => {
    const oldConfig = stdio('fail-old', 'old_action');
    const manager = new FakeMcpManager({ broken_server: oldConfig });
    const registry = new ToolRegistry();
    await recoverServerTools('broken_server', [tool('broken_server', 'old_action')], registry, oldConfig);

    const result = await updateMCPConfig({ broken_server: stdio('fail-new', 'new_action') }, {
      mode: 'merge',
      manager: manager as any,
      registry,
    });

    expect(result.ok).toBe(false);
    expect(result.services[0]).toMatchObject({
      action: 'disabled_after_failure',
      enabled: false,
      registered: false,
      usable: false,
      rollbackError: expect.stringContaining('synthetic activation failure'),
    });
    expect(manager.getConfig().broken_server.enabled).toBe(false);
  });
});
