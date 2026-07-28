import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  makeLLMCall: vi.fn(),
}));

vi.mock('../server/llm/providers', async () => {
  const actual = await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers');
  return {
    ...actual,
    makeLLMCall: mocks.makeLLMCall,
  };
});

import { runWithTools } from '../server/llm/adapter';
import { ToolRegistry } from '../server/tools/registry';

function cancellationRegistry() {
  const registry = new ToolRegistry();
  const first = vi.fn(async () => JSON.stringify({ ok: true, verified: true }));
  const second = vi.fn(async () => JSON.stringify({ ok: true, verified: true }));
  for (const [name, handler] of [['cancel_first', first], ['cancel_second', second]] as const) {
    registry.register({
      name,
      description: `Cancellation boundary tool ${name}`,
      parameters: { type: 'object', properties: {}, required: [] },
      permission: 'public',
      securityLevel: 'safe',
      handler,
    });
  }
  return { registry, first, second };
}

const getters = [
  () => null,
  () => null,
  () => null,
  () => null,
  () => null,
] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LLM tool loop cancellation boundary', () => {
  it('drops a late model response before it can dispatch its tool calls', async () => {
    const { registry, first } = cancellationRegistry();
    let cancelled = false;
    mocks.makeLLMCall.mockImplementationOnce(async () => {
      cancelled = true;
      return {
        text: 'late response',
        toolCalls: [{ id: 'late-tool', name: 'cancel_first', arguments: {} }],
      };
    });

    const result = await runWithTools(
      [{ role: 'user', content: 'Run the tool' }],
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      1,
      ...getters,
      undefined,
      { isCancelled: () => cancelled },
    );

    expect(first).not.toHaveBeenCalled();
    expect(result.toolCalls).toEqual([]);
    expect(result.text).toMatch(/cancelled before the model response/i);
  });

  it('stops the rest of a tool batch when cancellation arrives between calls', async () => {
    const { registry, first, second } = cancellationRegistry();
    let cancelled = false;
    first.mockImplementationOnce(async () => {
      cancelled = true;
      return JSON.stringify({ ok: true, verified: true });
    });
    mocks.makeLLMCall.mockResolvedValueOnce({
      text: 'two calls',
      toolCalls: [
        { id: 'first-tool', name: 'cancel_first', arguments: {} },
        { id: 'second-tool', name: 'cancel_second', arguments: {} },
      ],
    });

    const result = await runWithTools(
      [{ role: 'user', content: 'Run both tools' }],
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      1,
      ...getters,
      undefined,
      { isCancelled: () => cancelled },
    );

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(result.toolCalls).toHaveLength(1);
    expect(result.text).toMatch(/cancelled before the remaining tool calls/i);
  });
});
