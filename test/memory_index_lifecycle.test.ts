import { makeApp, JWT_SECRET } from './helpers';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { mountMemoryRoutes } from '../server/routes/memory_routes';
import { addMemory, backfillEmbeddings, formatMemoriesForContext, queryMemoriesVector } from '../server/memory/store';
import { closeDatabase, flushDBOrThrow, initDatabase, readDB, querySQL, runSQL, writeDB } from '../db_layer';
import { upsertUserRetrievalModelPreferences } from '../server/llm/retrieval_model_preferences';
import { generateConfiguredEmbedding } from '../server/llm/embedding_provider';
import { rerankConfiguredDocuments } from '../server/llm/rerank_provider';

vi.mock('../server/llm/embedding_provider', async importOriginal => ({
  ...await importOriginal<typeof import('../server/llm/embedding_provider')>(),
  generateConfiguredEmbedding: vi.fn(async (text: string) => ({
    provider: 'openai', model: 'synthetic-embedding', vector: text.includes('football') ? [0, 1] : [1, 0],
  })),
}));
vi.mock('../server/llm/rerank_provider', async importOriginal => ({
  ...await importOriginal<typeof import('../server/llm/rerank_provider')>(),
  rerankConfiguredDocuments: vi.fn(async (_query: string, documents: string[]) => ({
    provider: 'siliconflow', model: 'synthetic-rerank', items: documents.map((_item, index) => ({ index, score: 1 - index * 0.1 })),
  })),
}));

describe('memory content and index lifecycle through actual REST and SQLite', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => {
    app = await makeApp();
    mountMemoryRoutes(app.apiRouter, JWT_SECRET, { getDeepSeek: () => null, getGemini: () => null });
  });
  beforeEach(() => { vi.clearAllMocks(); });
  afterAll(() => { app.server.close(); });
  function configure(uid: string, rerank = false) {
    upsertUserRetrievalModelPreferences(uid, {
      embedding: { provider: 'openai', model: 'synthetic-embedding', fallbackProvider: '', fallbackModel: '' },
      rerank: { enabled: rerank, provider: 'siliconflow', model: 'synthetic-rerank', topN: 5 },
    });
  }
  function seed(uid: string, content: string, confidence = 1, scope: { domain?: string; orgId?: string; agentId?: string } = {}) {
    return addMemory({
      userId: uid, type: 'fact', content, confidence, keywords: [content], sourceInteractionId: 'synthetic-index-fixture',
      embedding: content.includes('football') ? [0, 1] : [1, 0],
      embeddingNamespace: { provider: 'openai', model: 'synthetic-embedding', dimensions: 2 },
    }, { generateEmbedding: false, deduplicate: false, ...scope });
  }
  function request(uid: string, id: string, method: string, body?: unknown) {
    return fetch(`${app.url}/api/memories/${id}`, {
      method, headers: { Authorization: `Bearer ${jwt.sign({ uid, role: 'admin' }, JWT_SECRET)}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000), ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  const recall = (uid: string, query = 'banana', signal?: AbortSignal) => queryMemoriesVector({
    userId: uid, query, useVector: true, domain: 'personal', orgId: '', limit: 5, signal,
  });

  it('control: recall separates other users, work organizations and avatar lanes', async () => {
    const uid = 'audit10-scope'; configure(uid);
    const owned = seed(uid, 'banana personal fixture');
    seed(`${uid}-other`, 'banana other-user fixture');
    seed(uid, 'banana work fixture', 1, { domain: 'work', orgId: 'synthetic-org' });
    seed(uid, 'banana avatar fixture', 1, { agentId: 'memory_avatar_synthetic' });
    expect((await recall(uid)).map(item => item.id)).toEqual([owned.id]);
    expect((await request(`${uid}-other`, owned.id, 'DELETE')).status).toBe(404);
  });

  it('reindexes an edited memory for the new topic after its durable REST update', async () => {
    const uid = 'audit10-edit'; configure(uid);
    const memory = seed(uid, 'banana breakfast preference');
    await flushDBOrThrow();
    expect((await recall(uid, 'banana')).map(item => item.id)).toEqual([memory.id]);
    const edit = await request(uid, memory.id, 'PUT', { content: 'football weekend preference', keywords: ['football'] });
    expect(edit.status).toBe(200);
    const rows = await querySQL<{ content: string }>('SELECT content FROM memories WHERE id = ?', [memory.id]);
    expect(rows[0].content).toBe('football weekend preference');
    expect(readDB().memories.find(item => item.id === memory.id)?.embedding).toEqual([0, 1]);
    expect((await recall(uid, 'football')).map(item => item.id)).toEqual([memory.id]);
    expect(await recall(uid, 'banana')).toEqual([]);
    // A current vector has the expected behavior under the very same query.
    const fresh = seed(uid, 'football current vector control');
    expect((await recall(uid, 'football')).map(item => item.id)).toEqual(expect.arrayContaining([memory.id, fresh.id]));
    expect(vi.mocked(generateConfiguredEmbedding)).toHaveBeenCalled();
  });

  it('removes a durably deleted memory from an in-flight rerank and the resulting prompt', async () => {
    const uid = 'audit10-rerank-delete'; configure(uid, true);
    const erased = seed(uid, 'banana private source to delete');
    const surviving = seed(uid, 'banana surviving source', 0.9);
    await flushDBOrThrow();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let reached!: () => void;
    const pending = new Promise<void>(resolve => { reached = resolve; });
    vi.mocked(rerankConfiguredDocuments).mockImplementationOnce(async () => {
      reached(); await held;
      return { provider: 'siliconflow', model: 'synthetic-rerank', items: [{ index: 0, score: 1 }, { index: 1, score: 0.9 }] };
    });
    const inFlight = recall(uid);
    await pending;
    expect((await request(uid, erased.id, 'DELETE')).status).toBe(200);
    expect(readDB().memories.some(item => item.id === erased.id)).toBe(false);
    expect(await querySQL('SELECT id FROM memories WHERE id = ?', [erased.id])).toEqual([]);
    release();
    const returned = await inFlight;
    expect(returned.map(item => item.id)).toEqual([surviving.id]);
    expect(formatMemoriesForContext(returned, { currentTurnText: 'banana' })).not.toContain('banana private source to delete');
    // A newly started retrieval sees only the surviving record.
    expect((await recall(uid)).map(item => item.id)).toEqual([surviving.id]);
    expect(readDB().memories.some(item => item.id === erased.id)).toBe(false);
  });

  it('persists the vector, namespace and content digest across a normal database reopen', async () => {
    const uid = 'audit10-reopen'; configure(uid);
    const memory = addMemory({ userId: uid, type: 'fact', content: 'banana breakfast preference', keywords: ['banana'], confidence: 1, sourceInteractionId: 'synthetic-index-fixture' }, { deduplicate: false });
    // Exercise the real background attach path, replacing only the external embedding request.
    await vi.waitFor(() => expect(readDB().memories.find(item => item.id === memory.id)?.embedding).toEqual([1, 0]));
    expect((await recall(uid, 'fruit')).map(item => item.id)).toEqual([memory.id]);
    await flushDBOrThrow();
    await closeDatabase();
    await initDatabase();
    const loaded = readDB().memories.find(item => item.id === memory.id);
    expect(loaded?.content).toBe('banana breakfast preference');
    expect(loaded?.embedding).toEqual([1, 0]);
    expect(loaded?.embeddingNamespace).toEqual({ provider: 'openai', model: 'synthetic-embedding', dimensions: 2 });
    expect(loaded?.embeddingContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await recall(uid, 'fruit')).map(item => item.id)).toEqual([memory.id]);
    // The persisted row and keyword fallback still work; this is not loss of its plaintext.
    expect((await recall(uid, 'banana')).map(item => item.id)).toEqual([memory.id]);
  });

  it('uses keyword fallback while the new embedding is pending and rejects a late old embedding', async () => {
    const uid = 'index-late'; configure(uid);
    let oldDone!: (value: any) => void;
    let newDone!: (value: any) => void;
    vi.mocked(generateConfiguredEmbedding)
      .mockImplementationOnce(() => new Promise(resolve => { oldDone = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { newDone = resolve; }));
    const memory = addMemory({ userId: uid, type: 'fact', content: 'banana old pending', keywords: ['banana'], confidence: 1, sourceInteractionId: 'synthetic-index-fixture' }, { deduplicate: false });
    expect(oldDone).toBeDefined();
    expect((await request(uid, memory.id, 'PUT', { content: 'football new pending', keywords: ['football'] })).status).toBe(200);
    expect(memory.embedding).toBeUndefined();
    expect((await recall(uid, 'football')).map(item => item.id)).toEqual([memory.id]);
    newDone({ provider: 'openai', model: 'synthetic-embedding', vector: [0, 1] });
    await vi.waitFor(() => expect(memory.embedding).toEqual([0, 1]));
    oldDone({ provider: 'openai', model: 'synthetic-embedding', vector: [1, 0] });
    await Promise.resolve(); await Promise.resolve();
    expect(memory.embedding).toEqual([0, 1]);
  });

  it('never reattaches a pending embedding after its memory is deleted', async () => {
    const uid = 'index-deleted'; configure(uid);
    let done!: (value: any) => void;
    vi.mocked(generateConfiguredEmbedding).mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    const memory = addMemory({ userId: uid, type: 'fact', content: 'banana pending deleted', keywords: ['banana'], confidence: 1, sourceInteractionId: 'synthetic-index-fixture' }, { deduplicate: false });
    expect((await request(uid, memory.id, 'DELETE')).status).toBe(200);
    done({ provider: 'openai', model: 'synthetic-embedding', vector: [1, 0] });
    await Promise.resolve(); await Promise.resolve();
    expect(memory.embedding).toBeUndefined();
    expect(readDB().memories.some(item => item.id === memory.id)).toBe(false);
  });

  it('invalidates an index when the deduplication merge changes its indexed keywords', async () => {
    const uid = 'index-merge'; configure(uid);
    const memory = seed(uid, 'banana stable preference', 0.4);
    const merged = addMemory({ userId: uid, type: 'fact', content: memory.content, keywords: ['football'], confidence: 0.9, sourceInteractionId: 'synthetic-index-merge' });
    expect(merged.id).toBe(memory.id);
    expect(merged.embedding).toBeUndefined();
    await vi.waitFor(() => expect(merged.embedding).toEqual([0, 1]));
    expect((await recall(uid, 'football')).map(item => item.id)).toEqual([memory.id]);
  });

  it('backfill cannot overwrite an index for a later edit or restore its old array snapshot', async () => {
    const uid = 'index-backfill'; configure(uid);
    const memory = addMemory({ userId: uid, type: 'fact', content: 'banana backfill old', keywords: ['banana'], confidence: 1, sourceInteractionId: 'synthetic-index-fixture' }, { deduplicate: false, generateEmbedding: false });
    let done!: (value: any) => void;
    vi.mocked(generateConfiguredEmbedding).mockImplementationOnce(() => new Promise(resolve => { done = resolve; }));
    const pending = backfillEmbeddings(uid);
    expect((await request(uid, memory.id, 'PUT', { content: 'football backfill new', keywords: ['football'] })).status).toBe(200);
    done({ provider: 'openai', model: 'synthetic-embedding', vector: [1, 0] });
    expect(await pending).toBe(0);
    expect(memory.embedding).toEqual([0, 1]);
  });

  it('advances across bounded backfill batches when the gateway returns a canonical alias', async () => {
    const uid = 'index-canonical-alias'; configure(uid);
    const memories = [1, 2, 3].map(n => addMemory({ userId: uid, type: 'fact', content: `alias fixture ${n}`,
      keywords: ['alias'], confidence: 1, sourceInteractionId: 'index-alias-fixture' }, { generateEmbedding: false, deduplicate: false }));
    vi.mocked(generateConfiguredEmbedding).mockImplementation(async () => ({ provider: 'openai', model: 'canonical-embedding', route: 'primary', vector: [1, 0] }));
    try {
      for (let i = 0; i < 3; i++) expect(await backfillEmbeddings(uid, { limit: 1 })).toBe(1);
      expect(await backfillEmbeddings(uid, { limit: 1 })).toBe(0);
      await flushDBOrThrow();
      for (const m of memories) expect((await querySQL<{ embeddingNamespace: string }>('SELECT embeddingNamespace FROM memories WHERE id=?', [m.id]))[0].embeddingNamespace).toContain('canonical-embedding');
    } finally { vi.mocked(generateConfiguredEmbedding).mockImplementation(async text => ({ provider: 'openai', model: 'synthetic-embedding', vector: text.includes('football') ? [0, 1] : [1, 0] })); }
  });

  it('stops maintenance at a provider failure and reports unfinished indexes', async () => {
    const uid = 'index-rate-limit'; configure(uid);
    for (let i = 0; i < 4; i++) addMemory({ userId: uid, type: 'fact', content: `rate limit fixture ${i}`,
      keywords: ['index'], confidence: 1, sourceInteractionId: 'index-limit-fixture' }, { generateEmbedding: false, deduplicate: false });
    vi.mocked(generateConfiguredEmbedding).mockRejectedValueOnce(new Error('Lumi Official API request failed (429): rate limited'));
    const progress = { attempted: 0, indexed: 0, failed: 0, stale: 0, remaining: 0, errors: {} };
    expect(await backfillEmbeddings(uid, { limit: 4, progress })).toBe(0);
    expect(progress).toMatchObject({ attempted: 1, failed: 1, remaining: 4, errors: { http_429: 1 } });
    expect(vi.mocked(generateConfiguredEmbedding)).toHaveBeenCalledWith(expect.any(String), uid, expect.objectContaining({ allowFallback: false }));
  });

  it.each(['content', 'owner', 'scope', 'rerank-failure'])('rechecks %s after a delayed rerank', async change => {
    const uid = `rerank-current-${change}`; configure(uid, true);
    const changed = seed(uid, 'banana old candidate');
    const kept = seed(uid, 'banana current candidate', 0.9);
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { reached = resolve; });
    vi.mocked(rerankConfiguredDocuments).mockImplementationOnce(async () => {
      reached(); await gate;
      if (change === 'rerank-failure') throw new Error('Synthetic rerank failure');
      return { provider: 'siliconflow', model: 'synthetic-rerank', items: [{ index: 0, score: 1 }, { index: 1, score: 0.9 }] };
    });
    const pending = recall(uid); await started;
    if (change === 'content') expect((await request(uid, changed.id, 'PUT', { content: 'football updated candidate', keywords: ['football'] })).status).toBe(200);
    else if (change === 'owner') { changed.userId = 'another-synthetic-user'; writeDB(readDB()); }
    else if (change === 'scope') { changed.domain = 'work'; changed.orgId = 'another-scope'; writeDB(readDB()); }
    else expect((await request(uid, changed.id, 'DELETE')).status).toBe(200);
    release(); expect((await pending).map(item => item.id)).toEqual([kept.id]);
  });

  it('cancels a delayed rerank without returning candidates or updating retrieval counters', async () => {
    const uid = 'rerank-cancel'; configure(uid, true);
    const memory = seed(uid, 'banana cancel candidate'); seed(uid, 'banana cancel other');
    const controller = new AbortController();
    vi.mocked(rerankConfiguredDocuments).mockImplementationOnce(async () => {
      controller.abort();
      return { provider: 'siliconflow', model: 'synthetic-rerank', items: [] };
    });
    await expect(recall(uid, 'banana', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(memory.retrieveCount).toBe(0);
  });

  it('preserves keyword recall for legacy schema and rejects corrupted persisted index metadata', async () => {
    const uid = 'index-legacy'; configure(uid);
    const memory = seed(uid, 'banana legacy row');
    await flushDBOrThrow();
    for (const column of ['embedding', 'embeddingNamespace', 'embeddingContentHash']) await runSQL(`ALTER TABLE memories DROP COLUMN ${column}`);
    await closeDatabase(); await initDatabase();
    expect((await querySQL<{ name: string }>('PRAGMA table_info(memories)')).map(item => item.name)).toEqual(expect.arrayContaining(['embedding', 'embeddingNamespace', 'embeddingContentHash']));
    expect(readDB().memories.find(item => item.id === memory.id)?.embedding).toBeUndefined();
    expect((await recall(uid, 'banana')).map(item => item.id)).toEqual([memory.id]);
    await flushDBOrThrow();
    await runSQL('UPDATE memories SET embedding = ?, embeddingNamespace = ?, embeddingContentHash = ? WHERE id = ?', ['[1,0]', '{broken-json', 'invalid', memory.id]);
    await closeDatabase(); await initDatabase();
    expect(readDB().memories.find(item => item.id === memory.id)?.embedding).toBeUndefined();
    expect((await recall(uid, 'banana')).map(item => item.id)).toEqual([memory.id]);
  });
});
