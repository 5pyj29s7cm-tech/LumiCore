import { beforeAll, describe, expect, it } from 'vitest';
import { buildAutonomousCapabilityPipeline } from '../server/autonomy/task_executor';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';

let registry: ToolRegistry;

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
  registry = new ToolRegistry();
  registerAllTools(registry);
});

describe('autonomous capability planning entrance', () => {
  it('routes scheduled work through the same durable capability protocol', () => {
    const pipeline = buildAutonomousCapabilityPipeline({
      id: 'autotask-scheduled-1',
      userId: 'autonomous-plan-user',
      title: 'Inspect installed applications',
      description: '检查本机已经安装的桌面应用并生成只读清单。',
      source: 'scheduler',
    }, 30, registry);

    expect(pipeline.turnIntent.channel).toBe('scheduler');
    expect(pipeline.turnIntent.boundary).toBe('task_center');
    expect(pipeline.executionPlan.taskId).toBe('autotask-scheduled-1');
    expect(pipeline.executionPlan.decisionAuthority).toBe('semantic_planner');
    expect(pipeline.executionPlan.scriptAuthority).toBe('adapter_only');
    expect(pipeline.executionPlan.nodes.length).toBeGreaterThan(0);
  });

  it('fails autonomous external commits closed before any tool can execute', () => {
    const pipeline = buildAutonomousCapabilityPipeline({
      id: 'autotask-external-1',
      userId: 'autonomous-plan-user',
      title: 'Send a message',
      description: 'send to Alice: deployment is complete',
      source: 'user_request',
    }, 30, registry);

    expect(pipeline.turnIntent.channel).toBe('agent');
    expect(pipeline.executionPlan.risk).toMatchObject({
      sideEffectClass: 'external_commit',
      requiresConfirmation: true,
      failClosed: true,
    });
    expect(pipeline.executionPlan.risk.confirmationBinding?.taskId).toBe('autotask-external-1');
  });
});
