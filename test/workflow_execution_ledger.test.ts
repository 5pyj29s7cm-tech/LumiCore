import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { registerWorkflowTools } from '../server/tools/definitions/workflow_tools';
import { ToolRegistry } from '../server/tools/registry';

describe('saved workflow execution receipts', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('stops at the real failed step and never appends false completion', async () => {
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    const laterStep = vi.fn(async () => 'should not run');
    registry.register({
      name: 'workflow_test_ok', description: 'test', parameters: {}, permission: 'public', securityLevel: 'safe',
      handler: async () => JSON.stringify({ ok: true, status: 'completed' }),
    });
    registry.register({
      name: 'workflow_test_fail', description: 'test', parameters: {}, permission: 'public', securityLevel: 'safe',
      handler: async () => { throw new Error('real step failure'); },
    });
    registry.register({
      name: 'workflow_test_later', description: 'test', parameters: {}, permission: 'public', securityLevel: 'safe',
      handler: laterStep,
    });
    const userId = `workflow-ledger-${Date.now()}`;
    const name = `failure-${Date.now()}`;
    await registry.execute('save_workflow', {
      name,
      steps: [
        { description: 'first', tool: 'workflow_test_ok', args: {} },
        { description: 'second', tool: 'workflow_test_fail', args: {} },
        { description: 'third', tool: 'workflow_test_later', args: {} },
      ],
    }, { userId });

    const result = JSON.parse(await registry.execute('run_workflow', { name }, {
      userId,
      requestConfirmation: async () => true,
    }));

    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      completedSteps: 1,
      totalSteps: 3,
      failedStep: 2,
      blocker: 'real step failure',
    });
    expect(result.steps).toHaveLength(2);
    expect(laterStep).not.toHaveBeenCalled();
  });
});
