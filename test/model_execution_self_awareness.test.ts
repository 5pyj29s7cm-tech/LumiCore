import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { buildModelSelfAwareness } from '../server/cognition/vision_routing';
import { dispatchLLMCall, dispatchLLMCallStreaming, type LLMGetters } from '../server/llm/dispatch';
import { runConversationTurn } from '../server/llm/conversation_turn';
import { resetCircuit } from '../server/cloud/circuit_breaker';
import type { NormalizedMessage } from '../server/llm/providers';

vi.mock('../server/llm/local_models', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/llm/local_models')>();
  return { ...actual,
    ensureLocalModelReady: vi.fn(async (_provider: string, model: string) => model),
    runLocalModelInference: vi.fn(async (_provider: string, execute: () => Promise<unknown>) => execute()),
  };
});

beforeAll(async () => { await initDatabase(); });
afterEach(() => { resetCircuit(); vi.clearAllMocks(); });

const primary = { provider: 'relay', model: 'aliyun/deepseek-v4-flash' };
const backup = { provider: 'lmstudio' as const, model: 'qwen2.5-7b-instruct' };
const config = { ...primary, selectionMode: 'ordered_fallback' as const, fallbackCandidates: [backup],
  allowCloudFallback: true, requestId: 'synthetic-model-identity-request', source: 'chat' };
const usage = { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 };

function clients(streaming: boolean) {
  const primaryCreate = vi.fn(async (_payload: any) => { throw Object.assign(new Error('free quota exhausted'), { status: 403 }); });
  const localCreate = vi.fn(async (_payload: any) => streaming
    ? (async function* () {
      yield { choices: [{ delta: { content: 'synthetic local answer' }, finish_reason: null }] };
      yield { choices: [{ delta: {}, finish_reason: 'stop' }], usage };
    })()
    : { choices: [{ message: { role: 'assistant', content: 'synthetic local answer' }, finish_reason: 'stop' }], usage });
  const getters: LLMGetters = {
    getDeepSeek: () => null, getGemini: () => null, getOpenAI: () => null,
    getAnthropic: () => null, getQwen: () => null, getOllama: () => null,
    getRelay: () => ({ chat: { completions: { create: primaryCreate } } }),
    getLmStudio: () => ({ chat: { completions: { create: localCreate } } }),
  };
  return { getters, primaryCreate, localCreate };
}

function messages(): NormalizedMessage[] {
  return [{ role: 'system', content: 'You are Lumi.' + buildModelSelfAwareness(primary.provider, primary.model, 'synthetic-identity-user') },
    { role: 'user', content: 'Which model is answering this message?', sourceMessageId: 'synthetic-identity-question' }];
}

function systemText(payload: any): string {
  return payload.messages.filter((message: any) => message.role === 'system').map((message: any) => message.content).join('\n');
}

describe('model identity follows the executing candidate', () => {
  it.each([false, true])('preserves primary preference while giving a fallback its own identity (streaming=%s)', async streaming => {
    const { getters, primaryCreate, localCreate } = clients(streaming);
    const input = messages(), original = structuredClone(input);
    const result = streaming
      ? await dispatchLLMCallStreaming(input, [], config, () => {}, getters)
      : await dispatchLLMCall(input, [], config, getters);
    expect(result.routing).toMatchObject({ requestedProvider: primary.provider, requestedModel: primary.model,
      selectedProvider: backup.provider, selectedModel: backup.model });
    expect(primaryCreate).toHaveBeenCalledOnce();
    expect(localCreate).toHaveBeenCalledOnce();
    const primaryPrompt = systemText(primaryCreate.mock.calls[0][0]);
    const localPrompt = systemText(localCreate.mock.calls[0][0]);
    expect(primaryPrompt).toContain(`Executing candidate: ${JSON.stringify(primary)}`);
    expect(localPrompt).toContain(`Executing candidate: ${JSON.stringify(backup)}`);
    expect(localPrompt).toContain(`Configured request preference: ${JSON.stringify(primary)}`);
    expect(localPrompt).not.toContain(`Executing candidate: ${JSON.stringify(primary)}`);
    expect(localPrompt).not.toContain('mention this exact primary model');
    expect(localPrompt.match(/\[Model execution routing for this request\]/g)).toHaveLength(1);
    expect(input).toEqual(original);
  });

  it('uses the same fallback identity for a normal no-tool conversation without a repair call', async () => {
    const { getters, primaryCreate, localCreate } = clients(true);
    const chunks: string[] = [];
    const result = await runConversationTurn({ messages: messages(), config, getters,
      onChunk: chunk => chunks.push(chunk), taskText: 'Which model is answering this message?' });
    expect(result).toMatchObject({ completion: 'complete', corrected: false, text: 'synthetic local answer', toolCalls: [] });
    expect(result.usageRecords).toContainEqual(expect.objectContaining({ provider: backup.provider, model: backup.model,
      requestedProvider: primary.provider, requestedModel: primary.model }));
    expect(systemText(localCreate.mock.calls[0][0])).toContain(`Executing candidate: ${JSON.stringify(backup)}`);
    expect(localCreate.mock.calls[0][0].tools).toBeUndefined();
    expect(chunks.join('')).toBe('synthetic local answer');
    expect(primaryCreate).toHaveBeenCalledOnce();
    expect(localCreate).toHaveBeenCalledOnce();
  });

  it('does not reuse a previous candidate identity when the next request selects a different model', async () => {
    const first = clients(false);
    const sharedMessages = messages();
    await dispatchLLMCall(sharedMessages, [], config, first.getters);
    resetCircuit();
    const nextModel = 'local-second-request';
    const second = clients(false);
    await dispatchLLMCall(sharedMessages, [], { ...config, provider: 'lmstudio', model: nextModel,
      requestId: 'synthetic-second-model-identity-request', fallbackCandidates: [] }, second.getters);
    const prompt = systemText(second.localCreate.mock.calls[0][0]);
    expect(prompt).toContain(`Executing candidate: ${JSON.stringify({ provider: 'lmstudio', model: nextModel })}`);
    expect(prompt).not.toContain(`Executing candidate: ${JSON.stringify(backup)}`);
    expect(prompt.match(/\[Model execution routing for this request\]/g)).toHaveLength(1);
  });
});
