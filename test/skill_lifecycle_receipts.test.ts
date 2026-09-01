import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcpManager } from '../server/mcp/client';
import type { MCPToolDef } from '../server/mcp/client';
import { activateInstalledSkill, registerConnectedSkillTools } from '../server/mcp';
import { registerSkillTools, setSkillLLMGetters } from '../server/tools/definitions/skill_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';

const temporaryDirectories: string[] = [];
const adminLocalToolContext = {
  userId: 'skill-admin',
  authenticated: true,
  authRole: 'admin',
  localExecution: true,
  executionBoundary: 'trusted_local' as const,
};

function temporarySkillDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function receiptSkillTool(skillName = 'receipt-skill'): MCPToolDef {
  return {
    serverName: skillName,
    name: `mcp_${skillName}_probe`,
    description: 'Return a verified receipt from the installed test skill.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    capability: {
      id: `skill.${skillName}.probe`,
      family: skillName,
      lane: 'system',
      operation: 'observe',
      risk: 'low',
      sideEffects: [{ type: 'local_read', scope: 'test skill runtime', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok', 'status', 'verified'],
        requiredValues: { ok: true, status: 'completed', verified: true },
        successStatuses: ['completed'],
        failureStatuses: ['failed'],
        successSignals: ['connected MCP tool returned a verified runtime receipt'],
        limitations: [],
      },
      trust: 'user-reviewed',
    },
  };
}

describe('skill lifecycle terminal receipts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setSkillLLMGetters(null);
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('records unavailable draft generation as failure instead of a successful error string', async () => {
    setSkillLLMGetters(null);
    const registry = new ToolRegistry();
    registerSkillTools(registry);
    const record = await executeToolCall({
      registry,
      name: 'generate_skill',
      arguments: { description: 'Create a reviewed test draft' },
      context: { ...adminLocalToolContext, requestConfirmation: async () => true },
    });

    expect(record.error).toContain('LLM providers');
    expect(record.result).toBe('');
    expect(record.terminalVerification?.status).toBe('failed');
  });

  it('exposes current Skill Hall entries as discovery receipts without changing runtime state', async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
    const registry = new ToolRegistry();
    registerSkillTools(registry);
    const install = vi.spyOn(mcpManager, 'installSkillValidated');
    const restart = vi.spyOn(mcpManager, 'restartServer');

    const record = await executeToolCall({
      registry,
      name: 'skill_marketplace_search',
      arguments: { query: 'calculator', language: 'en' },
      context: { userId: 'skill-marketplace-search-user' },
    });

    expect(record.error).toBeUndefined();
    expect(record.terminalVerification?.status).toBe('verified');
    const result = JSON.parse(record.result);
    expect(result).toMatchObject({ ok: true, status: 'listed' });
    expect(result.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'skill-calculator', installable: true }),
    ]));
    expect(install).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it('does not install or activate a skill when the confirmation boundary is declined', async () => {
    const install = vi.spyOn(mcpManager, 'installSkillValidated');
    const restart = vi.spyOn(mcpManager, 'restartServer');
    const registry = new ToolRegistry();
    registerSkillTools(registry);

    const record = await executeToolCall({
      registry,
      name: 'install_skill',
      arguments: { directory: 'D:\\unapproved-skill', name: 'unapproved-skill' },
      context: { ...adminLocalToolContext, requestConfirmation: async () => false },
    });

    expect(record.result).toContain('requires user confirmation');
    expect(record.terminalVerification?.status).not.toBe('verified');
    expect(install).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it('activates an approved installed runtime in the current registry and executes it with a receipt', async () => {
    const tool = receiptSkillTool();
    vi.spyOn(mcpManager, 'getConfig').mockReturnValue({
      'receipt-skill': { enabled: true, source: 'local' },
    });
    vi.spyOn(mcpManager, 'restartServer').mockResolvedValue([tool]);
    const callTool = vi.spyOn(mcpManager, 'callToolForServer').mockResolvedValue(JSON.stringify({
      ok: true,
      status: 'completed',
      verified: true,
      value: 'runtime-call-finished',
    }));

    const registry = new ToolRegistry();
    registerSkillTools(registry);
    const activation = await activateInstalledSkill('receipt-skill', { registry });
    expect(activation).toMatchObject({
      skillName: 'receipt-skill',
      runtimeStatus: 'registered',
      usable: true,
      toolCount: 1,
      registeredToolNames: ['mcp_receipt-skill_probe'],
      manifestCapabilityIds: ['skill.receipt-skill.probe'],
    });
    expect(registry.get('mcp_receipt-skill_probe')).toBeDefined();
    expect(registry.getCapabilityManifestEntry('mcp_receipt-skill_probe')).toMatchObject({
      toolName: 'mcp_receipt-skill_probe',
      capabilityId: 'skill.receipt-skill.probe',
      source: 'skill',
      executable: true,
    });

    const runtimeRecord = await executeToolCall({
      registry,
      name: 'mcp_receipt-skill_probe',
      arguments: {},
      context: { ...adminLocalToolContext, requestConfirmation: async () => true },
    });
    expect(callTool).toHaveBeenCalledWith(
      'receipt-skill',
      'probe',
      {},
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(runtimeRecord.error).toBeUndefined();
    expect(runtimeRecord.terminalVerification).toMatchObject({
      status: 'unverified',
      reason: expect.stringContaining('Host-owned corroboration is required'),
    });
    expect(JSON.parse(runtimeRecord.result)).toMatchObject({
      ok: true,
      status: 'completed',
      verified: true,
    });
  });

  it('rejects an arbitrary local directory even after generic confirmation', async () => {
    const sourceDirectory = temporarySkillDirectory('lumi-unreviewed-skill-');
    fs.writeFileSync(path.join(sourceDirectory, 'package.json'), JSON.stringify({ name: 'unreviewed-skill', version: '1.0.0' }));
    fs.writeFileSync(path.join(sourceDirectory, 'index.ts'), 'export const receipt = true;');
    const install = vi.spyOn(mcpManager, 'installSkillValidated');
    const registry = new ToolRegistry();
    registerSkillTools(registry);

    const record = await executeToolCall({
      registry,
      name: 'install_skill',
      arguments: { directory: sourceDirectory, name: 'unreviewed-skill' },
      context: { ...adminLocalToolContext, requestConfirmation: async () => true },
    });

    expect(record.error).toContain('Arbitrary local skill execution is disabled');
    expect(record.terminalVerification?.status).toBe('failed');
    expect(install).not.toHaveBeenCalled();
  });

  it('rolls back a newly installed package when its MCP runtime cannot activate', async () => {
    vi.spyOn(mcpManager, 'getConfig').mockReturnValue({
      'failed-skill': { enabled: true, source: 'local' },
    });
    vi.spyOn(mcpManager, 'restartServer').mockRejectedValue(new Error('injected MCP startup failure'));
    const disconnect = vi.spyOn(mcpManager, 'disconnectServer').mockResolvedValue();
    const uninstall = vi.spyOn(mcpManager, 'uninstallSkill').mockImplementation(() => {});

    const registry = new ToolRegistry();
    await expect(activateInstalledSkill('failed-skill', {
      registry,
      rollbackInstallOnFailure: true,
    })).rejects.toThrow('injected MCP startup failure');
    expect(registry.list().some(entry => entry.name.startsWith('mcp_failed-skill_'))).toBe(false);
    expect(disconnect).toHaveBeenCalledWith('failed-skill');
    expect(uninstall).toHaveBeenCalledWith('failed-skill');
  });

  it('replaces only exact tools owned by one server and rejects cross-owner collisions', async () => {
    const registry = new ToolRegistry();
    await registerConnectedSkillTools('foo_bar', [receiptSkillTool('foo_bar')], { registry });
    await registerConnectedSkillTools('foo', [receiptSkillTool('foo')], { registry });

    const replacement: MCPToolDef = {
      ...receiptSkillTool('foo'),
      name: 'mcp_foo_next',
      rawName: 'next',
    };
    await registerConnectedSkillTools('foo', [replacement], { registry });
    expect(registry.get('mcp_foo_probe')).toBeUndefined();
    expect(registry.get('mcp_foo_next')).toBeDefined();
    expect(registry.get('mcp_foo_bar_probe')).toBeDefined();

    const crossOwnerCollision: MCPToolDef = {
      ...receiptSkillTool('foo'),
      name: 'mcp_foo_bar_probe',
      rawName: 'bar_probe',
    };
    await expect(registerConnectedSkillTools('foo', [crossOwnerCollision], { registry }))
      .rejects.toThrow(/collides with server "foo_bar"/);
    expect(registry.get('mcp_foo_next')).toBeDefined();
    expect(registry.get('mcp_foo_bar_probe')).toBeDefined();
  });

  it('surfaces an incomplete activation rollback instead of swallowing it', async () => {
    const manager = {
      getConfig: () => ({ broken: { enabled: true, source: 'local' as const } }),
      saveConfig: vi.fn(),
      beginSkillActivation: vi.fn(),
      commitSkillActivation: vi.fn(),
      restartServer: vi.fn().mockRejectedValue(new Error('startup failed')),
      disconnectServer: vi.fn().mockRejectedValue(new Error('close failed')),
      uninstallSkill: vi.fn(() => { throw new Error('remove failed'); }),
    };

    await expect(activateInstalledSkill('broken', {
      registry: new ToolRegistry(),
      manager,
      rollbackInstallOnFailure: true,
    })).rejects.toThrow(/startup failed.*Rollback incomplete.*close failed.*remove failed/);
  });
});
