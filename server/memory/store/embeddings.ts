import { Memory } from '../types';

import { generateConfiguredEmbedding, getEmbeddingRoute, type EmbeddingResult } from '../../llm/embedding_provider';

import { isProviderLocalOnly, isStrictPrivacy } from '../../config/privacy';
import { hasCurrentMemoryEmbedding, invalidateMemoryEmbedding, memoryEmbeddingInputHash } from '../embedding_identity';
import { isTestMemory } from '../provenance';
import { runSerializedMutation } from '../../persistence/durable_scope_mutation';

import { getMemoryStore, saveMemoryStore } from './state';
import { isOperationalTraceMemory, matchesMemoryScope, isMemoryAvatarScoped } from './evidence';

/** Bounded cache keyed by user, actual vector space and input text. */
const embeddingCache = new Map<string, EmbeddingResult>();

const EMBEDDING_CACHE_MAX = 500;

// A gateway may return its canonical model name for a configured alias. Keep
// that identity bound to the exact user/selection, never to a fallback route.
const resolvedEmbeddingRoutes = new Map<string, { provider: string; model: string }>();

function embeddingRouteIdentity(userId: string) {
  const primary = getEmbeddingRoute(userId).primary;
  return resolvedEmbeddingRoutes.get(JSON.stringify([userId, primary.provider, primary.model])) || primary;
}

function cacheEmbedding(key: string, result: EmbeddingResult) {
  if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
    const first = embeddingCache.keys().next().value;
    if (first) embeddingCache.delete(first);
  }
  embeddingCache.set(key, result);
}

function embeddingCacheKey(userId: string, provider: string, model: string, text: string): string {
  return JSON.stringify([userId, provider, model, text]);
}

export function embeddingNamespace(result: EmbeddingResult): NonNullable<Memory['embeddingNamespace']> {
  return { provider: result.provider, model: result.model, dimensions: result.vector.length };
}

export async function generateEmbeddingWithIdentity(text: string, userId = 'anonymous', options: { signal?: AbortSignal; allowFallback?: boolean; onError?: (error: unknown) => void } = {}): Promise<EmbeddingResult | null> {
  options.signal?.throwIfAborted();
  const route = getEmbeddingRoute(userId);
  // Only the currently selected primary identity can satisfy a cache read.
  // A fallback vector is retained under its actual identity, never the primary route.
  const routeKey = embeddingCacheKey(userId, route.primary.provider, route.primary.model, text);
  const cached = !isStrictPrivacy() || isProviderLocalOnly(route.primary.provider)
    ? embeddingCache.get(routeKey) : undefined;
  if (cached) return cached;

  try {
    const result = await generateConfiguredEmbedding(text, userId, options);
    options.signal?.throwIfAborted();
    cacheEmbedding(embeddingCacheKey(userId, result.provider, result.model, text), result);
    if (result.route === 'primary') {
      if (resolvedEmbeddingRoutes.size >= EMBEDDING_CACHE_MAX) resolvedEmbeddingRoutes.delete(resolvedEmbeddingRoutes.keys().next().value!);
      resolvedEmbeddingRoutes.set(JSON.stringify([userId, route.primary.provider, route.primary.model]), { provider: result.provider, model: result.model });
      cacheEmbedding(routeKey, result);
    }
    return result;
  } catch (error) {
    options.signal?.throwIfAborted();
    options.onError?.(error);
    return null;
  }
}

/** Async background embedding generation — updates memory in-place */
export async function attachEmbedding(memory: Memory): Promise<void> {
  if (hasCurrentMemoryEmbedding(memory)) return;
  const inputHash = memoryEmbeddingInputHash(memory);
  const text = `${memory.type}: ${memory.content} ${memory.keywords.join(' ')}`;
  const result = await generateEmbeddingWithIdentity(text, memory.userId);
  if (result) {
    try {
      const all = getMemoryStore();
      const existing = all.find(m => m.id === memory.id);
      if (existing && memoryEmbeddingInputHash(existing) === inputHash) {
        existing.embedding = result.vector;
        existing.embeddingNamespace = embeddingNamespace(result);
        existing.embeddingContentHash = inputHash;
        saveMemoryStore(all);
      }
    } catch {}
  }
}

/** Clear the old index synchronously; background work can only attach to this content. */
export function refreshMemoryEmbedding(memory: Memory): void {
  invalidateMemoryEmbedding(memory);
  void attachEmbedding(memory).catch(() => {});
}

export interface MemoryIndexProgress { attempted: number; indexed: number; failed: number; stale: number; remaining: number; errors: Record<string, number> }

/** Explicitly migrate missing, legacy or differently configured vector spaces. */
type MemoryIndexOptions = { limit?: number; signal?: AbortSignal; domain?: string; orgId?: string; progress?: MemoryIndexProgress };

export function backfillEmbeddings(userId?: string, options: MemoryIndexOptions = {}): Promise<number> {
  return runSerializedMutation(`memory_index:${userId || 'all'}`, () => runMemoryIndexBackfill(userId, options));
}

async function runMemoryIndexBackfill(userId: string | undefined, options: MemoryIndexOptions): Promise<number> {
  const all = getMemoryStore();
  const needsIndex = (m: Memory) => {
    if (userId && m.userId !== userId) return false;
    if (!matchesMemoryScope(m, options.domain, options.orgId)) return false;
    if (isTestMemory(m) || isOperationalTraceMemory(m) || isMemoryAvatarScoped(m) || m.nodeType === 'branch') return false;
    const primary = embeddingRouteIdentity(m.userId);
    return !hasCurrentMemoryEmbedding(m) || !m.embedding || !m.embeddingNamespace
      || m.embeddingNamespace.provider !== primary.provider
      || m.embeddingNamespace.model !== primary.model
      || m.embeddingNamespace.dimensions !== m.embedding.length;
  };
  const progress = options.progress;
  const targets = all.filter(needsIndex).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, options.limit ?? Infinity);
  let count = 0;
  let lastRequestAt = 0;
  for (const m of targets) {
    options.signal?.throwIfAborted();
    if (!needsIndex(m)) continue;
    // Background maintenance shares the official gateway's user-wide quota
    // with foreground chat. Keep it below 40 requests/minute and stop on the
    // first provider failure rather than flooding fallback routes.
    const delay = 1500 - (Date.now() - lastRequestAt);
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    options.signal?.throwIfAborted();
    lastRequestAt = Date.now();
    if (progress) progress.attempted++;
    const inputHash = memoryEmbeddingInputHash(m);
    const result = await generateEmbeddingWithIdentity(`${m.type}: ${m.content} ${m.keywords.join(' ')}`, m.userId, { signal: options.signal, allowFallback: false, onError: error => {
      if (!progress) return;
      const message = error instanceof Error ? error.message : '';
      const status = message.match(/(?:failed|HTTP)\s*\(?([45]\d\d)/i)?.[1];
      const code = status ? `http_${status}` : /timed? ?out|timeout/i.test(message) ? 'timeout' : 'provider_error';
      progress.errors[code] = (progress.errors[code] || 0) + 1;
    } });
    const currentStore = getMemoryStore();
    const current = currentStore.find(memory => memory.id === m.id);
    if (result && current && memoryEmbeddingInputHash(current) === inputHash) {
      current.embedding = result.vector;
      current.embeddingNamespace = embeddingNamespace(result);
      current.embeddingContentHash = inputHash;
      saveMemoryStore(currentStore);
      count++;
      if (progress) progress.indexed++;
    } else if (progress) {
      if (!result) progress.failed++; else progress.stale++;
    }
    if (!result) break;
  }
  if (progress) progress.remaining = getMemoryStore().filter(needsIndex).length;
  return count;
}
