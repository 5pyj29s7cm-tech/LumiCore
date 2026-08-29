import { loadKeys } from '../config/keys';
import { getLocalModelConfig } from './local_models';
import {
  getUserRetrievalModelPreferences,
  type EmbeddingModelSelection,
} from './retrieval_model_preferences';
import { relayApiKey } from '../relay/config';
import { officialApiModel, officialApiPath, officialApiRequest } from './official_api';

type EmbeddingSelection = Pick<EmbeddingModelSelection, 'provider' | 'model'>;

export interface EmbeddingResult {
  provider: string;
  model: string;
  vector: number[];
}

export interface EmbeddingRoute {
  primary: EmbeddingSelection;
  fallback?: EmbeddingSelection;
}

function normalizedBaseUrl(value: string, defaultValue: string): string {
  return String(value || defaultValue).trim().replace(/\/+$/, '');
}

function compatibleEmbeddingEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/v1$/i.test(base) ? `${base}/embeddings` : `${base}/v1/embeddings`;
}

function usableVector(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const vector = value.map(Number);
  return vector.every(Number.isFinite) ? vector : null;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs = 10_000): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(body?.error?.message || body?.message || `Embedding request failed (${response.status})`).slice(0, 300));
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function runEmbedding(selection: EmbeddingSelection, text: string): Promise<EmbeddingResult> {
  const provider = selection.provider;
  const model = provider === 'relay'
    ? officialApiModel('RELAY_EMBEDDING_MODEL', selection.model.trim())
    : selection.model.trim();
  if (!provider || provider.startsWith('inherit_') || !model) {
    throw new Error('Retrieval model requires an explicit embedding provider and model');
  }

  const keys = loadKeys();
  const input = text.slice(0, 12_000);

  if (provider === 'ollama') {
    const baseUrl = getLocalModelConfig('ollama').baseUrl;
    const body = await fetchJson(`${baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input }),
    });
    const vector = usableVector(body?.embeddings?.[0] || body?.embedding);
    if (!vector) throw new Error('Ollama returned no embedding vector');
    return { provider, model, vector };
  }

  const providerConfig: Record<string, { key: string; baseUrl: string }> = {
    openai: {
      key: process.env.OPENAI_API_KEY || keys.OPENAI_API_KEY || '',
      baseUrl: normalizedBaseUrl(process.env.OPENAI_BASE_URL || keys.OPENAI_BASE_URL || '', 'https://api.openai.com'),
    },
    qwen: {
      key: process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY || keys.DASHSCOPE_API_KEY || keys.QWEN_API_KEY || '',
      baseUrl: normalizedBaseUrl(process.env.QWEN_BASE_URL || keys.QWEN_BASE_URL || '', 'https://dashscope.aliyuncs.com/compatible-mode'),
    },
    siliconflow: {
      key: process.env.SILICONFLOW_API_KEY || keys.SILICONFLOW_API_KEY || '',
      baseUrl: normalizedBaseUrl(process.env.SILICONFLOW_BASE_URL || '', 'https://api.siliconflow.cn/v1'),
    },
    relay: {
      key: relayApiKey(),
      baseUrl: normalizedBaseUrl(process.env.RELAY_BASE_URL || keys.RELAY_BASE_URL || '', ''),
    },
    lmstudio: {
      key: '',
      baseUrl: getLocalModelConfig('lmstudio').baseUrl,
    },
  };

  const config = providerConfig[provider];
  if (!config) throw new Error(`Embedding provider is not supported: ${provider}`);
  if (provider !== 'lmstudio' && !config.key) throw new Error(`${provider} embedding credentials are not configured`);
  if (provider === 'relay' && !config.baseUrl) {
    throw new Error('RELAY_BASE_URL is not configured. Set it in Settings > AI Providers > Official.');
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.key) headers.Authorization = `Bearer ${config.key}`;
  // Keep the official lane on the shared transport so timeout, URL-origin,
  // bearer-header and redacted-error rules are identical across roles.
  const body = provider === 'relay'
    ? (await officialApiRequest<any>(officialApiPath('RELAY_EMBEDDINGS_PATH', '/embeddings'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // ModelDepot documents embedding input as an array. Do not collapse it
      // to a scalar just because other compatibility providers accept one.
      body: JSON.stringify({ model, input: [input] }),
    })).body
    : await fetchJson(compatibleEmbeddingEndpoint(config.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, input }),
    });
  const vector = usableVector(body?.data?.[0]?.embedding || body?.embedding);
  if (!vector) throw new Error(`${provider} returned no embedding vector`);
  return { provider, model, vector };
}

export function getEmbeddingRoute(userId = 'anonymous'): EmbeddingRoute {
  const preferences = getUserRetrievalModelPreferences(userId).embedding;
  const fallback = preferences.fallbackProvider && preferences.fallbackModel
    ? {
        provider: preferences.fallbackProvider,
        model: preferences.fallbackModel,
      }
    : undefined;
  return {
    primary: { provider: preferences.provider, model: preferences.model },
    fallback,
  };
}

export async function generateConfiguredEmbedding(text: string, userId = 'anonymous'): Promise<EmbeddingResult> {
  const route = getEmbeddingRoute(userId);
  try {
    return await runEmbedding(route.primary, text);
  } catch (primaryError) {
    if (!route.fallback) throw primaryError;
    return runEmbedding(route.fallback, text);
  }
}
