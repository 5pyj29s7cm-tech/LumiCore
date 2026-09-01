import './helpers';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  makeLLMCall: vi.fn(),
}));

vi.mock('../server/llm/providers', async () => {
  const actual = await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers');
  return { ...actual, makeLLMCall: mocks.makeLLMCall };
});

import { initDatabase } from '../db_layer';
import { runWithTools } from '../server/llm/adapter';
import { ToolRegistry } from '../server/tools/registry';

const POLICY = {
  allowedTools: ['*'],
  forbiddenTools: [] as string[],
  requireConfirmation: [] as string[],
  maxIterations: 8,
};

function registerProbe(
  registry: ToolRegistry,
  name: string,
  handler = vi.fn(async () => `${name}-ok`),
) {
  registry.register({
    name,
    description: `${name} protected schema probe`,
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
}

async function runProjected(
  registry: ToolRegistry,
  task: string,
  modelToolProjection: {
    toolNames: string[];
    requiredToolNames?: string[];
    maxTools: number;
    allowDynamicDiscovery?: boolean;
    discoveryToolName?: string;
  },
  maxIterations: number,
  context: Record<string, unknown> = {},
) {
  return runWithTools(
    [{ role: 'user', content: task }],
    registry,
    { provider: 'deepseek', model: 'protected-schema-test' },
    undefined,
    maxIterations,
    () => null,
    () => null,
    () => null,
    () => null,
    () => null,
    undefined,
    {
      toolPolicy: POLICY,
      modelToolProjection,
      currentTurnExecutionRequested: true,
      routedTaskText: task,
      ...context,
    },
  );
}

beforeAll(async () => {
  await initDatabase();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('adapter provider-schema protection', () => {
  it('protects task verification plus discovery and autofix declarations', async () => {
    const registry = new ToolRegistry();
    for (const name of [
      'write_file',
      'work_product_verify',
      'desktop_path_info',
      'client_capability_manifest',
      'capability_gap_autofix',
    ]) registerProbe(registry, name);
    mocks.makeLLMCall.mockResolvedValueOnce({ text: 'No action selected.', toolCalls: null });

    await runProjected(
      registry,
      'Create D:\\deliverables\\report.txt and verify the generated file.',
      {
        toolNames: [
          'write_file',
          'work_product_verify',
          'desktop_path_info',
          'client_capability_manifest',
          'capability_gap_autofix',
        ],
        maxTools: 5,
        allowDynamicDiscovery: true,
        discoveryToolName: 'client_capability_manifest',
      },
      1,
    );

    const config = mocks.makeLLMCall.mock.calls[0][2];
    expect(config.protectedToolNames).toEqual(expect.arrayContaining([
      'write_file',
      'work_product_verify',
      'desktop_path_info',
      'client_capability_manifest',
      'capability_gap_autofix',
    ]));
    expect(config.localRequiredToolNames).toEqual(config.protectedToolNames);
  });

  it('keeps provider-specific schema drops local to that attempt so discovery can re-project them', async () => {
    const registry = new ToolRegistry();
    registerProbe(registry, 'semantic_probe');
    registerProbe(registry, 'optional_probe');
    registerProbe(registry, 'capability_gap_autofix');
    registerProbe(
      registry,
      'client_capability_manifest',
      vi.fn(async () => JSON.stringify({
        capabilities: [{ toolName: 'optional_probe', executableThisTurn: true }],
      })),
    );
    mocks.makeLLMCall
      .mockResolvedValueOnce({
        text: 'Inspect the manifest.',
        toolCalls: [{
          id: 'manifest-protection-1',
          name: 'client_capability_manifest',
          arguments: { query: 'optional probe', executableOnly: true, limit: 2 },
        }],
        modelRequestContext: {
          deliveredToolNames: [
            'semantic_probe',
            'capability_gap_autofix',
            'client_capability_manifest',
          ],
          droppedToolNames: ['optional_probe'],
        },
      })
      .mockResolvedValueOnce({ text: 'The optional schema was not delivered.', toolCalls: null });

    await runProjected(
      registry,
      'Find the exact capability for this request.',
      {
        toolNames: [
          'semantic_probe',
          'optional_probe',
          'capability_gap_autofix',
          'client_capability_manifest',
        ],
        maxTools: 4,
        allowDynamicDiscovery: true,
        discoveryToolName: 'client_capability_manifest',
      },
      2,
    );

    const secondDeclarations = mocks.makeLLMCall.mock.calls[1][1]
      .map((declaration: any) => declaration.function.name);
    expect(secondDeclarations).toEqual(expect.arrayContaining([
      'semantic_probe',
      'optional_probe',
      'capability_gap_autofix',
      'client_capability_manifest',
    ]));
  });

  it('does not protect an entire trusted 32-schema projection', async () => {
    const registry = new ToolRegistry();
    const optionalNames = Array.from({ length: 25 }, (_, index) => `optional_verbose_${index}`);
    const names = [
      'semantic_action',
      ...optionalNames,
      'pinned_resume',
      'workflow_required',
      'explicit_named',
      'already_executed',
      'client_capability_manifest',
      'capability_gap_autofix',
    ];
    expect(names).toHaveLength(32);
    for (const name of names) registerProbe(registry, name);
    mocks.makeLLMCall.mockResolvedValueOnce({ text: 'No action selected.', toolCalls: null });

    await runProjected(
      registry,
      'Continue the exact task with explicit_named.',
      {
        toolNames: names,
        requiredToolNames: ['pinned_resume', 'workflow_required'],
        maxTools: 32,
        allowDynamicDiscovery: false,
        discoveryToolName: 'client_capability_manifest',
      },
      1,
      {
        trustedActionContinuation: true,
        priorToolRecords: [{
          id: 'prior-required-receipt',
          name: 'already_executed',
          arguments: {},
          result: 'already-executed-ok',
          durationMs: 1,
        }],
      },
    );

    const config = mocks.makeLLMCall.mock.calls[0][2];
    expect(config.protectedToolNames).toEqual([
      'semantic_action',
      'pinned_resume',
      'workflow_required',
      'explicit_named',
      'already_executed',
      'client_capability_manifest',
      'capability_gap_autofix',
    ]);
    expect(config.protectedToolNames).toHaveLength(7);
    expect(config.protectedToolNames.length).toBeLessThan(names.length);
    expect(config.localRequiredToolNames).toEqual(config.protectedToolNames);
  });
});
