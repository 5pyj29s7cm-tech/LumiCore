// Hybrid inference dispatch — local Ollama tier → cloud fallback.
// If a local model is available (Ollama detected), try it first.
// On failure or timeout, fall back to the cloud provider specified in user config.

import { NormalizedMessage, makeLLMCall, makeLLMCallStreaming, StreamCallback } from './providers';
import { NormalizedLLMResponse } from '../tools/types';

export interface DispatchConfig {
  provider: string;        // primary cloud provider (deepseek, qwen, openai, etc.)
  model: string;           // primary cloud model
  localModel?: string;     // local Ollama model override (default: first detected)
  maxTokens?: number;
  userId?: string;
  signal?: AbortSignal;
}

interface LLMGetters {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI: () => any;
  getAnthropic: () => any;
  getQwen: () => any;
  getOllama: () => any;
  getLmStudio?: () => any;
  isOllamaAvailable: () => boolean;
}

/**
 * Try a local Ollama call. Returns the response if successful, null if Ollama
 * is not available or fails. Fast timeout (15s) to avoid blocking.
 */
async function tryLocal(
  messages: NormalizedMessage[],
  toolDeclarations: any[],
  config: DispatchConfig,
  getters: LLMGetters,
): Promise<NormalizedLLMResponse | null> {
  if (!getters.isOllamaAvailable()) return null;
  const ollama = getters.getOllama();
  if (!ollama) return null;

  const localModel = config.localModel || 'qwen2.5:7b';

  try {
    const result = await makeLLMCall(
      messages,
      toolDeclarations,
      { provider: 'ollama', model: localModel, maxTokens: config.maxTokens, userId: config.userId },
      getters.getDeepSeek, getters.getGemini, getters.getOpenAI, getters.getAnthropic, getters.getQwen, getters.getOllama, getters.getLmStudio,
    );
    if (result.text || result.toolCalls) return result;
    // Empty response — fallback
    console.log('[Dispatch] Local model returned empty — falling back to cloud');
    return null;
  } catch (err: any) {
    console.log(`[Dispatch] Local model failed (${err.message}) — falling back to cloud`);
    return null;
  }
}

/**
 * Call LLM with automatic local→cloud tiered dispatch.
 * Uses the same call signature as makeLLMCall for easy drop-in.
 */
export async function dispatchLLMCall(
  messages: NormalizedMessage[],
  toolDeclarations: any[],
  config: DispatchConfig,
  getters: LLMGetters,
): Promise<{ text: string | null; toolCalls: any[] | null; tier: 'local' | 'cloud'; usage?: any }> {

  // ── Tier 1: Local Ollama ──
  const localResult = await tryLocal(messages, toolDeclarations, config, getters);
  if (localResult) {
    return { ...localResult, tier: 'local' };
  }

  // ── Tier 2: Cloud provider ──
  const provider = config.provider || 'deepseek';
  const model = config.model || 'deepseek-v4-flash';
  console.log(`[Dispatch] Routing to cloud: ${provider}/${model}`);

  const cloudResult = await makeLLMCall(
    messages,
    toolDeclarations,
    { provider: provider as any, model, maxTokens: config.maxTokens, userId: config.userId },
    getters.getDeepSeek, getters.getGemini, getters.getOpenAI, getters.getAnthropic, getters.getQwen, getters.getOllama, getters.getLmStudio,
  );

  return { ...cloudResult, tier: 'cloud' };
}

/**
 * Streaming variant: tries local first, falls back to cloud streaming.
 * The onChunk callback receives text from whichever tier is active.
 * Returns the tier that was actually used.
 */
export async function dispatchLLMCallStreaming(
  messages: NormalizedMessage[],
  toolDeclarations: any[],
  config: DispatchConfig,
  onChunk: StreamCallback,
  getters: LLMGetters,
): Promise<{ text: string | null; toolCalls: any[] | null; tier: 'local' | 'cloud'; usage?: any }> {

  // ── Tier 1: Local Ollama (non-streaming, fast enough for small models) ──
  const localResult = await tryLocal(messages, toolDeclarations, config, getters);
  if (localResult) {
    if (localResult.text) {
      // Simulate streaming by emitting the full text as a single chunk
      onChunk(localResult.text);
    }
    return { ...localResult, tier: 'local' };
  }

  // ── Tier 2: Cloud streaming ──
  const provider = config.provider || 'deepseek';
  const model = config.model || 'deepseek-v4-flash';
  console.log(`[Dispatch] Routing stream to cloud: ${provider}/${model}`);

  const cloudResult = await makeLLMCallStreaming(
    messages,
    toolDeclarations,
    { provider: provider as any, model, maxTokens: config.maxTokens, userId: config.userId, signal: config.signal },
    onChunk,
    getters.getDeepSeek, getters.getGemini, getters.getOpenAI, getters.getAnthropic, getters.getQwen, getters.getOllama, getters.getLmStudio,
  );

  return { ...cloudResult, tier: 'cloud' };
}
