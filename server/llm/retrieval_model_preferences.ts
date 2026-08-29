import { readDB, writeDB } from '../../db_layer';

export interface EmbeddingModelSelection {
  provider: string;
  model: string;
  fallbackProvider: string;
  fallbackModel: string;
}

export interface RerankModelSelection {
  enabled: boolean;
  provider: string;
  model: string;
  topN: number;
}

export interface RetrievalModelPreferences {
  embedding: EmbeddingModelSelection;
  rerank: RerankModelSelection;
}

const DEFAULT_EMBEDDING: EmbeddingModelSelection = {
  provider: 'openai',
  model: 'text-embedding-3-small',
  fallbackProvider: 'ollama',
  fallbackModel: 'nomic-embed-text',
};

const DEFAULT_RERANK: RerankModelSelection = {
  enabled: false,
  provider: 'siliconflow',
  model: 'Qwen/Qwen3-Reranker-8B',
  topN: 5,
};

const EMBEDDING_PROVIDERS = new Set(['openai', 'qwen', 'siliconflow', 'ollama', 'lmstudio', 'relay']);
const FALLBACK_PROVIDERS = new Set(['', ...EMBEDDING_PROVIDERS]);
const RERANK_PROVIDERS = new Set(['siliconflow', 'relay']);
export const DEFAULT_EMBEDDING_MODELS: Record<string, string> = {
  openai: 'text-embedding-3-small',
  qwen: 'text-embedding-v4',
  siliconflow: 'Qwen/Qwen3-Embedding-8B',
  ollama: 'nomic-embed-text',
  lmstudio: 'text-embedding-nomic-embed-text-v1.5',
  relay: 'huawei_maas/bge-m3',
};
export const DEFAULT_RERANK_MODELS: Record<string, string> = {
  siliconflow: 'Qwen/Qwen3-Reranker-8B',
  relay: 'huawei_maas/bge-reranker-v2-m3',
};

export function isEmbeddingProvider(value: unknown): value is string {
  return typeof value === 'string' && EMBEDDING_PROVIDERS.has(value);
}

export function isEmbeddingFallbackProvider(value: unknown): value is string {
  return typeof value === 'string' && FALLBACK_PROVIDERS.has(value);
}

export function isRerankProvider(value: unknown): value is string {
  return typeof value === 'string' && RERANK_PROVIDERS.has(value);
}

function cleanText(value: unknown, maxLength = 180): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeEmbedding(value: Record<string, unknown>): EmbeddingModelSelection {
  const requestedProvider = cleanText(value.provider);
  const provider = EMBEDDING_PROVIDERS.has(requestedProvider)
    ? requestedProvider
    : DEFAULT_EMBEDDING.provider;
  const hasFallbackProvider = typeof value.fallbackProvider === 'string';
  const requestedFallbackProvider = cleanText(value.fallbackProvider);
  const fallbackProvider = hasFallbackProvider && FALLBACK_PROVIDERS.has(requestedFallbackProvider)
    ? requestedFallbackProvider
    : DEFAULT_EMBEDDING.fallbackProvider;

  return {
    provider,
    model: cleanText(value.model) || DEFAULT_EMBEDDING_MODELS[provider] || DEFAULT_EMBEDDING.model,
    fallbackProvider,
    fallbackModel: fallbackProvider
      ? cleanText(value.fallbackModel) || DEFAULT_EMBEDDING_MODELS[fallbackProvider] || DEFAULT_EMBEDDING.fallbackModel
      : '',
  };
}

function normalizeRerank(value: Record<string, unknown>): RerankModelSelection {
  const requestedProvider = cleanText(value.provider);
  const provider = RERANK_PROVIDERS.has(requestedProvider)
    ? requestedProvider
    : DEFAULT_RERANK.provider;
  const requestedTopN = Number(value.topN);
  return {
    enabled: value.enabled === true,
    provider,
    model: cleanText(value.model) || DEFAULT_RERANK_MODELS[provider] || DEFAULT_RERANK.model,
    topN: Number.isFinite(requestedTopN)
      ? Math.max(1, Math.min(50, Math.round(requestedTopN)))
      : DEFAULT_RERANK.topN,
  };
}

export function normalizeRetrievalModelPreferences(value: unknown): RetrievalModelPreferences {
  const container = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const root = container.retrieval && typeof container.retrieval === 'object'
    ? container.retrieval as Record<string, unknown>
    : container;
  const embedding = root.embedding && typeof root.embedding === 'object'
    ? root.embedding as Record<string, unknown>
    : root;
  const rerank = root.rerank && typeof root.rerank === 'object'
    ? root.rerank as Record<string, unknown>
    : {};
  return {
    embedding: normalizeEmbedding(embedding),
    rerank: normalizeRerank(rerank),
  };
}

function settingKey(userId: string): string {
  return `retrieval_model_prefs_${userId || 'anonymous'}`;
}

function legacySettingKey(userId: string): string {
  return `model_role_prefs_${userId || 'anonymous'}`;
}

export function getUserRetrievalModelPreferences(userId: string): RetrievalModelPreferences {
  try {
    const db = readDB();
    const settings = db.settings || [];
    const row = settings.find((item: any) => item.key === settingKey(userId))
      || settings.find((item: any) => item.key === legacySettingKey(userId));
    return normalizeRetrievalModelPreferences(row?.value ? JSON.parse(row.value) : null);
  } catch {
    return normalizeRetrievalModelPreferences(null);
  }
}

export function upsertUserRetrievalModelPreferences(userId: string, value: unknown): RetrievalModelPreferences {
  const preferences = normalizeRetrievalModelPreferences(value);
  const db = readDB();
  if (!db.settings) (db as any).settings = [];
  const key = settingKey(userId);
  const payload = JSON.stringify({ ...preferences, updatedAt: new Date().toISOString() });
  const row = (db.settings || []).find((item: any) => item.key === key);
  if (row) row.value = payload;
  else db.settings.push({ key, value: payload });
  db.settings = db.settings.filter((item: any) => item.key !== legacySettingKey(userId));
  writeDB(db);
  return preferences;
}
