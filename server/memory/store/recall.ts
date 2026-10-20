import { runRetrievalRequest } from '../../llm/retrieval_request';
import { Memory, MemoryQuery } from '../types';

import { getRerankSelection, rerankConfiguredDocuments } from '../../llm/rerank_provider';
import { isProviderLocalOnly, isStrictPrivacy } from '../../config/privacy';
import { hasCurrentMemoryEmbedding, memoryEmbeddingInputHash } from '../embedding_identity';

import { getMemoryStore, markMemoriesRetrieved } from './state';
import { matchesMemoryQueryFilters } from './evidence';
import { generateEmbeddingWithIdentity } from './embeddings';
import { strengthenAssociations, findAssociatedMemories } from './associations';
import { dedupeMemoriesInRankOrder, tokenize } from './text';

/** Cosine similarity between two vectors */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Score query against memory using language-aware token overlap, with recency bonus */
function relevanceScore(query: string, memory: Memory): number {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return memory.confidence;

  const contentLower = memory.content.toLowerCase();
  let hits = 0;
  for (const t of qTokens) {
    if (contentLower.includes(t)) { hits += 2; continue; }
    let kwHit = false;
    for (const kw of memory.keywords) {
      if (kw.toLowerCase().includes(t) || t.includes(kw.toLowerCase())) { kwHit = true; break; }
    }
    if (kwHit) hits += 1;
  }
  let score = (hits / (qTokens.length * 2)) * memory.confidence;

  // Temporal recency boost: recent memories get higher scores for cross-session continuity
  const hoursAgo = (Date.now() - new Date(memory.updatedAt).getTime()) / (1000 * 60 * 60);
  if (hoursAgo < 1) score *= 1.3;        // Last hour: strong boost
  else if (hoursAgo < 24) score *= 1.15;  // Today: moderate boost
  else if (hoursAgo < 72) score *= 1.05;  // Last 3 days: slight boost

  return score;
}

export function queryMemories(q: MemoryQuery): Memory[] {
  const all = getMemoryStore();
  let memories = all.filter(memory => matchesMemoryQueryFilters(memory, q));

  // Tier-based priority: core_identity always first, then growth, then internalized, then episodic
  const tierPriority: Record<string, number> = {
    core_identity: 0,
    growth: 1,
    internalized: 2,
    episodic: 3,
  };
  const priorityForTier = (tier: string): number => tierPriority[tier] ?? tierPriority.episodic;

  // Retrieve personality-driven retrieval biases (cross-system fusion: vector→memory)
  const typeBias = q.retrievalTypeWeights || {};
  const perspectiveBias = q.retrievalPerspectiveWeights || {};
  const hasBias = Object.keys(typeBias).length > 0 || Object.keys(perspectiveBias).length > 0;

  if (q.query) {
    const scored = memories
      .map(m => {
        let score = relevanceScore(q.query!, m);
        // Apply personality-driven retrieval biases
        if (hasBias && score > 0) {
          const typeMult = typeBias[m.type] || 1;
          const perspMult = perspectiveBias[m.perspective] || 1;
          score = +(score * typeMult * perspMult).toFixed(4);
        }
        return { m, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => {
        // Tier priority overrides score within same magnitude
        return b.score - a.score || priorityForTier(a.m.tier) - priorityForTier(b.m.tier);
      });
    memories = scored.map(({ m }) => m);
  } else {
    // Sort by tier priority, then importance, then confidence, then recency
    // Apply personality-driven perspective bias to priority sorting
    memories.sort((a, b) => {
      const tierDiff = priorityForTier(a.tier) - priorityForTier(b.tier);
      if (tierDiff !== 0) return tierDiff;
      if (b.importance !== a.importance) return b.importance - a.importance;
      // self-perspective memories take priority over owner traits (boosted by personality bias)
      const perspWeightA = perspectiveBias[a.perspective] || 1;
      const perspWeightB = perspectiveBias[b.perspective] || 1;
      const perspA = (a.perspective === 'lumi_self' || a.perspective === 'lumi_growth' ? 0 : 1) / perspWeightA;
      const perspB = (b.perspective === 'lumi_self' || b.perspective === 'lumi_growth' ? 0 : 1) / perspWeightB;
      if (perspA !== perspB) return perspA - perspB;
      // Type bias affects tie-breaking
      const typeWeightA = typeBias[a.type] || 1;
      const typeWeightB = typeBias[b.type] || 1;
      if (typeWeightA !== typeWeightB) return typeWeightB - typeWeightA;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  memories = dedupeMemoriesInRankOrder(memories, memory => memory);
  const limit = q.limit || 10;
  const result = memories.slice(0, limit);

  // ── Hebbian learning: co-retrieved memories strengthen pairwise associations ──
  if (q.recordRetrieval === true && q.userId && result.length >= 2) {
    const resultIds = result.map(m => m.id);
    strengthenAssociations(q.userId, resultIds);

    // Enrich: pull in strongly associated memories not already in the result
    const resultIdSet = new Set(resultIds);
    const associated: Memory[] = [];
    const byId = new Map(all.map(memory => [memory.id, memory]));
    for (const m of result) {
      for (const am of findAssociatedMemories(byId, m.id, { ...q, userId: q.userId })) {
        if (!resultIdSet.has(am.id)) {
          resultIdSet.add(am.id);
          associated.push(am);
        }
      }
    }
    if (associated.length > 0) {
      // Append associated memories after direct matches
      associated.sort((a, b) => (b.importance || 0) - (a.importance || 0));
      result.push(...associated.slice(0, Math.ceil(limit * 0.5)));
    }
  }

  const uniqueResult = dedupeMemoriesInRankOrder(result, memory => memory);
  if (q.recordRetrieval === true) markMemoriesRetrieved(uniqueResult);

  return uniqueResult;
}

/** Async vector-based semantic search. Falls back to keyword search if embeddings unavailable. */
export async function queryMemoriesVector(q: MemoryQuery): Promise<Memory[]> {
  q.signal?.throwIfAborted();
  if (!q.query || !q.useVector) {
    return queryMemories(q);
  }

  // Generate query embedding
  const queryEmbedding = await runRetrievalRequest(signal => generateEmbeddingWithIdentity(q.query!, q.userId, { signal }), q.signal, q.semanticTimeoutMs ?? 3_000).catch(error => {
    q.signal?.throwIfAborted();
    console.warn(`[Memory] Embedding unavailable: ${error?.message || String(error)}`);
    return null;
  });
  q.signal?.throwIfAborted();
  if (!queryEmbedding) {
    // Embeddings unavailable — fall back to keyword search
    return queryMemories({ ...q, useVector: false });
  }

  const limit = q.limit || 5;
  const candidateLimit = Math.max(20, limit * 4);
  const typeBias = q.retrievalTypeWeights || {};
  const perspectiveBias = q.retrievalPerspectiveWeights || {};

  // Vector recall scans every memory in the requested scope, including passages with no shared keyword.
  const scopedMemories = getMemoryStore().filter(memory => matchesMemoryQueryFilters(memory, q));
  const ranked = scopedMemories
    .map(m => {
      let score = 0;
      if (!hasCurrentMemoryEmbedding(m) || !m.embedding
        || m.embedding.length !== queryEmbedding.vector.length
        || m.embeddingNamespace?.provider !== queryEmbedding.provider
        || m.embeddingNamespace?.model !== queryEmbedding.model
        || m.embeddingNamespace?.dimensions !== queryEmbedding.vector.length) {
        score = relevanceScore(q.query!, m);
      } else {
        const cos = cosineSimilarity(queryEmbedding.vector, m.embedding);
        score = +(cos * m.confidence).toFixed(4);
      }
      if (score > 0) {
        score *= typeBias[m.type] || 1;
        score *= perspectiveBias[m.perspective] || 1;
      }
      return { m, inputHash: memoryEmbeddingInputHash(m), score: +score.toFixed(4) };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
  const scored = dedupeMemoriesInRankOrder(ranked, candidate => candidate.m);

  const publishCurrent = (candidates: typeof scored): Memory[] => {
    q.signal?.throwIfAborted();
    const current = new Map(getMemoryStore().map(memory => [memory.id, memory]));
    const result = candidates.flatMap(candidate => {
      const memory = current.get(candidate.m.id);
      return memory && matchesMemoryQueryFilters(memory, q)
        && memoryEmbeddingInputHash(memory) === candidate.inputHash ? [memory] : [];
    }).slice(0, limit);
    if (q.recordRetrieval === true) markMemoriesRetrieved(result);
    return result;
  };

  const retrievalUserId = q.userId || 'anonymous';
  const rerank = getRerankSelection(retrievalUserId);
  if (rerank.enabled && scored.length > 1 && (!isStrictPrivacy() || isProviderLocalOnly(rerank.provider))) {
    try {
      const candidates = scored.slice(0, candidateLimit);
      const ranked = await runRetrievalRequest(signal => rerankConfiguredDocuments(
        q.query,
        candidates.map(({ m }) => `${m.type}: ${m.content}\nKeywords: ${m.keywords.join(', ')}`),
        retrievalUserId,
        Math.max(limit, rerank.topN),
        { signal },
      ), q.signal, q.semanticTimeoutMs ?? 3_000);
      q.signal?.throwIfAborted();
      const seen = new Set<number>();
      const reordered = ranked.items
        .map(item => {
          seen.add(item.index);
          return candidates[item.index];
        })
        .filter(Boolean);
      reordered.push(...candidates.filter((_, index) => !seen.has(index)));
      return publishCurrent(reordered);
    } catch (error: any) {
      q.signal?.throwIfAborted();
      console.warn(`[Memory] Rerank unavailable; preserving vector order: ${error?.message || String(error)}`);
    }
  }

  q.signal?.throwIfAborted();
  return publishCurrent(scored);
}
