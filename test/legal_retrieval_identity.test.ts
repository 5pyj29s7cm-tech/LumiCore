import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import * as EDB from '../server/org/db';
import { saveKeys } from '../server/config/keys';
import { createLegalArticle, indexLegalArticle, searchSimilarCases, searchStatutes } from '../server/legal/kb';
import { searchKnowledgeBase } from '../server/org/kb';
import { getEmbeddingRoute } from '../server/llm/embedding_provider';
import { upsertUserRetrievalModelPreferences } from '../server/llm/retrieval_model_preferences';

beforeAll(async () => { await initDatabase(); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function fixture(label: string) {
  vi.stubEnv('LUMI_PRIVACY', 'standard');
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-round3-key');
  vi.stubEnv('OPENAI_BASE_URL', 'https://embedding.example.invalid');
  saveKeys({ OPENAI_API_KEY: 'synthetic-round3-key' });
  const userId = `round3-${label}`;
  const orgId = EDB.createOrg(label, `round3-${label}`, userId).id;
  EDB.addMember(orgId, userId, 'owner');
  const article = createLegalArticle(orgId, userId, { title: `Imported ${label}`, content: `Synthetic original paragraph ${label} about an unrelated controlled fixture.`, articleType: 'judgment' });
  const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => new Response(JSON.stringify({ model: JSON.parse(String(init?.body || '{}')).model, data: [{ embedding: [1, 0] }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return { userId, orgId, article, fetchMock };
}

describe('legal retrieval identity', () => {
  it('uses the article author configuration for indexing and actor configuration for search', async () => {
    const { userId, orgId, article, fetchMock } = fixture('actor-selection');
    upsertUserRetrievalModelPreferences(userId, { embedding: { provider: 'lmstudio', model: 'selected-local-embedding', fallbackProvider: '' } });
    expect(getEmbeddingRoute(userId).primary).toMatchObject({ provider: 'lmstudio' });
    expect(await indexLegalArticle(orgId, article.id)).toBe(1);
    const indexedCalls = fetchMock.mock.calls.length;
    const results = await searchSimilarCases(orgId, 'a separate query for actor-selection', 5, userId);
    expect(results[0].articleId).toBe(article.id);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(indexedCalls);
    for (const args of fetchMock.mock.calls as any[]) {
      expect(String(args[0])).toContain('127.0.0.1:1234');
      expect(JSON.parse(args[1].body).model).toBe('selected-local-embedding');
    }
  });

  it('shares fresh legal vectors with ordinary organization semantic search', async () => {
    const { userId, orgId, article } = fixture('interop');
    upsertUserRetrievalModelPreferences(userId, { embedding: { provider: 'openai', model: 'text-embedding-3-small', fallbackProvider: '' } });
    await indexLegalArticle(orgId, article.id);
    const indexed = EDB.getAllKbEmbeddings(orgId).filter(row => row.articleId === article.id);
    expect(indexed[0].modelName).toBe('openai/text-embedding-3-small');
    const query = '\u7d2b\u8272\u6d77\u8c5a';
    expect((await searchSimilarCases(orgId, query, 5, userId)).map(row => row.articleId)).toContain(article.id);
    const ordinary = await searchKnowledgeBase(orgId, query, { userId, limit: 5 });
    expect(ordinary).toContainEqual(expect.objectContaining({ articleId: article.id, source: 'semantic' }));
  });

  it('rejects equal-dimension vectors from another model and unknown legacy labels', async () => {
    const { userId, orgId, article } = fixture('different-space');
    EDB.saveKbEmbedding(article.id, 0, [1, 0], article.content, 'qwen/different-space');
    const results = await searchSimilarCases(orgId, 'unrelated query in the current openai space', 5, userId);
    expect(results).toEqual([]);
    EDB.deleteKbEmbeddings(article.id);
    EDB.saveKbEmbedding(article.id, 0, [1, 0], article.content, 'text-embedding-3-small');
    expect(await searchSimilarCases(orgId, 'a legacy query', 5, userId)).toEqual([]);
  });

  it('uses an explicit indexing actor rather than the article author', async () => {
    const { orgId, article, fetchMock } = fixture('indexing-actor');
    const actor = 'round3-indexing-editor';
    upsertUserRetrievalModelPreferences(actor, { embedding: { provider: 'openai', model: 'editor-embedding', fallbackProvider: '' } });
    await indexLegalArticle(orgId, article.id, actor);
    expect(JSON.parse((fetchMock.mock.calls as any[])[0][1].body).model).toBe('editor-embedding');
    expect(EDB.getAllKbEmbeddings(orgId)[0].modelName).toBe('openai/editor-embedding');
  });

  it('applies the same actor and identity checks to local statute articles', async () => {
    const { userId, orgId, fetchMock } = fixture('statute-identity');
    const article = createLegalArticle(orgId, userId, { title: 'Synthetic statute', content: 'Synthetic regulation for testing.', articleType: 'statute' });
    upsertUserRetrievalModelPreferences(userId, { embedding: { provider: 'openai', model: 'statute-embedding', fallbackProvider: '' } });
    await indexLegalArticle(orgId, article.id, userId);
    const query = 'unrelated synthetic semantic query';
    expect(await searchStatutes(orgId, query, 5, userId)).toContainEqual(expect.objectContaining({ articleId: article.id }));
    expect(JSON.parse((fetchMock.mock.calls as any[]).at(-1)[1].body).model).toBe('statute-embedding');
    EDB.deleteKbEmbeddings(article.id);
    EDB.saveKbEmbedding(article.id, 0, [1, 0], article.content, 'qwen/other-space');
    expect(await searchStatutes(orgId, query, 5, userId)).not.toContainEqual(expect.objectContaining({ articleId: article.id }));
  });
});
