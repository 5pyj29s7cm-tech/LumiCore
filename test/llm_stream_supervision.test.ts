import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  makeLLMCallStreamingDirect,
  type ModelAttemptTimeouts,
} from '../server/llm/providers';
import {
  getCircuitStatus,
  isCircuitClosed,
  isCircuitHealthy,
  recordFailure,
  resetCircuit,
  setCircuitBreakerConfig,
} from '../server/cloud/circuit_breaker';

const generous: ModelAttemptTimeouts = {
  requestMs: 120,
  firstByteMs: 120,
  semanticContentMs: 120,
  idleMs: 120,
  absoluteMs: 180,
};

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function callDeepSeek(
  client: any,
  attemptTimeouts: Partial<ModelAttemptTimeouts>,
  options: { signal?: AbortSignal; onChunk?: (chunk: string) => void } = {},
) {
  return makeLLMCallStreamingDirect(
    [{ role: 'user', content: 'test' }],
    [],
    {
      provider: 'deepseek',
      model: 'generic-model',
      signal: options.signal,
      attemptTimeouts: { ...generous, ...attemptTimeouts },
    },
    options.onChunk || (() => {}),
    () => client,
    () => null,
  );
}

function callGemini(client: any, attemptTimeouts: Partial<ModelAttemptTimeouts>) {
  return makeLLMCallStreamingDirect(
    [{ role: 'user', content: 'test' }],
    [],
    { provider: 'gemini', model: 'generic-gemini', attemptTimeouts: { ...generous, ...attemptTimeouts } },
    () => {},
    () => null,
    () => client,
  );
}

function callAnthropic(client: any, attemptTimeouts: Partial<ModelAttemptTimeouts>) {
  return makeLLMCallStreamingDirect(
    [{ role: 'user', content: 'test' }],
    [],
    { provider: 'anthropic', model: 'generic-anthropic', attemptTimeouts: { ...generous, ...attemptTimeouts } },
    () => {},
    () => null,
    () => null,
    () => null,
    () => client,
  );
}

function callRelay(
  client: any,
  attemptTimeouts: Partial<ModelAttemptTimeouts>,
  options: { onChunk?: (chunk: string) => void; toolDeclarations?: any[]; relayStreaming?: boolean } = {},
) {
  return makeLLMCallStreamingDirect(
    [{ role: 'user', content: 'test' }],
    options.toolDeclarations || [],
    {
      provider: 'relay',
      model: 'aliyun/qwen-plus',
      relayStreaming: options.relayStreaming,
      attemptTimeouts: { ...generous, ...attemptTimeouts },
    },
    options.onChunk || (() => {}),
    () => null,
    () => null,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => client,
  );
}

afterEach(() => {
  resetCircuit();
  setCircuitBreakerConfig({
    failureThreshold: 5,
    halfOpenSuccessThreshold: 2,
    cooldownMs: 30_000,
    failureWindowMs: 60_000,
  });
});

describe('provider-independent streaming attempt supervision', () => {
  it('enforces the request deadline even when create() never settles', async () => {
    const client = { chat: { completions: { create: () => new Promise<never>(() => {}) } } };
    await expect(callDeepSeek(client, { requestMs: 15 }))
      .rejects.toMatchObject({ stage: 'request' });
  });

  it('wires the same hard request boundary into Gemini and Anthropic adapters', async () => {
    const gemini = {
      getGenerativeModel: () => ({ generateContentStream: () => new Promise<never>(() => {}) }),
    };
    const anthropic = {
      messages: { stream: () => new Promise<never>(() => {}) },
    };

    await expect(callGemini(gemini, { requestMs: 15 })).rejects.toMatchObject({ stage: 'request' });
    await expect(callAnthropic(anthropic, { requestMs: 15 })).rejects.toMatchObject({ stage: 'request' });
  });

  it('enforces TTFT and asks a stalled iterator to stop', async () => {
    const returnSpy = vi.fn(async () => ({ done: true, value: undefined }));
    const iterator = {
      next: () => new Promise<IteratorResult<any>>(() => {}),
      return: returnSpy,
    };
    const client = {
      chat: { completions: { create: async () => ({ [Symbol.asyncIterator]: () => iterator }) } },
    };

    await expect(callDeepSeek(client, { firstByteMs: 15 }))
      .rejects.toMatchObject({ stage: 'first_byte' });
    expect(returnSpy).toHaveBeenCalledTimes(1);
  });

  it('does not let hidden reasoning frames renew the semantic-content deadline', async () => {
    async function* reasoningOnly() {
      while (true) {
        await delay(4);
        yield { choices: [{ delta: { reasoning_content: 'hidden' } }] };
      }
    }
    const client = { chat: { completions: { create: async () => reasoningOnly() } } };

    await expect(callDeepSeek(client, {
      semanticContentMs: 30,
      firstByteMs: 20,
      idleMs: 20,
      absoluteMs: 120,
    })).rejects.toMatchObject({ stage: 'semantic_content' });
  });

  it('enforces idle time after a visible semantic chunk', async () => {
    let calls = 0;
    const iterator = {
      next: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve({ done: false, value: { choices: [{ delta: { content: 'partial' } }] } });
        return new Promise<IteratorResult<any>>(() => {});
      },
      return: async () => ({ done: true, value: undefined }),
    };
    const chunks: string[] = [];
    const client = {
      chat: { completions: { create: async () => ({ [Symbol.asyncIterator]: () => iterator }) } },
    };

    await expect(callDeepSeek(client, { idleMs: 15 }, { onChunk: chunk => chunks.push(chunk) }))
      .rejects.toMatchObject({ stage: 'idle' });
    expect(chunks).toEqual(['partial']);
  });

  it('enforces the absolute deadline even while semantic frames keep arriving', async () => {
    async function* endlessText() {
      while (true) {
        await delay(4);
        yield { choices: [{ delta: { content: 'x' } }] };
      }
    }
    const client = { chat: { completions: { create: async () => endlessText() } } };

    await expect(callDeepSeek(client, {
      firstByteMs: 20,
      semanticContentMs: 20,
      idleMs: 20,
      absoluteMs: 35,
    })).rejects.toMatchObject({ stage: 'absolute' });
  });

  it('settles immediately on caller cancellation without poisoning provider health', async () => {
    const controller = new AbortController();
    const client = { chat: { completions: { create: () => new Promise<never>(() => {}) } } };
    const pending = callDeepSeek(client, {}, { signal: controller.signal });
    setTimeout(() => controller.abort(new DOMException('stopped', 'AbortError')), 10);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(getCircuitStatus().some(status => status.key === 'deepseek:generic-model')).toBe(false);
  });

  it('records health only after the full stream completes', async () => {
    setCircuitBreakerConfig({ failureThreshold: 1, halfOpenSuccessThreshold: 1, cooldownMs: 0 });
    recordFailure('deepseek', 'generic-model', new Error('initial outage'));
    expect(isCircuitClosed('deepseek', 'generic-model')).toBe(true); // enter half-open

    async function* failsAfterHandshake() {
      yield { choices: [{ delta: { content: 'partial' } }] };
      throw new Error('stream transport failed');
    }
    const failing = { chat: { completions: { create: async () => failsAfterHandshake() } } };
    await expect(callDeepSeek(failing, {})).rejects.toThrow('stream transport failed');
    expect(getCircuitStatus()).toContainEqual(expect.objectContaining({
      key: 'deepseek:generic-model',
      state: 'open',
    }));

    expect(isCircuitClosed('deepseek', 'generic-model')).toBe(true); // next half-open probe
    async function* complete() {
      yield { choices: [{ delta: { content: 'complete' } }] };
    }
    const healthy = { chat: { completions: { create: async () => complete() } } };
    await expect(callDeepSeek(healthy, {})).resolves.toMatchObject({ text: 'complete' });
    expect(isCircuitHealthy('deepseek', 'generic-model')).toBe(true);
  });

  it('falls back to one non-stream relay request when SSE fails before semantic output', async () => {
    const requests: any[] = [];
    const client = {
      chat: {
        completions: {
          create: vi.fn(async (params: any) => {
            requests.push(params);
            if (params.stream) {
              return (async function* () {
                // ModelDepot currently emits an empty handshake frame before
                // reporting chat_stream_error on this deployment.
                yield { choices: [{ delta: {} }] };
                throw new Error('chat_stream_error');
              })();
            }
            return { choices: [{ message: { role: 'assistant', content: 'relay answer' } }] };
          }),
        },
      },
    };
    const chunks: string[] = [];

    await expect(callRelay(client, {}, { relayStreaming: true, onChunk: chunk => chunks.push(chunk) }))
      .resolves.toMatchObject({ text: 'relay answer', toolCalls: null });
    expect(requests.map(request => request.stream)).toEqual([true, false]);
    expect(chunks).toEqual(['relay answer']);
  });

  it('keeps structured tool calls from the relay non-stream fallback', async () => {
    const requests: any[] = [];
    const client = {
      chat: {
        completions: {
          create: vi.fn(async (params: any) => {
            requests.push(params);
            if (params.stream) {
              return (async function* () {
                yield { choices: [{ delta: {} }] };
                throw new Error('chat_stream_error');
              })();
            }
            return {
              choices: [{
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [{
                    id: 'call-1',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{"q":"lumi"}' },
                  }],
                },
              }],
            };
          }),
        },
      },
    };

    const result = await callRelay(client, {}, {
      relayStreaming: true,
      toolDeclarations: [{
        type: 'function',
        function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object' } },
      }],
    });
    expect(requests.map(request => request.stream)).toEqual([true, false]);
    expect(result.text).toBeNull();
    expect(result.toolCalls).toEqual([{ id: 'call-1', name: 'lookup', arguments: { q: 'lumi' } }]);
  });

  it('recognizes an in-band relay stream error frame before the iterator closes', async () => {
    const requests: any[] = [];
    const client = {
      chat: {
        completions: {
          create: vi.fn(async (params: any) => {
            requests.push(params);
            if (params.stream) {
              return (async function* () {
                yield { choices: [{ delta: {} }] };
                yield { error: { code: 'chat_stream_error', message: 'stream unavailable' } };
              })();
            }
            return { choices: [{ message: { role: 'assistant', content: 'in-band recovered' } }] };
          }),
        },
      },
    };

    await expect(callRelay(client, {}, { relayStreaming: true })).resolves.toMatchObject({ text: 'in-band recovered' });
    expect(requests.map(request => request.stream)).toEqual([true, false]);
  });

  it('does not replay a relay request after visible output has started', async () => {
    const requests: any[] = [];
    const chunks: string[] = [];
    const client = {
      chat: {
        completions: {
          create: vi.fn(async (params: any) => {
            requests.push(params);
            return (async function* () {
              yield { choices: [{ delta: { content: 'partial' } }] };
              throw new Error('chat_stream_error');
            })();
          }),
        },
      },
    };

    await expect(callRelay(client, {}, { relayStreaming: true, onChunk: chunk => chunks.push(chunk) }))
      .rejects.toThrow('chat_stream_error');
    expect(requests).toHaveLength(1);
    expect(chunks).toEqual(['partial']);
  });

  it('uses one non-stream relay request by default when the gateway SSE contract is not enabled', async () => {
    const requests: any[] = [];
    const client = {
      chat: {
        completions: {
          create: vi.fn(async (params: any) => {
            requests.push(params);
            return { choices: [{ message: { role: 'assistant', content: 'default relay answer' } }] };
          }),
        },
      },
    };
    const chunks: string[] = [];

    await expect(callRelay(client, {}, { onChunk: chunk => chunks.push(chunk) }))
      .resolves.toMatchObject({ text: 'default relay answer', toolCalls: null });
    expect(requests).toHaveLength(1);
    expect(requests[0].stream).toBe(false);
    expect(chunks).toEqual(['default relay answer']);
  });
});
