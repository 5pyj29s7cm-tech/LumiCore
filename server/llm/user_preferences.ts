import { readDB, writeDB } from '../../db_layer';

export type UserLLMProvider =
  | 'deepseek'
  | 'qwen'
  | 'openai'
  | 'gemini'
  | 'anthropic'
  | 'ark'
  | 'xiaomi'
  | 'kimi'
  | 'glm'
  | 'relay'
  | 'ollama'
  | 'lmstudio'
  | 'auto';

export interface UserLLMPrefs {
  provider: UserLLMProvider;
  model: string;
  models: Record<string, string>;
  source: 'personal';
}

export const DEFAULT_MODELS: Record<UserLLMProvider, string> = {
  deepseek: 'deepseek-v4-flash',
  qwen: 'qwen-plus',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
  anthropic: 'claude-sonnet-4-6',
  ark: 'doubao-seed-2-0-lite-260215',
  xiaomi: 'mimo-v2.5-pro',
  kimi: 'moonshot-v1-8k',
  glm: 'glm-5.1',
  relay: 'gpt-4o',
  ollama: 'qwen2.5:7b',
  lmstudio: 'local-model',
  auto: 'qwen2.5:7b',
};

const VALID_PROVIDERS = new Set<UserLLMProvider>([
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
  'ollama',
  'lmstudio',
  'auto',
]);

function normalizeProvider(value: unknown): UserLLMProvider {
  return typeof value === 'string' && VALID_PROVIDERS.has(value as UserLLMProvider)
    ? value as UserLLMProvider
    : 'deepseek';
}

export function isUserLLMProvider(value: unknown): value is UserLLMProvider {
  return typeof value === 'string' && VALID_PROVIDERS.has(value as UserLLMProvider);
}

function normalizeModels(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, model]) => typeof model === 'string' && model.trim())
    .map(([provider, model]) => [provider, String(model).trim().slice(0, 200)]));
}

function parsePrefsRow(key: string): any {
  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === key);
    if (setting?.value) return JSON.parse(setting.value);
  } catch {}
  return null;
}

function normalizeLegacyModel(provider: UserLLMProvider, model: string): string {
  if (provider === 'deepseek' && model === 'deepseek-chat') return 'deepseek-v4-flash';
  if (provider === 'deepseek' && model === 'deepseek-reasoner') return 'deepseek-v4-pro';
  if (provider === 'xiaomi' && model === 'xiaomi-chat') return 'mimo-v2.5-pro';
  return model;
}

function resolvePrefs(raw: any): UserLLMPrefs {
  const provider = normalizeProvider(raw?.provider);
  const rawModels = normalizeModels(raw?.models);
  const model = normalizeLegacyModel(provider, rawModels[provider] || DEFAULT_MODELS[provider]);
  const models = { ...rawModels, [provider]: model };
  return {
    provider,
    model,
    models,
    source: 'personal',
  };
}

export function getUserPreferredLLM(userId: string): UserLLMPrefs {
  return resolvePrefs(parsePrefsRow(`llm_prefs_${userId}`));
}

export function upsertUserPreferredLLM(
  userId: string,
  input: { provider?: string; model?: string; models?: Record<string, string> },
): UserLLMPrefs {
  if (!isUserLLMProvider(input.provider)) throw new Error(`Unsupported reasoning provider: ${input.provider || ''}`);
  const current = getUserPreferredLLM(userId || 'anonymous');
  const provider = input.provider;
  const models = {
    ...current.models,
    ...normalizeModels(input.models),
  };
  const requestedModel = String(input.model || models[provider] || DEFAULT_MODELS[provider]).trim().slice(0, 200);
  if (!requestedModel) throw new Error('A reasoning model name is required');
  models[provider] = requestedModel;
  const payload = { provider, models, updatedAt: new Date().toISOString() };
  const db = readDB();
  const key = `llm_prefs_${userId || 'anonymous'}`;
  if (!db.settings) (db as any).settings = [];
  const index = (db.settings || []).findIndex((setting: any) => setting.key === key);
  if (index >= 0) db.settings[index].value = JSON.stringify(payload);
  else db.settings.push({ key, value: JSON.stringify(payload) });
  writeDB(db);
  return resolvePrefs(payload);
}

export function getScopedPreferredLLM(
  userId: string,
  _scope: { domain?: string; orgId?: string } = {},
): UserLLMPrefs {
  return getUserPreferredLLM(userId);
}

export function getUserPreferredLLMConfig(
  userId: string,
  options: { maxTokens?: number; domain?: string; orgId?: string } = {},
): { provider: UserLLMProvider; model: string; userId: string; maxTokens?: number; domain?: string; orgId?: string } {
  const pref = getScopedPreferredLLM(userId, { domain: options.domain, orgId: options.orgId });
  return {
    provider: pref.provider,
    model: pref.model,
    userId,
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
    ...(options.domain ? { domain: options.domain } : {}),
    ...(options.orgId ? { orgId: options.orgId } : {}),
  };
}
