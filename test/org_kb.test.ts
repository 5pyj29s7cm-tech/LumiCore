import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp } from './helpers';

let cleanup = () => {};
let originalOpenAIKey: string | undefined;
let KB: typeof import('../server/org/kb');

beforeAll(async () => {
  originalOpenAIKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = '';
  const app = await makeApp();
  cleanup = app.cleanup;
  KB = await import('../server/org/kb');
});

afterAll(() => {
  if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAIKey;
  cleanup();
});

describe('Org Knowledge Base', () => {
  it('falls back to keyword search when embeddings are unavailable', async () => {
    const orgId = 'org-kb-keyword';
    const article = KB.createArticle(orgId, 'user-1', {
      title: 'Remote Access Policy',
      content: 'Employees must request approval before using remote access. VPN access requires MFA and a manager review.',
      category: 'policy',
      tags: ['security', 'vpn'],
      status: 'published',
    });

    const results = await KB.searchKnowledgeBase(orgId, 'remote access approval', 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toMatchObject({
      articleId: article.id,
      source: 'keyword',
      category: 'policy',
    });
  });

  it('reports category, status, index health, and verifiable ingestion evidence', async () => {
    const orgId = 'org-kb-stats';
    const article = KB.createArticle(orgId, 'user-1', {
      title: 'Draft Billing SOP',
      content: 'Billing files are reviewed by finance before monthly close.',
      category: 'sop',
      tags: ['finance'],
      status: 'draft',
    });

    await KB.indexArticle(orgId, article.id);
    const manifest = KB.getArticleIngestionManifest(orgId, article.id);
    const stats = KB.getStats(orgId);

    expect(stats.totalArticles).toBe(1);
    expect(stats.draftArticles).toBe(1);
    expect(stats.missingIndexArticles).toBe(1);
    expect(stats.categoryBreakdown).toContainEqual({ category: 'sop', count: 1 });
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      sourceId: `org:${orgId}:article:${article.id}`,
    });
    expect(manifest?.sourceContentHash).toHaveLength(64);
    expect(manifest?.coverage.blockers.length).toBeGreaterThan(0);
    expect(stats.articleHealth[0]).toMatchObject({
      articleId: article.id,
      indexed: false,
      stale: false,
      verified: false,
    });
    expect(stats.articleHealth[0].ingestionStatus).not.toBe('missing');
    expect(stats.fullyAbsorbed).toBe(false);
  });

  it('respects category and status filters during search', async () => {
    const orgId = 'org-kb-filter';
    KB.createArticle(orgId, 'user-1', {
      title: 'Published Handbook',
      content: 'The onboarding handbook contains the published travel process.',
      category: 'policy',
      tags: ['onboarding'],
      status: 'published',
    });
    KB.createArticle(orgId, 'user-1', {
      title: 'Draft Travel Notes',
      content: 'Draft notes mention the travel process but are not ready.',
      category: 'sop',
      tags: ['travel'],
      status: 'draft',
    });

    const results = await KB.searchKnowledgeBase(orgId, 'travel process', {
      limit: 10,
      category: 'policy',
      status: 'published',
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: 'Published Handbook',
      status: 'published',
      category: 'policy',
    });
  });
});
