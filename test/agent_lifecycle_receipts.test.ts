import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import { registerAgentTools } from '../server/tools/definitions/agent_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import { ToolRegistry } from '../server/tools/registry';
import { getBackgroundTask, resetBackgroundTasksForTest } from '../server/agents/background_tasks';

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

  it('registers a real scoped background task and returns a verified handoff receipt', async () => {
    resetBackgroundTasksForTest({ clearPersisted: false, markHydrated: true });
    const registry = new ToolRegistry();
    registerAgentTools(registry);
    const userId = `agent-delegation-${Date.now()}`;
    const created = await executeToolCall({
      registry,
      name: 'agent_create',
      arguments: { name: 'Delegation Worker', category: 'test' },
      context: { userId, requestConfirmation: async () => true },
    });
    const workerId = JSON.parse(created.result).agent.id;
    const context = {
      userId,
      taskId: 'conversation-task-1',
      conversationId: 'conversation-1',
      conversationAgentId: 'lumi',
      personalityId: 'lumi',
      requestId: 'request-1',
      idempotencyKey: 'delegation-request-1',
      modelRouting: { provider: 'openai', model: 'test-model', selectionMode: 'pinned' as const },
      toolPolicy: {
        allowedTools: ['agent_delegate_background'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 1,
      },
    };

    const delegated = await executeToolCall({
      registry,
      name: 'agent_delegate_background',
      arguments: {
        task: 'Run a controlled multi-agent acceptance task.',
        preferredAgentIds: [workerId],
      },
      context,
    });
    expect(delegated.error).toBeUndefined();
    expect(delegated.terminalVerification?.status).toBe('verified');
    const payload = JSON.parse(delegated.result);
    expect(payload).toMatchObject({
      ok: true,
      status: 'registered',
      persisted: true,
      task: { status: 'queued', workerNames: ['Delegation Worker'] },
    });
    expect(getBackgroundTask(payload.task.id, userId)).toMatchObject({
      id: payload.task.id,
      prompt: 'Run a controlled multi-agent acceptance task.',
      context: {
        conversationId: 'conversation-1',
        actionTaskId: 'conversation-task-1',
        provider: 'openai',
        model: 'test-model',
      },
    });

    const duplicate = await executeToolCall({
      registry,
      name: 'agent_delegate_background',
      arguments: { task: 'Run a controlled multi-agent acceptance task.', preferredAgentIds: [workerId] },
      context,
    });
    expect(JSON.parse(duplicate.result).task.id).toBe(payload.task.id);
  });
});
