import { loadKeys } from '../config/keys';
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
import { getLocalModelConfig } from './local_models';
import { rerankConfiguredDocuments } from './rerank_provider';
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
  getUserPreferredWorldModel,
  getUserWorldModelPrefs,
  isWorldModelProvider,
  upsertUserWorldModelPrefs,
} from './world_preferences';

export const LUMI_MODEL_ROLES = [
  'reasoning',
  'vision',
  'world',
  'image_generation',
  'video_generation',
  'embedding',
  'rerank',
  'speech_recognition',
  'speech_synthesis',
] as const;

export type LumiModelRole = typeof LUMI_MODEL_ROLES[number];

export interface ModelConfigurationUpdate {
  role: LumiModelRole;
  provider?: string;
  model?: string;
  fallbackProvider?: string;
  fallbackModel?: string;
  enabled?: boolean;
  topN?: number;
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
const STT_PROVIDERS = new Set(['auto', 'local-whisper', 'qwen', 'ark', 'whisper']);
const TTS_PROVIDERS = new Set(['auto', 'local-cosyvoice', 'gptsovits', 'cosyvoice', 'ark']);
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

function providerConfigured(provider: string): boolean {
  if (provider === 'auto' || provider === 'inherit_vision') return true;
  if (provider === 'ollama' || provider === 'lmstudio') return getLocalModelConfig(provider).detected;
  if (provider === 'local-whisper' || provider === 'local-cosyvoice' || provider === 'gptsovits') return true;
  const keys = loadKeys();
  return (PROVIDER_KEY_NAMES[provider] || []).some(name => Boolean(process.env[name] || keys[name]));
}

function roleSelection(provider: string, model: string, extra: Record<string, unknown> = {}) {
  return {
    provider,
    model,
    configured: providerConfigured(provider),
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
  const activeStt = getActiveStreamingSTTProvider({ requireHealthy: true })
    || getActiveSTTProvider({ requireHealthy: true });
  const activeTts = getActiveTTSProvider({ requireHealthy: true });

  return {
    reasoning: roleSelection(reasoning.provider, reasoning.model),
    vision: roleSelection(vision.provider, vision.model),
    world: roleSelection(world.provider, world.model, {
      effectiveProvider: resolvedWorld.provider,
      effectiveModel: resolvedWorld.model,
      inheritedFromVision: resolvedWorld.inheritedFromVision,
      configured: providerConfigured(resolvedWorld.provider),
    }),
    image_generation: roleSelection(generation.image.provider, generation.image.model, {
      configured: generation.image.provider === 'auto'
        ? ['openai', 'qwen', 'siliconflow'].some(providerConfigured)
        : providerConfigured(generation.image.provider),
    }),
    video_generation: roleSelection(generation.video.provider, generation.video.model),
    embedding: roleSelection(retrieval.embedding.provider, retrieval.embedding.model, {
      fallbackProvider: retrieval.embedding.fallbackProvider,
      fallbackModel: retrieval.embedding.fallbackModel,
      fallbackConfigured: retrieval.embedding.fallbackProvider
        ? providerConfigured(retrieval.embedding.fallbackProvider)
        : false,
    }),
    rerank: roleSelection(retrieval.rerank.provider, retrieval.rerank.model, {
      enabled: retrieval.rerank.enabled,
      topN: retrieval.rerank.topN,
    }),
    speech_recognition: roleSelection(voice.stt, '', {
      effectiveProvider: activeStt,
      configured: Boolean(activeStt),
      providerManagedModel: true,
    }),
    speech_synthesis: roleSelection(voice.tts, '', {
      effectiveProvider: activeTts,
      configured: Boolean(activeTts),
      providerManagedModel: true,
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
  };
  return role
    ? { ...base, role, configuration: roles[role] }
    : { ...base, roles };
}

export function updateLumiModelConfiguration(userId: string, input: ModelConfigurationUpdate) {
  const uid = userId || 'anonymous';
  if (!isLumiModelRole(input.role)) throw new Error(`Unsupported model role: ${input.role || ''}`);

  if (input.role === 'reasoning') {
    const current = getUserPreferredLLM(uid);
    const provider = input.provider || current.provider;
    const model = cleanModel(input.model) || current.models[provider] || (DEFAULT_MODELS as Record<string, string>)[provider];
    if (!isUserLLMProvider(provider)) throw new Error(`Unsupported reasoning provider: ${provider}`);
    upsertUserPreferredLLM(uid, { provider, model, models: { ...current.models, [provider]: model } });
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
    if (input.model) throw new Error('Speech roles select a provider; the provider manages its model identifier.');
    if (input.role === 'speech_recognition') {
      if (!STT_PROVIDERS.has(provider)) throw new Error(`Unsupported speech recognition provider: ${provider}`);
      setVoicePreference({ stt: provider as any });
    } else {
      if (!TTS_PROVIDERS.has(provider)) throw new Error(`Unsupported speech synthesis provider: ${provider}`);
      setVoicePreference({ tts: provider as any });
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
): Promise<{ ok: true; provider: string; model: string; latencyMs: number }> {
  if (!TESTABLE_LLM_PROVIDERS.has(provider)) throw new Error(`Unsupported provider: ${provider}`);
  const localConfig = provider === 'ollama' || provider === 'lmstudio'
    ? getLocalModelConfig(provider)
    : null;
  const model = String(requestedModel || localConfig?.models.find(modelName => !/(?:embed|whisper|rerank)/i.test(modelName)) || (DEFAULT_MODELS as Record<string, string>)[provider] || '').trim();
  if (!model || model.length > 200) throw new Error('A valid model name is required');

  const startedAt = Date.now();
  if (provider === 'gemini') {
    const client = llm.getGemini?.();
    if (!client) throw new Error('Gemini is not configured');
    const instance = client.getGenerativeModel({ model });
    await withConnectionTestTimeout(instance.generateContent('Reply with only OK.'), 20_000);
  } else if (provider === 'anthropic') {
    const client = llm.getAnthropic?.();
    if (!client) throw new Error('Anthropic is not configured');
    const controller = new AbortController();
    try {
      await withConnectionTestTimeout(client.messages.create({
        model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Reply with only OK.' }],
      }, { signal: controller.signal }), 20_000);
    } finally {
      controller.abort();
    }
  } else {
    const getterByProvider: Record<string, (() => any) | undefined> = {
      deepseek: llm.getDeepSeek,
      openai: llm.getOpenAI,
      qwen: llm.getQwen,
      ark: llm.getArk,
      ollama: llm.getOllama,
      lmstudio: llm.getLmStudio,
      xiaomi: llm.getXiaomi,
      kimi: llm.getKimi,
      glm: llm.getGlm,
      relay: llm.getRelay,
    };
    const client = getterByProvider[provider]?.();
    if (!client) throw new Error(`${provider} is not configured or not currently reachable`);
    const request: Record<string, any> = {
      model,
      messages: [{ role: 'user', content: 'Reply with only OK.' }],
      stream: false,
    };
    if (provider === 'xiaomi' || (provider === 'openai' && /^(?:o[134]|gpt-5)/i.test(model))) {
      request.max_completion_tokens = 8;
    } else {
      request.max_tokens = 8;
    }
    const controller = new AbortController();
    try {
      await withConnectionTestTimeout(
        client.chat.completions.create(request, { signal: controller.signal }),
        provider === 'ollama' || provider === 'lmstudio' ? 45_000 : 20_000,
      );
    } finally {
      controller.abort();
    }
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
    return testLLMProviderConnection(String(config.provider), String(config.model), llm);
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
      verification: 'active_adapter_health',
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
