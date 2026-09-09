import { describe, expect, it } from 'vitest';
import {
  compileReasoningFailoverCandidates,
  REASONING_FAILOVER_PRIORITY,
} from '../server/llm/failover_policy';
import type { UserLLMPrefs } from '../server/llm/user_preferences';

function preferences(overrides: Partial<UserLLMPrefs> = {}): UserLLMPrefs {
  return {
    schemaVersion: 2,
    provider: 'deepseek',
    model: 'deepseek-primary',
    models: { deepseek: 'deepseek-primary' },
    selectionMode: 'pinned',
    fallbackCandidates: [],
    allowCloudFallback: true,
    autoFallbackProvider: 'deepseek',
    autoFallbackModel: 'deepseek-primary',
    source: 'personal',
    ...overrides,
  };
}

describe('reasoning failover policy', () => {
  it('does not resurrect remembered BYOK models behind the official service', () => {
    const candidates = compileReasoningFailoverCandidates({
      primaryProvider: 'relay',
      primaryModel: 'aliyun/deepseek-v4-flash',
      preferences: preferences({
        provider: 'relay',
        model: 'aliyun/deepseek-v4-flash',
        models: { relay: 'aliyun/deepseek-v4-flash', qwen: 'qwen-plus', openai: 'remembered-openai' },
        autoFallbackProvider: 'relay',
        autoFallbackModel: 'aliyun/deepseek-v4-flash',
        fallbackCandidates: [{ provider: 'ollama', model: 'local-backup' }],
      }),
    });
    expect(candidates).toEqual([{ provider: 'ollama', model: 'local-backup' }]);
  });

  it('uses only declared cloud routes when automatic mode targets the official service', () => {
    const candidates = compileReasoningFailoverCandidates({
      primaryProvider: 'ollama',
      primaryModel: 'local-backup',
      preferences: preferences({
        provider: 'auto',
        autoFallbackProvider: 'relay',
        autoFallbackModel: 'aliyun/deepseek-v4-flash',
        models: { qwen: 'qwen-plus' },
      }),
    });
    expect(candidates).toEqual([{ provider: 'relay', model: 'aliyun/deepseek-v4-flash' }]);
  });

  it('retains an explicitly selected BYOK fallback behind the official service', () => {
    const candidates = compileReasoningFailoverCandidates({
      primaryProvider: 'relay',
      primaryModel: 'aliyun/deepseek-v4-flash',
      explicitCandidates: [{ provider: 'qwen', model: 'user-selected-model' }],
      preferences: preferences({
        provider: 'relay',
        autoFallbackProvider: 'relay',
        autoFallbackModel: 'aliyun/deepseek-v4-flash',
        models: { qwen: 'qwen-plus' },
      }),
    });
    expect(candidates).toEqual([{ provider: 'qwen', model: 'user-selected-model' }]);
  });

  it('keeps the official relay out of the implicit compatibility priority', () => {
    expect(REASONING_FAILOVER_PRIORITY).not.toContain('relay');

    const candidates = compileReasoningFailoverCandidates({
      primaryProvider: 'deepseek',
      primaryModel: 'deepseek-primary',
      preferences: preferences(),
    });

    expect(candidates.map(candidate => candidate.provider)).not.toContain('relay');
    // Existing built-in provider fallback remains intact for compatibility.
    expect(candidates.map(candidate => candidate.provider)).toContain('qwen');
  });

  it('keeps relay when the caller explicitly supplies it', () => {
    const candidates = compileReasoningFailoverCandidates({
      primaryProvider: 'deepseek',
      primaryModel: 'deepseek-primary',
      explicitCandidates: [{ provider: 'relay', model: 'aliyun/qwen-plus' }],
      preferences: preferences(),
    });

    expect(candidates[0]).toEqual({ provider: 'relay', model: 'aliyun/qwen-plus' });
  });

  it('keeps relay from persisted fallback preferences and selected model memory', () => {
    const fromFallback = compileReasoningFailoverCandidates({
      primaryProvider: 'deepseek',
      primaryModel: 'deepseek-primary',
      preferences: preferences({
        fallbackCandidates: [{ provider: 'relay', model: 'fallback-relay' }],
      }),
    });
    expect(fromFallback).toContainEqual({ provider: 'relay', model: 'fallback-relay' });

    const fromAutoFallback = compileReasoningFailoverCandidates({
      primaryProvider: 'deepseek',
      primaryModel: 'deepseek-primary',
      preferences: preferences({
        autoFallbackProvider: 'relay',
        autoFallbackModel: 'aliyun/qwen-plus',
      }),
    });
    expect(fromAutoFallback).toContainEqual({ provider: 'relay', model: 'aliyun/qwen-plus' });

    const fromModelMemory = compileReasoningFailoverCandidates({
      primaryProvider: 'deepseek',
      primaryModel: 'deepseek-primary',
      preferences: preferences({
        models: { deepseek: 'deepseek-primary', relay: 'remembered-relay-model' },
      }),
    });
    expect(fromModelMemory).toContainEqual({ provider: 'relay', model: 'remembered-relay-model' });
  });
});
