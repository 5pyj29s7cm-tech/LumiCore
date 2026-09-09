import { afterEach, describe, expect, it, vi } from 'vitest';
import * as providers from '../server/llm/providers';
import { runConversationTurn, type ConversationTurnInput } from '../server/llm/conversation_turn';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { resetCircuit } from '../server/cloud/circuit_breaker';
import type { NormalizedLLMResponse } from '../server/tools/types';

const config = { provider: 'deepseek', model: 'conversation-fixture', noImplicitFailover: true };
const getters = { getDeepSeek: () => null, getGemini: () => null };
const response = (text: string | null, extra: Partial<NormalizedLLMResponse> = {}): NormalizedLLMResponse => ({
  text, toolCalls: null, ...extra,
});
const input = (extra: Partial<ConversationTurnInput> = {}): ConversationTurnInput => ({
  messages: [{ role: 'user', content: '请用两句话介绍自己。' }], config, getters, ...extra,
});

afterEach(() => {
  vi.restoreAllMocks();
  resetCircuit();
});

describe('shared no-tool conversation turn', () => {
  it('streams the initial answer while the real provider is still running and exposes no tools', async () => {
    let release!: () => void;
    const finish = new Promise<void>(resolve => { release = resolve; });
    let firstChunk!: () => void;
    const first = new Promise<void>(resolve => { firstChunk = resolve; });
    const chunks: string[] = [];
    const create = vi.fn(async function* () {
      yield { choices: [{ delta: { content: '我是 Lumi。' } }] };
      await finish;
      yield { choices: [{ delta: { content: '我可以和你聊天。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 } };
    });
    const pending = runConversationTurn(input({
      getters: { ...getters, getDeepSeek: () => ({ chat: { completions: { create } } }) },
      onChunk: chunk => { chunks.push(chunk); firstChunk(); },
    }));
    await first;
    expect(chunks.join('')).toBe('我是 Lumi。');
    release();
    const result = await pending;
    expect(result).toMatchObject({ text: '我是 Lumi。我可以和你聊天。', completion: 'complete', corrected: false, toolCalls: [] });
    expect(result.usageRecords).toEqual([expect.objectContaining({ provider: 'deepseek', model: 'conversation-fixture', totalTokens: 20 })]);
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0] as unknown as [any])[0].tools || []).toEqual([]);
  });

  it('uses the real provider path for one sentence-count correction and only publishes the first draft stream', async () => {
    let attempt = 0;
    const create = vi.fn(async function* () {
      attempt += 1;
      yield { choices: [{ delta: { content: attempt === 1 ? '我是 Lumi。' : '我是 Lumi。我可以和你聊天。' }, finish_reason: 'stop' }], usage: { prompt_tokens: attempt, completion_tokens: attempt, total_tokens: attempt * 2 } };
    });
    const chunks: string[] = [];
    const result = await runConversationTurn(input({
      getters: { ...getters, getDeepSeek: () => ({ chat: { completions: { create } } }) },
      onChunk: chunk => chunks.push(chunk),
    }));
    expect(result).toMatchObject({ text: '我是 Lumi。我可以和你聊天。', completion: 'complete', corrected: true });
    expect(chunks).toEqual(['我是 Lumi。']);
    expect(result.usageRecords.map(record => record.totalTokens)).toEqual([2, 4]);
    expect(create).toHaveBeenCalledTimes(2);
    expect((create.mock.calls[1] as unknown as [any])[0].messages.at(-1).content).toContain('严格为 2 句话');
    for (const args of create.mock.calls) expect((args as unknown as [any])[0].tools || []).toEqual([]);
  });

  it('replaces an incomplete answer even when its sentence count was already correct', async () => {
    const model = vi.spyOn(providers, 'makeLLMCallStreaming')
      .mockResolvedValueOnce(response('我是 Lumi。我可以帮你。', { streamIncomplete: true }))
      .mockResolvedValueOnce(response('我是 Lumi。我可以和你聊天。'));
    const result = await runConversationTurn(input());
    expect(result).toMatchObject({ completion: 'complete', corrected: true, text: '我是 Lumi。我可以和你聊天。' });
    expect(model.mock.calls[1][0].at(-1)?.content).toContain('流式连接中断');
  });

  it.each([
    ['empty', response('')],
    ['truncated', response('我是 Lumi。我可以帮你。', { streamIncomplete: true })],
    ['wrong sentence count', response('我是 Lumi。')],
    ['undeclared tool request', response('我是 Lumi。我可以帮你。', { toolCalls: [{ id: 'invalid', name: 'write_file', arguments: {} }] })],
  ])('blocks a %s correction and never retries a third time', async (_label, second) => {
    const model = vi.spyOn(providers, 'makeLLMCallStreaming')
      .mockResolvedValueOnce(response('我是 Lumi。'))
      .mockResolvedValueOnce(second);
    const result = await runConversationTurn(input());
    expect(model).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ completion: 'incomplete', corrected: false, toolCalls: [], completionGuard: { blocked: true } });
    const final = finalizeLumiResponse({ taskText: '请用两句话介绍自己。', responseText: result.text, completionGuard: result.completionGuard, source: 'chat' });
    expect(final.blocked).toBe(true);
  });

  it('does not turn leftover streamed text into a successful empty terminal result', async () => {
    const model = vi.spyOn(providers, 'makeLLMCallStreaming')
      .mockImplementationOnce(async (_messages, _tools, _config, onChunk) => {
        onChunk('我是 Lumi。我可以帮你。');
        return response(null);
      })
      .mockResolvedValueOnce(response(null));
    const result = await runConversationTurn(input());
    expect(result.completion).toBe('incomplete');
    expect(model).toHaveBeenCalledTimes(2);
  });

  it('does not start correction after cancellation and suppresses late chunks', async () => {
    const controller = new AbortController();
    const chunks: string[] = [];
    const model = vi.spyOn(providers, 'makeLLMCallStreaming').mockImplementationOnce(async (_messages, _tools, _config, onChunk) => {
      controller.abort();
      onChunk('late draft');
      return response('我是 Lumi。');
    });
    await expect(runConversationTurn(input({ config: { ...config, signal: controller.signal }, onChunk: chunk => chunks.push(chunk) }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(model).toHaveBeenCalledTimes(1);
    expect(chunks).toEqual([]);
  });

  it('revalidates ownership before correction and does not downgrade revocation to an ordinary incomplete reply', async () => {
    let current = true;
    const model = vi.spyOn(providers, 'makeLLMCallStreaming').mockImplementationOnce(async () => {
      current = false;
      return response('我是 Lumi。');
    });
    await expect(runConversationTurn(input({ assertCurrent: () => { if (!current) throw new Error('owner revoked'); } }))).rejects.toThrow('owner revoked');
    expect(model).toHaveBeenCalledTimes(1);
  });

  it('retains actual selected-model usage when the correction request fails', async () => {
    vi.spyOn(providers, 'makeLLMCallStreaming')
      .mockResolvedValueOnce(response('我是 Lumi。', {
        usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
        routing: { requestedProvider: 'deepseek', requestedModel: 'conversation-fixture', selectedProvider: 'openai', selectedModel: 'configured-backup', selectionMode: 'ordered_fallback', fallbackReason: 'primary unavailable', attempts: [] },
      }))
      .mockRejectedValueOnce(new Error('repair provider unavailable'));
    const result = await runConversationTurn(input());
    expect(result).toMatchObject({ completion: 'incomplete', completionGuard: { blocked: true, reason: 'conversation_repair_failed' } });
    expect(result.usageRecords).toEqual([expect.objectContaining({ provider: 'openai', model: 'configured-backup', totalTokens: 5 })]);
  });

  it('cancels while correction is pending without releasing replacement text', async () => {
    const controller = new AbortController();
    const onChunk = vi.fn();
    const model = vi.spyOn(providers, 'makeLLMCallStreaming')
      .mockResolvedValueOnce(response('我是 Lumi。'))
      .mockImplementationOnce(async (_messages, _tools, _config, onCorrectionChunk) => {
        controller.abort();
        onCorrectionChunk('我是 Lumi。我可以帮你。');
        return response('我是 Lumi。我可以帮你。');
      });
    await expect(runConversationTurn(input({ config: { ...config, signal: controller.signal }, onChunk }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(model).toHaveBeenCalledTimes(2);
    expect(onChunk).not.toHaveBeenCalled();
  });
});
