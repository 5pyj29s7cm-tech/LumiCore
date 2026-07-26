import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerAllTools(registry);
  return registry;
}

describe('unified execution pipeline', () => {
  it('builds turn intent, capability plan, policy and trace from one call', () => {
    const registry = createRegistry();
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text: '打开 AutoCAD',
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      source: 'chat',
    });

    expect(pipeline.turnIntent.flow.routeText).toContain('AutoCAD');
    expect(pipeline.execution.allowToolUse).toBe(true);
    expect(pipeline.capabilityPlan.schemaVersion).toBe(1);
    expect(pipeline.capabilityPlan.taskLedgerRequired).toBe(true);
    expect(pipeline.capabilityPlan.capabilityIds.length).toBeGreaterThan(0);
    expect(pipeline.intentTrace.toolPolicy.allowedTools)
      .toEqual(pipeline.execution.toolPolicy.allowedTools);
  });

  it('keeps capability identity shared across chat, voice and task entrances', () => {
    const registry = createRegistry();
    const build = (channel: 'chat' | 'voice' | 'task') => buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text: '打开 AutoCAD',
        channel,
        source: channel,
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      source: channel,
    });
    const chat = build('chat');
    const voice = build('voice');
    const task = build('task');
    const toolCapability = registry.getCapabilityManifest()
      .find(entry => entry.toolName === 'desktop_open')?.capabilityId;

    expect(toolCapability).toBeTruthy();
    expect(chat.capabilityPlan.capabilityIds).toContain(toolCapability);
    expect(voice.capabilityPlan.capabilityIds).toContain(toolCapability);
    expect(task.capabilityPlan.capabilityIds).toContain(toolCapability);
    expect(chat.turnIntent.channel).toBe('chat');
    expect(voice.turnIntent.channel).toBe('voice');
    expect(task.turnIntent.channel).toBe('task');
  });
});
