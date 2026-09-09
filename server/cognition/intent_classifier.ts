import type { LLMCallConfig } from '../llm/providers';
import type { NormalizedLLMResponse } from '../tools/types';
import { runRetrievalRequest } from '../llm/retrieval_request';

export const INTENT_CLASSIFIER_MAX_TOKENS = 512;
export const INTENT_CLASSIFIER_TIMEOUT_MS = 4_500;

/** An optional routing hint must not consume the user's full reply failover budget. */
export async function callIntentClassifier(
  config: LLMCallConfig,
  invoke: (boundedConfig: LLMCallConfig) => Promise<NormalizedLLMResponse>,
): Promise<NormalizedLLMResponse & { text: string }> {
  // Reuse the existing abortable request boundary, including transports that
  // ignore abort or spend time preparing a local model before their HTTP call.
  return runRetrievalRequest(async signal => {
    const result = await invoke({
      ...config,
      signal,
      maxTokens: INTENT_CLASSIFIER_MAX_TOKENS,
      noImplicitFailover: true,
      selectionMode: 'pinned',
      fallbackCandidates: [],
      allowCloudFallback: false,
      attemptTimeouts: {
        requestMs: INTENT_CLASSIFIER_TIMEOUT_MS,
        firstByteMs: INTENT_CLASSIFIER_TIMEOUT_MS,
        semanticContentMs: INTENT_CLASSIFIER_TIMEOUT_MS,
        idleMs: INTENT_CLASSIFIER_TIMEOUT_MS,
        absoluteMs: INTENT_CLASSIFIER_TIMEOUT_MS,
      },
    });
    signal.throwIfAborted();
    // Keep an empty reasoning-only completion out of the classifier cache.
    // classifyIntentLLM already falls back to its local result on this error.
    if (!result.text?.trim()) throw new Error('Intent classifier returned no visible text');
    return { ...result, text: result.text };
  }, config.signal, INTENT_CLASSIFIER_TIMEOUT_MS);
}
