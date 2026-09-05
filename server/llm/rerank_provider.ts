import { loadKeys } from '../config/keys';
import {
  DEFAULT_RERANK_MODELS,
  getUserRetrievalModelPreferences,
  type RerankModelSelection,
} from './retrieval_model_preferences';
import { officialApiModel, officialApiPath, officialApiRequest } from './official_api';
import { requireLocalProvider } from '../config/privacy';
import { runRetrievalRequest } from './retrieval_request';

export interface RerankItem {
  index: number;
  score: number;
}

export interface RerankResult {
  provider: string;
  model: string;
  items: RerankItem[];
}

function siliconFlowBaseUrl(): string {
  return String(process.env.SILICONFLOW_BASE_URL || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
}

async function runSiliconFlowRerank(
  selection: RerankModelSelection,
  query: string,
  documents: string[],
  topN: number,
  signal?: AbortSignal,
): Promise<RerankResult> {
  const keys = loadKeys();
  const apiKey = process.env.SILICONFLOW_API_KEY || keys.SILICONFLOW_API_KEY || '';
  if (!apiKey) throw new Error('SILICONFLOW_API_KEY is not configured in Settings > AI Providers.');

  const body = await runRetrievalRequest(async requestSignal => {
    const response = await fetch(`${siliconFlowBaseUrl()}/rerank`, {
      method: 'POST',
      signal: requestSignal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: selection.model,
        query: query.slice(0, 8_000),
        documents: documents.map(document => document.slice(0, 20_000)),
        top_n: topN,
        return_documents: false,
      }),
    });
    const body = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      throw new Error(String(body?.message || body?.error || `SiliconFlow rerank failed (${response.status})`).slice(0, 400));
    }
    return body;
  }, signal, 10_000);
  const items = Array.isArray(body?.results)
    ? body.results
        .map((item: any) => ({ index: Number(item?.index), score: Number(item?.relevance_score) }))
        .filter((item: RerankItem) => Number.isInteger(item.index)
          && item.index >= 0
          && item.index < documents.length
          && Number.isFinite(item.score))
    : [];
  if (items.length === 0) throw new Error('SiliconFlow rerank returned no valid ranked documents.');
  return { provider: selection.provider, model: selection.model, items };
}

async function runOfficialRerank(
  selection: RerankModelSelection,
  query: string,
  documents: string[],
  topN: number,
  signal?: AbortSignal,
): Promise<RerankResult> {
  const model = officialApiModel('RELAY_RERANK_MODEL', selection.model || DEFAULT_RERANK_MODELS.relay);
  const { body } = await runRetrievalRequest(requestSignal => officialApiRequest<any>(officialApiPath('RELAY_RERANK_PATH', '/api/v1/rerank'), {
    method: 'POST',
    signal: requestSignal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      query: query.slice(0, 8_000),
      documents: documents.map(document => document.slice(0, 20_000)),
      top_n: topN,
      return_documents: false,
    }),
  }), signal, 60_000);
  const rawItems = Array.isArray(body?.results) ? body.results
    : Array.isArray(body?.data?.results) ? body.data.results
      : Array.isArray(body?.data) ? body.data : [];
  const items = rawItems
    .map((item: any) => ({
      index: Number(item?.index),
      score: Number(item?.relevance_score ?? item?.score ?? item?.relevanceScore),
    }))
    .filter((item: RerankItem) => Number.isInteger(item.index)
      && item.index >= 0
      && item.index < documents.length
      && Number.isFinite(item.score))
    .slice(0, topN);
  if (items.length === 0) throw new Error('Lumi Official API rerank returned no valid ranked documents.');
  return { provider: selection.provider, model, items };
}


export function getRerankSelection(userId = 'anonymous'): RerankModelSelection {
  return getUserRetrievalModelPreferences(userId).rerank;
}

export async function rerankConfiguredDocuments(
  query: string,
  documents: string[],
  userId = 'anonymous',
  topNOverride?: number,
  options: { signal?: AbortSignal } = {},
): Promise<RerankResult> {
  options.signal?.throwIfAborted();
  const selection = getRerankSelection(userId);
  requireLocalProvider(selection.provider);
  if (!selection.enabled) throw new Error('Rerank is disabled.');
  const normalizedDocuments = documents.map(document => String(document || '').trim()).filter(Boolean).slice(0, 100);
  if (!String(query || '').trim()) throw new Error('Rerank query is required.');
  if (normalizedDocuments.length === 0) throw new Error('At least one rerank document is required.');
  const requestedTopN = Number(topNOverride) || selection.topN;
  const topN = Math.max(1, Math.min(normalizedDocuments.length, Math.round(requestedTopN)));

  if (selection.provider === 'siliconflow') {
    return runSiliconFlowRerank(selection, query, normalizedDocuments, topN, options.signal);
  }
  if (selection.provider === 'relay') {
    return runOfficialRerank(selection, query, normalizedDocuments, topN, options.signal);
  }
  throw new Error(`Rerank provider is not supported: ${selection.provider}`);
}
