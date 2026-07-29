/**
 * Org Knowledge Base: CRUD, chunking, indexing, hybrid search, and health stats.
 */

import * as EDB from './db';
import { logAudit } from './db';
import { generateEmbedding, cosineSimilarity } from '../memory/store';
import { generateConfiguredEmbedding } from '../llm/embedding_provider';
import { getRerankSelection, rerankConfiguredDocuments } from '../llm/rerank_provider';
import {
  buildKnowledgeIngestionManifest,
  chunkKnowledgeText,
  evaluateKnowledgeManifest,
  evaluateKnowledgeRetrievalCases,
  hashKnowledgeContent,
  markKnowledgeManifestStale,
  type KnowledgeChunkManifest,
  type KnowledgeIngestionManifest,
  type KnowledgeRetrievalCaseEvidence,
} from '../knowledge/ingestion_manifest';

export interface KnowledgeSearchResult {
  articleId: string;
  title: string;
  chunk: string;
  score: number;
  source: 'semantic' | 'keyword';
  category: string;
  status: string;
  tags: string[];
  updatedAt: string;
  chunkIndex?: number;
}

export interface KnowledgeStats {
  totalArticles: number;
  publishedArticles: number;
  draftArticles: number;
  archivedArticles: number;
  totalChunks: number;
  indexedArticles: number;
  missingIndexArticles: number;
  staleArticles: number;
  verifiedArticles: number;
  unverifiedArticles: number;
  failedArticles: number;
  fullyAbsorbed: boolean;
  categoryBreakdown: Array<{ category: string; count: number }>;
  statusBreakdown: Array<{ status: string; count: number }>;
  articleHealth: Array<{
    articleId: string;
    chunks: number;
    indexed: boolean;
    stale: boolean;
    updatedAt: string;
    lastIndexedAt: string | null;
    ingestionStatus: KnowledgeIngestionManifest['status'] | 'missing';
    verified: boolean;
    coverage?: KnowledgeIngestionManifest['coverage'];
  }>;
}

interface SearchOptions {
  limit?: number;
  category?: string;
  status?: string;
  userId?: string;
}

interface ArticleMutationOptions {
  index?: boolean;
}

function parseIngestionManifest(value: unknown): KnowledgeIngestionManifest | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && (parsed as any).schemaVersion === 1
      ? parsed as KnowledgeIngestionManifest
      : null;
  } catch {
    return null;
  }
}

export function getArticleIngestionManifest(
  orgId: string,
  articleId: string,
): KnowledgeIngestionManifest | null {
  const article = EDB.getKbArticle(orgId, articleId);
  if (!article) return null;
  const manifest = parseIngestionManifest(article.ingestionManifest);
  if (!manifest) return null;
  const current = evaluateKnowledgeManifest(manifest, hashArticleRevision(article.content));
  return { ...manifest, ...current };
}

function hashArticleRevision(content: string): string {
  return hashKnowledgeContent(content);
}

// Article CRUD

export function listArticles(orgId: string, filters?: { category?: string; status?: string }) {
  return EDB.listKbArticles(orgId, filters)
    .slice()
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function getArticle(orgId: string, articleId: string) {
  return EDB.getKbArticle(orgId, articleId);
}

export function createArticle(
  orgId: string,
  authorId: string,
  data: { title: string; content: string; category?: string; tags?: string[]; status?: 'draft' | 'published' },
  options: ArticleMutationOptions = {},
) {
  const article = EDB.createKbArticle(orgId, authorId, normalizeArticleInput(data));
  logAudit({
    orgId,
    userId: authorId,
    action: 'kb.article.create',
    resourceType: 'kb_article',
    resourceId: article.id,
    details: { title: article.title, category: article.category, status: article.status },
  });
  if (options.index !== false) {
    indexArticle(orgId, article.id).catch(err => {
      console.error(`[KB] Failed to index article ${article.id}:`, err.message);
    });
  }
  return article;
}

export function updateArticle(
  orgId: string,
  userId: string,
  articleId: string,
  updates: { title?: string; content?: string; category?: string; tags?: string[]; status?: 'draft' | 'published' | 'archived' },
  options: ArticleMutationOptions = {},
) {
  const dbUpdates: any = normalizeArticleInput(updates);
  if (updates.tags) dbUpdates.tags = JSON.stringify(normalizeTags(updates.tags));
  const article = EDB.updateKbArticle(orgId, articleId, dbUpdates);
  if (article) {
    logAudit({
      orgId,
      userId,
      action: 'kb.article.update',
      resourceType: 'kb_article',
      resourceId: articleId,
      details: updates,
    });
    if (updates.content || updates.title || updates.category || updates.tags) {
      const priorManifest = parseIngestionManifest(article.ingestionManifest);
      if (priorManifest && updates.content) {
        EDB.setKbArticleIngestionManifest(
          orgId,
          articleId,
          JSON.stringify(markKnowledgeManifestStale(priorManifest, article.content)),
        );
      }
      if (options.index !== false) {
        indexArticle(orgId, articleId).catch(err => {
          console.error(`[KB] Failed to re-index article ${articleId}:`, err.message);
        });
      }
    }
  }
  return article;
}

export function deleteArticle(orgId: string, userId: string, articleId: string) {
  const result = EDB.deleteKbArticle(orgId, articleId);
  if (result) {
    logAudit({
      orgId,
      userId,
      action: 'kb.article.delete',
      resourceType: 'kb_article',
      resourceId: articleId,
    });
  }
  return result;
}

// Stats

export function getStats(orgId: string): KnowledgeStats {
  const articles = listArticles(orgId);
  const allEmbeddings = EDB.getAllKbEmbeddings(orgId);
  const embeddingsByArticle = new Map<string, EDB.KbEmbedding[]>();
  for (const embedding of allEmbeddings) {
    const list = embeddingsByArticle.get(embedding.articleId) || [];
    list.push(embedding);
    embeddingsByArticle.set(embedding.articleId, list);
  }

  const categoryCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  const articleHealth: KnowledgeStats['articleHealth'] = articles.map(article => {
    const chunks = embeddingsByArticle.get(article.id) || [];
    const lastIndexedAt = chunks
      .map(chunk => chunk.createdAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
    const indexed = chunks.length > 0;
    const rawManifest = parseIngestionManifest(article.ingestionManifest);
    const manifest = rawManifest
      ? { ...rawManifest, ...evaluateKnowledgeManifest(rawManifest, hashArticleRevision(article.content)) }
      : null;
    const stale = manifest?.status === 'stale' || (indexed && lastIndexedAt !== null
      ? new Date(lastIndexedAt).getTime() < new Date(article.updatedAt).getTime()
      : false);

    categoryCounts.set(article.category || 'general', (categoryCounts.get(article.category || 'general') || 0) + 1);
    statusCounts.set(article.status || 'published', (statusCounts.get(article.status || 'published') || 0) + 1);

    return {
      articleId: article.id,
      chunks: chunks.length,
      indexed,
      stale,
      updatedAt: article.updatedAt,
      lastIndexedAt,
      ingestionStatus: manifest?.status || 'missing',
      verified: manifest?.coverage.verified === true,
      coverage: manifest?.coverage,
    };
  });

  return {
    totalArticles: articles.length,
    publishedArticles: statusCounts.get('published') || 0,
    draftArticles: statusCounts.get('draft') || 0,
    archivedArticles: statusCounts.get('archived') || 0,
    totalChunks: allEmbeddings.length,
    indexedArticles: articleHealth.filter(item => item.indexed).length,
    missingIndexArticles: articleHealth.filter(item => !item.indexed).length,
    staleArticles: articleHealth.filter(item => item.stale).length,
    verifiedArticles: articleHealth.filter(item => item.verified).length,
    unverifiedArticles: articleHealth.filter(item => !item.verified && item.ingestionStatus !== 'failed').length,
    failedArticles: articleHealth.filter(item => item.ingestionStatus === 'failed').length,
    fullyAbsorbed: articleHealth.length > 0 && articleHealth.every(item => item.verified),
    categoryBreakdown: [...categoryCounts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
    statusBreakdown: [...statusCounts.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status)),
    articleHealth,
  };
}

// Chunking

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 120;

// Indexing

const articleIndexGenerations = new Map<string, number>();

export async function indexArticle(orgId: string, articleId: string): Promise<number> {
  const article = EDB.getKbArticle(orgId, articleId);
  if (!article) return 0;
  const generation = (articleIndexGenerations.get(articleId) || 0) + 1;
  articleIndexGenerations.set(articleId, generation);
  const sourceContent = String(article.content || '');
  const sourceRevision = hashArticleRevision(sourceContent);
  const chunks = chunkKnowledgeText(sourceContent, {
    maxChunkSize: CHUNK_SIZE,
    overlapSize: CHUNK_OVERLAP,
  });

  const pendingChunks: KnowledgeChunkManifest[] = chunks.map(chunk => ({
    index: chunk.index,
    start: chunk.start,
    end: chunk.end,
    charCount: chunk.charCount,
    contentHash: chunk.contentHash,
    stored: false,
    embeddingStatus: 'pending',
    citationKey: `org:${orgId}:article:${articleId}#chunk:${chunk.index + 1}/${chunks.length}#sha256:${chunk.contentHash}`,
  }));
  const pendingBase = buildKnowledgeIngestionManifest({
    sourceId: `org:${orgId}:article:${articleId}`,
    content: sourceContent,
    chunks: pendingChunks,
    extraction: { status: sourceContent.trim() ? 'verified' : 'failed', method: 'org-article' },
  });
  const pendingManifest: KnowledgeIngestionManifest = {
    ...pendingBase,
    status: chunks.length > 0 ? 'pending' : 'failed',
    coverage: {
      ...pendingBase.coverage,
      verified: false,
      blockers: chunks.length > 0 ? ['indexing_in_progress'] : pendingBase.coverage.blockers,
    },
  };
  EDB.setKbArticleIngestionManifest(orgId, articleId, JSON.stringify(pendingManifest));
  if (chunks.length === 0) {
    EDB.deleteKbEmbeddings(articleId);
    return 0;
  }

  const tags = parseTags(article.tags).join(', ');
  const contextPrefix = [
    `Title: ${article.title}`,
    `Category: ${article.category || 'general'}`,
    tags ? `Tags: ${tags}` : '',
  ].filter(Boolean).join('\n');

  const embeddingResults: Array<
    | Awaited<ReturnType<typeof generateConfiguredEmbedding>>
    | { error: string }
  > = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      embeddingResults[i] = await generateConfiguredEmbedding(
        `${contextPrefix}\n\n${chunks[i].text}`,
        article.authorId,
      );
      if (i > 0 && i % 5 === 0) {
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (err: any) {
      embeddingResults[i] = { error: String(err?.message || err || 'embedding_failed').slice(0, 300) };
      console.error(`[KB] Failed to embed chunk ${i} of article ${articleId}:`, err);
    }
  }

  const latest = EDB.getKbArticle(orgId, articleId);
  if (!latest
    || articleIndexGenerations.get(articleId) !== generation
    || hashArticleRevision(latest.content) !== sourceRevision) {
    return 0;
  }

  EDB.deleteKbEmbeddings(articleId);
  const chunkManifests: KnowledgeChunkManifest[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embeddingResult = embeddingResults[i];
    const embedding = embeddingResult && !('error' in embeddingResult)
      ? embeddingResult
      : null;
    const error = embeddingResult && 'error' in embeddingResult
      ? embeddingResult.error
      : undefined;
    const row = embedding
      ? EDB.saveKbEmbedding(
        articleId,
        i,
        embedding.vector,
        chunk.text,
        `${embedding.provider}/${embedding.model}`,
      )
      : null;
    chunkManifests.push({
      index: chunk.index,
      start: chunk.start,
      end: chunk.end,
      charCount: chunk.charCount,
      contentHash: chunk.contentHash,
      memoryId: row?.id,
      stored: Boolean(row),
      embeddingStatus: embedding ? 'verified' : 'failed',
      embeddingProvider: embedding?.provider,
      embeddingModel: embedding?.model,
      embeddingDimensions: embedding?.vector.length,
      citationKey: `org:${orgId}:article:${articleId}#chunk:${i + 1}/${chunks.length}#sha256:${chunk.contentHash}`,
      error,
    });
  }

  let manifest = buildKnowledgeIngestionManifest({
    sourceId: `org:${orgId}:article:${articleId}`,
    content: sourceContent,
    chunks: chunkManifests,
    extraction: { status: 'verified', method: 'org-article' },
  });
  const sampleIndexes = chunks.length <= 12
    ? chunks.map(chunk => chunk.index)
    : Array.from(new Set(Array.from({ length: 12 }, (_, index) => Math.round(index * (chunks.length - 1) / 11))));
  const cases: KnowledgeRetrievalCaseEvidence[] = [];
  const articleById = new Map([[article.id, latest]]);
  for (const index of sampleIndexes) {
    const probe = chunks[index].text.replace(/\s+/g, ' ').trim().slice(0, 180);
    const retrieved = await semanticSearch(orgId, probe, 5, articleById, article.authorId);
    cases.push({
      caseId: `chunk_${index + 1}`,
      expectedChunkIndexes: [index],
      retrievedMemoryIds: retrieved.flatMap(result => {
        const matched = chunkManifests[result.chunkIndex ?? -1];
        return matched?.memoryId ? [matched.memoryId] : [];
      }),
      citedChunkHashes: retrieved.flatMap(result => {
        const matched = chunkManifests[result.chunkIndex ?? -1];
        return matched?.contentHash ? [matched.contentHash] : [];
      }),
    });
  }
  const retrieval = evaluateKnowledgeRetrievalCases({ cases, chunks: chunkManifests, topK: 5 });
  const manifestWithRetrieval = { ...manifest, retrieval, updatedAt: new Date().toISOString() };
  manifest = { ...manifestWithRetrieval, ...evaluateKnowledgeManifest(manifestWithRetrieval) };

  const current = EDB.getKbArticle(orgId, articleId);
  if (!current
    || articleIndexGenerations.get(articleId) !== generation
    || hashArticleRevision(current.content) !== sourceRevision) {
    return 0;
  }
  EDB.setKbArticleIngestionManifest(orgId, articleId, JSON.stringify(manifest));
  const indexed = chunkManifests.filter(chunk => chunk.embeddingStatus === 'verified').length;

  if (indexed > 0) {
    logAudit({
      orgId,
      userId: article.authorId,
      action: 'kb.article.index',
      resourceType: 'kb_article',
      resourceId: articleId,
      details: {
        chunks: chunks.length,
        indexed,
        ingestionStatus: manifest.status,
        manifestId: manifest.manifestId,
        recallAt5: manifest.coverage.retrievalRecallAt5,
      },
    });
  }

  return indexed;
}

// Search

export async function searchKnowledgeBase(
  orgId: string,
  query: string,
  limitOrOptions: number | SearchOptions = 5
): Promise<KnowledgeSearchResult[]> {
  const options = typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : limitOrOptions;
  const limit = clampLimit(options.limit || 5);
  const normalizedQuery = String(query || '').trim();
  if (!normalizedQuery) return [];

  const articleFilters = {
    category: options.category,
    status: options.status,
  };
  const articles = listArticles(orgId, articleFilters);
  if (articles.length === 0) return [];

  const articleById = new Map(articles.map(article => [article.id, article]));
  const retrievalUserId = options.userId || 'anonymous';
  const semanticResults = await semanticSearch(orgId, normalizedQuery, limit * 4, articleById, retrievalUserId);
  const keywordResults = keywordSearch(articles, normalizedQuery, limit * 2);

  const merged = new Map<string, KnowledgeSearchResult>();
  for (const result of [...semanticResults, ...keywordResults]) {
    const key = `${result.articleId}:${result.chunkIndex ?? result.chunk.slice(0, 80)}`;
    const existing = merged.get(key);
    if (!existing || result.score > existing.score || existing.source === 'keyword') {
      merged.set(key, result);
    }
  }

  const candidates = [...merged.values()]
    .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(limit * 4, 20));

  const rerank = getRerankSelection(retrievalUserId);
  if (rerank.enabled && candidates.length > 1) {
    try {
      const ranked = await rerankConfiguredDocuments(
        normalizedQuery,
        candidates.map(result => `${result.title}\n${result.chunk}`),
        retrievalUserId,
        Math.max(limit, rerank.topN),
      );
      const seen = new Set<number>();
      const reordered = ranked.items
        .map(item => {
          seen.add(item.index);
          const result = candidates[item.index];
          return result ? { ...result, score: item.score } : null;
        })
        .filter((result): result is KnowledgeSearchResult => result !== null);
      reordered.push(...candidates.filter((_, index) => !seen.has(index)));
      return reordered.slice(0, limit);
    } catch (error: any) {
      console.warn(`[KB] Rerank unavailable; preserving hybrid search order: ${error?.message || String(error)}`);
    }
  }

  return candidates.slice(0, limit);
}

async function semanticSearch(
  orgId: string,
  query: string,
  limit: number,
  articleById: Map<string, EDB.KbArticle>,
  userId: string,
): Promise<KnowledgeSearchResult[]> {
  const allEmbeddings = EDB.getAllKbEmbeddings(orgId)
    .filter(embedding => articleById.has(embedding.articleId));
  if (allEmbeddings.length === 0) return [];

  let queryEmbedding: number[] | null = null;
  try {
    queryEmbedding = await generateEmbedding(query, userId);
  } catch {
    return [];
  }
  if (!queryEmbedding) return [];

  return allEmbeddings
    .map(embedding => {
      let embeddingArr: number[];
      try {
        embeddingArr = JSON.parse(embedding.embedding);
      } catch {
        return null;
      }
      const article = articleById.get(embedding.articleId);
      if (!article) return null;
      const score = cosineSimilarity(queryEmbedding!, embeddingArr);
      if (score < 0.28) return null;
      return toSearchResult(article, embedding.content, score, 'semantic', embedding.chunkIndex);
    })
    .filter((item): item is KnowledgeSearchResult => item !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function keywordSearch(articles: EDB.KbArticle[], query: string, limit: number): KnowledgeSearchResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  return articles
    .map(article => {
      const haystack = normalizeText([
        article.title,
        article.category,
        parseTags(article.tags).join(' '),
        article.content,
      ].join(' '));
      let score = 0;
      for (const token of tokens) {
        if (!token) continue;
        if (normalizeText(article.title).includes(token)) score += 5;
        if (normalizeText(article.category).includes(token)) score += 2.2;
        if (normalizeText(parseTags(article.tags).join(' ')).includes(token)) score += 2.8;
        const matches = countOccurrences(haystack, token);
        score += Math.min(matches, 8) * (token.length >= 4 ? 1.1 : 0.7);
      }
      if (score <= 0) return null;
      const normalizedScore = Math.min(0.92, 0.24 + score / Math.max(16, tokens.length * 7));
      return toSearchResult(article, makeKeywordExcerpt(article.content, tokens), normalizedScore, 'keyword');
    })
    .filter((item): item is KnowledgeSearchResult => item !== null)
    .sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

function toSearchResult(
  article: EDB.KbArticle,
  chunk: string,
  score: number,
  source: 'semantic' | 'keyword',
  chunkIndex?: number
): KnowledgeSearchResult {
  return {
    articleId: article.id,
    title: article.title,
    chunk,
    score,
    source,
    category: article.category || 'general',
    status: article.status || 'published',
    tags: parseTags(article.tags),
    updatedAt: article.updatedAt,
    chunkIndex,
  };
}

function normalizeArticleInput<T extends { title?: string; content?: string; category?: string; tags?: string[]; status?: string }>(data: T): T {
  const normalized: any = { ...data };
  if (typeof normalized.title === 'string') normalized.title = normalized.title.trim();
  if (typeof normalized.content === 'string') normalized.content = normalized.content.trim();
  if (typeof normalized.category === 'string') normalized.category = normalized.category.trim() || 'general';
  if (Array.isArray(normalized.tags)) normalized.tags = normalizeTags(normalized.tags);
  return normalized;
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map(tag => String(tag || '').trim()).filter(Boolean))].slice(0, 20);
}

function parseTags(tags: string | string[] | undefined): string[] {
  if (Array.isArray(tags)) return normalizeTags(tags);
  try {
    const parsed = JSON.parse(tags || '[]');
    return Array.isArray(parsed) ? normalizeTags(parsed) : [];
  } catch {
    return String(tags || '').split(',').map(tag => tag.trim()).filter(Boolean);
  }
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(query: string): string[] {
  const normalized = normalizeText(query);
  const words = normalized.split(/\s+/).filter(token => token.length >= 2);
  const cjk = [...normalized.matchAll(/[\u4e00-\u9fff]{2,}/g)].flatMap(match => {
    const value = match[0];
    const grams = new Set<string>([value]);
    for (let i = 0; i < value.length - 1; i++) grams.add(value.slice(i, i + 2));
    return [...grams];
  });
  return [...new Set([...words, ...cjk])].slice(0, 24);
}

function countOccurrences(value: string, token: string): number {
  if (!value || !token) return 0;
  let count = 0;
  let index = value.indexOf(token);
  while (index !== -1) {
    count++;
    index = value.indexOf(token, index + token.length);
  }
  return count;
}

function makeKeywordExcerpt(content: string, tokens: string[]): string {
  const normalizedContent = normalizeText(content);
  let hit = -1;
  for (const token of tokens) {
    hit = normalizedContent.indexOf(token);
    if (hit >= 0) break;
  }
  const start = Math.max(0, hit < 0 ? 0 : hit - 90);
  const end = Math.min(content.length, start + 360);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < content.length ? '...' : '';
  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 5;
  return Math.max(1, Math.min(50, Math.floor(limit)));
}
