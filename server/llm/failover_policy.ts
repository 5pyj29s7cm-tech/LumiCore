import {
  DEFAULT_MODELS,
  type UserLLMFallbackCandidate,
  type UserLLMPrefs,
} from './user_preferences';

/** Stable order used only after every user-declared candidate is exhausted. */
export const REASONING_FAILOVER_PRIORITY = [
  'deepseek',
  'qwen',
  'openai',
  'gemini',
  'anthropic',
  'ark',
  'xiaomi',
  'kimi',
  'glm',
  'relay',
] as const;

function normalizedCandidate(value: { provider?: string; model?: string }): UserLLMFallbackCandidate | null {
  const provider = String(value.provider || '').trim() as UserLLMFallbackCandidate['provider'];
  const model = String(value.model || '').trim().slice(0, 200);
  return provider && model ? { provider, model } : null;
}

/**
 * Compile an authorized, deterministic reasoning failover chain. Explicit
 * ordering wins; stored model choices win over built-in defaults. Runtime
 * configuration and health are checked later by dispatch.
 */
export function compileReasoningFailoverCandidates(input: {
  primaryProvider: string;
  primaryModel: string;
  explicitCandidates?: UserLLMFallbackCandidate[];
  preferences?: UserLLMPrefs | null;
}): UserLLMFallbackCandidate[] {
  const preferred = input.preferences;
  const raw: Array<{ provider?: string; model?: string }> = [
    ...(input.explicitCandidates || []),
    ...(preferred?.fallbackCandidates || []),
    ...(preferred ? [{
      provider: preferred.autoFallbackProvider,
      model: preferred.autoFallbackModel,
    }] : []),
  ];

  if (preferred) {
    for (const provider of REASONING_FAILOVER_PRIORITY) {
      raw.push({
        provider,
        model: preferred.models?.[provider] || DEFAULT_MODELS[provider],
      });
    }
    for (const provider of Object.keys(preferred.models || {}).sort()) {
      raw.push({ provider, model: preferred.models?.[provider] });
    }
  }

  const primaryKey = `${input.primaryProvider}\u0000${input.primaryModel}`;
  const unique = new Map<string, UserLLMFallbackCandidate>();
  for (const item of raw) {
    const candidate = normalizedCandidate(item);
    if (!candidate) continue;
    const key = `${candidate.provider}\u0000${candidate.model}`;
    if (key === primaryKey || unique.has(key)) continue;
    unique.set(key, candidate);
  }
  return [...unique.values()].slice(0, 11);
}
