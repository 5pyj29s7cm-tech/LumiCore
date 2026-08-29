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
