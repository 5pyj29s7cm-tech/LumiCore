import { readDB, writeDB } from '../../db_layer';
import {
  getRegisteredProviderDefaultModel,
  isExtensionProviderId,
  isRegisteredOpenAICompatibleProvider,
  isRegisteredProviderLocal,
} from '../extensions/registry';
import { normalizeLumiOfficialModel } from '../../shared/model_provider_capabilities';

export type BuiltinUserLLMProvider =
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

export type UserLLMProvider = BuiltinUserLLMProvider | `ext_${string}`;

export type CloudUserLLMProvider = Exclude<UserLLMProvider, 'ollama' | 'lmstudio' | 'auto'>;

export type UserLLMSelectionMode = 'pinned' | 'ordered_fallback' | 'auto';

export interface UserLLMFallbackCandidate {
  provider: Exclude<UserLLMProvider, 'auto'>;
  model: string;
}

export interface UserLLMLegacyMigration {
  migratedAt: string;
  entries: Array<{ provider: string; from: string; to: string }>;
}

export interface UserLLMPrefs {
  schemaVersion: 2;
  provider: UserLLMProvider;
  model: string;
  models: Record<string, string>;
  selectionMode: UserLLMSelectionMode;
  fallbackCandidates: UserLLMFallbackCandidate[];
  allowCloudFallback: boolean;
  autoFallbackProvider: CloudUserLLMProvider;
  autoFallbackModel: string;
  legacyMigration?: UserLLMLegacyMigration;
  source: 'personal';
}

export const DEFAULT_MODELS: Record<BuiltinUserLLMProvider, string> = {
  deepseek: 'deepseek-v4-flash',
  qwen: 'qwen-plus',
  openai: 'gpt-4o',
  gemini: 'gemini-2.0-flash',
  anthropic: 'claude-sonnet-4-6',
  ark: 'doubao-seed-2-0-lite-260215',
  xiaomi: 'mimo-v2.5-pro',
  kimi: 'moonshot-v1-8k',
  glm: 'glm-5.1',
  // ModelDepot/Lumi Official model IDs include the upstream namespace.
  relay: 'aliyun/qwen-plus',
  ollama: 'qwen2.5:7b',
  lmstudio: 'local-model',
  auto: 'qwen2.5:7b',
};

const VALID_PROVIDERS = new Set<BuiltinUserLLMProvider>([
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
const CLOUD_PROVIDERS = new Set<CloudUserLLMProvider>([
  'deepseek', 'qwen', 'openai', 'gemini', 'anthropic', 'ark', 'xiaomi', 'kimi', 'glm', 'relay',
]);

function normalizeProvider(value: unknown): UserLLMProvider {
  return typeof value === 'string' && (VALID_PROVIDERS.has(value as BuiltinUserLLMProvider) || isExtensionProviderId(value))
    ? value as UserLLMProvider
    : 'deepseek';
}

export function isUserLLMProvider(value: unknown, userId?: string): value is UserLLMProvider {
  return typeof value === 'string' && (
    VALID_PROVIDERS.has(value as BuiltinUserLLMProvider)
    || isRegisteredOpenAICompatibleProvider(value, userId)
  );
}

export function getDefaultModelForProvider(provider: UserLLMProvider, userId?: string): string {
  return (DEFAULT_MODELS as Record<string, string>)[provider]
    || getRegisteredProviderDefaultModel(provider, userId)
    || '';
}

export function isCloudLLMProvider(provider: UserLLMProvider, userId?: string): provider is CloudUserLLMProvider {
  if (CLOUD_PROVIDERS.has(provider as CloudUserLLMProvider)) return true;
  return isRegisteredOpenAICompatibleProvider(provider, userId)
    && !isRegisteredProviderLocal(provider, userId);
}

function normalizeModels(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, model]) => typeof model === 'string' && model.trim())
    .map(([provider, model]) => [provider, String(model).trim().slice(0, 200)]));
}

function normalizeSelectionMode(value: unknown, provider: UserLLMProvider): UserLLMSelectionMode {
  if (provider === 'auto') return 'auto';
  return value === 'ordered_fallback' ? 'ordered_fallback' : 'pinned';
}

function normalizeFallbackCandidates(value: unknown): UserLLMFallbackCandidate[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, UserLLMFallbackCandidate>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const provider = String((item as any).provider || '').trim() as UserLLMProvider;
    const model = String((item as any).model || '').trim().slice(0, 200);
    if (!provider || provider === 'auto' || (!VALID_PROVIDERS.has(provider as BuiltinUserLLMProvider) && !isExtensionProviderId(provider)) || !model) continue;
    const key = `${provider}\u0000${model}`;
    if (!unique.has(key)) unique.set(key, { provider, model });
  }
  return [...unique.values()].slice(0, 8);
}

function normalizeCloudFallback(value: unknown): CloudUserLLMProvider {
  return typeof value === 'string' && (CLOUD_PROVIDERS.has(value as CloudUserLLMProvider) || isExtensionProviderId(value))
    ? value as CloudUserLLMProvider
    : 'deepseek';
}

function parsePrefsRow(key: string): any {
  try {
    const db = readDB();
    const setting = (db.settings || []).find((s: any) => s.key === key);
    if (setting?.value) return JSON.parse(setting.value);
  } catch {}
  return null;
}

function migrateLegacyModel(provider: UserLLMProvider, model: string): string {
  if (provider === 'deepseek' && model === 'deepseek-chat') return 'deepseek-v4-flash';
  if (provider === 'deepseek' && model === 'deepseek-reasoner') return 'deepseek-v4-pro';
  if (provider === 'xiaomi' && model === 'xiaomi-chat') return 'mimo-v2.5-pro';
  if (provider === 'relay') return normalizeLumiOfficialModel('reasoning', model);
  return model;
}

function resolvePrefs(raw: any, userId?: string): UserLLMPrefs {
  const provider = normalizeProvider(raw?.provider);
  const rawModels = normalizeModels(raw?.models);
  const isLegacySchema = Number(raw?.schemaVersion || 0) < 2;
  const migrationEntries: UserLLMLegacyMigration['entries'] = [];
  const migratedModels = Object.fromEntries(Object.entries(rawModels).map(([candidateProvider, candidateModel]) => {
    const normalizedProvider = normalizeProvider(candidateProvider);
    // Official model placeholders are invalid even in schema-v2 records: an
    // older UI could persist them after the schema migration had run.
    const migrated = normalizedProvider === 'relay'
      ? migrateLegacyModel(normalizedProvider, candidateModel)
      : (isLegacySchema ? migrateLegacyModel(normalizedProvider, candidateModel) : candidateModel);
    if (migrated !== candidateModel) {
      migrationEntries.push({ provider: normalizedProvider, from: candidateModel, to: migrated });
    }
    return [candidateProvider, migrated];
  }));
  const model = migratedModels[provider] || getDefaultModelForProvider(provider, userId);
  const models = { ...migratedModels, [provider]: model };
  const autoFallbackProvider = isCloudLLMProvider(provider, userId)
    ? provider as CloudUserLLMProvider
    : normalizeCloudFallback(raw?.autoFallbackProvider);
  const rawAutoFallbackModel = String(raw?.autoFallbackModel || models[autoFallbackProvider] || getDefaultModelForProvider(autoFallbackProvider, userId));
  const autoFallbackModel = autoFallbackProvider === 'relay'
    ? migrateLegacyModel(autoFallbackProvider, rawAutoFallbackModel)
    : (isLegacySchema ? migrateLegacyModel(autoFallbackProvider, rawAutoFallbackModel) : rawAutoFallbackModel);
  if (autoFallbackModel !== rawAutoFallbackModel) {
    migrationEntries.push({ provider: autoFallbackProvider, from: rawAutoFallbackModel, to: autoFallbackModel });
  }
  models[autoFallbackProvider] = autoFallbackModel;
  const legacyMigration = raw?.legacyMigration && typeof raw.legacyMigration === 'object'
    ? raw.legacyMigration as UserLLMLegacyMigration
    : migrationEntries.length > 0
      ? { migratedAt: new Date().toISOString(), entries: migrationEntries }
      : undefined;
  return {
    schemaVersion: 2,
    provider,
    model,
    models,
    selectionMode: normalizeSelectionMode(raw?.selectionMode, provider),
    fallbackCandidates: normalizeFallbackCandidates(raw?.fallbackCandidates),
    allowCloudFallback: raw?.allowCloudFallback !== false,
    autoFallbackProvider,
    autoFallbackModel,
    ...(legacyMigration ? { legacyMigration } : {}),
    source: 'personal',
  };
}

function persistResolvedPrefs(userId: string, prefs: UserLLMPrefs, updatedAt?: string): void {
  const db = readDB();
  const key = `llm_prefs_${userId || 'anonymous'}`;
  const payload = {
    schemaVersion: 2,
    provider: prefs.provider,
    models: prefs.models,
    selectionMode: prefs.selectionMode,
    fallbackCandidates: prefs.fallbackCandidates,
    allowCloudFallback: prefs.allowCloudFallback,
    autoFallbackProvider: prefs.autoFallbackProvider,
    autoFallbackModel: prefs.autoFallbackModel,
    ...(prefs.legacyMigration ? { legacyMigration: prefs.legacyMigration } : {}),
    updatedAt: updatedAt || new Date().toISOString(),
  };
  if (!db.settings) (db as any).settings = [];
  const index = (db.settings || []).findIndex((setting: any) => setting.key === key);
  if (index >= 0) db.settings[index].value = JSON.stringify(payload);
  else db.settings.push({ key, value: JSON.stringify(payload) });
  writeDB(db);
}

export function getUserPreferredLLM(userId: string, options: { persistMigration?: boolean } = {}): UserLLMPrefs {
  const uid = userId || 'anonymous';
  const raw = parsePrefsRow(`llm_prefs_${uid}`);
  const resolved = resolvePrefs(raw, uid);
  // Legacy aliases are migrated exactly once. New schema writes preserve the
  // user's literal model id, including ids that happen to match old aliases.
  if (options.persistMigration !== false && raw && (Number(raw.schemaVersion || 0) < 2 || resolved.legacyMigration?.entries.some(entry => entry.provider === 'relay'))) {
    persistResolvedPrefs(uid, resolved, raw.updatedAt);
  }
  return resolved;
}

export function upsertUserPreferredLLM(
  userId: string,
  input: {
    provider?: string;
    model?: string;
    models?: Record<string, string>;
    selectionMode?: string;
    fallbackCandidates?: Array<{ provider?: string; model?: string }>;
    allowCloudFallback?: boolean;
    autoFallbackProvider?: string;
    autoFallbackModel?: string;
  },
): UserLLMPrefs {
  const uid = userId || 'anonymous';
  if (!isUserLLMProvider(input.provider, uid)) throw new Error(`Unsupported reasoning provider: ${input.provider || ''}`);
  const current = getUserPreferredLLM(uid);
  const provider = input.provider;
  const models = {
    ...current.models,
    ...normalizeModels(input.models),
  };
  // Schema v2 treats model ids as opaque user choices. Compatibility aliases
  // are only rewritten while reading a pre-v2 row above.
  const requestedModel = String(input.model || models[provider] || getDefaultModelForProvider(provider, uid)).trim().slice(0, 200);
  if (!requestedModel) throw new Error('A reasoning model name is required');
  models[provider] = requestedModel;
  const requestedFallback = input.autoFallbackProvider
    ? normalizeCloudFallback(input.autoFallbackProvider)
    : null;
  if (requestedFallback && !isCloudLLMProvider(requestedFallback, uid)) {
    throw new Error(`Automatic fallback provider must be an active cloud provider: ${requestedFallback}`);
  }
  const autoFallbackProvider = requestedFallback
    || (isCloudLLMProvider(provider, uid)
      ? provider as CloudUserLLMProvider
      : provider === 'auto' && isCloudLLMProvider(current.provider, uid)
        ? current.provider as CloudUserLLMProvider
        : current.autoFallbackProvider);
  const autoFallbackModel = String(
    input.autoFallbackModel
    || models[autoFallbackProvider]
    || current.autoFallbackModel
    || getDefaultModelForProvider(autoFallbackProvider, uid),
  ).trim().slice(0, 200);
  if (!autoFallbackModel) throw new Error('An automatic-mode fallback model is required');
  models[autoFallbackProvider] = autoFallbackModel;
  const selectionMode = normalizeSelectionMode(input.selectionMode || current.selectionMode, provider);
  const fallbackCandidates = input.fallbackCandidates === undefined
    ? current.fallbackCandidates
    : normalizeFallbackCandidates(input.fallbackCandidates);
  if (input.fallbackCandidates !== undefined) {
    const unavailable = fallbackCandidates.find(candidate => !isUserLLMProvider(candidate.provider, uid));
    if (unavailable) throw new Error(`Fallback provider is not active: ${unavailable.provider}`);
  }
  const allowCloudFallback = input.allowCloudFallback === undefined
    ? current.allowCloudFallback
    : input.allowCloudFallback === true;
  const payload = {
    schemaVersion: 2,
    provider,
    models,
    selectionMode,
    fallbackCandidates,
    allowCloudFallback,
    autoFallbackProvider,
    autoFallbackModel,
    ...(current.legacyMigration ? { legacyMigration: current.legacyMigration } : {}),
    updatedAt: new Date().toISOString(),
  };
  const resolved = resolvePrefs(payload, uid);
  persistResolvedPrefs(uid, resolved, payload.updatedAt);
  return resolved;
}

export function getScopedPreferredLLM(
  userId: string,
  _scope: { domain?: string; orgId?: string } = {},
): UserLLMPrefs {
  return getUserPreferredLLM(userId);
}

export function getUserPreferredLLMConfig(
  userId: string,
  options: {
    maxTokens?: number;
    domain?: string;
    orgId?: string;
    source?: string;
    conversationId?: string;
    requestId?: string;
    interactionId?: string;
  } = {},
): {
  provider: UserLLMProvider;
  model: string;
  userId: string;
  selectionMode: UserLLMSelectionMode;
  fallbackCandidates: UserLLMFallbackCandidate[];
  allowCloudFallback: boolean;
  maxTokens?: number;
  domain?: string;
  orgId?: string;
  source?: string;
  conversationId?: string;
  requestId?: string;
  interactionId?: string;
} {
  const pref = getScopedPreferredLLM(userId, { domain: options.domain, orgId: options.orgId });
  return {
    provider: pref.provider,
    model: pref.model,
    userId,
    selectionMode: pref.selectionMode,
    fallbackCandidates: pref.fallbackCandidates.map(candidate => ({ ...candidate })),
    allowCloudFallback: pref.allowCloudFallback,
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
    ...(options.domain ? { domain: options.domain } : {}),
    ...(options.orgId ? { orgId: options.orgId } : {}),
    ...(options.source ? { source: options.source } : {}),
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
    ...(options.interactionId ? { interactionId: options.interactionId } : {}),
  };
}
