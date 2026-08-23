import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchLLMCallStreaming, type LLMGetters } from '../server/llm/dispatch';
import { makeLLMCallStreaming } from '../server/llm/providers';
import { resetCircuit } from '../server/cloud/circuit_breaker';

vi.mock('../server/llm/local_models', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/llm/local_models')>();
  return {
    ...actual,
    resolveAutoLocalModelCandidates: vi.fn(async () => []),
  };
});

function getters(overrides: Partial<LLMGetters> = {}): LLMGetters {
  return {
    getDeepSeek: () => null,
    getGemini: () => null,
    getOpenAI: () => null,
    getAnthropic: () => null,
    getQwen: () => null,
    getOllama: () => null,
    getArk: () => null,
    getXiaomi: () => null,
    getKimi: () => null,
    getGlm: () => null,
    getRelay: () => null,
    ...overrides,
  };
}

const deadlines = {
  requestMs: 40,
  firstByteMs: 40,
  semanticContentMs: 40,
  idleMs: 40,
  absoluteMs: 100,
};

afterEach(() => resetCircuit());

describe('transactional streaming model routing', () => {
  it('uses the configured auto cloud chain without reverting to a non-streaming call', async () => {
    async function* unavailable() {
      yield { choices: [{ delta: { reasoning_content: 'not visible' } }] };
      throw new Error('auto primary unavailable');
    }
    async function* available() {
      yield { choices: [{ delta: { content: 'auto fallback streamed' } }] };
    }
    const deepSeek = { chat: { completions: { create: async () => unavailable() } } };
    const openAI = { chat: { completions: { create: async () => available() } } };
    const chunks: string[] = [];

    const result = await dispatchLLMCallStreaming(
      [{ role: 'user', content: 'auto route' }],
      [],
      {
        provider: 'deepseek',
        model: 'auto-primary',
        selectionMode: 'auto',
        fallbackCandidates: [{ provider: 'openai', model: 'auto-fallback' }],
        allowCloudFallback: true,
        attemptTimeouts: deadlines,
      },
      chunk => chunks.push(chunk),
      getters({ getDeepSeek: () => deepSeek, getOpenAI: () => openAI }),
    );

    expect(chunks).toEqual(['auto fallback streamed']);
    expect(result.routing).toMatchObject({
      selectionMode: 'auto',
      selectedProvider: 'openai',
      selectedModel: 'auto-fallback',
    });
  });

  it('hands off after a pre-visible failure and exposes only the fallback answer', async () => {
    async function* primary() {
      yield { choices: [{ delta: { reasoning_content: 'hidden planning' } }] };
      throw new Error('primary stream failed');
    }
    async function* fallback() {
      yield { choices: [{ delta: { content: 'fallback answer' } }] };
    }
    const deepSeek = { chat: { completions: { create: async () => primary() } } };
    const openAI = { chat: { completions: { create: async () => fallback() } } };
    const chunks: string[] = [];

    const result = await dispatchLLMCallStreaming(
      [{ role: 'user', content: 'route safely' }],
      [],
      {
        provider: 'deepseek',
        model: 'primary-model',
        selectionMode: 'ordered_fallback',
        fallbackCandidates: [{ provider: 'openai', model: 'fallback-model' }],
        allowCloudFallback: true,
        attemptTimeouts: deadlines,
      },
      chunk => chunks.push(chunk),
      getters({ getDeepSeek: () => deepSeek, getOpenAI: () => openAI }),
    );

    expect(chunks).toEqual(['fallback answer']);
    expect(result.text).toBe('fallback answer');
    expect(result.routing.attempts.map(attempt => `${attempt.provider}:${attempt.status}`)).toEqual([
      'deepseek:failed',
      'openai:succeeded',
    ]);
  });

  it('never appends a second model after visible output has committed for a pinned primary', async () => {
    async function* primary() {
      yield { choices: [{ delta: { content: 'visible partial' } }] };
      throw new Error('failed after commit');
    }
    const fallbackCreate = vi.fn(async function* () {
      yield { choices: [{ delta: { content: 'must not appear' } }] };
    });
    const deepSeek = { chat: { completions: { create: async () => primary() } } };
    const openAI = { chat: { completions: { create: fallbackCreate } } };
    const chunks: string[] = [];

    await expect(dispatchLLMCallStreaming(
      [{ role: 'user', content: 'do not splice models' }],
      [],
      {
        provider: 'deepseek',
        model: 'committed-primary',
        selectionMode: 'pinned',
        fallbackCandidates: [{ provider: 'openai', model: 'forbidden-replay' }],
        allowCloudFallback: true,
        attemptTimeouts: deadlines,
      },
      chunk => chunks.push(chunk),
      getters({ getDeepSeek: () => deepSeek, getOpenAI: () => openAI }),
    )).rejects.toThrow('failed after commit');

    expect(chunks).toEqual(['visible partial']);
    expect(fallbackCreate).not.toHaveBeenCalled();
  });

  it('does not expose or replay a failed pinned candidate tool call', async () => {
    async function* primary() {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'unsafe', function: { name: 'side_effect', arguments: '{}' } }] } }] };
      throw new Error('tool stream failed before completion');
    }
    async function* fallback() {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'safe', function: { name: 'read_only', arguments: '{"id":1}' } }] } }] };
    }
    const deepSeek = { chat: { completions: { create: async () => primary() } } };
    const openAI = { chat: { completions: { create: async () => fallback() } } };

    const result = await dispatchLLMCallStreaming(
      [{ role: 'user', content: 'use one completed tool plan' }],
      [{ type: 'function', function: { name: 'side_effect', description: '', parameters: {} } },
        { type: 'function', function: { name: 'read_only', description: '', parameters: {} } }],
      {
        provider: 'deepseek',
        model: 'failed-tool-primary',
        selectionMode: 'pinned',
        fallbackCandidates: [{ provider: 'openai', model: 'safe-tool-fallback' }],
        allowCloudFallback: true,
        attemptTimeouts: deadlines,
      },
      () => {},
      getters({ getDeepSeek: () => deepSeek, getOpenAI: () => openAI }),
    );

    expect(result.toolCalls).toEqual([{ id: 'safe', name: 'read_only', arguments: { id: 1 } }]);
    expect(result.routing.selectedProvider).toBe('openai');
  });

  it('stops a pinned failover route immediately on caller cancellation', async () => {
    const controller = new AbortController();
    const deepSeek = { chat: { completions: { create: () => new Promise<never>(() => {}) } } };
    const fallbackCreate = vi.fn();
    const openAI = { chat: { completions: { create: fallbackCreate } } };
    const pending = dispatchLLMCallStreaming(
      [{ role: 'user', content: 'cancel' }],
      [],
      {
        provider: 'deepseek',
        model: 'cancelled-primary',
        selectionMode: 'pinned',
        fallbackCandidates: [{ provider: 'openai', model: 'must-not-run' }],
        allowCloudFallback: true,
        signal: controller.signal,
        attemptTimeouts: deadlines,
      },
      () => {},
      getters({ getDeepSeek: () => deepSeek, getOpenAI: () => openAI }),
    );
    setTimeout(() => controller.abort(new DOMException('cancelled', 'AbortError')), 10);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fallbackCreate).not.toHaveBeenCalled();
  });

  it('fails over a pinned model after a pre-visible timeout', async () => {
    const deepSeek = { chat: { completions: { create: () => new Promise<never>(() => {}) } } };
    const fallbackCreate = vi.fn(async function* () {
      yield { choices: [{ delta: { content: 'pinned fallback answer' } }] };
    });
    const openAI = { chat: { completions: { create: fallbackCreate } } };
    const chunks: string[] = [];

    const result = await makeLLMCallStreaming(
      [{ role: 'user', content: 'stay pinned' }],
      [],
      {
        provider: 'deepseek',
        model: 'pinned-model',
        selectionMode: 'pinned',
        fallbackCandidates: [{ provider: 'openai', model: 'must-not-run' }],
        allowCloudFallback: true,
        attemptTimeouts: { ...deadlines, requestMs: 15 },
      },
      chunk => chunks.push(chunk),
      () => deepSeek,
      () => null,
      () => openAI,
    );
    expect(result.text).toBe('pinned fallback answer');
    expect(result.routing).toMatchObject({
      selectionMode: 'pinned',
      selectedProvider: 'openai',
      selectedModel: 'must-not-run',
    });
    expect(chunks).toEqual(['pinned fallback answer']);
    expect(fallbackCreate).toHaveBeenCalledTimes(1);
  });
});
