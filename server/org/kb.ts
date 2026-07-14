/**
 * Org Knowledge Base: CRUD, chunking, indexing, hybrid search, and health stats.
 */

import * as EDB from './db';
import { logAudit } from './db';
import { generateEmbedding, cosineSimilarity } from '../memory/store';
import { getRerankSelection, rerankConfiguredDocuments } from '../llm/rerank_provider';

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
  categoryBreakdown: Array<{ category: string; count: number }>;
  statusBreakdown: Array<{ status: string; count: number }>;
  articleHealth: Array<{
    articleId: string;
    chunks: number;
    indexed: boolean;
    stale: boolean;
    updatedAt: string;
    lastIndexedAt: string | null;
  }>;
}

interface SearchOptions {
  limit?: number;
  category?: string;
  status?: string;
  userId?: string;
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
  data: { title: string; content: string; category?: string; tags?: string[]; status?: 'draft' | 'published' }
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
  indexArticle(orgId, article.id).catch(err => {
    console.error(`[KB] Failed to index article ${article.id}:`, err.message);
  });
  return article;
}

export function updateArticle(
  orgId: string,
  userId: string,
  articleId: string,
  updates: { title?: string; content?: string; category?: string; tags?: string[]; status?: 'draft' | 'published' | 'archived' }
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
      EDB.deleteKbEmbeddings(articleId);
      indexArticle(orgId, articleId).catch(err => {
        console.error(`[KB] Failed to re-index article ${articleId}:`, err.message);
      });
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
  const articleHealth = articles.map(article => {
    const chunks = embeddingsByArticle.get(article.id) || [];
    const lastIndexedAt = chunks
      .map(chunk => chunk.createdAt)
      .filter(Boolean)
      .sort()
      .at(-1) || null;
    const indexed = chunks.length > 0;
    const stale = indexed && lastIndexedAt !== null
      ? new Date(lastIndexedAt).getTime() < new Date(article.updatedAt).getTime()
      : false;

    categoryCounts.set(article.category || 'general', (categoryCounts.get(article.category || 'general') || 0) + 1);
    statusCounts.set(article.status || 'published', (statusCounts.get(article.status || 'published') || 0) + 1);

    return {
      articleId: article.id,
      chunks: chunks.length,
      indexed,
      stale,
      updatedAt: article.updatedAt,
      lastIndexedAt,
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

function chunkText(text: string): string[] {
  const cleaned = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!cleaned) return [];
  if (cleaned.length <= CHUNK_SIZE) return [cleaned];

  const chunks: string[] = [];
  let start = 0;
  while (start < cleaned.length) {
    const hardEnd = Math.min(start + CHUNK_SIZE, cleaned.length);
    let breakPoint = hardEnd;

    if (hardEnd < cleaned.length) {
      const windowStart = Math.max(start + Math.floor(CHUNK_SIZE * 0.55), hardEnd - 160);
      const slice = cleaned.slice(windowStart, Math.min(hardEnd + 120, cleaned.length));
      const matches = [...slice.matchAll(/[。！？!?；;\n]/g)];
      const last = matches.at(-1);
      if (last?.index !== undefined) {
        breakPoint = windowStart + last.index + 1;
      }
    }

    const chunk = cleaned.slice(start, breakPoint).trim();
    if (chunk.length > 10) chunks.push(chunk);
    if (breakPoint >= cleaned.length) break;

    const nextStart = Math.max(0, breakPoint - CHUNK_OVERLAP);
    start = nextStart <= start ? breakPoint : nextStart;
  }
  return chunks;
}

// Indexing

export async function indexArticle(orgId: string, articleId: string): Promise<number> {
  const article = EDB.getKbArticle(orgId, articleId);
  if (!article) return 0;

  EDB.deleteKbEmbeddings(articleId);

  const chunks = chunkText(article.content);
  if (chunks.length === 0) return 0;

  const tags = parseTags(article.tags).join(', ');
  const contextPrefix = [
    `Title: ${article.title}`,
    `Category: ${article.category || 'general'}`,
    tags ? `Tags: ${tags}` : '',
  ].filter(Boolean).join('\n');

  let indexed = 0;
  for (let i = 0; i < chunks.length; i++) {
    try {
      const embedding = await generateEmbedding(`${contextPrefix}\n\n${chunks[i]}`, article.authorId);
      if (embedding) {
        EDB.saveKbEmbedding(articleId, i, embedding, chunks[i]);
        indexed++;
      }
      if (i > 0 && i % 5 === 0) {
        await new Promise(r => setTimeout(r, 200));
      }
    } catch (err) {
      console.error(`[KB] Failed to embed chunk ${i} of article ${articleId}:`, err);
    }
  }

  if (indexed > 0) {
    logAudit({
      orgId,
      userId: article.authorId,
      action: 'kb.article.index',
      resourceType: 'kb_article',
      resourceId: articleId,
      details: { chunks: chunks.length, indexed },
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
