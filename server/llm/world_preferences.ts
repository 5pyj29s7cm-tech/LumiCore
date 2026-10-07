import { isSelectionProvider, normalizeModelSelection } from './model_selection';
import { readSettingJson } from '../persistence/settings_repository';
import { writeModelPreference } from './model_preference_revision';
import { LUMI_OFFICIAL_DEFAULT_MODELS } from '../../shared/model_provider_capabilities';
import {
  DEFAULT_VISION_MODELS,
  getUserPreferredVision,
  type VisionProvider,
} from './vision_preferences';

export type WorldModelProvider = 'inherit_vision' | VisionProvider;

export interface WorldModelPrefs {
  provider: WorldModelProvider;
  model: string;
  models: Record<string, string>;
}

export interface ResolvedWorldModel {
  provider: VisionProvider;
  model: string;
  configuredProvider: WorldModelProvider;
  inheritedFromVision: boolean;
}

export const DEFAULT_WORLD_MODELS: Record<VisionProvider, string> = {
  ...DEFAULT_VISION_MODELS,
  // Desktop action prediction benefits more from latency than the primary
  // deep-inspection vision lane. Keep the roles independently selectable.
  relay: LUMI_OFFICIAL_DEFAULT_MODELS.world,
};

const WORLD_SELECTION = {
  defaults: DEFAULT_WORLD_MODELS,
  defaultProvider: 'inherit_vision' as const,
  specialProvider: 'inherit_vision' as const,
  specialModel: 'empty' as const,
  includeDefaults: true,
};

export function normalizeWorldModelPrefs(raw: unknown): WorldModelPrefs {
  return normalizeModelSelection<WorldModelProvider>(raw, WORLD_SELECTION);
}

export function getUserWorldModelPrefs(userId: string): WorldModelPrefs {
  return normalizeWorldModelPrefs(readSettingJson(`world_prefs_${userId || 'anonymous'}`));
}

export function getUserPreferredWorldModel(userId: string): ResolvedWorldModel {
  const prefs = getUserWorldModelPrefs(userId || 'anonymous');
  if (prefs.provider === 'inherit_vision') {
    const vision = getUserPreferredVision(userId || 'anonymous');
    return {
      provider: vision.provider,
      model: vision.model,
      configuredProvider: 'inherit_vision',
      inheritedFromVision: true,
    };
  }
  return {
    provider: prefs.provider,
    model: prefs.model,
    configuredProvider: prefs.provider,
    inheritedFromVision: false,
  };
}

export function upsertUserWorldModelPrefs(userId: string, input: unknown): WorldModelPrefs {
  const prefs = normalizeWorldModelPrefs(input);
  const key = `world_prefs_${userId || 'anonymous'}`;
  const payload = { ...prefs, updatedAt: new Date().toISOString() };
  writeModelPreference(key, payload, ['world']);
  return prefs;
}

export function isWorldModelProvider(value: unknown): value is WorldModelProvider {
  return isSelectionProvider(value, WORLD_SELECTION);
}
