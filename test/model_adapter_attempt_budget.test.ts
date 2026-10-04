import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { makeLLMCall, makeLLMCallStreaming } from '../server/llm/providers';
import { providerGetterArguments, type ProviderGetters } from '../server/llm/provider_getters';
import { resetCircuit } from '../server/cloud/circuit_breaker';
beforeAll(async () => { await initDatabase(); });
afterEach(() => resetCircuit());
describe('the model route owns the application retry budget', () => {
  it.each(['openai', 'gemini', 'anthropic'])('uses one %s adapter attempt in completion and streaming modes', async provider => {
    for (const streaming of [false, true]) {
      resetCircuit();
      const create = vi.fn(async () => { throw Object.assign(new Error('temporary provider unavailable'), { status: 503 }); });
      const clients: ProviderGetters = {
        getDeepSeek: () => null,
        getGemini: () => ({ getGenerativeModel: () => ({ generateContent: create, generateContentStream: create }) }),
        getOpenAI: () => ({ chat: { completions: { create } } }), getAnthropic: () => ({ messages: { create, stream: create } }),
      };
      const config = { provider, model: 'bounded-'+provider+'-'+streaming, noImplicitFailover: true,
        attemptTimeouts: { requestMs: 100, firstByteMs: 100, semanticContentMs: 100, idleMs: 100, absoluteMs: 2000 } };
      const messages = [{ role: 'user' as const, content: 'One route candidate' }], chunks = vi.fn();
      await expect(streaming
        ? makeLLMCallStreaming(messages, [], config, chunks, ...providerGetterArguments(clients))
        : makeLLMCall(messages, [], config, ...providerGetterArguments(clients))).rejects.toThrow('temporary provider unavailable');
      expect(create).toHaveBeenCalledTimes(1); expect(chunks).not.toHaveBeenCalled();
    }
  });
  it('does not request a provider after an already-cancelled turn', async () => {
    const create = vi.fn(), controller = new AbortController(); controller.abort();
    await expect(makeLLMCall([{ role: 'user', content: 'Cancelled' }], [],
      { provider: 'openai', model: 'cancelled-adapter', noImplicitFailover: true, signal: controller.signal },
      () => null, () => null, () => ({ chat: { completions: { create } } }))).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});
