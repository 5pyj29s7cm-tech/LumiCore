import type { ProviderArguments } from "../provider_getters";
import { isStrictPrivacy } from "../../config/privacy";
import { getScopedPreferredLLM } from "../user_preferences";
import { compileReasoningFailoverCandidates } from "../failover_policy";
import { isExtensionProviderId, isRegisteredOpenAICompatibleProvider } from "../../extensions/registry";
import type { LLMCallConfig } from './contracts';
import { isReasoningModel } from './openai_compatible';

export function autoDispatchPreference(config: LLMCallConfig) {
  const preferred = config.userId
    ? getScopedPreferredLLM(config.userId, { domain: config.domain, orgId: config.orgId })
    : null;
  return {
    // Routing changes candidates, not request-level safety/visibility contracts.
    // Keep future tool, cancellation and output constraints on the same path.
    ...config,
    provider: preferred?.autoFallbackProvider || 'deepseek',
    model: preferred?.autoFallbackModel || preferred?.models?.deepseek || 'deepseek-v4-flash',
    localModel: config.model || preferred?.model,
    requestedProvider: config.provider,
    requestedModel: config.model,
    selectionMode: 'auto' as const,
    fallbackCandidates: config.fallbackCandidates || preferred?.fallbackCandidates || [],
    allowCloudFallback: config.allowCloudFallback !== false
      && preferred?.allowCloudFallback !== false
      && !isStrictPrivacy(),
  };
}

/**
 * An explicit caller budget is a contract. Classifiers and other bounded
 * control-plane calls must not silently become 4k-token reasoning requests
 * merely because the selected model can reason. Full reasoning calls that do
 * not provide a budget keep the generous default.
 */
export function resolveModelMaxTokens(model: string, requested?: number): number | undefined {
  if (Number.isFinite(requested) && Number(requested) > 0) {
    return Math.max(1, Math.floor(Number(requested)));
  }
  return isReasoningModel(model) ? 8_000 : undefined;
}

export function pinnedFailoverDispatchPreference(config: LLMCallConfig) {
  if (config.noImplicitFailover === true) return null;
  if (config.role === 'vision' || config.role === 'world') return null;
  // A disabled/removed signed provider is an explicit trust-state change.
  // Preserve the selection and surface that state instead of routing around it.
  if (isExtensionProviderId(config.provider)
    && !isRegisteredOpenAICompatibleProvider(config.provider, config.userId)) return null;
  const preferred = config.userId
    ? getScopedPreferredLLM(config.userId, { domain: config.domain, orgId: config.orgId })
    : null;
  const isStoredReasoningPrimary = Boolean(
    preferred
    && preferred.provider === config.provider
    && preferred.model === config.model,
  );
  const explicitCandidates = config.fallbackCandidates || [];
  if (!isStoredReasoningPrimary && explicitCandidates.length === 0) return null;

  const fallbackCandidates = compileReasoningFailoverCandidates({
    primaryProvider: config.provider,
    primaryModel: config.model,
    explicitCandidates,
    preferences: isStoredReasoningPrimary ? preferred : null,
  });
  if (fallbackCandidates.length === 0) return null;
  return {
    ...config,
    requestedProvider: config.provider,
    requestedModel: config.model,
    selectionMode: 'pinned' as const,
    fallbackCandidates,
    allowCloudFallback: config.allowCloudFallback !== false
      && preferred?.allowCloudFallback !== false
      && !isStrictPrivacy(),
  };
}

export function autoDispatchGetters(...getters: ProviderArguments) {
  const [getDeepSeek, getGemini, getOpenAI, getAnthropic, getQwen, getOllama, getLmStudio, getArk, getXiaomi, getKimi, getGlm, getRelay] = getters;
  return {
    getDeepSeek,
    getGemini,
    getOpenAI: getOpenAI || (() => null),
    getAnthropic: getAnthropic || (() => null),
    getQwen: getQwen || (() => null),
    getOllama: getOllama || (() => null),
    getLmStudio: getLmStudio || (() => null),
    getArk: getArk || (() => null),
    getXiaomi: getXiaomi || (() => null),
    getKimi: getKimi || (() => null),
    getGlm: getGlm || (() => null),
    getRelay: getRelay || (() => null),
  };
}
