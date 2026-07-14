import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { saveKeys } from '../server/config/keys';
import { generateConfiguredEmbedding } from '../server/llm/embedding_provider';
import { rerankConfiguredDocuments } from '../server/llm/rerank_provider';
import { upsertUserRetrievalModelPreferences } from '../server/llm/retrieval_model_preferences';
import { addMemory, queryMemoriesVector } from '../server/memory/store';

describe('knowledge retrieval model routing', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    saveKeys({ SILICONFLOW_API_KEY: '' });
  });

  it('uses the selected SiliconFlow embedding model', async () => {
    saveKeys({ SILICONFLOW_API_KEY: 'siliconflow-test-key' });
    upsertUserRetrievalModelPreferences('embedding-user', {
      embedding: {
        provider: 'siliconflow',
        model: 'Qwen/Qwen3-Embedding-4B',
        fallbackProvider: '',
      },
      rerank: { enabled: false },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [0.2, 0.3, 0.4] }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateConfiguredEmbedding('semantic retrieval', 'embedding-user');

    expect(result).toEqual({
      provider: 'siliconflow',
      model: 'Qwen/Qwen3-Embedding-4B',
      vector: [0.2, 0.3, 0.4],
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.siliconflow.cn/v1/embeddings');
  });

  it('uses the selected reranker and preserves returned candidate indices', async () => {
    saveKeys({ SILICONFLOW_API_KEY: 'siliconflow-test-key' });
    upsertUserRetrievalModelPreferences('rerank-user', {
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        fallbackProvider: '',
      },
      rerank: {
        enabled: true,
        provider: 'siliconflow',
        model: 'Qwen/Qwen3-Reranker-4B',
        topN: 2,
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'rerank-result',
        results: [
          { index: 1, relevance_score: 0.98 },
          { index: 0, relevance_score: 0.42 },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await rerankConfiguredDocuments(
      'Which passage is about contract termination?',
      ['A weather forecast for tomorrow.', 'The contract may be terminated after material breach.'],
      'rerank-user',
    );

    expect(result).toEqual({
      provider: 'siliconflow',
      model: 'Qwen/Qwen3-Reranker-4B',
      items: [
        { index: 1, score: 0.98 },
        { index: 0, score: 0.42 },
      ],
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.siliconflow.cn/v1/rerank');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: 'Qwen/Qwen3-Reranker-4B',
      top_n: 2,
    });
  });

  it('recalls scoped knowledge by vector meaning even without shared keywords', async () => {
    saveKeys({ SILICONFLOW_API_KEY: 'siliconflow-test-key' });
    upsertUserRetrievalModelPreferences('semantic-memory-user', {
      embedding: {
        provider: 'siliconflow',
        model: 'Qwen/Qwen3-Embedding-0.6B',
        fallbackProvider: '',
      },
      rerank: { enabled: false },
    });
    addMemory({
      userId: 'semantic-memory-user',
      type: 'knowledge',
      content: 'A material breach permits ending the agreement.',
      keywords: ['agreement-remedy'],
      confidence: 0.9,
      sourceInteractionId: 'contract-guide.md',
      embedding: [1, 0],
    }, { agentId: 'lumi', tier: 'internalized', source: 'import' });
    addMemory({
      userId: 'semantic-memory-user',
      type: 'knowledge',
      content: 'The studio lighting uses a warm color temperature.',
      keywords: ['lighting-design'],
      confidence: 0.9,
      sourceInteractionId: 'studio-guide.md',
      embedding: [0, 1],
    }, { agentId: 'lumi', tier: 'internalized', source: 'import' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: [1, 0] }] }),
    }));

    const results = await queryMemoriesVector({
      userId: 'semantic-memory-user',
      agentId: 'lumi',
      type: 'knowledge',
      query: 'What allows contract termination?',
      limit: 1,
      useVector: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0].sourceInteractionId).toBe('contract-guide.md');
  });
});
