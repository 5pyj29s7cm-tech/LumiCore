import { describe, expect, it } from 'vitest';
import { createCallerKeyProvider } from '../server/llm/caller_key_provider';

describe('request-local supplied provider credentials', () => {
  it.each([
    ['gemini', 'getGemini', 'gemini-2.0-flash'],
    ['anthropic', 'getAnthropic', 'claude-sonnet-4-6'],
    ['deepseek', 'getDeepSeek', 'deepseek-v4-flash'],
    ['qwen', 'getQwen', 'qwen-plus'],
    ['openai', 'getOpenAI', 'gpt-4o'],
  ])('keeps %s clients separate between requests and exposes no alternate client', (provider, getter, model) => {
    const first = createCallerKeyProvider(provider, undefined, 'synthetic-first-key');
    const second = createCallerKeyProvider(provider, 'caller-selected-model', 'synthetic-second-key');
    expect(first).toMatchObject({ provider, model });
    expect(second.model).toBe('caller-selected-model');
    expect(Object.keys(first.getters)).toEqual([getter]);
    const client = (first.getters as any)[getter]();
    const other = (second.getters as any)[getter]();
    expect(client).not.toBe(other);
    expect(client.apiKey).toBe('synthetic-first-key');
    expect(other.apiKey).toBe('synthetic-second-key');
    expect((first.getters as any)[getter]()).toBe(client);
    if (provider === 'deepseek') expect(client.baseURL).toBe('https://api.deepseek.com/v1');
    if (provider === 'qwen') expect(client.baseURL).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
  });
  it('preserves the existing unknown-provider OpenAI default', () => {
    const caller = createCallerKeyProvider('unknown', undefined, 'synthetic-key');
    expect(caller).toMatchObject({ provider: 'openai', model: 'gpt-4o' });
    expect(Object.keys(caller.getters)).toEqual(['getOpenAI']);
  });
});
