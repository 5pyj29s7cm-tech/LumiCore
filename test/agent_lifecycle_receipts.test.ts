import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { registerAgentTools } from '../server/tools/definitions/agent_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';

describe('agent lifecycle terminal receipts', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('verifies create and terminate from persisted state receipts', async () => {
    const registry = new ToolRegistry();
    registerAgentTools(registry);
    const userId = `agent-receipt-${Date.now()}`;
    const context = { userId, requestConfirmation: async () => true };

    const created = await executeToolCall({
      registry,
      name: 'agent_create',
      arguments: { name: 'Receipt Worker', category: 'test' },
      context,
    });
    const createdPayload = JSON.parse(created.result);
    expect(created.error).toBeUndefined();
    expect(created.terminalVerification?.status).toBe('verified');
    expect(createdPayload).toMatchObject({ ok: true, status: 'created', agent: { status: 'active' } });

    const terminated = await executeToolCall({
      registry,
      name: 'agent_terminate',
      arguments: { agentId: createdPayload.agent.id },
      context,
    });
    expect(terminated.error).toBeUndefined();
    expect(terminated.terminalVerification?.status).toBe('verified');
    expect(JSON.parse(terminated.result)).toMatchObject({ ok: true, status: 'terminated', terminated: 1 });
  });

  it('reports invalid external-agent configuration as an execution failure', async () => {
    const registry = new ToolRegistry();
    registerAgentTools(registry);
    const record = await executeToolCall({
      registry,
      name: 'agent_create',
      arguments: { name: 'Broken External Worker', runtime: 'external' },
      context: { userId: 'agent-invalid-runtime', requestConfirmation: async () => true },
    });

    expect(record.error).toContain('externalCommand');
    expect(record.terminalVerification?.status).toBe('failed');
  });
});
