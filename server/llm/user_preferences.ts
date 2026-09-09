import { readDB } from '../../db_layer';
import { writeModelPreference } from './model_preference_revision';
import {
  getRegisteredProviderDefaultModel,
  isExtensionProviderId,
  isRegisteredOpenAICompatibleProvider,
  isRegisteredProviderLocal,
} from '../extensions/registry';
import {
  LUMI_OFFICIAL_BASE_URL,
  LUMI_OFFICIAL_DEFAULT_MODELS,
  LUMI_OFFICIAL_REASONING_DEFAULTS_VERSION,
  migrateLumiOfficialReasoningDefault,
  normalizeLumiOfficialModel,
} from '../../shared/model_provider_capabilities';
import { relayBaseUrl } from '../relay/config';

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
  officialDefaultsVersion?: number;
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
  relay: LUMI_OFFICIAL_DEFAULT_MODELS.reasoning,
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
  // Chat and background helpers resolve through the same per-user default.
  // Missing preferences are not authorization to resurrect configured BYOKs.
  return typeof value === 'string' && (VALID_PROVIDERS.has(value as BuiltinUserLLMProvider) || isExtensionProviderId(value))
    ? value as UserLLMProvider
    : 'relay';
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
    : 'relay';
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

/** A custom OpenAI-compatible deployment keeps its own model identifiers. */
function usesOfficialGatewayDefaults(): boolean {
  const base = relayBaseUrl();
  if (!base) return true;
  try { return new URL(base).origin === new URL(LUMI_OFFICIAL_BASE_URL).origin; }
  catch { return false; }
}

function resolvePrefs(raw: any, userId?: string): UserLLMPrefs {
  const provider = normalizeProvider(raw?.provider);
  const rawModels = normalizeModels(raw?.models);
  const legacySelectedModel = typeof raw?.model === 'string' ? raw.model.trim().slice(0, 200) : '';
  if (!rawModels[provider] && legacySelectedModel) rawModels[provider] = legacySelectedModel;
  const isLegacySchema = Number(raw?.schemaVersion || 0) < 2;
  const rawDefaultsVersion = Number(raw?.officialDefaultsVersion || 0);
  const officialDefaultsVersion = Number.isSafeInteger(rawDefaultsVersion) && rawDefaultsVersion >= 0 ? rawDefaultsVersion : 0;
  const migrateOfficialDefaults = usesOfficialGatewayDefaults()
    && officialDefaultsVersion < LUMI_OFFICIAL_REASONING_DEFAULTS_VERSION;
  const officialPrimary = provider === 'relay'
    || (['auto', 'ollama', 'lmstudio'].includes(provider) && raw?.autoFallbackProvider === 'relay');
  // This was an automatically provisioned failed direct route in old official
  // configurations. Independent BYOK selections and local backups stay intact.
  if (migrateOfficialDefaults && officialPrimary && rawModels.qwen === 'qwen-plus') delete rawModels.qwen;
  const migrationEntries: UserLLMLegacyMigration['entries'] = [];
  const migrateOfficial = (model: string) => migrateOfficialDefaults
    ? migrateLumiOfficialReasoningDefault(model)
    : migrateLegacyModel('relay', model);
  const migratedModels = Object.fromEntries(Object.entries(rawModels).map(([candidateProvider, candidateModel]) => {
    const normalizedProvider = normalizeProvider(candidateProvider);
    // Official model placeholders are invalid even in schema-v2 records: an
    // older UI could persist them after the schema migration had run.
    const migrated = normalizedProvider === 'relay'
      ? migrateOfficial(candidateModel)
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
  // A cloud primary is also its auto-mode cloud selection. Do not overwrite
  // its saved model map with a stale duplicate autoFallbackModel field.
  const rawAutoFallbackModel = String(autoFallbackProvider === provider
    ? model
    : raw?.autoFallbackModel || models[autoFallbackProvider] || getDefaultModelForProvider(autoFallbackProvider, userId));
  const autoFallbackModel = autoFallbackProvider === 'relay'
    ? migrateOfficial(rawAutoFallbackModel)
    : (isLegacySchema ? migrateLegacyModel(autoFallbackProvider, rawAutoFallbackModel) : rawAutoFallbackModel);
  if (autoFallbackModel !== rawAutoFallbackModel) {
    migrationEntries.push({ provider: autoFallbackProvider, from: rawAutoFallbackModel, to: autoFallbackModel });
  }
  models[autoFallbackProvider] = autoFallbackModel;
  const fallbackCandidates = normalizeFallbackCandidates(normalizeFallbackCandidates(raw?.fallbackCandidates)
    .filter(candidate => !(migrateOfficialDefaults && officialPrimary
      && candidate.provider === 'qwen' && candidate.model === 'qwen-plus'))
    .map(candidate => {
      const migrated = candidate.provider === 'relay' ? migrateOfficial(candidate.model) : candidate.model;
      if (migrated !== candidate.model) migrationEntries.push({ provider: candidate.provider, from: candidate.model, to: migrated });
      return { ...candidate, model: migrated };
    }))
    .filter(candidate => candidate.provider !== provider || candidate.model !== model);
  const previousMigration = raw?.legacyMigration && typeof raw.legacyMigration === 'object'
    ? raw.legacyMigration as UserLLMLegacyMigration : undefined;
  const legacyMigration = migrationEntries.length > 0
    ? { migratedAt: new Date().toISOString(), entries: [
      ...(Array.isArray(previousMigration?.entries) ? previousMigration.entries : []), ...migrationEntries,
    ] }
    : previousMigration;
  return {
    schemaVersion: 2,
    officialDefaultsVersion: migrateOfficialDefaults
      ? LUMI_OFFICIAL_REASONING_DEFAULTS_VERSION : officialDefaultsVersion,
    provider,
    model,
    models,
    selectionMode: normalizeSelectionMode(raw?.selectionMode, provider),
    fallbackCandidates,
    allowCloudFallback: raw?.allowCloudFallback !== false,
    autoFallbackProvider,
    autoFallbackModel,
    ...(legacyMigration ? { legacyMigration } : {}),
    source: 'personal',
  };
}

function persistResolvedPrefs(userId: string, prefs: UserLLMPrefs, updatedAt?: string): void {
  const key = `llm_prefs_${userId || 'anonymous'}`;
  const payload = {
    schemaVersion: 2,
    officialDefaultsVersion: prefs.officialDefaultsVersion,
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
  writeModelPreference(key, payload, ['reasoning']);
}

export function getUserPreferredLLM(userId: string, options: { persistMigration?: boolean } = {}): UserLLMPrefs {
  const uid = userId || 'anonymous';
  const raw = parsePrefsRow(`llm_prefs_${uid}`);
  const resolved = resolvePrefs(raw, uid);
  // Legacy aliases are migrated exactly once. New schema writes preserve the
  // user's literal model id, including ids that happen to match old aliases.
  if (options.persistMigration !== false && raw && (Number(raw.schemaVersion || 0) < 2
    || Number(raw.officialDefaultsVersion || 0) !== resolved.officialDefaultsVersion
    || JSON.stringify(normalizeModels(raw.models)) !== JSON.stringify(resolved.models)
    || raw.autoFallbackModel !== resolved.autoFallbackModel
    || JSON.stringify(normalizeFallbackCandidates(raw.fallbackCandidates)) !== JSON.stringify(resolved.fallbackCandidates))) {
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
    officialDefaultsVersion: LUMI_OFFICIAL_REASONING_DEFAULTS_VERSION,
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
