import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { updateClientState } from '../server/client/self_model';
import { mcpManager } from '../server/mcp';
import type { MCPToolDef } from '../server/mcp';
import { registerClientSelfTools } from '../server/tools/definitions/client_self_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';

const adminLocalToolContext = {
  userId: 'client-repair-admin',
  authenticated: true,
  authRole: 'admin',
  localExecution: true,
  executionBoundary: 'trusted_local' as const,
};

describe('client repair terminal receipts', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('delegates safe recovery to the authoritative client action receipt', async () => {
    const registry = new ToolRegistry();
    registerClientSelfTools(registry);
    const userId = `client-recovery-${Date.now()}`;
    updateClientState(userId, { platform: 'desktop', mode: 'assistant' });
    const record = await executeToolCall({
      registry,
      name: 'client_self_repair',
      arguments: { action: 'refresh_client_state' },
      context: {
        userId,
        desktopRelay: async () => {
          await new Promise(resolve => setTimeout(resolve, 5));
          updateClientState(userId, { runtime: { backendNodeRunning: true } });
          return JSON.stringify({ ok: true, status: 'refreshed', verified: true });
        },
        toolPolicy: {
          allowedTools: ['client_self_repair', 'client_action'],
          forbiddenTools: [],
          requireConfirmation: [],
          maxIterations: 2,
        },
      },
    });

    expect(record.error).toBeUndefined();
    expect(record.terminalVerification?.status).toBe('verified');
    expect(JSON.parse(record.result)).toMatchObject({
      ok: true,
      status: 'verified',
      requestedRepair: 'refresh_client_state',
      delegatedCapability: 'client.surface.action',
    });
  });

  it('requires a connected non-empty tool inventory after skill repair', async () => {
    const registry = new ToolRegistry();
    registerClientSelfTools(registry);
    const tools: MCPToolDef[] = [{
      serverName: 'receipt',
      name: 'mcp_receipt_probe',
      description: 'Read the repaired skill runtime state.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      capability: {
        id: 'skill.receipt.probe',
        family: 'receipt',
        lane: 'system',
        operation: 'observe',
        risk: 'low',
        sideEffects: [{ type: 'local_read', scope: 'test skill runtime', reversible: true }],
        verification: {
          strategy: 'terminal_receipt',
          required: true,
          requiredFields: [],
          successSignals: ['terminal runtime receipt'],
          limitations: [],
        },
        trust: 'user-reviewed',
      },
    }];
    vi.spyOn(mcpManager, 'getConfig').mockReturnValue({
      receipt: { enabled: true, source: 'local' },
    });
    const repair = vi.spyOn(mcpManager, 'repairSkill').mockResolvedValue({
      success: true,
      action: 'restarted',
      directory: 'D:\\skills\\receipt',
      toolCount: 1,
      tools,
    });
    const record = await executeToolCall({
      registry,
      name: 'client_repair_skill',
      arguments: { skillName: 'receipt' },
      context: { ...adminLocalToolContext, requestConfirmation: async () => true },
    });

    expect(repair).toHaveBeenCalledWith('receipt');
    expect(record.error).toBeUndefined();
    expect(record.terminalVerification?.status).toBe('verified');
    expect(JSON.parse(record.result)).toMatchObject({
      ok: true,
      status: 'repaired',
      runtimeStatus: 'registered',
      usable: true,
      toolCount: 1,
      registeredToolNames: ['mcp_receipt_probe'],
      manifestCapabilityIds: ['skill.receipt.probe'],
    });
    expect(registry.get('mcp_receipt_probe')).toBeDefined();
    expect(registry.getCapabilityManifestEntry('mcp_receipt_probe')).toMatchObject({
      capabilityId: 'skill.receipt.probe',
      source: 'skill',
      executable: true,
    });
  });

  it('does not treat a tool count without exact declarations as a usable repaired skill', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'mcp_receipt_stale',
      description: 'Stale pre-repair registration.',
      parameters: { type: 'object', properties: {} },
      handler: async () => '{"ok":true}',
      permission: 'user',
      securityLevel: 'safe',
    });
    registerClientSelfTools(registry);
    vi.spyOn(mcpManager, 'getConfig').mockReturnValue({
      receipt: { enabled: false, source: 'local' },
    });
    vi.spyOn(mcpManager, 'repairSkill').mockResolvedValue({
      success: true,
      action: 'restarted',
      directory: 'D:\\skills\\receipt',
      toolCount: 2,
    });
    const disconnect = vi.spyOn(mcpManager, 'disconnectServer').mockResolvedValue();
    const saveConfig = vi.spyOn(mcpManager, 'saveConfig').mockImplementation(() => {});

    const record = await executeToolCall({
      registry,
      name: 'client_repair_skill',
      arguments: { skillName: 'receipt' },
      context: { ...adminLocalToolContext, requestConfirmation: async () => true },
    });

    expect(record.error).toContain('without exact connected tool declarations');
    expect(record.terminalVerification?.status).toBe('failed');
    // An unowned same-prefix registry entry must not be deleted by a failed repair.
    expect(registry.get('mcp_receipt_stale')).toBeDefined();
    expect(disconnect).toHaveBeenCalledWith('receipt');
    expect(saveConfig).toHaveBeenCalledWith({
      receipt: { enabled: false, source: 'local' },
    });
  });

  it('rejects reserved repair identities before filesystem or config mutation', async () => {
    const registry = new ToolRegistry();
    registerClientSelfTools(registry);
    const repair = vi.spyOn(mcpManager, 'repairSkill');
    const getConfig = vi.spyOn(mcpManager, 'getConfig');

    for (const skillName of ['.', '..', '__proto__', 'constructor', 'prototype']) {
      const record = await executeToolCall({
        registry,
        name: 'client_repair_skill',
        arguments: { skillName },
        context: { ...adminLocalToolContext, requestConfirmation: async () => true },
      });
      expect(record.error).toMatch(/Invalid MCP server or skill name/);
      expect(record.terminalVerification?.status).toBe('failed');
    }

    expect(repair).not.toHaveBeenCalled();
    expect(getConfig).not.toHaveBeenCalled();
  });

  it('does not repair host skills from an organization workspace', async () => {
    const registry = new ToolRegistry();
    registerClientSelfTools(registry);
    const repair = vi.spyOn(mcpManager, 'repairSkill');
    const getConfig = vi.spyOn(mcpManager, 'getConfig');
    const record = await executeToolCall({
      registry,
      name: 'client_repair_skill',
      arguments: { skillName: 'receipt' },
      context: {
        ...adminLocalToolContext,
        domain: 'work',
        orgId: 'org-test',
        requestConfirmation: async () => true,
      },
    });

    expect(record.error).toMatch(/personal workspace/i);
    expect(record.terminalVerification?.status).toBe('failed');
    expect(repair).not.toHaveBeenCalled();
    expect(getConfig).not.toHaveBeenCalled();
  });
});
