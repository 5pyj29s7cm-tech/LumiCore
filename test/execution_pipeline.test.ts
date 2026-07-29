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
    expect(pipeline.executionPlan.decisionAuthority).toBe('semantic_planner');
    expect(pipeline.executionPlan.scriptAuthority).toBe('adapter_only');
    expect(pipeline.executionPlan.nodes.length).toBeGreaterThan(0);
    const adapterNodes = pipeline.executionPlan.nodes
      .filter(node => node.executionRole === 'adapter');
    expect(pipeline.executionPlan.expectedEvidence.length)
      .toBe(adapterNodes.length);
    expect(pipeline.executionPlan.edges.length).toBeGreaterThan(0);
    expect(pipeline.executionPlan.nodes.some(node => node.executionRole === 'planner')).toBe(true);
    expect(pipeline.executionPlan.nodes.some(node => node.executionRole === 'verifier')).toBe(true);
    expect(pipeline.executionPlan.nodes.some(node => node.executionRole === 'join')).toBe(true);
    for (const adapter of adapterNodes) {
      expect(pipeline.executionPlan.edges).toContainEqual(expect.objectContaining({
        to: adapter.nodeId,
        condition: 'selected',
      }));
      expect(pipeline.executionPlan.edges).toContainEqual(expect.objectContaining({
        from: adapter.nodeId,
        condition: 'success',
      }));
    }
    expect(pipeline.capabilityPlan.promptOverlay).toContain('Capability Execution Plan');
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
    expect(chat.executionPlan.planId).toBe(voice.executionPlan.planId);
    expect(voice.executionPlan.planId).toBe(task.executionPlan.planId);
  });

  it('fails external commits closed and binds confirmation to immutable payload evidence', () => {
    const registry = createRegistry();
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text: 'send to Alice: deployment is complete',
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
    });

    expect(pipeline.normalizedIntent.sideEffectClass).toBe('external_commit');
    expect(pipeline.executionPlan.risk.requiresConfirmation).toBe(true);
    expect(pipeline.executionPlan.risk.failClosed).toBe(true);
    expect(pipeline.executionPlan.risk.confirmationBinding).toMatchObject({
      taskId: pipeline.executionPlan.taskId,
      target: 'Alice',
      tool: '',
    });
    expect(pipeline.executionPlan.risk.confirmationBinding?.payloadDigest).toHaveLength(64);
    expect(pipeline.executionPlan.fallbackPolicy).toMatchObject({
      maxRetries: 0,
      reconcileUnknownOutcome: true,
      allowLegacyRoute: false,
      onUnknownOutcome: 'reconcile_then_stop',
    });
  });

  it('permits bounded jittered retry only for read/status plans', () => {
    const registry = createRegistry();
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text: 'read messages from Alice',
        channel: 'voice',
        source: 'voice',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
    });

    expect(pipeline.normalizedIntent.operation).toBe('read');
    expect(pipeline.executionPlan.risk.sideEffectClass).toBe('none');
    expect(pipeline.executionPlan.fallbackPolicy).toMatchObject({
      retryClass: 'idempotent_only',
      maxRetries: 2,
      jitter: true,
      allowLegacyRoute: false,
    });
  });

  it('compiles a matched skill workflow as an adapter with declared tool candidates', () => {
    const registry = createRegistry();
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text: 'Lumi, show me a visible demo of yourself',
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      source: 'chat',
    });

    expect(pipeline.turnIntent.boundary).toBe('skill_workflow');
    expect(pipeline.executionPlan.nodes).toContainEqual(expect.objectContaining({
      type: 'skill',
      executionRole: 'adapter',
      capabilityId: 'desktop-automation/self_intro_demo',
    }));
    for (const toolName of ['client_action', 'desktop_list_apps', 'desktop_open', 'desktop_active_window']) {
      expect(pipeline.executionPlan.nodes).toContainEqual(expect.objectContaining({
        toolName,
        executionRole: 'adapter',
      }));
    }
  });
});
