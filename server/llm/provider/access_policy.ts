import { isProviderLocalOnly, isStrictPrivacy, requireLocalProvider, requireLocalEndpoint } from "../../config/privacy";
import { getScopedPreferredLLM } from "../user_preferences";
import { getUserPreferredVision } from "../vision_preferences";
import { getUserPreferredWorldModel } from "../world_preferences";
import { getLocalModelConfig, type LocalModelProvider } from "../local_models";
import { isRegisteredOpenAICompatibleProvider, isRegisteredProviderLocal } from "../../extensions/registry";
import type { LLMCallConfig } from './contracts';
import { isQwenVisionModel } from './content';

export function extensionProviderForCall(config: LLMCallConfig): boolean {
  return isRegisteredOpenAICompatibleProvider(config.provider, config.userId);
}

export function extensionProviderFailure(provider: string, error: unknown): Error {
  const messages: string[] = [];
  let current: any = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const message = String(current?.message || current || '').trim();
    if (message && !messages.includes(message)) messages.push(message);
    current = current?.cause;
  }
  const detail = [...messages].reverse().find(message => !/^Connection error\.?$/i.test(message))
    || messages[0]
    || 'unknown provider error';
  return new Error(`Extension provider ${provider} failed: ${detail}`, { cause: error });
}

export function assertProviderAllowedByPrivacy(config: LLMCallConfig): void {
  if (!isStrictPrivacy() && config.dataRoutingPolicy !== 'local_only') return;
  if (extensionProviderForCall(config)) {
    if (!isRegisteredProviderLocal(config.provider, config.userId)) {
      throw new Error(`[Privacy] Local-only routing active. Extension provider "${config.provider}" is not declared as a loopback-only local provider.`);
    }
    return;
  }
  if (config.dataRoutingPolicy === 'local_only' && !isProviderLocalOnly(config.provider)) {
    throw new Error(`[Privacy] Local-only routing active. Cloud provider "${config.provider}" is blocked. Use ollama or lmstudio.`);
  }
  requireLocalProvider(config.provider);
  if (isProviderLocalOnly(config.provider)) {
    requireLocalEndpoint(getLocalModelConfig(config.provider as LocalModelProvider).baseUrl, 'Local language model', true);
  }
}

export function assertQwenAllowedByUserPrefs(config: { provider: string; model: string; userId?: string; domain?: string; orgId?: string; role?: 'reasoning' | 'vision' | 'world'; authorizedRoutingCandidate?: boolean }): void {
  if (config.provider !== 'qwen') return;
  if (config.authorizedRoutingCandidate === true) return;

  if (!config.userId) {
    throw new Error('Qwen model call blocked: missing user preference context. Pass userId so Lumi can respect the selected brain/vision provider.');
  }

  if (config.role === 'world') {
    const world = getUserPreferredWorldModel(config.userId);
    if (world.provider === 'qwen') return;
    throw new Error(`Qwen desktop-action call blocked: the current action role is ${world.provider}/${world.model}. Select Qwen-VL under Settings > World Model > Desktop Action Model.`);
  }

  if (isQwenVisionModel(config.model) || config.role === 'vision') {
    const vision = getUserPreferredVision(config.userId);
    if (vision.provider === 'qwen') return;
    throw new Error(`Qwen-VL call blocked: the current visual-perception role is ${vision.provider}/${vision.model}. Select Qwen-VL under Settings > World Model > Visual Perception.`);
  }

  const preferred = getScopedPreferredLLM(config.userId, { domain: config.domain, orgId: config.orgId });
  if (preferred.provider !== 'qwen') {
    throw new Error(`Qwen LLM call blocked: current primary reasoning brain is ${preferred.provider}/${preferred.model}. Change Primary Reasoning Brain to Qwen to use Alibaba LLM.`);
  }
}
