import { cleanModelName, isSelectionProvider, normalizeModelMap, normalizeModelSelection } from './model_selection';
import { readSettingJson } from '../persistence/settings_repository';
import { writeModelPreference } from './model_preference_revision';
import { LUMI_OFFICIAL_DEFAULT_MODELS } from '../../shared/model_provider_capabilities';

export type VisionProvider = 'openai' | 'gemini' | 'ark' | 'qwen' | 'ollama' | 'lmstudio' | 'relay';

export interface VisionPrefs {
  provider: VisionProvider;
  model: string;
  models: Record<string, string>;
}

export const DEFAULT_VISION_MODELS: Record<VisionProvider, string> = {
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
  ark: 'doubao-1-5-vision-pro-32k',
  qwen: 'qwen-vl-max',
  ollama: 'qwen2.5vl:7b',
  lmstudio: 'local-vision-model',
  relay: LUMI_OFFICIAL_DEFAULT_MODELS.vision,
};

const VISION_SELECTION = {
  defaults: DEFAULT_VISION_MODELS,
  defaultProvider: 'openai' as const,
  maxLength: 200,
};

export function isVisionProvider(value: unknown): value is VisionProvider {
  return isSelectionProvider(value, VISION_SELECTION);
}

export function getUserPreferredVision(userId: string): VisionPrefs {
  return normalizeModelSelection<VisionProvider>(readSettingJson(`vision_prefs_${userId}`), VISION_SELECTION);
}

export function upsertUserPreferredVision(
  userId: string,
  input: { provider?: string; model?: string; models?: Record<string, string> },
): VisionPrefs {
  if (!isVisionProvider(input.provider)) throw new Error(`Unsupported vision provider: ${input.provider || ''}`);
  const current = getUserPreferredVision(userId || 'anonymous');
  const provider = input.provider;
  const models = {
    ...current.models,
    ...normalizeModelMap(input.models, 200),
  };
  const model = cleanModelName(input.model, 200) || models[provider] || DEFAULT_VISION_MODELS[provider];
  if (!model) throw new Error('A vision model name is required');
  models[provider] = model;
  const payload = { provider, model, models, updatedAt: new Date().toISOString() };
  const key = `vision_prefs_${userId || 'anonymous'}`;
  writeModelPreference(key, payload, ['vision']);
  return { provider, model, models };
}

export function getUserPreferredVisionConfig(
  userId: string,
  options: { maxTokens?: number } = {},
): { provider: VisionProvider; model: string; maxTokens?: number; userId: string } {
  const pref = getUserPreferredVision(userId);
  return {
    provider: pref.provider,
    model: pref.model,
    userId,
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
  };
}
