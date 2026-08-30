import { flushDBOrThrow } from '../../db_layer';
import { loadKeys } from '../config/keys';
import {
  getRegisteredProviderDefaultModel,
  isRegisteredOpenAICompatibleProvider,
  listRegisteredProviders,
} from '../extensions/registry';
import { getVoicePreference, setVoicePreference } from '../config/voice_preference';
import { getActiveSTTProvider, getActiveStreamingSTTProvider } from '../stt/adapter';
import { getActiveProvider as getActiveTTSProvider } from '../tts/adapter';
import { analyzeScreen } from './adapter';
import { generateConfiguredEmbedding } from './embedding_provider';
import {
  DEFAULT_IMAGE_GENERATION_MODELS,
  DEFAULT_VIDEO_GENERATION_MODELS,
  getUserPreferredGenerationModels,
  isImageGenerationProvider,
  isVideoGenerationProvider,
  upsertUserPreferredGenerationModels,
} from './generation_preferences';
import { ensureLocalModelReady, getLocalModelConfig } from './local_models';
import { makeLLMCall, makeLLMCallDirect } from './providers';
import { dispatchLLMCall } from './dispatch';
import { compileReasoningFailoverCandidates } from './failover_policy';
import { rerankConfiguredDocuments } from './rerank_provider';
import { relayConfigured } from '../relay/config';
import { listOfficialApiModels, type OfficialApiModelCatalog } from './official_api';
import {
  DEFAULT_EMBEDDING_MODELS,
  DEFAULT_RERANK_MODELS,
  getUserRetrievalModelPreferences,
  isEmbeddingFallbackProvider,
  isEmbeddingProvider,
  isRerankProvider,
  upsertUserRetrievalModelPreferences,
} from './retrieval_model_preferences';
import {
  DEFAULT_MODELS,
  getDefaultModelForProvider,
  getUserPreferredLLM,
  isUserLLMProvider,
  upsertUserPreferredLLM,
} from './user_preferences';
import {
  DEFAULT_VISION_MODELS,
  getUserPreferredVision,
  isVisionProvider,
  upsertUserPreferredVision,
} from './vision_preferences';
import {
  DEFAULT_WORLD_MODELS,
  getUserPreferredWorldModel,
  getUserWorldModelPrefs,
  isWorldModelProvider,
  upsertUserWorldModelPrefs,
} from './world_preferences';
import {
  LUMI_MODEL_ROLE_IDS,
  LUMI_OFFICIAL_DEFAULT_MODELS,
  LUMI_OFFICIAL_PROVIDER_ID,
  LUMI_OFFICIAL_ROLE_CAPABILITIES,
  LUMI_OFFICIAL_SUPPORTED_ROLES,
  LUMI_OFFICIAL_UNSUPPORTED_ROLES,
  normalizeLumiOfficialModel,
} from '../../shared/model_provider_capabilities';
import { normalizeVoiceModelId } from '../config/voice_preference';

// Keep the public role list in lockstep with the settings capability manifest.
// A second hand-maintained list previously allowed the UI and runtime to drift.
export const LUMI_MODEL_ROLES = LUMI_MODEL_ROLE_IDS;

export type LumiModelRole = typeof LUMI_MODEL_ROLES[number];

export interface ModelConfigurationUpdate {
  role: LumiModelRole;
  provider?: string;
  model?: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  enabled?: boolean;
  topN?: number;
  selectionMode?: 'pinned' | 'ordered_fallback' | 'auto';
  fallbackCandidates?: Array<{ provider: string; model: string }>;
  allowCloudFallback?: boolean;
}

export interface TestableModelRuntime {
  getDeepSeek?: () => any;
  getGemini?: () => any;
  getOpenAI?: () => any;
  getAnthropic?: () => any;
  getQwen?: () => any;
  getArk?: () => any;
  getOllama?: () => any;
  getLmStudio?: () => any;
  getXiaomi?: () => any;
  getKimi?: () => any;
  getGlm?: () => any;
  getRelay?: () => any;
}

const TESTABLE_LLM_PROVIDERS = new Set([
  'deepseek', 'gemini', 'openai', 'anthropic', 'qwen', 'ark',
  'ollama', 'lmstudio', 'xiaomi', 'kimi', 'glm', 'relay',
]);
const TESTABLE_VISION_PROVIDERS = new Set(['openai', 'gemini', 'ark', 'qwen', 'ollama', 'lmstudio', 'relay']);
const STT_PROVIDERS = new Set(['auto', 'local-whisper', 'qwen', 'ark', 'whisper', 'relay']);
const TTS_PROVIDERS = new Set(['auto', 'local-cosyvoice', 'gptsovits', 'cosyvoice', 'ark', 'relay']);
const VISION_TEST_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAAEUUlEQVR4nO1XbUxbVRiuv7htV27b24pbgdveS4uU7wIDCpN1k7ENNzZhjDFsEOyK3UTFRVjcDB8DNzBZpmxz+FEH6v5sJiQLYW5EiT+2+TUomkiYPyRkBrfMyFdMOvOYc1Qis6VAmTHRkzzpzTnv+zzP+bj3vJVI/m/3NI6zKjiZqU7FiF8opeI0G6JHMCAchIuTmWoJt2S+Fh5qjmIZcShYUX9QSUWPThFj9CnOcVaFUroQcQMhAieLQr5lNwV5Jn1kLGA+I3p8rgQnM9UFSlZLRWjl0XhQYQavsWDkzTu48fYEDJo02kfGSEwgHk5mevFvBlRS4Uu/+xhigEZmpCKr2HiEK5PRfegqRt/1YtTtRfdL12gfGSMxJJbk+N0KRvz8Xv0HWMYw5S+BEIYpzNApk8CrU1Cd34KRDu8c1Gx5lY6RGBJLcvwfTGGKaM6q83wOo2R8O1ZLo2bF9eo0rDZuw+Brv+Cbdu8cfP36DLJMRTTmTxMk16cBxgCiGdAA6dPIo7GKTaCzE7WZ6K0fxfVjXp+42DBGY0gsySG5/ngXZEAtFelMIpTJELSZaCu/gGutXgyfv0t/faGtvBsGTTrN+X0VxKUb4GRGhKsTEalKwbq4SlxqmMTlpml8f9WLvqYZnyAxjya7YNTZ8FBoAuVYsgGN3ISVbDx4dSpaXd/CaipBc9kHGH7vNg4Vn4Et1o61MWVY83ApMk3FSNZvRrpQhBPlg+DVaeAjcihH0AZ22drw1v4ZNJR/hcvNg7g79SvOH7gCm9lOkWXaidXCNqSIBTj8eD/Ouu7gCWszInTZQRqQGREeakH7s7fQUTONk/sm0Vh6DtfdY9iz4QiyTSUUGVGFSBW2Ii92H9z2cXQ5b6PTMQYhcq3P13FRh7Cq4CxOPz+Fk3sn0e6cwOFd36Hrwqeo3duKOlcrHDsOUPEkfjNe2TKA0/ZxvFNxi5qoWvdGcIdQp0rFqZqfZsWPV0zgmP1nOEs7scn6JPKzHVhvKUNi5EYUJrbgeNFNnNj5Azrs43CX/wi34yZ4lWXpBnKT9qOl9AYaikfQsH0ELxcM42D+MGpzB5DFO5GhdyBDcOKR6OfwQvYVHMwZQL1tAI0bh9D8mAdHC4eQZ65eugE2RI+VikSUZZ7BM7ZP4Mrox9MUH6Mk5n3YhEaK7QY3HOZe7LFchCvtEqpTP0JFahd0bHJwX0L2L98DctPlmetRldGHqrR+VFj6sIFvwXq+CZXxPaiM68VTcT3YGnsUWrkZKkbwfxcs1gD7R5JWboJ2RQzS9U5UJvSg1HgOO/Sd2B39IaxhDjpGb8IFcC3aADt7lQq0ACHvt56zQZCuoc+0KJln1stmgF0G/PsMSAIUJMtuQCpMzClIApVkyw1fJZmE1O3/lAGfRSnHWRWkZL7vs5eKnrCwXLlknj8mnvtmgBE9REMyX9Nqc1aQJSL7RKrXZThwUypG/Ixw+p255L/cfgNpjJqDkvhwjQAAAABJRU5ErkJggg==';

const PROVIDER_KEY_NAMES: Record<string, string[]> = {
  deepseek: ['DEEPSEEK_API_KEY'],
  qwen: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  ark: ['ARK_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  kimi: ['KIMI_API_KEY'],
  glm: ['GLM_API_KEY'],
  relay: ['RELAY_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  siliconflow: ['SILICONFLOW_API_KEY'],
  whisper: ['OPENAI_API_KEY'],
  cosyvoice: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
};

function cleanModel(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 200) : '';
}

function officialConfiguredModel(value: unknown, role: LumiModelRole, fallback: string): string {
  const model = normalizeLumiOfficialModel(role, value);
  return model || fallback || LUMI_OFFICIAL_DEFAULT_MODELS[role];
}

function providerConfigured(provider: string, userId?: string): boolean {
  if (provider === 'auto' || provider === 'inherit_vision') return true;
  if (provider === 'ollama' || provider === 'lmstudio') return getLocalModelConfig(provider).detected;
  if (provider === 'local-whisper' || provider === 'local-cosyvoice' || provider === 'gptsovits') return true;
  if (isRegisteredOpenAICompatibleProvider(provider, userId)) {
    return listRegisteredProviders(userId).some(item => item.id === provider && item.configured === true);
  }
  if (provider === 'relay') {
    return relayConfigured();
  }
  const keys = loadKeys();
  return (PROVIDER_KEY_NAMES[provider] || []).some(name => Boolean(process.env[name] || keys[name]));
}

/** Whether the configured Lumi official gateway can be used by the runtime. */
export function isLumiOfficialApiConfigured(userId = 'anonymous'): boolean {
  return providerConfigured(LUMI_OFFICIAL_PROVIDER_ID, userId);
}

function roleSelection(provider: string, model: string, userId: string, extra: Record<string, unknown> = {}) {
  return {
    provider,
    model,
    configured: providerConfigured(provider, userId),
    ...extra,
  };
}

function allRoleConfigurations(userId: string): Record<LumiModelRole, Record<string, unknown>> {
  const reasoning = getUserPreferredLLM(userId);
  const vision = getUserPreferredVision(userId);
  const world = getUserWorldModelPrefs(userId);
  const resolvedWorld = getUserPreferredWorldModel(userId);
  const generation = getUserPreferredGenerationModels(userId);
  const retrieval = getUserRetrievalModelPreferences(userId);
  const voice = getVoicePreference();
  const activeStreamingStt = getActiveStreamingSTTProvider({ requireHealthy: true });
  const activeStt = activeStreamingStt || getActiveSTTProvider({ requireHealthy: true });
  const activeTts = getActiveTTSProvider({ requireHealthy: true });

  return {
    reasoning: roleSelection(reasoning.provider, reasoning.model, userId, {
      configured: providerConfigured(reasoning.provider, userId),
      selectionMode: reasoning.selectionMode,
      fallbackCandidates: reasoning.fallbackCandidates,
      allowCloudFallback: reasoning.allowCloudFallback,
      legacyMigration: reasoning.legacyMigration,
    }),
    vision: roleSelection(vision.provider, vision.model, userId, {
      configured: providerConfigured(vision.provider, userId),
    }),
    world: roleSelection(world.provider, world.model, userId, {
      effectiveProvider: resolvedWorld.provider,
      effectiveModel: resolvedWorld.model,
      inheritedFromVision: resolvedWorld.inheritedFromVision,
      configured: providerConfigured(resolvedWorld.provider, userId),
    }),
    image_generation: roleSelection(generation.image.provider, generation.image.model, userId, {
      configured: generation.image.provider === 'auto'
        ? ['openai', 'qwen', 'siliconflow', LUMI_OFFICIAL_PROVIDER_ID].some(provider => providerConfigured(provider, userId))
        : providerConfigured(generation.image.provider, userId),
    }),
    video_generation: roleSelection(generation.video.provider, generation.video.model, userId, {
      configured: providerConfigured(generation.video.provider, userId),
    }),
    embedding: roleSelection(retrieval.embedding.provider, retrieval.embedding.model, userId, {
      fallbackProvider: retrieval.embedding.fallbackProvider,
      fallbackModel: retrieval.embedding.fallbackModel,
      fallbackConfigured: retrieval.embedding.fallbackProvider
        ? providerConfigured(retrieval.embedding.fallbackProvider, userId)
        : false,
    }),
    rerank: roleSelection(retrieval.rerank.provider, retrieval.rerank.model, userId, {
      enabled: retrieval.rerank.enabled,
      topN: retrieval.rerank.topN,
      configured: providerConfigured(retrieval.rerank.provider, userId),
    }),
    speech_recognition: roleSelection(voice.stt, voice.stt === LUMI_OFFICIAL_PROVIDER_ID
      ? (voice.sttModel || LUMI_OFFICIAL_DEFAULT_MODELS.speech_recognition)
      : '', userId, {
      effectiveProvider: activeStt,
      configured: voice.stt === LUMI_OFFICIAL_PROVIDER_ID
        ? providerConfigured(LUMI_OFFICIAL_PROVIDER_ID, userId)
        : Boolean(activeStt),
      realtimeSupported: Boolean(activeStreamingStt),
      batchOnly: voice.stt === LUMI_OFFICIAL_PROVIDER_ID && !activeStreamingStt,
      providerManagedModel: false,
    }),
    speech_synthesis: roleSelection(voice.tts, voice.tts === LUMI_OFFICIAL_PROVIDER_ID
      ? (voice.ttsModel || LUMI_OFFICIAL_DEFAULT_MODELS.speech_synthesis)
      : '', userId, {
      effectiveProvider: activeTts,
      configured: voice.tts === LUMI_OFFICIAL_PROVIDER_ID
        ? providerConfigured(LUMI_OFFICIAL_PROVIDER_ID, userId)
        : Boolean(activeTts),
      providerManagedModel: false,
    }),
  };
}

export function isLumiModelRole(value: unknown): value is LumiModelRole {
  return typeof value === 'string' && (LUMI_MODEL_ROLES as readonly string[]).includes(value);
}

export function getLumiModelConfiguration(userId: string, role?: LumiModelRole) {
  const roles = allRoleConfigurations(userId || 'anonymous');
  const base = {
    scope: 'lumi',
    sharedAcrossPersonalAndOrganizationDomains: true,
    organizationOverridesSupported: false,
    officialApi: {
      provider: LUMI_OFFICIAL_PROVIDER_ID,
      configured: isLumiOfficialApiConfigured(userId || 'anonymous'),
      supportedRoles: [...LUMI_OFFICIAL_SUPPORTED_ROLES],
      unavailableRoles: [...LUMI_OFFICIAL_UNSUPPORTED_ROLES],
    },
  };
  return role
    ? { ...base, role, configuration: roles[role] }
    : { ...base, roles };
}

export interface OfficialModelConfigurationRoleReceipt {
  role: LumiModelRole;
  provider: string;
  model: string;
  status: 'applied' | 'skipped';
  reason?: 'adapter_not_available' | 'official_api_not_configured';
}

export interface OfficialModelConfigurationApplyResult {
  ok: true;
  provider: typeof LUMI_OFFICIAL_PROVIDER_ID;
  /** The live catalog was read before all selected roles were persisted. */
  verification: 'catalog_verified_and_configuration_persisted';
  catalog: { modelCount: number; roleCount: number };
  applied: OfficialModelConfigurationRoleReceipt[];
  skipped: OfficialModelConfigurationRoleReceipt[];
  roles: Record<LumiModelRole, OfficialModelConfigurationRoleReceipt>;
  configuration: ReturnType<typeof getLumiModelConfiguration>;
}

function officialModelForRole(userId: string, role: LumiModelRole): string {
  const envName: Record<LumiModelRole, string> = {
    reasoning: 'RELAY_REASONING_MODEL',
    vision: 'RELAY_VISION_MODEL',
    world: 'RELAY_WORLD_MODEL',
    image_generation: 'RELAY_IMAGE_MODEL',
    video_generation: 'RELAY_VIDEO_MODEL',
    embedding: 'RELAY_EMBEDDING_MODEL',
    rerank: 'RELAY_RERANK_MODEL',
    speech_recognition: 'RELAY_STT_MODEL',
    speech_synthesis: 'RELAY_TTS_MODEL',
  };
  // Voice model selections are persisted in the voice preference and must
  // win over a legacy deployment env value; otherwise the UI can appear to
  // save one model while every realtime request silently uses another.
  if (role === 'speech_recognition') {
    const voice = getVoicePreference();
    if (voice.stt === LUMI_OFFICIAL_PROVIDER_ID && voice.sttModel) {
      return officialConfiguredModel(voice.sttModel, role, LUMI_OFFICIAL_DEFAULT_MODELS[role]);
    }
  }
  if (role === 'speech_synthesis') {
    const voice = getVoicePreference();
    if (voice.tts === LUMI_OFFICIAL_PROVIDER_ID && voice.ttsModel) {
      return officialConfiguredModel(voice.ttsModel, role, LUMI_OFFICIAL_DEFAULT_MODELS[role]);
    }
  }
  const configured = cleanModel(process.env[envName[role]]);
  if (configured) return officialConfiguredModel(configured, role, LUMI_OFFICIAL_DEFAULT_MODELS[role]);

  switch (role) {
    case 'reasoning': {
      const preference = getUserPreferredLLM(userId);
      return officialConfiguredModel(
        preference.provider === LUMI_OFFICIAL_PROVIDER_ID
          ? (preference.model || preference.models[LUMI_OFFICIAL_PROVIDER_ID])
          : preference.models[LUMI_OFFICIAL_PROVIDER_ID],
        role,
        DEFAULT_MODELS[LUMI_OFFICIAL_PROVIDER_ID],
      );
    }
    case 'vision': {
      const preference = getUserPreferredVision(userId);
      return officialConfiguredModel(
        preference.provider === LUMI_OFFICIAL_PROVIDER_ID
          ? (preference.model || preference.models[LUMI_OFFICIAL_PROVIDER_ID])
          : preference.models[LUMI_OFFICIAL_PROVIDER_ID],
        role,
        DEFAULT_VISION_MODELS[LUMI_OFFICIAL_PROVIDER_ID],
      );
    }
    case 'world': {
      const preference = getUserWorldModelPrefs(userId);
      return officialConfiguredModel(
        preference.provider === LUMI_OFFICIAL_PROVIDER_ID
          ? (preference.model || preference.models[LUMI_OFFICIAL_PROVIDER_ID])
          : preference.models[LUMI_OFFICIAL_PROVIDER_ID],
        role,
        DEFAULT_WORLD_MODELS[LUMI_OFFICIAL_PROVIDER_ID],
      );
    }
    case 'embedding': {
      const preference = getUserRetrievalModelPreferences(userId);
      return officialConfiguredModel(
        preference.embedding.provider === LUMI_OFFICIAL_PROVIDER_ID ? preference.embedding.model : '',
        role,
        DEFAULT_EMBEDDING_MODELS[LUMI_OFFICIAL_PROVIDER_ID],
      );
    }
    case 'image_generation': {
      const preference = getUserPreferredGenerationModels(userId).image;
      return officialConfiguredModel(
        preference.provider === LUMI_OFFICIAL_PROVIDER_ID ? preference.model : '',
        role,
        DEFAULT_IMAGE_GENERATION_MODELS[LUMI_OFFICIAL_PROVIDER_ID],
      );
    }
    case 'video_generation': {
      const preference = getUserPreferredGenerationModels(userId).video;
      return officialConfiguredModel(
        preference.provider === LUMI_OFFICIAL_PROVIDER_ID ? preference.model : '',
        role,
        DEFAULT_VIDEO_GENERATION_MODELS[LUMI_OFFICIAL_PROVIDER_ID],
      );
    }
    case 'rerank': {
      const preference = getUserRetrievalModelPreferences(userId).rerank;
      return officialConfiguredModel(
        preference.provider === LUMI_OFFICIAL_PROVIDER_ID ? preference.model : '',
        role,
        DEFAULT_RERANK_MODELS[LUMI_OFFICIAL_PROVIDER_ID],
      );
    }
    case 'speech_recognition':
      return officialConfiguredModel(getVoicePreference().sttModel, role, LUMI_OFFICIAL_DEFAULT_MODELS[role]);
    case 'speech_synthesis':
      return officialConfiguredModel(getVoicePreference().ttsModel, role, LUMI_OFFICIAL_DEFAULT_MODELS[role]);
  }
}

function restoreModelConfigurationSnapshot(
  userId: string,
  snapshot: {
    reasoning: ReturnType<typeof getUserPreferredLLM>;
    vision: ReturnType<typeof getUserPreferredVision>;
    world: ReturnType<typeof getUserWorldModelPrefs>;
    generation: ReturnType<typeof getUserPreferredGenerationModels>;
    retrieval: ReturnType<typeof getUserRetrievalModelPreferences>;
    voice: ReturnType<typeof getVoicePreference>;
  },
): void {
  // Best effort rollback. Each preference writer is synchronous from the
  // caller's perspective and writeDB coalesces the resulting snapshot flush.
  try {
    upsertUserPreferredLLM(userId, {
      provider: snapshot.reasoning.provider,
      model: snapshot.reasoning.model,
      models: snapshot.reasoning.models,
      selectionMode: snapshot.reasoning.selectionMode,
      fallbackCandidates: snapshot.reasoning.fallbackCandidates,
      allowCloudFallback: snapshot.reasoning.allowCloudFallback,
      autoFallbackProvider: snapshot.reasoning.autoFallbackProvider,
      autoFallbackModel: snapshot.reasoning.autoFallbackModel,
    });
  } catch {}
  try {
    upsertUserPreferredVision(userId, {
      provider: snapshot.vision.provider,
      model: snapshot.vision.model,
      models: snapshot.vision.models,
    });
  } catch {}
  try {
    upsertUserWorldModelPrefs(userId, snapshot.world);
  } catch {}
  try {
    upsertUserPreferredGenerationModels(userId, snapshot.generation);
  } catch {}
  try {
    upsertUserRetrievalModelPreferences(userId, snapshot.retrieval);
  } catch {}
  try {
    setVoicePreference(snapshot.voice);
  } catch {}
}

/**
 * Apply the configured Lumi official API to every model role in one atomic
 * server-side operation. The role manifest is intentionally authoritative:
 * if a future build removes an adapter it will be reported as skipped instead
 * of being silently presented as applied. The operation rolls back on an
 * unexpected persistence/validation error so a click cannot leave a half-
 * adapted setup.
 */
export async function applyLumiOfficialModelConfiguration(
  userId: string,
  options: { catalog?: OfficialApiModelCatalog } = {},
): Promise<OfficialModelConfigurationApplyResult> {
  const uid = userId || 'anonymous';
  if (!isLumiOfficialApiConfigured(uid)) {
    throw new Error('Lumi Official API is not configured. Set RELAY_API_KEY and RELAY_BASE_URL in Settings > AI Providers > Official.');
  }

  // A saved key/base URL is not proof that any selected model still exists.
  // Read the current gateway catalog before changing preferences so one-click
  // adaptation cannot persist stale or capability-incompatible model ids.
  const catalog = options.catalog || await listOfficialApiModels();
  if (catalog.models.length === 0) {
    throw new Error('Lumi Official API returned an empty model catalog. No role configuration was changed.');
  }

  const current = allRoleConfigurations(uid);
  const snapshot = {
    reasoning: getUserPreferredLLM(uid),
    vision: getUserPreferredVision(uid),
    world: getUserWorldModelPrefs(uid),
    generation: getUserPreferredGenerationModels(uid),
    retrieval: getUserRetrievalModelPreferences(uid),
    voice: getVoicePreference(),
  };
  const applied: OfficialModelConfigurationRoleReceipt[] = [];
  const skipped: OfficialModelConfigurationRoleReceipt[] = [];

  for (const role of LUMI_MODEL_ROLES) {
    if (!LUMI_OFFICIAL_ROLE_CAPABILITIES[role]) {
      const existing = current[role];
      skipped.push({
        role,
        provider: String(existing?.provider || existing?.effectiveProvider || ''),
        model: String(existing?.model || existing?.effectiveModel || ''),
        status: 'skipped',
        reason: 'adapter_not_available',
      });
      continue;
    }

    const availableModels = catalog.byRole[role] || [];
    const configuredModel = officialModelForRole(uid, role);
    const model = availableModels.includes(configuredModel)
      ? configuredModel
      : availableModels.includes(LUMI_OFFICIAL_DEFAULT_MODELS[role])
        ? LUMI_OFFICIAL_DEFAULT_MODELS[role]
        : availableModels[0];
    if (!model) {
      restoreModelConfigurationSnapshot(uid, snapshot);
      throw new Error(`Lumi Official API catalog has no compatible model for ${role}. No role configuration was changed.`);
    }
    try {
      const update: ModelConfigurationUpdate = {
        role,
        provider: LUMI_OFFICIAL_PROVIDER_ID,
      };
      update.model = model;
      updateLumiModelConfiguration(uid, update);
      applied.push({
        role,
        provider: LUMI_OFFICIAL_PROVIDER_ID,
        model,
        status: 'applied',
      });
    } catch (error: any) {
      restoreModelConfigurationSnapshot(uid, snapshot);
      try { await flushDBOrThrow(); } catch {}
      const detail = String(error?.message || error || 'unknown configuration error').slice(0, 240);
      throw new Error(`Official API adaptation failed for ${role}: ${detail}`);
    }
  }

  // Preference writers coalesce snapshots for performance. The one-click
  // operation is an explicit durability boundary, so do not report success
  // until every role is on disk.
  try {
    await flushDBOrThrow();
  } catch (error: any) {
    restoreModelConfigurationSnapshot(uid, snapshot);
    try { await flushDBOrThrow(); } catch {}
    throw new Error(`Official API adaptation could not be persisted: ${String(error?.message || error).slice(0, 240)}`);
  }

  return {
    ok: true,
    provider: LUMI_OFFICIAL_PROVIDER_ID,
    verification: 'catalog_verified_and_configuration_persisted',
    catalog: {
      modelCount: catalog.models.length,
      roleCount: Object.keys(catalog.byRole).length,
    },
    applied,
    skipped,
    roles: Object.fromEntries([...applied, ...skipped].map(receipt => [receipt.role, receipt])) as Record<LumiModelRole, OfficialModelConfigurationRoleReceipt>,
    configuration: getLumiModelConfiguration(uid),
  };
}

export function updateLumiModelConfiguration(userId: string, input: ModelConfigurationUpdate) {
  const uid = userId || 'anonymous';
  if (!isLumiModelRole(input.role)) throw new Error(`Unsupported model role: ${input.role || ''}`);

  if (input.role === 'reasoning') {
    const current = getUserPreferredLLM(uid);
    const provider = input.provider || current.provider;
    if (!isUserLLMProvider(provider, uid)) throw new Error(`Unsupported reasoning provider: ${provider}`);
    const model = cleanModel(input.model) || current.models[provider] || getDefaultModelForProvider(provider, uid);
    upsertUserPreferredLLM(uid, {
      provider,
      model,
      models: { ...current.models, [provider]: model },
      selectionMode: input.selectionMode || current.selectionMode,
      fallbackCandidates: input.fallbackCandidates || current.fallbackCandidates,
      allowCloudFallback: input.allowCloudFallback === undefined
        ? current.allowCloudFallback
        : input.allowCloudFallback,
    });
  } else if (input.role === 'vision') {
    const current = getUserPreferredVision(uid);
    const provider = input.provider || current.provider;
    if (!isVisionProvider(provider)) throw new Error(`Unsupported vision provider: ${provider}`);
    const model = cleanModel(input.model) || current.models[provider] || DEFAULT_VISION_MODELS[provider];
    upsertUserPreferredVision(uid, { provider, model, models: { ...current.models, [provider]: model } });
  } else if (input.role === 'world') {
    const current = getUserWorldModelPrefs(uid);
    const provider = input.provider || current.provider;
    if (!isWorldModelProvider(provider)) throw new Error(`Unsupported world provider: ${provider}`);
    const model = provider === 'inherit_vision' ? '' : cleanModel(input.model) || current.models[provider] || current.model;
    upsertUserWorldModelPrefs(uid, {
      provider,
      model,
      models: provider === 'inherit_vision' ? current.models : { ...current.models, [provider]: model },
    });
  } else if (input.role === 'image_generation' || input.role === 'video_generation') {
    const current = getUserPreferredGenerationModels(uid);
    if (input.role === 'image_generation') {
      const provider = input.provider || current.image.provider;
      if (!isImageGenerationProvider(provider)) throw new Error(`Unsupported image provider: ${provider}`);
      const model = provider === 'auto'
        ? cleanModel(input.model)
        : cleanModel(input.model) || current.image.models[provider] || DEFAULT_IMAGE_GENERATION_MODELS[provider];
      current.image = {
        provider,
        model,
        models: provider === 'auto' ? current.image.models : { ...current.image.models, [provider]: model },
      };
    } else {
      const provider = input.provider || current.video.provider;
      if (!isVideoGenerationProvider(provider)) throw new Error(`Unsupported video provider: ${provider}`);
      const model = cleanModel(input.model) || current.video.models[provider] || DEFAULT_VIDEO_GENERATION_MODELS[provider];
      current.video = { provider, model, models: { ...current.video.models, [provider]: model } };
    }
    upsertUserPreferredGenerationModels(uid, current);
  } else if (input.role === 'embedding' || input.role === 'rerank') {
    const current = getUserRetrievalModelPreferences(uid);
    if (input.role === 'embedding') {
      const provider = input.provider || current.embedding.provider;
      const fallbackProvider = input.fallbackProvider === undefined
        ? current.embedding.fallbackProvider
        : input.fallbackProvider;
      if (!isEmbeddingProvider(provider)) throw new Error(`Unsupported embedding provider: ${provider}`);
      if (!isEmbeddingFallbackProvider(fallbackProvider)) throw new Error(`Unsupported embedding fallback provider: ${fallbackProvider}`);
      current.embedding = {
        provider,
        model: cleanModel(input.model)
          || (provider === current.embedding.provider ? current.embedding.model : DEFAULT_EMBEDDING_MODELS[provider]),
        fallbackProvider,
        fallbackModel: fallbackProvider
          ? cleanModel(input.fallbackModel)
            || (fallbackProvider === current.embedding.fallbackProvider
              ? current.embedding.fallbackModel
              : DEFAULT_EMBEDDING_MODELS[fallbackProvider])
          : '',
      };
    } else {
      const provider = input.provider || current.rerank.provider;
      if (!isRerankProvider(provider)) throw new Error(`Unsupported rerank provider: ${provider}`);
      current.rerank = {
        enabled: input.enabled === undefined ? current.rerank.enabled : input.enabled,
        provider,
        model: cleanModel(input.model)
          || (provider === current.rerank.provider ? current.rerank.model : DEFAULT_RERANK_MODELS[provider]),
        topN: input.topN === undefined ? current.rerank.topN : input.topN,
      };
    }
    upsertUserRetrievalModelPreferences(uid, current);
  } else {
    const current = getVoicePreference();
    const provider = input.provider || (input.role === 'speech_recognition' ? current.stt : current.tts);
    const requestedModel = cleanModel(input.model);
    if (input.role === 'speech_recognition') {
      if (!STT_PROVIDERS.has(provider)) throw new Error(`Unsupported speech recognition provider: ${provider}`);
      if (requestedModel && provider !== LUMI_OFFICIAL_PROVIDER_ID) {
        throw new Error('Speech model selection is only supported by Lumi Official API.');
      }
      if (requestedModel && !normalizeVoiceModelId(requestedModel)) {
        throw new Error('Speech model must use a provider/model identifier.');
      }
      setVoicePreference({
        stt: provider as any,
        ...(provider === LUMI_OFFICIAL_PROVIDER_ID
          ? { sttModel: normalizeVoiceModelId(requestedModel) || current.sttModel || LUMI_OFFICIAL_DEFAULT_MODELS.speech_recognition }
          : {}),
      });
    } else {
      if (!TTS_PROVIDERS.has(provider)) throw new Error(`Unsupported speech synthesis provider: ${provider}`);
      if (requestedModel && provider !== LUMI_OFFICIAL_PROVIDER_ID) {
        throw new Error('Speech model selection is only supported by Lumi Official API.');
      }
      if (requestedModel && !normalizeVoiceModelId(requestedModel)) {
        throw new Error('Speech model must use a provider/model identifier.');
      }
      setVoicePreference({
        tts: provider as any,
        ...(provider === LUMI_OFFICIAL_PROVIDER_ID
          ? { ttsModel: normalizeVoiceModelId(requestedModel) || current.ttsModel || LUMI_OFFICIAL_DEFAULT_MODELS.speech_synthesis }
          : {}),
      });
    }
  }

  return getLumiModelConfiguration(uid, input.role);
}

async function withConnectionTestTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Connection test timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function testLLMProviderConnection(
  provider: string,
  requestedModel: string | undefined,
  llm: TestableModelRuntime,
  userId = 'anonymous',
): Promise<{ ok: true; provider: string; model: string; latencyMs: number }> {
  const extensionProvider = isRegisteredOpenAICompatibleProvider(provider, userId);
  if (!TESTABLE_LLM_PROVIDERS.has(provider) && !extensionProvider) throw new Error(`Unsupported provider: ${provider}`);
  const localConfig = provider === 'ollama' || provider === 'lmstudio'
    ? getLocalModelConfig(provider)
    : null;
  let model = String(requestedModel || localConfig?.models.find(modelName => !/(?:embed|whisper|rerank)/i.test(modelName)) || getRegisteredProviderDefaultModel(provider, userId) || (DEFAULT_MODELS as Record<string, string>)[provider] || '').trim();
  if (!model || model.length > 200) throw new Error('A valid model name is required');

  const startedAt = Date.now();
  if (provider === 'ollama' || provider === 'lmstudio') {
    const selection = await ensureLocalModelReady(provider, requestedModel, { force: true, timeoutMs: 8_000 });
    model = selection.model;
  }
  const controller = new AbortController();
  try {
    // Exercise the exact production adapter and request formatter. A raw SDK
    // probe can look healthy while the real Lumi route fails because it omits
    // provider-specific request fields, privacy gates, or local supervision.
    await withConnectionTestTimeout(makeLLMCallDirect(
      [{ role: 'user', content: 'Reply with only OK.' }],
      [],
      {
        provider: provider as any,
        model,
        userId,
        selectionMode: 'pinned',
        maxTokens: 8,
        noImplicitFailover: true,
        authorizedRoutingCandidate: true,
        signal: controller.signal,
      },
      llm.getDeepSeek || (() => null),
      llm.getGemini || (() => null),
      llm.getOpenAI,
      llm.getAnthropic,
      llm.getQwen,
      llm.getOllama,
      llm.getLmStudio,
      llm.getArk,
      llm.getXiaomi,
      llm.getKimi,
      llm.getGlm,
      llm.getRelay,
    ), provider === 'ollama' || provider === 'lmstudio' ? 45_000 : 20_000);
  } finally {
    controller.abort();
  }

  return { ok: true, provider, model, latencyMs: Date.now() - startedAt };
}

export async function testVisionProviderConnection(
  provider: string,
  model: string,
  llm: TestableModelRuntime,
): Promise<{ ok: true; provider: string; model: string; latencyMs: number }> {
  if (!TESTABLE_VISION_PROVIDERS.has(provider)) throw new Error(`Unsupported vision provider: ${provider}`);
  if (!model.trim() || model.length > 200) throw new Error('A valid vision model name is required');
  const startedAt = Date.now();
  await withConnectionTestTimeout(analyzeScreen(
    VISION_TEST_IMAGE_BASE64,
    'Confirm that you received the image. Reply with only OK.',
    { provider: provider as any, model, maxTokens: 24 },
    llm.getDeepSeek,
    llm.getGemini,
    llm.getOpenAI,
    llm.getAnthropic,
    llm.getQwen,
    llm.getOllama,
    llm.getLmStudio,
    llm.getArk,
    llm.getXiaomi,
    llm.getKimi,
    llm.getGlm,
    llm.getRelay,
  ), provider === 'ollama' || provider === 'lmstudio' ? 60_000 : 30_000);
  return { ok: true, provider, model, latencyMs: Date.now() - startedAt };
}

export async function testLumiModelConfiguration(
  userId: string,
  role: LumiModelRole,
  llm: TestableModelRuntime = {},
): Promise<Record<string, unknown>> {
  const uid = userId || 'anonymous';
  const config = allRoleConfigurations(uid)[role];
  const startedAt = Date.now();

  if (role === 'reasoning') {
    const preference = getUserPreferredLLM(uid);
    if (preference.selectionMode !== 'pinned') {
      const result = await makeLLMCall(
        [{ role: 'user', content: 'Reply with only OK.' }],
        [],
        {
          provider: preference.provider,
          model: preference.model,
          userId: uid,
          selectionMode: preference.selectionMode,
          fallbackCandidates: preference.fallbackCandidates,
          allowCloudFallback: preference.allowCloudFallback,
          maxTokens: 8,
        },
        llm.getDeepSeek || (() => null),
        llm.getGemini || (() => null),
        llm.getOpenAI,
        llm.getAnthropic,
        llm.getQwen,
        llm.getOllama,
        llm.getLmStudio,
        llm.getArk,
        llm.getXiaomi,
        llm.getKimi,
        llm.getGlm,
        llm.getRelay,
      );
      return {
        ok: true,
        requestedProvider: preference.provider,
        requestedModel: preference.model,
        provider: result.routing?.selectedProvider || preference.provider,
        model: result.routing?.selectedModel || preference.model,
        selectionMode: preference.selectionMode,
        fallbackReason: result.routing?.fallbackReason || '',
        attempts: result.routing?.attempts || [],
        latencyMs: Date.now() - startedAt,
        verification: 'live_routed_model_call',
      };
    }
    return testLLMProviderConnection(String(config.provider), String(config.model), llm, uid);
  }
  if (role === 'vision' || role === 'world') {
    const provider = role === 'world' ? String(config.effectiveProvider) : String(config.provider);
    const model = role === 'world' ? String(config.effectiveModel) : String(config.model);
    return testVisionProviderConnection(provider, model, llm);
  }
  if (role === 'embedding') {
    const result = await generateConfiguredEmbedding('Lumi model configuration test', uid);
    return {
      ok: true,
      provider: result.provider,
      model: result.model,
      dimensions: result.vector.length,
      latencyMs: Date.now() - startedAt,
      verification: 'live_model_call',
    };
  }
  if (role === 'rerank') {
    if (config.enabled !== true) {
      return { ok: true, enabled: false, verification: 'configuration', note: 'Rerank is disabled.' };
    }
    const result = await rerankConfiguredDocuments(
      'Which document is about model configuration?',
      ['This document describes weather.', 'This document describes model configuration.'],
      uid,
      1,
    );
    return {
      ok: true,
      provider: result.provider,
      model: result.model,
      latencyMs: Date.now() - startedAt,
      verification: 'live_model_call',
    };
  }
  if (role === 'speech_recognition' || role === 'speech_synthesis') {
    const effectiveProvider = String(config.effectiveProvider || '');
    if (!effectiveProvider) throw new Error(`No healthy ${role === 'speech_recognition' ? 'STT' : 'TTS'} provider is available`);
    return {
      ok: true,
      provider: config.provider,
      effectiveProvider,
      // This endpoint does not spend credits or fabricate an audio sample.
      // Report adapter readiness honestly; live speech remains a separate
      // microphone/file or synthesis acceptance test.
      verification: 'configured_adapter',
      liveMediaVerified: false,
      latencyMs: Date.now() - startedAt,
    };
  }

  if (config.configured !== true) throw new Error(`${String(config.provider)} is not configured`);
  return {
    ok: true,
    provider: config.provider,
    model: config.model,
    verification: 'adapter_and_credentials',
    artifactGenerated: false,
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * Local-admin diagnostic for the real reasoning failover path. It never
 * changes preferences. The synthetic primary is rejected locally before any
 * network request; an authorized alternate candidate must then complete a
 * real, bounded model call through the production dispatcher. The successful
 * candidate receives only the same health accounting as an ordinary call.
 */
export async function testLumiModelFailoverConfiguration(
  userId: string,
  llm: TestableModelRuntime = {},
): Promise<Record<string, unknown>> {
  const uid = userId || 'anonymous';
  const preference = getUserPreferredLLM(uid);
  const fallbackCandidates = compileReasoningFailoverCandidates({
    primaryProvider: preference.provider,
    primaryModel: preference.model,
    explicitCandidates: preference.fallbackCandidates,
    preferences: preference,
  });
  if (fallbackCandidates.length === 0) {
    throw new Error('No authorized alternate reasoning model is configured for the failover probe');
  }
  const startedAt = Date.now();
  const result = await dispatchLLMCall(
    [{ role: 'user', content: 'Reply with only OK.' }],
    [],
    {
      provider: '__lumi_forced_unavailable_primary__',
      model: '__lumi_forced_unavailable_model__',
      requestedProvider: preference.provider,
      requestedModel: preference.model,
      userId: uid,
      selectionMode: 'ordered_fallback',
      fallbackCandidates,
      allowCloudFallback: preference.allowCloudFallback,
      maxTokens: 8,
    },
    {
      getDeepSeek: llm.getDeepSeek || (() => null),
      getGemini: llm.getGemini || (() => null),
      getOpenAI: llm.getOpenAI || (() => null),
      getAnthropic: llm.getAnthropic || (() => null),
      getQwen: llm.getQwen || (() => null),
      getOllama: llm.getOllama || (() => null),
      getLmStudio: llm.getLmStudio || (() => null),
      getArk: llm.getArk || (() => null),
      getXiaomi: llm.getXiaomi || (() => null),
      getKimi: llm.getKimi || (() => null),
      getGlm: llm.getGlm || (() => null),
      getRelay: llm.getRelay || (() => null),
    },
  );
  return {
    ok: true,
    requestedProvider: result.routing.requestedProvider,
    requestedModel: result.routing.requestedModel,
    provider: result.routing.selectedProvider,
    model: result.routing.selectedModel,
    selectionMode: result.routing.selectionMode,
    fallbackReason: result.routing.fallbackReason,
    attempts: result.routing.attempts,
    latencyMs: Date.now() - startedAt,
    verification: 'live_forced_primary_failure_failover',
  };
}
