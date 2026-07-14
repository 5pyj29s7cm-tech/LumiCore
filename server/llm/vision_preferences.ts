import { readDB, writeDB } from '../../db_layer';

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
  relay: 'qwen2.5-vl-7b-instruct',
};

const VALID_VISION_PROVIDERS = new Set<VisionProvider>(['openai', 'gemini', 'ark', 'qwen', 'ollama', 'lmstudio', 'relay']);

function normalizeVisionProvider(value: unknown): VisionProvider {
  return typeof value === 'string' && VALID_VISION_PROVIDERS.has(value as VisionProvider)
    ? value as VisionProvider
    : 'openai';
}

export function isVisionProvider(value: unknown): value is VisionProvider {
  return typeof value === 'string' && VALID_VISION_PROVIDERS.has(value as VisionProvider);
}

function normalizeVisionModels(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, model]) => typeof model === 'string' && model.trim())
    .map(([provider, model]) => [provider, String(model).trim().slice(0, 200)]));
}

export function getUserPreferredVision(userId: string): VisionPrefs {
  let raw: any = null;
  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === `vision_prefs_${userId}`);
    if (setting?.value) raw = JSON.parse(setting.value);
  } catch {}

  const provider = normalizeVisionProvider(raw?.provider);
  const models = normalizeVisionModels(raw?.models);
  const model = models[provider] || raw?.model || DEFAULT_VISION_MODELS[provider];

  return { provider, model, models };
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
    ...normalizeVisionModels(input.models),
  };
  const model = String(input.model || models[provider] || DEFAULT_VISION_MODELS[provider]).trim().slice(0, 200);
  if (!model) throw new Error('A vision model name is required');
  models[provider] = model;
  const payload = { provider, model, models, updatedAt: new Date().toISOString() };
  const db = readDB();
  const key = `vision_prefs_${userId || 'anonymous'}`;
  if (!db.settings) (db as any).settings = [];
  const index = (db.settings || []).findIndex((setting: any) => setting.key === key);
  if (index >= 0) db.settings[index].value = JSON.stringify(payload);
  else db.settings.push({ key, value: JSON.stringify(payload) });
  writeDB(db);
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
