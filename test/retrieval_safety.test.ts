import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ db: { settings: [] as any[], memories: [] as any[] } }));
const kbState = vi.hoisted(() => ({ articles: [] as any[], embeddings: [] as any[] }));
vi.mock('../db_layer', () => ({ readDB: () => state.db, writeDB: (next: typeof state.db) => { state.db = next; } }));
vi.mock('../server/org/db', () => ({ listKbArticles: () => kbState.articles, getAllKbEmbeddings: () => kbState.embeddings, logAudit: () => {} }));
vi.mock('../server/org/resource_acl', () => ({ getOrganizationResourcePolicy: () => ({ policy: null }) }));
vi.mock('../server/config/keys', () => ({ loadKeys: () => ({ OPENAI_API_KEY: 'synthetic', SILICONFLOW_API_KEY: 'synthetic' }) }));
vi.mock('../server/llm/local_models', () => ({ getLocalModelConfig: () => ({ baseUrl: 'http://127.0.0.1:59999' }) }));
vi.mock('../server/relay/config', () => ({ relayApiKey: () => '' }));
vi.mock('../server/llm/official_api', () => ({ officialApiModel: (_key: string, model: string) => model, officialApiPath: (_key: string, path: string) => path, officialApiRequest: () => { throw new Error('No official transport in this fixture'); } }));

import { generateConfiguredEmbedding } from '../server/llm/embedding_provider';
import { rerankConfiguredDocuments } from '../server/llm/rerank_provider';
import { getUserRetrievalModelPreferences, upsertUserRetrievalModelPreferences, type RetrievalModelPreferences } from '../server/llm/retrieval_model_preferences';
import { addMemory, backfillEmbeddings, queryMemoriesVector } from '../server/memory/store';
import { searchKnowledgeBase } from '../server/org/kb';

let userId = '';
let sequence = 0;
function update(patch: { embedding?: Partial<RetrievalModelPreferences['embedding']>; rerank?: Partial<RetrievalModelPreferences['rerank']> }) {
  const current = getUserRetrievalModelPreferences(userId);
  upsertUserRetrievalModelPreferences(userId, { embedding: { ...current.embedding, ...patch.embedding }, rerank: { ...current.rerank, ...patch.rerank } });
}
function configure(primary = 'space-a', fallback = 'space-b') {
  upsertUserRetrievalModelPreferences(userId, {
    embedding: { provider: 'openai', model: primary, fallbackProvider: fallback ? 'openai' : '', fallbackModel: fallback },
    rerank: { enabled: false, provider: 'siliconflow', model: 'audit-rerank' },
  });
}
function memory(content: string, vector?: number[], namespace?: { provider: string; model: string; dimensions: number }) {
  return addMemory({ userId, type: 'knowledge', content, keywords: [content], confidence: 1, sourceInteractionId: 'audit', embedding: vector, embeddingNamespace: namespace }, { generateEmbedding: false, deduplicate: false, source: 'import' });
}
const response = (vector: number[], model?: string) => new Response(JSON.stringify({ model, data: [{ embedding: vector }] }), { status: 200 });
function kbArticle(id: string, content: string, modelName?: string) {
  kbState.articles.push({ id, orgId: 'audit-org', title: id, content, tags: '[]', category: 'audit', status: 'published', updatedAt: '2026-01-01T00:00:00Z' });
  if (modelName) kbState.embeddings.push({ articleId: id, chunkIndex: 0, content, embedding: '[1,0]', modelName });
}

beforeEach(() => {
  state.db = { settings: [], memories: [] };
  kbState.articles = []; kbState.embeddings = [];
  userId = `retrieval-safety-${++sequence}`;
  for (const key of ['OPENAI_API_KEY', 'SILICONFLOW_API_KEY', 'OPENAI_BASE_URL', 'SILICONFLOW_BASE_URL']) vi.stubEnv(key, '');
  vi.stubEnv('LUMI_PRIVACY', 'standard');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected mock transport'); }));
  configure();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('retrieval privacy and cancellation', () => {
  it('blocks both cloud embedding candidates and rerank before transport under strict mode', async () => {
    vi.stubEnv('LUMI_PRIVACY', 'strict');
    update({ rerank: { enabled: true } });
    await expect(generateConfiguredEmbedding('private query', userId)).rejects.toThrow(/Privacy/);
    await expect(rerankConfiguredDocuments('private query', ['private document'], userId)).rejects.toThrow(/Privacy/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows local embedding fallback in strict mode and skips cloud reranking during recall', async () => {
    update({ embedding: { fallbackProvider: 'ollama', fallbackModel: 'local-space' }, rerank: { enabled: true } });
    vi.stubEnv('LUMI_PRIVACY', 'strict');
    memory('contract alpha'); memory('contract beta');
    const transport = vi.fn(async (_url: unknown) => new Response(JSON.stringify({ embeddings: [[1, 0]] }), { status: 200 }));
    vi.stubGlobal('fetch', transport);
    expect(await queryMemoriesVector({ userId, query: 'contract', useVector: true })).toHaveLength(2);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(String(transport.mock.calls[0][0])).toBe('http://127.0.0.1:59999/api/embed');
  });

  it('stops a hung embedding immediately on cancellation without calling its fallback', async () => {
    const controller = new AbortController();
    const transport = vi.fn((_url: unknown, _init: RequestInit) => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', transport);
    const pending = queryMemoriesVector({ userId, query: 'query', useVector: true, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    expect(transport.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('cancels hung rerank and does not mark memory as retrieved after cancellation', async () => {
    update({ rerank: { enabled: true } });
    const first = memory('contract alpha'); memory('contract beta');
    const transport = vi.fn(async (url: unknown, _init: RequestInit) => String(url).endsWith('/rerank') ? new Promise<Response>(() => {}) : response([1, 0]));
    vi.stubGlobal('fetch', transport);
    const controller = new AbortController();
    const pending = queryMemoriesVector({ userId, query: 'contract', useVector: true, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    controller.abort();
    await rejected;
    expect(first.retrieveCount).toBe(0);
    expect(transport.mock.calls[1][1].signal?.aborted).toBe(true);
  });

  it('bounds rerank even when fetch ignores its signal', async () => {
    vi.useFakeTimers();
    update({ rerank: { enabled: true } });
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const pending = rerankConfiguredDocuments('query', ['document'], userId);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
  });
});

describe('embedding vector identity', () => {
  it('uses keyword ranking for legacy or different-model vectors even with the same dimension', async () => {
    memory('contract', [0, 1]);
    memory('garden', [1, 0], { provider: 'openai', model: 'different-space', dimensions: 2 });
    vi.stubGlobal('fetch', vi.fn(async () => response([1, 0])));
    expect((await queryMemoriesVector({ userId, query: 'contract', useVector: true, limit: 1 })).map(m => m.content)).toEqual(['contract']);
  });

  it('persists actual model identity during migration and never caches fallback vectors under the primary', async () => {
    const contract = memory('contract'); memory('garden');
    let primaryBroken = false;
    const models: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); models.push(body.model);
      if (body.model === 'space-a' && primaryBroken) return new Response('{}', { status: 503 });
      const contractInput = body.input.includes('contract');
      return response(body.model === 'space-a' ? (contractInput ? [1, 0] : [0, 1]) : (contractInput ? [0, 1] : [1, 0]), body.model);
    }));
    expect(await backfillEmbeddings(userId)).toBe(2);
    expect(contract.embeddingNamespace).toEqual({ provider: 'openai', model: 'space-a', dimensions: 2 });
    primaryBroken = true;
    expect((await queryMemoriesVector({ userId, query: 'contract question', useVector: true, limit: 1 }))[0].id).toBe(contract.id);
    expect(models.slice(-2)).toEqual(['space-a', 'space-b']);
    primaryBroken = false;
    const previousCount = models.length;
    expect((await queryMemoriesVector({ userId, query: 'contract question', useVector: true, limit: 1 }))[0].id).toBe(contract.id);
    expect(models.slice(previousCount)).toEqual(['space-a']);
    configure('space-b', '');
    expect(await backfillEmbeddings(userId)).toBe(2);
    expect(contract.embeddingNamespace?.model).toBe('space-b');
  });

  it('records the model identity reported by the actual embedding response', async () => {
    const row = memory('contract');
    vi.stubGlobal('fetch', vi.fn(async () => response([1, 0], 'resolved-model-version')));
    await backfillEmbeddings(userId);
    expect(row.embeddingNamespace).toEqual({ provider: 'openai', model: 'resolved-model-version', dimensions: 2 });
  });
});

describe('organization knowledge retrieval', () => {
  it('compares only vectors from the actual provider/model and retains keyword fallback', async () => {
    kbArticle('keyword', 'contract termination');
    kbArticle('wrong-model', 'garden', 'openai/space-b');
    kbArticle('legacy', 'weather', 'text-embedding-3-small');
    kbArticle('matching-model', 'agreement remedy', 'openai/space-a');
    vi.stubGlobal('fetch', vi.fn(async () => response([1, 0], 'space-a')));
    const results = await searchKnowledgeBase('audit-org', 'contract', { userId, limit: 10 });
    expect(results.filter(result => result.source === 'semantic').map(result => result.articleId)).toEqual(['matching-model']);
    expect(results.some(result => result.articleId === 'keyword' && result.source === 'keyword')).toBe(true);
  });

  it('propagates cancellation through organization embeddings without starting fallback', async () => {
    kbArticle('pending', 'contract', 'openai/space-a');
    const transport = vi.fn((_url: unknown, _init: RequestInit) => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', transport);
    const controller = new AbortController();
    const pending = searchKnowledgeBase('audit-org', 'contract', { userId, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1].signal?.aborted).toBe(true);
  });

  it('does not swallow cancellation of organization reranking', async () => {
    kbArticle('one', 'contract alpha'); kbArticle('two', 'contract beta');
    update({ rerank: { enabled: true } });
    const transport = vi.fn((_url: unknown, _init: RequestInit) => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', transport);
    const controller = new AbortController();
    const pending = searchKnowledgeBase('audit-org', 'contract', { userId, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(String(transport.mock.calls[0][0])).toMatch(/\/rerank$/);
    controller.abort();
    await rejected;
    expect(transport.mock.calls[0][1].signal?.aborted).toBe(true);
  });
});
