import './helpers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  makeLLMCall: vi.fn(),
}));

vi.mock('../server/llm/providers', async () => {
  const actual = await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers');
  return { ...actual, makeLLMCall: mocks.makeLLMCall };
});

import {
  buildModelCapabilityPolicy,
  buildModelToolProjection,
} from '../server/cognition/capability_selection';
import type { LumiExecutionDecision } from '../server/cognition/execution_decision';
import { buildLumiExecutionDecision } from '../server/cognition/execution_decision';
import { buildLumiTurnDispatch } from '../server/cognition/turn_dispatch';
import { runWithTools } from '../server/llm/adapter';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';
import { initDatabase } from '../db_layer';

const WILDCARD_POLICY = {
  allowedTools: ['*'],
  forbiddenTools: [] as string[],
  requireConfirmation: [] as string[],
  maxIterations: 80,
};

const getters = [
  () => null,
  () => null,
  () => null,
  () => null,
  () => null,
] as const;

function decision(overrides: Partial<LumiExecutionDecision> = {}): LumiExecutionDecision {
  return {
    allowToolUse: true,
    selfRepairToolPolicy: null,
    clientActionToolPolicy: null,
    baseToolPolicy: WILDCARD_POLICY,
    toolRoute: null,
    toolPolicy: WILDCARD_POLICY,
    maxIterations: 80,
    promptOverlay: '',
    ...overrides,
  };
}

function registerProbe(
  registry: ToolRegistry,
  name: string,
  handler = vi.fn(async () => `${name}-ok`),
) {
  registry.register({
    name,
    description: `${name} model projection probe`,
    parameters: { type: 'object', properties: {} },
    permission: 'public',
    securityLevel: 'safe',
    evidence: {
      capability: `test.${name}`,
      operation: 'observe',
      assurance: 'observed',
    },
    handler,
  });
  return handler;
}

async function projectedRun(
  registry: ToolRegistry,
  context: Record<string, unknown>,
  maxIterations = 4,
) {
  return runWithTools(
    [{ role: 'user', content: 'Find and run the requested hidden capability.' }],
    registry,
    { provider: 'deepseek', model: 'projection-test' },
    undefined,
    maxIterations,
    ...getters,
    undefined,
    context,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

beforeAll(async () => {
  await initDatabase();
});

describe('model tool declaration projection', () => {
  it('keeps a no-route turn bounded to discovery and keeps hard routes exact', () => {
    expect(buildModelToolProjection(decision())).toEqual({
      toolNames: ['client_capability_manifest'],
      maxTools: 32,
      allowDynamicDiscovery: true,
      discoveryToolName: 'client_capability_manifest',
    });

    const hard = buildModelToolProjection(decision({
      toolRoute: {
        toolNames: ['desktop_open', 'desktop_active_window'],
        categories: ['desktop_launch'],
        reasons: ['exact launch'],
        totalAvailable: 361,
        maxTools: 32,
        truncated: false,
        hardAllowlist: true,
      },
    }));
    expect(hard).toEqual({
      toolNames: ['desktop_open', 'desktop_active_window'],
      maxTools: 32,
      allowDynamicDiscovery: false,
      discoveryToolName: 'client_capability_manifest',
    });

    expect(buildModelToolProjection(decision({ allowToolUse: false }))).toEqual({
      toolNames: [],
      maxTools: 0,
      allowDynamicDiscovery: false,
    });
  });

  it('does not evict a saturated resumed-task route tail', () => {
    const names = [
      ...Array.from({ length: 30 }, (_, index) => `route_${index}`),
      'client_capability_manifest',
      'resume_target_tail',
    ];
    const projection = buildModelToolProjection(decision({
      toolRoute: {
        toolNames: names,
        categories: ['work_takeover'],
        reasons: ['resumed task policy snapshot'],
        totalAvailable: 361,
        maxTools: 32,
        truncated: true,
      },
    }));
    expect(projection.toolNames).toEqual(names);
    expect(projection.toolNames).toHaveLength(32);
    expect(projection.toolNames.at(-1)).toBe('resume_target_tail');
  });

  it('intersects a priority projection with policy while preserving projection order', () => {
    const registry = new ToolRegistry();
    registerProbe(registry, 'alpha');
    registerProbe(registry, 'beta');
    registerProbe(registry, 'blocked');
    const policy = {
      ...WILDCARD_POLICY,
      forbiddenTools: ['blocked'],
    };
    expect(registry.getToolDeclarationsForPolicy(policy, {
      visibleToolNames: ['beta', 'blocked', 'alpha'],
    }).map(item => item.function.name)).toEqual(['beta', 'alpha']);
  });

  it.each([
    {
      label: 'capability learning',
      text: 'Lumi, stabilize the existing desktop capability, check duplicate hard-coded scripts, and make it reusable.',
      channel: 'chat' as const,
      expected: ['capability_learning_list', 'self_extension_plan', 'capability_gap_autofix'],
    },
    {
      label: 'desktop control',
      text: 'Use the mouse to click and drag in the current desktop window, then press Enter with the keyboard and continue through computer control.',
      channel: 'chat' as const,
      expected: ['mouse_drag', 'keyboard_press', 'computer_use'],
    },
    {
      label: 'external AI history',
      text: 'Read ChatGPT conversation history and sync the latest messages.',
      channel: 'voice' as const,
      expected: ['external_ai_history_sync', 'external_ai_history_status', 'external_ai_history_query'],
    },
    {
      label: 'task center',
      text: 'Create a project report package, verify the result, and export it.',
      channel: 'task' as const,
      expected: [
        'work_takeover_task_advance',
        'work_takeover_task_verify_result',
        'work_takeover_task_export_packet',
      ],
    },
  ])('keeps $label semantic tools in the actual bounded model declarations', ({
    text,
    channel,
    expected,
  }) => {
    const registry = new ToolRegistry();
    registerAllTools(registry);
    const dispatch = buildLumiTurnDispatch({
      userId: `projection_${channel}`,
      text,
      channel,
      source: channel,
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const execution = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text,
      toolDeclarations: registry.getToolDeclarations(),
      toolRegistry: registry,
    });
    const projection = buildModelToolProjection(execution);
    const declarations = registry.getToolDeclarationsForPolicy(
      buildModelCapabilityPolicy(execution),
      { visibleToolNames: projection.toolNames },
    ).map(item => item.function.name);

    expect(declarations.length).toBeLessThanOrEqual(projection.maxTools);
    expect(declarations).toEqual(expect.arrayContaining(expected));
    expect(declarations).toContain('client_capability_manifest');
  });

  it('shows only the bounded schemas while the base authorization can still execute a hidden tool', async () => {
    const registry = new ToolRegistry();
    registerProbe(registry, 'visible_probe');
    const hidden = registerProbe(registry, 'hidden_authorized_probe');
    mocks.makeLLMCall.mockResolvedValueOnce({ text: 'No tool needed.', toolCalls: null });

    await projectedRun(registry, {
      toolPolicy: WILDCARD_POLICY,
      modelToolProjection: {
        toolNames: ['visible_probe'],
        maxTools: 1,
        allowDynamicDiscovery: false,
      },
    }, 1);

    expect(mocks.makeLLMCall.mock.calls[0][1].map((item: any) => item.function.name))
      .toEqual(['visible_probe']);
    await expect(registry.execute('hidden_authorized_probe', {}, {
      toolPolicy: buildModelCapabilityPolicy(decision()),
    })).resolves.toContain('hidden_authorized_probe-ok');
    expect(hidden).toHaveBeenCalledTimes(1);
  });

  it('re-projects verified, query-scoped manifest matches on the next iteration without exceeding the cap', async () => {
    const registry = new ToolRegistry();
    registerProbe(registry, 'initial_probe');
    const hidden = registerProbe(registry, 'hidden_discovered_probe');
    const manifest = registerProbe(
      registry,
      'client_capability_manifest',
      vi.fn(async () => JSON.stringify({
        capabilities: [{
          toolName: 'hidden_discovered_probe',
          executableThisTurn: true,
        }],
      })),
    );
    mocks.makeLLMCall
      .mockResolvedValueOnce({
        text: 'Discover the exact capability.',
        toolCalls: [{
          id: 'manifest-1',
          name: 'client_capability_manifest',
          arguments: { query: 'hidden discovered probe', executableOnly: true, limit: 2 },
        }],
      })
      .mockResolvedValueOnce({
        text: 'Use the discovered capability.',
        toolCalls: [{ id: 'hidden-1', name: 'hidden_discovered_probe', arguments: {} }],
      })
      .mockResolvedValueOnce({ text: 'The hidden capability completed.', toolCalls: null });

    const result = await projectedRun(registry, {
      toolPolicy: WILDCARD_POLICY,
      modelToolProjection: {
        toolNames: ['initial_probe', 'client_capability_manifest'],
        maxTools: 2,
        allowDynamicDiscovery: true,
        discoveryToolName: 'client_capability_manifest',
      },
    });

    const declarationCalls = mocks.makeLLMCall.mock.calls.map(call => (
      call[1].map((item: any) => item.function.name)
    ));
    expect(declarationCalls[0]).toEqual(['initial_probe', 'client_capability_manifest']);
    expect(declarationCalls[1]).toEqual(['hidden_discovered_probe', 'client_capability_manifest']);
    expect(declarationCalls.every(names => names.length <= 2)).toBe(true);
    expect(manifest).toHaveBeenCalledTimes(1);
    expect(hidden).toHaveBeenCalledTimes(1);
    expect(result.toolCalls.map(record => record.name)).toEqual([
      'client_capability_manifest',
      'hidden_discovered_probe',
    ]);
  });

  it('does not expand an unscoped manifest dump', async () => {
    const registry = new ToolRegistry();
    registerProbe(registry, 'initial_probe');
    const hidden = registerProbe(registry, 'hidden_unscoped_probe');
    registerProbe(
      registry,
      'client_capability_manifest',
      vi.fn(async () => JSON.stringify({
        capabilities: [{ toolName: 'hidden_unscoped_probe', executableThisTurn: true }],
      })),
    );
    mocks.makeLLMCall
      .mockResolvedValueOnce({
        text: 'List everything.',
        toolCalls: [{ id: 'manifest-all', name: 'client_capability_manifest', arguments: {} }],
      })
      .mockResolvedValueOnce({
        text: 'Try a hidden name.',
        toolCalls: [{ id: 'hidden-all', name: 'hidden_unscoped_probe', arguments: {} }],
      })
      .mockResolvedValueOnce({ text: 'Stopped.', toolCalls: null });

    await projectedRun(registry, {
      toolPolicy: WILDCARD_POLICY,
      modelToolProjection: {
        toolNames: ['initial_probe', 'client_capability_manifest'],
        maxTools: 2,
        allowDynamicDiscovery: true,
      },
    });

    expect(mocks.makeLLMCall.mock.calls[1][1].map((item: any) => item.function.name))
      .toEqual(['initial_probe', 'client_capability_manifest']);
    expect(hidden).not.toHaveBeenCalled();
  });

  it('keeps remote-restricted and hard-off contexts fail-closed after projection', async () => {
    const remoteRegistry = new ToolRegistry();
    registerProbe(remoteRegistry, 'web_search');
    registerProbe(remoteRegistry, 'hidden_host_tool');
    mocks.makeLLMCall.mockResolvedValueOnce({ text: 'Remote response.', toolCalls: null });
    await projectedRun(remoteRegistry, {
      executionBoundary: 'remote_restricted',
      source: 'rest_chat',
      toolPolicy: WILDCARD_POLICY,
      modelToolProjection: {
        toolNames: ['hidden_host_tool', 'web_search'],
        maxTools: 2,
      },
    }, 1);
    expect(mocks.makeLLMCall.mock.calls[0][1].map((item: any) => item.function.name))
      .toEqual(['web_search']);

    vi.clearAllMocks();
    const offRegistry = new ToolRegistry();
    registerProbe(offRegistry, 'web_search');
    mocks.makeLLMCall.mockResolvedValueOnce({ text: 'Tools are off.', toolCalls: null });
    await projectedRun(offRegistry, {
      toolPolicy: { ...WILDCARD_POLICY, forbiddenTools: ['*'], maxIterations: 1 },
      modelToolProjection: { toolNames: ['web_search'], maxTools: 1 },
    }, 1);
    expect(mocks.makeLLMCall.mock.calls[0][1]).toEqual([]);
  });
});
