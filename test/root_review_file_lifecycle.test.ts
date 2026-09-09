import { makeApp, JWT_SECRET } from './helpers';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readDB } from '../db_layer';
import { addMember, createOrg, getKbArticle, getKbEmbeddings, listKbArticles } from '../server/org/db';
import { generateConfiguredEmbedding } from '../server/llm/embedding_provider';
import { hasCurrentMemoryEmbedding } from '../server/memory/embedding_identity';

vi.mock('../server/llm/embedding_provider', async importOriginal => ({
  ...await importOriginal<typeof import('../server/llm/embedding_provider')>(),
  generateConfiguredEmbedding: vi.fn(async () => ({ vector: [1, 0], provider: 'synthetic', model: 'offline-fixture' })),
}));

describe('file lifecycle owns its organization article during indexing', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  beforeAll(async () => {
    app = await makeApp();
    app.apiRouter.use('/', (await import('../routes/files')).default);
  });
  afterAll(() => app.cleanup());

  it('deleting a file while its first embedding is pending also deletes the newly created article', async () => {
    const uid = 'synthetic-file-lifecycle-owner';
    const org = createOrg('Synthetic file lifecycle', 'synthetic-file-lifecycle', uid);
    addMember(org.id, uid, 'owner');
    const headers = { 'Content-Type': 'application/json', Cookie: `token=${jwt.sign({ uid, username: uid, orgId: org.id, orgRole: 'owner' }, JWT_SECRET)}` };
    let release!: (value: any) => void;
    vi.mocked(generateConfiguredEmbedding).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = fetch(`${app.url}/api/files/save?domain=work&orgId=${org.id}`, {
      method: 'POST', headers, body: JSON.stringify({ name: 'cancelled-source.txt', content: 'Synthetic material that the owner deletes during indexing.' }),
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const article = listKbArticles(org.id)[0];
    expect(article).toBeDefined();
    const deletion = await fetch(`${app.url}/api/files/delete/cancelled-source.txt?domain=work&orgId=${org.id}`, { method: 'DELETE', headers });
    expect(deletion.status).toBe(200);
    release({ vector: [1, 0], provider: 'synthetic', model: 'offline-fixture' });
    const saveResponse = await pending;
    await saveResponse.json();
    expect(readDB().knowledgeFiles.filter((row: any) => row.orgId === org.id)).toEqual([]);
    expect(getKbArticle(org.id, article.id)).toBeUndefined();
    expect(getKbEmbeddings(article.id)).toEqual([]);
    expect(saveResponse.ok).toBe(false);
  });

  it('a renamed personal source does not reuse a verified embedding receipt after invalidating the actual vectors', async () => {
    const uid = 'synthetic-personal-rename-owner';
    const headers = { 'Content-Type': 'application/json', Cookie: `token=${jwt.sign({ uid, username: uid }, JWT_SECRET)}` };
    const saved = await fetch(`${app.url}/api/files/save?domain=personal`, {
      method: 'POST', headers, body: JSON.stringify({ name: 'before-rename.txt', content: 'A small synthetic source for rename index ownership.' }),
    });
    expect(saved.status).toBe(200);
    const ids = readDB().memories.filter((memory: any) => memory.userId === uid).map((memory: any) => memory.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(readDB().memories.filter((memory: any) => ids.includes(memory.id)).every(hasCurrentMemoryEmbedding)).toBe(true);
    const renamed = await fetch(`${app.url}/api/files/rename?domain=personal`, {
      method: 'POST', headers, body: JSON.stringify({ id: 'before-rename.txt', newName: 'after-rename.txt' }),
    });
    expect(renamed.status).toBe(200);
    const meta = readDB().knowledgeFiles.find((row: any) => row.userId === uid && row.filename === 'after-rename.txt');
    const currentMemories = readDB().memories.filter((memory: any) => ids.includes(memory.id));
    if (meta.ingestionManifest.chunks.every((chunk: any) => chunk.embeddingStatus === 'verified')) {
      expect(currentMemories.every(hasCurrentMemoryEmbedding)).toBe(true);
    }
    const reindexed = await fetch(`${app.url}/api/files/ingest?domain=personal`, {
      method: 'POST', headers, body: JSON.stringify({ fileId: 'after-rename.txt', agentId: 'lumi' }),
    });
    expect(reindexed.status).toBe(200);
    expect(readDB().memories.filter((memory: any) => memory.userId === uid).length).toBe(ids.length);
    expect(readDB().memories.filter((memory: any) => memory.userId === uid).every(hasCurrentMemoryEmbedding)).toBe(true);
  });

  it('a personal file deleted during indexing is not reported as saved by its late request', async () => {
    const uid = 'synthetic-personal-delete-owner';
    const headers = { 'Content-Type': 'application/json', Cookie: `token=${jwt.sign({ uid, username: uid }, JWT_SECRET)}` };
    let release!: (value: any) => void;
    vi.mocked(generateConfiguredEmbedding).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = fetch(`${app.url}/api/files/save?domain=personal`, {
      method: 'POST', headers, body: JSON.stringify({ name: 'deleted-source.txt', content: 'Synthetic personal source.' }),
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const deletion = await fetch(`${app.url}/api/files/delete/deleted-source.txt?domain=personal`, { method: 'DELETE', headers });
    expect(deletion.status).toBe(200);
    release({ vector: [1, 0], provider: 'synthetic', model: 'offline-fixture' });
    expect((await pending).status).toBe(409);
    expect(readDB().memories.filter((memory: any) => memory.userId === uid)).toEqual([]);
    expect(readDB().knowledgeFiles.filter((file: any) => file.userId === uid)).toEqual([]);
  });
});
