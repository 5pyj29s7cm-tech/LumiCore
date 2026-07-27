import { NormalizedMessage, makeLLMCall, makeLLMCallStreaming, StreamCallback } from './providers';
import { NormalizedLLMResponse } from '../tools/types';
import {
  markLocalModelUnhealthy,
  resolveAutoLocalModelCandidates,
  type LocalModelProvider,
} from './local_models';

export interface DispatchConfig {
  /** Explicit cloud fallback selected by the user. Never `auto`. */
  provider: string;
  model: string;
  /** Preferred local model for automatic local-first routing. */
  localModel?: string;
  maxTokens?: number;
  userId?: string;
  domain?: string;
  orgId?: string;
  signal?: AbortSignal;
  allowCloudFallback?: boolean;
}

export interface LLMGetters {
  getDeepSeek: () => any;
  getGemini: () => any;
  getOpenAI: () => any;
  getAnthropic: () => any;
  getQwen: () => any;
  getOllama: () => any;
  getLmStudio?: () => any;
  getArk?: () => any;
  getXiaomi?: () => any;
  getKimi?: () => any;
  getGlm?: () => any;
  getRelay?: () => any;
  isOllamaAvailable?: () => boolean;
  isLmStudioAvailable?: () => boolean;
}

function callArguments(config: DispatchConfig, provider: string, model: string) {
  return {
    provider: provider as any,
    model,
    maxTokens: config.maxTokens,
    userId: config.userId,
    domain: config.domain,
    orgId: config.orgId,
  };
}

function getterArguments(getters: LLMGetters) {
  return [
    getters.getDeepSeek,
    getters.getGemini,
    getters.getOpenAI,
    getters.getAnthropic,
    getters.getQwen,
    getters.getOllama,
    getters.getLmStudio,
    getters.getArk,
    getters.getXiaomi,
    getters.getKimi,
    getters.getGlm,
    getters.getRelay,
  ] as const;
}

/** Probe both local runtimes and try the exact configured model first. */
async function tryLocal(
  messages: NormalizedMessage[],
  toolDeclarations: any[],
  config: DispatchConfig,
  getters: LLMGetters,
): Promise<NormalizedLLMResponse | null> {
  const candidates = await resolveAutoLocalModelCandidates(config.localModel);
  const selected = candidates.filter((candidate, index, all) => (
    all.findIndex(item => item.provider === candidate.provider) === index
  ));

  for (const candidate of selected) {
    const getter = candidate.provider === 'ollama' ? getters.getOllama : getters.getLmStudio;
    if (!getter?.()) continue;
    try {
      const result = await makeLLMCall(
        messages,
        toolDeclarations,
        callArguments(config, candidate.provider, candidate.model),
        ...getterArguments(getters),
      );
      if (result.text || result.toolCalls) return result;
      console.log(`[Dispatch] ${candidate.provider}/${candidate.model} returned an empty response`);
    } catch (error: any) {
      markLocalModelUnhealthy(candidate.provider as LocalModelProvider, error);
      console.log(`[Dispatch] ${candidate.provider}/${candidate.model} failed (${error?.message || error})`);
    }
  }
  return null;
}

function exactCloudFallback(config: DispatchConfig): { provider: string; model: string } {
  const provider = String(config.provider || '').trim();
  const model = String(config.model || '').trim();
  if (!provider || !model || provider === 'auto') {
    throw new Error('Automatic model routing requires an explicit cloud fallback provider and model');
  }
  return { provider, model };
}

export async function dispatchLLMCall(
  messages: NormalizedMessage[],
  toolDeclarations: any[],
  config: DispatchConfig,
  getters: LLMGetters,
): Promise<{ text: string | null; toolCalls: any[] | null; tier: 'local' | 'cloud'; usage?: any }> {
  const localResult = await tryLocal(messages, toolDeclarations, config, getters);
  if (localResult) return { ...localResult, tier: 'local' };
  if (config.allowCloudFallback === false) {
    throw new Error('[Privacy] Strict mode: no healthy local LLM/model is available. Start Ollama or LM Studio and load the selected model.');
  }

  const fallback = exactCloudFallback(config);
  console.log(`[Dispatch] Routing to configured cloud fallback: ${fallback.provider}/${fallback.model}`);
  const cloudResult = await makeLLMCall(
    messages,
    toolDeclarations,
    callArguments(config, fallback.provider, fallback.model),
    ...getterArguments(getters),
  );
  return { ...cloudResult, tier: 'cloud' };
}

export async function dispatchLLMCallStreaming(
  messages: NormalizedMessage[],
  toolDeclarations: any[],
  config: DispatchConfig,
  onChunk: StreamCallback,
  getters: LLMGetters,
): Promise<{ text: string | null; toolCalls: any[] | null; tier: 'local' | 'cloud'; usage?: any }> {
  const localResult = await tryLocal(messages, toolDeclarations, config, getters);
  if (localResult) {
    if (localResult.text) onChunk(localResult.text);
    return { ...localResult, tier: 'local' };
  }
  if (config.allowCloudFallback === false) {
    throw new Error('[Privacy] Strict mode: no healthy local LLM/model is available. Start Ollama or LM Studio and load the selected model.');
  }

  const fallback = exactCloudFallback(config);
  console.log(`[Dispatch] Routing stream to configured cloud fallback: ${fallback.provider}/${fallback.model}`);
  const cloudResult = await makeLLMCallStreaming(
    messages,
    toolDeclarations,
    { ...callArguments(config, fallback.provider, fallback.model), signal: config.signal },
    onChunk,
    ...getterArguments(getters),
  );
  return { ...cloudResult, tier: 'cloud' };
}
