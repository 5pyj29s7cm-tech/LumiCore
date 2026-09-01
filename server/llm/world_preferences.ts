import { readDB, writeDB } from '../../db_layer';
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
  relay: 'aliyun/qwen3-vl-flash',
};

const WORLD_PROVIDERS = new Set<WorldModelProvider>([
  'inherit_vision',
  'openai',
  'gemini',
  'ark',
  'qwen',
  'ollama',
  'lmstudio',
  'relay',
]);

function parseSetting(userId: string): any {
  try {
    const db = readDB();
    const row = (db.settings || []).find((item: any) => item.key === `world_prefs_${userId}`);
    return row?.value ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

function normalizeModels(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, model]) => typeof model === 'string' && model.trim())
    .map(([provider, model]) => [provider, String(model).trim()]));
}

export function normalizeWorldModelPrefs(raw: any): WorldModelPrefs {
  const provider = WORLD_PROVIDERS.has(raw?.provider)
    ? raw.provider as WorldModelProvider
    : 'inherit_vision';
  const models = normalizeModels(raw?.models);
  const model = provider === 'inherit_vision'
    ? ''
    : models[provider] || String(raw?.model || '').trim() || DEFAULT_WORLD_MODELS[provider];
  return {
    provider,
    model,
    models: {
      ...DEFAULT_WORLD_MODELS,
      ...models,
    },
  };
}

export function getUserWorldModelPrefs(userId: string): WorldModelPrefs {
  return normalizeWorldModelPrefs(parseSetting(userId || 'anonymous'));
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
    model: prefs.model || prefs.models[prefs.provider] || DEFAULT_WORLD_MODELS[prefs.provider],
    configuredProvider: prefs.provider,
    inheritedFromVision: false,
  };
}

export function upsertUserWorldModelPrefs(userId: string, input: unknown): WorldModelPrefs {
  const prefs = normalizeWorldModelPrefs(input);
  const db = readDB();
  const key = `world_prefs_${userId || 'anonymous'}`;
  const payload = { ...prefs, updatedAt: new Date().toISOString() };
  if (!db.settings) (db as any).settings = [];
  const index = (db.settings || []).findIndex((item: any) => item.key === key);
  if (index >= 0) {
    (db.settings as any[])[index].value = JSON.stringify(payload);
  } else {
    db.settings.push({ key, value: JSON.stringify(payload) });
  }
  writeDB(db);
  return prefs;
}

export function isWorldModelProvider(value: unknown): value is WorldModelProvider {
  return WORLD_PROVIDERS.has(value as WorldModelProvider);
}
