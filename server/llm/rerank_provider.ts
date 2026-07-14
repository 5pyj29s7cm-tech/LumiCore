import { loadKeys } from '../config/keys';
import {
  getUserRetrievalModelPreferences,
  type RerankModelSelection,
} from './retrieval_model_preferences';

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
): Promise<RerankResult> {
  const keys = loadKeys();
  const apiKey = process.env.SILICONFLOW_API_KEY || keys.SILICONFLOW_API_KEY || '';
  if (!apiKey) throw new Error('SILICONFLOW_API_KEY is not configured in Settings > AI Providers.');

  const response = await fetch(`${siliconFlowBaseUrl()}/rerank`, {
    method: 'POST',
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

export function getRerankSelection(userId = 'anonymous'): RerankModelSelection {
  return getUserRetrievalModelPreferences(userId).rerank;
}

export async function rerankConfiguredDocuments(
  query: string,
  documents: string[],
  userId = 'anonymous',
  topNOverride?: number,
): Promise<RerankResult> {
  const selection = getRerankSelection(userId);
  if (!selection.enabled) throw new Error('Rerank is disabled.');
  const normalizedDocuments = documents.map(document => String(document || '').trim()).filter(Boolean).slice(0, 100);
  if (!String(query || '').trim()) throw new Error('Rerank query is required.');
  if (normalizedDocuments.length === 0) throw new Error('At least one rerank document is required.');
  const requestedTopN = Number(topNOverride) || selection.topN;
  const topN = Math.max(1, Math.min(normalizedDocuments.length, Math.round(requestedTopN)));

  if (selection.provider === 'siliconflow') {
    return runSiliconFlowRerank(selection, query, normalizedDocuments, topN);
  }
  throw new Error(`Rerank provider is not supported: ${selection.provider}`);
}
