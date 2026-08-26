import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  makeLLMCall: vi.fn(),
}));

vi.mock('../server/llm/providers', async () => {
  const actual = await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers');
  return { ...actual, makeLLMCall: mocks.makeLLMCall };
});

import {
  HARD_MAX_TOOL_INVOCATIONS_PER_MODEL_RESPONSE,
  HARD_MAX_TOOL_INVOCATIONS_PER_TURN,
  ToolLifecyclePersistenceError,
  runWithTools,
} from '../server/llm/adapter';
import { ToolRegistry } from '../server/tools/registry';

const getters = [
  () => null,
  () => null,
  () => null,
  () => null,
  () => null,
] as const;

function registerSimpleTool(
  registry: ToolRegistry,
  name: string,
  handler: (args: Record<string, any>) => Promise<string>,
) {
  registry.register({
    name,
    description: `Budget test tool ${name}`,
    parameters: {
      type: 'object',
      properties: { index: { type: 'number' } },
      required: ['index'],
    },
    permission: 'public',
    securityLevel: 'safe',
    handler,
  });
}

function budgetReceipt(result: Awaited<ReturnType<typeof runWithTools>>) {
  return result.toolCalls.find(record => record.name === 'lumi_tool_invocation_budget');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('hard per-turn tool invocation budget', () => {
  it('rejects an oversized mixed observation/mutation model response before any call runs', async () => {
    const registry = new ToolRegistry();
    const observe = vi.fn(async () => 'observed');
    const mutate = vi.fn(async () => 'mutated');
    registerSimpleTool(registry, 'budget_observe', observe);
    registerSimpleTool(registry, 'budget_mutate', mutate);
    mocks.makeLLMCall.mockResolvedValueOnce({
      text: 'run the whole batch',
      toolCalls: Array.from(
        { length: HARD_MAX_TOOL_INVOCATIONS_PER_MODEL_RESPONSE + 1 },
        (_, index) => ({
          id: `oversized-${index}`,
          name: index % 2 === 0 ? 'budget_observe' : 'budget_mutate',
          arguments: { index },
        }),
      ),
    });

    const result = await runWithTools(
      [{ role: 'user', content: 'Inspect and update every requested item.' }],
      registry,
      { provider: 'deepseek', model: 'budget-test' },
      undefined,
      80,
      ...getters,
    );

    expect(observe).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
    const record = budgetReceipt(result);
    expect(record).toMatchObject({
      adapterStarted: false,
      terminalVerification: { status: 'failed', strategy: 'terminal_receipt' },
      envelope: { status: 'failed' },
    });
    expect(record?.receipt).toMatchObject({
      code: 'TOOL_INVOCATION_BUDGET_EXCEEDED',
      boundary: 'model_response',
      limit: HARD_MAX_TOOL_INVOCATIONS_PER_MODEL_RESPONSE,
      executedInvocations: 0,
      overLimitBatchExecuted: false,
      appliesToOperations: expect.arrayContaining(['observe', 'mutate']),
    });
    expect(result.text).toContain('left unexecuted');
  });

  it('waits for an asynchronous terminal-receipt observer before returning', async () => {
    const registry = new ToolRegistry();
    registerSimpleTool(registry, 'budget_observe', async () => 'observed');
    mocks.makeLLMCall.mockResolvedValueOnce({
      text: 'oversized batch',
      toolCalls: Array.from(
        { length: HARD_MAX_TOOL_INVOCATIONS_PER_MODEL_RESPONSE + 1 },
        (_, index) => ({ id: `durable-${index}`, name: 'budget_observe', arguments: { index } }),
      ),
    });
    let releaseObserver!: () => void;
    const observerBarrier = new Promise<void>(resolve => { releaseObserver = resolve; });
    const observer = vi.fn(async () => observerBarrier);
    let settled = false;

    const execution = runWithTools(
      [{ role: 'user', content: 'Run an oversized batch.' }],
      registry,
      { provider: 'deepseek', model: 'budget-test' },
      observer,
      80,
      ...getters,
    ).finally(() => { settled = true; });

    await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseObserver();
    const result = await execution;
    expect(budgetReceipt(result)).toBeDefined();
    expect(settled).toBe(true);
  });

  it('propagates a durable lifecycle observer failure instead of claiming a checkpoint was preserved', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => 'must not run');
    registerSimpleTool(registry, 'budget_observe', handler);
    mocks.makeLLMCall.mockResolvedValueOnce({
      text: 'oversized batch',
      toolCalls: Array.from(
        { length: HARD_MAX_TOOL_INVOCATIONS_PER_MODEL_RESPONSE + 1 },
        (_, index) => ({ id: `persist-fail-${index}`, name: 'budget_observe', arguments: { index } }),
      ),
    });

    const execution = runWithTools(
      [{ role: 'user', content: 'Run an oversized batch.' }],
      registry,
      { provider: 'deepseek', model: 'budget-test' },
      async () => { throw new Error('durable store unavailable'); },
      80,
      ...getters,
    );

    await expect(execution).rejects.toBeInstanceOf(ToolLifecyclePersistenceError);
    await expect(execution).rejects.toThrow('durable store unavailable');
    expect(handler).not.toHaveBeenCalled();
  });

  it('enforces one cumulative invocation ceiling across model iterations', async () => {
    const registry = new ToolRegistry();
    const probe = vi.fn(async args => `observed-${args.index}`);
    registerSimpleTool(registry, 'budget_probe', probe);
    const calls = (start: number, count: number) => Array.from({ length: count }, (_, offset) => ({
      id: `probe-${start + offset}`,
      name: 'budget_probe',
      arguments: { index: start + offset },
    }));
    for (let start = 0; start < HARD_MAX_TOOL_INVOCATIONS_PER_TURN; start += HARD_MAX_TOOL_INVOCATIONS_PER_MODEL_RESPONSE) {
      mocks.makeLLMCall.mockResolvedValueOnce({
        text: `batch-${start}`,
        toolCalls: calls(
          start,
          Math.min(
            HARD_MAX_TOOL_INVOCATIONS_PER_MODEL_RESPONSE,
            HARD_MAX_TOOL_INVOCATIONS_PER_TURN - start,
          ),
        ),
      });
    }
    mocks.makeLLMCall.mockResolvedValueOnce({
      text: 'one call beyond the turn budget',
      toolCalls: calls(HARD_MAX_TOOL_INVOCATIONS_PER_TURN, 1),
    });

    const result = await runWithTools(
      [{ role: 'user', content: 'Inspect each item in bounded batches.' }],
      registry,
      { provider: 'deepseek', model: 'budget-test' },
      undefined,
      80,
      ...getters,
    );

    expect(probe).toHaveBeenCalledTimes(HARD_MAX_TOOL_INVOCATIONS_PER_TURN);
    const record = budgetReceipt(result);
    expect(record?.receipt).toMatchObject({
      code: 'TOOL_INVOCATION_BUDGET_EXCEEDED',
      boundary: 'turn',
      limit: HARD_MAX_TOOL_INVOCATIONS_PER_TURN,
      executedInvocations: HARD_MAX_TOOL_INVOCATIONS_PER_TURN,
      invocableCalls: 1,
      overLimitBatchExecuted: false,
    });
    expect(result.toolCalls).toHaveLength(HARD_MAX_TOOL_INVOCATIONS_PER_TURN + 1);
  });

  it('counts required enum expansion against the response limit', async () => {
    const registry = new ToolRegistry();
    const expanded = vi.fn(async args => `checked-${args.target}`);
    const enumValues = Array.from(
      { length: HARD_MAX_TOOL_INVOCATIONS_PER_MODEL_RESPONSE + 1 },
      (_, index) => `target-${index}`,
    );
    registry.register({
      name: 'enum_budget_probe',
      description: 'Check one declared target.',
      parameters: {
        type: 'object',
        properties: { target: { type: 'string', enum: enumValues } },
        required: ['target'],
      },
      permission: 'public',
      securityLevel: 'safe',
      evidence: {
        capability: 'test.enum_budget_probe',
        operation: 'observe',
        assurance: 'observed',
        subjectArgument: 'target',
      },
      handler: expanded,
    });
    mocks.makeLLMCall.mockResolvedValueOnce({
      text: 'check every target',
      toolCalls: [{ id: 'enum-one', name: 'enum_budget_probe', arguments: { target: enumValues[0] } }],
    });

    const result = await runWithTools(
      [{ role: 'user', content: 'Check every declared target.' }],
      registry,
      { provider: 'deepseek', model: 'budget-test' },
      undefined,
      80,
      ...getters,
    );

    expect(expanded).not.toHaveBeenCalled();
    expect(budgetReceipt(result)?.receipt).toMatchObject({
      code: 'TOOL_INVOCATION_BUDGET_EXCEEDED',
      boundary: 'model_response',
      rawPlannedCalls: 1,
      normalizedPlannedCalls: enumValues.length,
      enumExpansionApplied: true,
      overLimitBatchExecuted: false,
    });
    expect(result.text).toContain('Schema-enum expansion');
  });
});
