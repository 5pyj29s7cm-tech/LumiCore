import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { updateClientState } from '../server/client/self_model';
import { mcpManager } from '../server/mcp';
import { registerClientSelfTools } from '../server/tools/definitions/client_self_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';

describe('client repair terminal receipts', () => {
  beforeAll(async () => {
    await initDatabase();
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
    const repair = vi.spyOn(mcpManager, 'repairSkill').mockResolvedValue({
      success: true,
      action: 'restarted',
      directory: 'D:\\skills\\receipt',
      toolCount: 2,
    });
    const record = await executeToolCall({
      registry,
      name: 'client_repair_skill',
      arguments: { skillName: 'receipt' },
      context: { requestConfirmation: async () => true },
    });

    expect(repair).toHaveBeenCalledWith('receipt');
    expect(record.error).toBeUndefined();
    expect(record.terminalVerification?.status).toBe('verified');
    expect(JSON.parse(record.result)).toMatchObject({
      ok: true,
      status: 'repaired',
      runtimeStatus: 'connected',
      toolCount: 2,
    });
    repair.mockRestore();
  });
});
