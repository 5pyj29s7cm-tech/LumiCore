import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { callIntentClassifier, INTENT_CLASSIFIER_TIMEOUT_MS } from '../server/cognition/intent_classifier';
import { classifyIntentLLM, type IntentResult } from '../server/cognition/intent';
import { makeLLMCall, type LLMCallConfig } from '../server/llm/providers';
import { upsertUserPreferredLLM } from '../server/llm/user_preferences';
import { resetCircuit } from '../server/cloud/circuit_breaker';

const userId = 'bounded-intent-classifier-fixture';
const classifierJson = '{"category":"conversation","confidence":0.9,"entities":{}}';
const response = (text: string) => ({ choices: [{ message: { content: text }, finish_reason: 'stop' }] });
const local: IntentResult = { category: 'unknown', confidence: 0.1, entities: {}, needsLLM: true };
const config = (): LLMCallConfig => ({
  provider: 'relay', model: 'aliyun/deepseek-v4-flash', userId,
  selectionMode: 'ordered_fallback', allowCloudFallback: true,
  fallbackCandidates: [{ provider: 'deepseek', model: 'deepseek-v4-pro' }],
  source: 'chat_intent_classifier',
});
function providers(primary: ReturnType<typeof vi.fn>, fallback = vi.fn(async () => response('main answer'))) {
  const relay = { chat: { completions: { create: primary } } };
  const deepseek = { chat: { completions: { create: fallback } } };
  const invoke = (input: LLMCallConfig) => makeLLMCall(
    [{ role: 'user', content: 'Synthetic classifier fixture' }], [], input,
    () => deepseek, () => null, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, () => relay,
  );
  return { invoke, fallback };
}

describe('optional intent classifier budget', () => {
  beforeAll(async () => {
    await initDatabase();
    upsertUserPreferredLLM(userId, {
      provider: 'relay', model: 'aliyun/deepseek-v4-flash', selectionMode: 'ordered_fallback',
      fallbackCandidates: [{ provider: 'deepseek', model: 'deepseek-v4-pro' }],
      allowCloudFallback: true,
    });
  });
  afterEach(() => { vi.useRealTimers(); resetCircuit(); vi.clearAllMocks(); });

  it('sends 512 tokens through the actual non-stream provider formatter', async () => {
    const primary = vi.fn(async (_params: Record<string, unknown>) => response(classifierJson));
    const { invoke, fallback } = providers(primary);
    const result = await callIntentClassifier(config(), invoke);
    expect(result.text).toBe(classifierJson);
    expect(primary).toHaveBeenCalledOnce();
    expect(primary.mock.calls[0][0]).toMatchObject({ model: 'aliyun/deepseek-v4-flash', max_tokens: 512 });
    expect(primary.mock.calls[0][0]).not.toHaveProperty('stream', true);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back to local intent on an empty answer without consulting stored backup providers', async () => {
    const primary = vi.fn(async () => response(''));
    const { invoke, fallback } = providers(primary);
    const result = await classifyIntentLLM('fixture empty classification', local, async () => (
      await callIntentClassifier(config(), invoke)
    ).text);
    expect(result).toBe(local);
    expect(primary).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('does not route classifier provider errors to the configured backup', async () => {
    const primary = vi.fn(async () => { throw Object.assign(new Error('Synthetic unauthorized response'), { status: 401 }); });
    const { invoke, fallback } = providers(primary);
    await expect(callIntentClassifier(config(), invoke)).rejects.toThrow();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('bounds the whole optional call even if preparation or the SDK ignores cancellation', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let captured: LLMCallConfig | undefined;
    let release!: (value: any) => void;
    const classified = classifyIntentLLM('fixture delayed classification', local, async () => (
      await callIntentClassifier({ ...config(), signal: parent.signal }, input => {
        captured = input;
        return new Promise(resolve => { release = resolve; });
      })
    ).text);
    await vi.advanceTimersByTimeAsync(INTENT_CLASSIFIER_TIMEOUT_MS - 1);
    expect(captured?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await classified).toBe(local);
    expect(captured?.signal?.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
    release({ text: classifierJson, toolCalls: [] });
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates parent cancellation and cleans up its own deadline', async () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    let signal: AbortSignal | undefined;
    const pending = callIntentClassifier({ ...config(), signal: parent.signal }, input => {
      signal = input.signal;
      return new Promise(() => {});
    });
    const reason = new DOMException('Synthetic caller cancellation', 'AbortError');
    const rejected = expect(pending).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(0);
    parent.abort(reason);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start classification when the parent is already cancelled', async () => {
    const parent = new AbortController(); parent.abort();
    const invoke = vi.fn();
    await expect(callIntentClassifier({ ...config(), signal: parent.signal }, invoke)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps the original main-reply policy and still reaches its configured backup', async () => {
    const original = config();
    const snapshot = structuredClone(original);
    const primary = vi.fn(async () => response(''));
    const { invoke, fallback } = providers(primary);
    await expect(callIntentClassifier(original, invoke)).rejects.toThrow('no visible text');
    expect(original).toEqual(snapshot);
    expect(fallback).not.toHaveBeenCalled();
    const mainReply = await invoke({ ...original, source: 'chat' });
    expect(mainReply.text).toBe('main answer');
    expect(mainReply.routing?.selectedProvider).toBe('deepseek');
    expect(fallback).toHaveBeenCalledOnce();
  });
});
