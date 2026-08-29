import { readDB, writeDB } from '../../db_layer';
import {
  Memory,
  MemoryEvidenceClass,
  MemoryQuery,
  MemoryType,
  MemoryTier,
  MemoryPerspective,
  CONVERSATIONAL_MEMORY_EVIDENCE,
} from './types';
export { CONVERSATIONAL_MEMORY_EVIDENCE } from './types';
import { applyMemoryFirewallMetadata, evaluateMemoryFirewall } from './firewall';
import { generateConfiguredEmbedding, getEmbeddingRoute } from '../llm/embedding_provider';
import { getRerankSelection, rerankConfiguredDocuments } from '../llm/rerank_provider';

function getMemoryStore(): Memory[] {
  const db = readDB();
  if (!db.memories) db.memories = [];
  return db.memories;
}

/**
 * Raw legacy execution receipts are operational audit data, not conversational memory.
 * Keep them stored and explicitly queryable, but exclude them from normal recall.
 */
export function isOperationalTraceMemory(
  memory: Pick<Memory, 'sourceInteractionId' | 'content'>,
): boolean {
  const source = String(memory.sourceInteractionId || '').trim().toLowerCase();
  const content = String(memory.content || '').trimStart();
  return source.startsWith('orch_')
    || /^(?:proactive_scan|growth_journal|autonomy_scan|daily_growth|self_reflection)_/i.test(source)
    || /^\[(?:Orchestrated Workflow|Proactive Scan|Growth Journal|Autonomy Scan|Daily Growth|Self Reflection)\b/i.test(content);
}

/**
 * Classify memory evidence from provenance fields instead of reading intent out
 * of the generated sentence. This keeps Lumi's own stories separate from facts
 * about the owner even when both happen to mention the same topic.
 */
export function classifyMemoryEvidence(
  memory: Pick<Memory, 'perspective' | 'source' | 'sourceInteractionId' | 'content'>,
): MemoryEvidenceClass {
  if (isOperationalTraceMemory(memory)) return 'operational_trace';
  if (memory.perspective === 'lumi_self' || memory.perspective === 'lumi_growth') {
    return 'lumi_narrative';
  }
  if (memory.perspective === 'shared_memory') return 'shared_context';
  if (memory.source === 'chat' || memory.source === 'voice' || memory.source === 'manual') {
    return 'owner_statement';
  }
  return 'owner_observation';
}

function semanticMemoryKey(memory: Memory): string {
  return String(memory.content || '')
    .toLowerCase()
    .replace(/^\[[^\]]{1,80}\]\s*/u, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 1000);
}

function dedupeMemoriesInRankOrder(memories: Memory[]): Memory[] {
  const seen = new Set<string>();
  return memories.filter(memory => {
    const key = semanticMemoryKey(memory) || memory.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Embedding / Vector Search ──

/** LRU cache for embeddings: text → vector. Avoids re-embedding the same content. */
const embeddingCache = new Map<string, number[]>();
const EMBEDDING_CACHE_MAX = 500;

function cacheEmbedding(key: string, vec: number[]) {
  if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
    const first = embeddingCache.keys().next().value;
    if (first) embeddingCache.delete(first);
  }
  embeddingCache.set(key, vec);
}

function getCachedEmbedding(key: string): number[] | undefined {
  return embeddingCache.get(key);
}

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

function matchesMemoryQueryFilters(memory: Memory, query: MemoryQuery): boolean {
  if (query.includeOperationalTraces !== true && isOperationalTraceMemory(memory)) return false;
  if (query.evidenceClasses && !query.evidenceClasses.includes(classifyMemoryEvidence(memory))) return false;
  if (query.userId && memory.userId !== query.userId) return false;
  // Ordinary Lumi retrieval must never absorb a Memory Avatar's frozen seed
  // memories. The avatar lane opts in by passing its exact agentId.
  if (query.agentId === undefined && isMemoryAvatarScoped(memory)) return false;
  if (query.agentId !== undefined && (memory.agentId || '') !== query.agentId) return false;
  if (query.type && memory.type !== query.type) return false;
  if (query.minConfidence !== undefined && memory.confidence < query.minConfidence) return false;
  if (query.tier && memory.tier !== query.tier) return false;
  if (query.perspective && memory.perspective !== query.perspective) return false;
  if (query.minImportance !== undefined && memory.importance < query.minImportance) return false;
  if (query.unconsolidatedOnly && memory.parentId) return false;
  if (query.parentId !== undefined && memory.parentId !== query.parentId) return false;
  if (query.nodeType && memory.nodeType !== query.nodeType) return false;
  if (query.before && new Date(memory.createdAt).getTime() > new Date(query.before).getTime()) return false;
  if (query.after && new Date(memory.createdAt).getTime() < new Date(query.after).getTime()) return false;
  if (query.location !== undefined && (memory.location || '') !== query.location) return false;
  if (query.domain !== undefined && (memory.domain || 'personal') !== query.domain) return false;
  if (query.orgId !== undefined && (memory.orgId || '') !== query.orgId) return false;
  return true;
}

function markMemoriesRetrieved(memories: Memory[]): void {
  if (memories.length === 0) return;
  const now = new Date().toISOString();
  const store = getMemoryStore();
  for (const memory of memories) {
    const stored = store.find(candidate => candidate.id === memory.id);
    if (stored) {
      stored.lastRetrievedAt = now;
      stored.retrieveCount = (stored.retrieveCount || 0) + 1;
    }
  }
  saveMemoryStore(store);
}

/** Generate an embedding through the configured retrieval role. */
export async function generateEmbedding(text: string, userId = 'anonymous'): Promise<number[] | null> {
  const route = getEmbeddingRoute(userId);
  const routeKey = [
    userId,
    route.primary.provider,
    route.primary.model,
    route.fallback?.provider || '',
    route.fallback?.model || '',
    text,
  ].join('\u0000');
  const cached = getCachedEmbedding(routeKey);
  if (cached) return cached;

  try {
    const result = await generateConfiguredEmbedding(text, userId);
    cacheEmbedding(routeKey, result.vector);
    return result.vector;
  } catch {
    return null;
  }
}

/** Async background embedding generation — updates memory in-place */
async function attachEmbedding(memory: Memory): Promise<void> {
  if (memory.embedding && memory.embedding.length > 0) return;
  const text = `${memory.type}: ${memory.content} ${memory.keywords.join(' ')}`;
  const vec = await generateEmbedding(text, memory.userId);
  if (vec) {
    memory.embedding = vec;
    try {
      const all = getMemoryStore();
      const existing = all.find(m => m.id === memory.id);
      if (existing) {
        existing.embedding = vec;
        saveMemoryStore(all);
      }
    } catch {}
  }
}

// ── Hebbian Co-Retrieval Map — "cells that fire together, wire together" ──
// When memories are retrieved in the same query, their pairwise association strengthens.
// Over time, this builds an organic associative network that mirrors the user's mental model.

type CoRetrievalMap = Map<string, Map<string, Map<string, number>>>;
// userId → memoryId → (associatedMemoryId → strength 0-1)

let coRetrievalMap: CoRetrievalMap = new Map();
const ASSOCIATION_STRENGTH_INCREMENT = 0.08;  // Per co-retrieval boost
const ASSOCIATION_DECAY_RATE = 0.02;           // Per decay cycle
const ASSOCIATION_THRESHOLD = 0.25;            // Min strength to be considered "associated"

function getAssocKey(idA: string, idB: string): [string, string] {
  return idA < idB ? [idA, idB] : [idB, idA]; // Canonical ordering
}

/** Load co-retrieval map from DB on startup */
function loadCoRetrievalMap(): void {
  try {
    const db = readDB();
    if (db.memoryAssociations && Array.isArray(db.memoryAssociations)) {
      for (const row of db.memoryAssociations) {
        if (!coRetrievalMap.has(row.userId)) {
          coRetrievalMap.set(row.userId, new Map());
        }
        const userMap = coRetrievalMap.get(row.userId)!;
        if (!userMap.has(row.memA)) userMap.set(row.memA, new Map());
        userMap.get(row.memA)!.set(row.memB, row.strength);
        // Symmetric
        if (!userMap.has(row.memB)) userMap.set(row.memB, new Map());
        userMap.get(row.memB)!.set(row.memA, row.strength);
      }
    }
  } catch {}
}

/** Persist co-retrieval map to DB */
function saveCoRetrievalMap(): void {
  try {
    const db = readDB();
    const rows: { userId: string; memA: string; memB: string; strength: number }[] = [];
    for (const [userId, userMap] of coRetrievalMap) {
      for (const [memA, assocMap] of userMap) {
        for (const [memB, strength] of assocMap) {
          if (memA < memB && strength >= ASSOCIATION_THRESHOLD) {
            rows.push({ userId, memA, memB, strength: +strength.toFixed(3) });
          }
        }
      }
    }
    db.memoryAssociations = rows;
    writeDB(db);
  } catch {}
}

/** Hebbian strengthen: increment association strength between all pairs in a co-retrieved set */
function strengthenAssociations(userId: string, memoryIds: string[]): void {
  if (memoryIds.length < 2) return;

  if (!coRetrievalMap.has(userId)) coRetrievalMap.set(userId, new Map());
  const userMap = coRetrievalMap.get(userId)!;

  for (let i = 0; i < memoryIds.length; i++) {
    for (let j = i + 1; j < memoryIds.length; j++) {
      const idA = memoryIds[i], idB = memoryIds[j];

      if (!userMap.has(idA)) userMap.set(idA, new Map());
      const aMap = userMap.get(idA)!;
      const prev = aMap.get(idB) || 0;
      aMap.set(idB, Math.min(1, +(prev + ASSOCIATION_STRENGTH_INCREMENT).toFixed(3)));

      if (!userMap.has(idB)) userMap.set(idB, new Map());
      userMap.get(idB)!.set(idA, Math.min(1, +(prev + ASSOCIATION_STRENGTH_INCREMENT).toFixed(3)));
    }
  }

  // Persist periodically (on every ~10th co-retrieval, to avoid excessive writes)
  saveCoRetrievalMap();
}

/** Periodically decay weak associations and remove dead ones */
export function decayMemoryAssociations(userId: string): number {
  const sizeBefore = coRetrievalMap.get(userId)?.size || 0;
  decayAssociations(userId);
  const sizeAfter = coRetrievalMap.get(userId)?.size || 0;
  if (sizeBefore !== sizeAfter) saveCoRetrievalMap();
  return sizeBefore - sizeAfter;
}

/** Initialize co-retrieval map from persistent storage */
export function initMemoryAssociations(): void {
  loadCoRetrievalMap();
}

/** Decay all associations — weak ones fade, strong ones persist */
function decayAssociations(userId: string): void {
  const userMap = coRetrievalMap.get(userId);
  if (!userMap) return;

  for (const [memId, assocMap] of userMap) {
    for (const [otherId, strength] of assocMap) {
      const newStrength = +(strength - ASSOCIATION_DECAY_RATE).toFixed(3);
      if (newStrength <= 0) {
        assocMap.delete(otherId);
      } else {
        assocMap.set(otherId, newStrength);
      }
    }
    if (assocMap.size === 0) userMap.delete(memId);
  }
  if (userMap.size === 0) coRetrievalMap.delete(userId);
}

/** Get memories strongly associated with a given memory ID */
export function getAssociatedMemories(
  memoryId: string,
  userId: string,
  threshold: number = ASSOCIATION_THRESHOLD,
  domain?: string,
  orgId?: string,
  includeOperationalTraces: boolean = false,
  agentId?: string,
): Memory[] {
  const userMap = coRetrievalMap.get(userId);
  if (!userMap) return [];
  const assocMap = userMap.get(memoryId);
  if (!assocMap) return [];

  const all = getMemoryStore();
  const result: Memory[] = [];
  for (const [assocId, strength] of assocMap) {
    if (strength >= threshold) {
      const mem = all.find(m => m.id === assocId);
      if (
        mem
        && matchesMemoryScope(mem, domain, orgId, agentId)
        && (includeOperationalTraces || !isOperationalTraceMemory(mem))
      ) {
        result.push(mem);
      }
    }
  }
  return result;
}

function matchesMemoryScope(memory: Memory, domain?: string, orgId?: string, agentId?: string): boolean {
  if (domain !== undefined && (memory.domain || 'personal') !== domain) return false;
  if (orgId !== undefined && (memory.orgId || '') !== orgId) return false;
  if (agentId !== undefined) {
    if ((memory.agentId || '') !== agentId) return false;
  } else if (isMemoryAvatarScoped(memory)) {
    // Scope-only operations are Lumi operations by default. An explicit
    // avatar agentId is required to touch that frozen lane.
    return false;
  }
  return true;
}

/** Memory Avatar memories are kept in a frozen, private lane. */
export function isMemoryAvatarAgentId(agentId: unknown): boolean {
  return String(agentId || '').trim().startsWith('memory_avatar_');
}

export function isMemoryAvatarScoped(memory: Pick<Memory, 'agentId'>): boolean {
  return isMemoryAvatarAgentId(memory.agentId);
}

// ── Dedup index (lazy, invalidated on write) ──

let dedupIndex: Map<string, Map<string, Memory[]>> | null = null;

function getDedupIndex(): Map<string, Map<string, Memory[]>> {
  if (dedupIndex) return dedupIndex;
  dedupIndex = new Map();
  for (const m of getMemoryStore()) {
    if (!dedupIndex.has(m.userId)) dedupIndex.set(m.userId, new Map());
    const typeMap = dedupIndex.get(m.userId)!;
    if (!typeMap.has(m.type)) typeMap.set(m.type, []);
    typeMap.get(m.type)!.push(m);
  }
  return dedupIndex;
}

function saveMemoryStore(memories: Memory[]): void {
  dedupIndex = null; // invalidate index on write
  const db = readDB();
  db.memories = memories;
  writeDB(db);
}

function generateId(): string {
  return `mem_${crypto.randomUUID()}`;
}

// Match CJK characters for language-aware tokenization
const CJK_RE = /[一-鿿㐀-䶿]/;

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const lower = text.toLowerCase();
  // Extract CJK character bigrams (overlapping pairs: 名字 → 名字)
  let cjkRun = '';
  for (const ch of lower) {
    if (CJK_RE.test(ch)) {
      cjkRun += ch;
      if (cjkRun.length >= 2) {
        tokens.push(cjkRun.slice(-2));
      }
    } else {
      if (cjkRun.length === 1) tokens.push(cjkRun); // lone CJK char
      cjkRun = '';
    }
  }
  if (cjkRun.length === 1) tokens.push(cjkRun);
  // Also split by whitespace for English/numbers
  const words = lower.split(/[\s,，。！？、；：""''（）\(\)\[\]【】]+/).filter(w => w.length > 1);
  for (const w of words) {
    if (!CJK_RE.test(w)) tokens.push(w);
    else if (w.length > 2) tokens.push(w); // keep full CJK words too
  }
  return [...new Set(tokens)];
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
        const tierDiff = priorityForTier(a.m.tier) - priorityForTier(b.m.tier);
        if (Math.abs(tierDiff) >= 2) return tierDiff;
        return b.score - a.score;
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

  memories = dedupeMemoriesInRankOrder(memories);
  const limit = q.limit || 10;
  const result = memories.slice(0, limit);

  // ── Hebbian learning: co-retrieved memories strengthen pairwise associations ──
  if (q.userId && result.length >= 2) {
    const resultIds = result.map(m => m.id);
    strengthenAssociations(q.userId, resultIds);

    // Enrich: pull in strongly associated memories not already in the result
    const resultIdSet = new Set(resultIds);
    const associated: Memory[] = [];
    for (const m of result) {
      const assoc = getAssociatedMemories(
        m.id,
        q.userId,
        ASSOCIATION_THRESHOLD,
        q.domain,
        q.orgId,
        q.includeOperationalTraces === true,
        q.agentId,
      );
      for (const am of assoc) {
        if (!resultIdSet.has(am.id) && matchesMemoryQueryFilters(am, q)) {
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
  } else if (q.userId && result.length === 1) {
    // Single result: still record it for future co-retrieval opportunities
    // (no pairwise to strengthen, but we can use this info later)
  }

  const uniqueResult = dedupeMemoriesInRankOrder(result);
  markMemoriesRetrieved(uniqueResult);

  return uniqueResult;
}

/** Async vector-based semantic search. Falls back to keyword search if embeddings unavailable. */
export async function queryMemoriesVector(q: MemoryQuery): Promise<Memory[]> {
  if (!q.query || !q.useVector) {
    return queryMemories(q);
  }

  // Generate query embedding
  const queryVec = await generateEmbedding(q.query, q.userId);
  if (!queryVec) {
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
      if (!m.embedding || m.embedding.length === 0 || m.embedding.length !== queryVec.length) {
        score = relevanceScore(q.query!, m);
      } else {
        const cos = cosineSimilarity(queryVec, m.embedding);
        score = +(cos * m.confidence).toFixed(4);
      }
      if (score > 0) {
        score *= typeBias[m.type] || 1;
        score *= perspectiveBias[m.perspective] || 1;
      }
      return { m, score: +score.toFixed(4) };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);
  const seenSemanticKeys = new Set<string>();
  const scored = ranked.filter(({ m }) => {
    const key = semanticMemoryKey(m) || m.id;
    if (seenSemanticKeys.has(key)) return false;
    seenSemanticKeys.add(key);
    return true;
  });

  const retrievalUserId = q.userId || 'anonymous';
  const rerank = getRerankSelection(retrievalUserId);
  if (rerank.enabled && scored.length > 1) {
    try {
      const candidates = scored.slice(0, candidateLimit);
      const ranked = await rerankConfiguredDocuments(
        q.query,
        candidates.map(({ m }) => `${m.type}: ${m.content}\nKeywords: ${m.keywords.join(', ')}`),
        retrievalUserId,
        Math.max(limit, rerank.topN),
      );
      const seen = new Set<number>();
      const reordered = ranked.items
        .map(item => {
          seen.add(item.index);
          return candidates[item.index];
        })
        .filter(Boolean);
      reordered.push(...candidates.filter((_, index) => !seen.has(index)));
      const result = reordered.slice(0, limit).map(({ m }) => m);
      markMemoriesRetrieved(result);
      return result;
    } catch (error: any) {
      console.warn(`[Memory] Rerank unavailable; preserving vector order: ${error?.message || String(error)}`);
    }
  }

  const result = scored.slice(0, limit).map(({ m }) => m);
  markMemoriesRetrieved(result);
  return result;
}

/** Pre-generate embeddings for all existing memories that lack them. One-time migration. */
export async function backfillEmbeddings(userId?: string): Promise<number> {
  const all = getMemoryStore();
  const targets = all.filter(m => !m.embedding && (!userId || m.userId === userId));
  let count = 0;
  for (const m of targets) {
    const vec = await generateEmbedding(`${m.type}: ${m.content} ${m.keywords.join(' ')}`, m.userId);
    if (vec) {
      m.embedding = vec;
      count++;
    }
    // Small delay to avoid rate limits
    if (count % 10 === 0 && count > 0) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  if (count > 0) saveMemoryStore(all);
  return count;
}

// ── Reminders ──

export interface Reminder {
  id: string;
  userId: string;
  content: string;
  dueAt: string | null;
  status: 'pending' | 'fired';
  sourceInteractionId: string;
  createdAt: string;
  firedAt: string | null;
  domain?: string;
  orgId?: string;
}

function getReminderStore(): Reminder[] {
  const db = readDB();
  if (!db.reminders) db.reminders = [];
  return db.reminders;
}

function saveReminderStore(reminders: Reminder[]): void {
  const db = readDB();
  db.reminders = reminders;
  writeDB(db);
}

export function addReminder(reminder: Omit<Reminder, 'id' | 'createdAt' | 'status' | 'firedAt'>): Reminder {
  const all = getReminderStore();
  const now = new Date().toISOString();
  const newReminder: Reminder = {
    id: `rem_${crypto.randomUUID()}`,
    ...reminder,
    status: 'pending',
    createdAt: now,
    firedAt: null,
  };
  all.push(newReminder);
  saveReminderStore(all);
  return newReminder;
}

export function upsertPendingReminder(
  reminder: Omit<Reminder, 'id' | 'createdAt' | 'status' | 'firedAt'>,
): { reminder: Reminder; created: boolean } {
  const all = getReminderStore();
  const existing = all.find(item =>
    item.userId === reminder.userId
    && item.status === 'pending'
    && item.sourceInteractionId === reminder.sourceInteractionId
    && (item.domain || 'personal') === (reminder.domain || 'personal')
    && (item.orgId || '') === (reminder.orgId || ''),
  );
  if (existing) {
    existing.content = reminder.content;
    existing.dueAt = reminder.dueAt;
    saveReminderStore(all);
    return { reminder: existing, created: false };
  }
  return { reminder: addReminder(reminder), created: true };
}

export function getDueReminders(filters: { userId?: string; domain?: string; orgId?: string } = {}): Reminder[] {
  const all = getReminderStore();
  const now = new Date().toISOString();
  return all
    .filter(r =>
      r.status === 'pending' &&
      r.dueAt &&
      r.dueAt <= now &&
      (!filters.userId || r.userId === filters.userId) &&
      (filters.domain === undefined || (r.domain || 'personal') === filters.domain) &&
      (filters.orgId === undefined || (r.orgId || '') === filters.orgId)
    )
    .slice(0, 10);
}

export function fireReminder(id: string): void {
  const all = getReminderStore();
  const r = all.find(r => r.id === id);
  if (r) {
    r.status = 'fired';
    r.firedAt = new Date().toISOString();
    saveReminderStore(all);
  }
}

// ── Memories ──

export function addMemory(
  memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt' | 'lastRetrievedAt' | 'retrieveCount' | 'tier' | 'perspective' | 'importance' | 'parentId' | 'agentId' | 'nodeType'>,
  overrides?: {
    tier?: Memory['tier'];
    perspective?: Memory['perspective'];
    importance?: number;
    parentId?: string | null;
    agentId?: string;
    nodeType?: Memory['nodeType'];
    location?: string;
    domain?: string;
    orgId?: string;
    source?: Memory['source'];
    privacyClass?: Memory['privacyClass'];
    retention?: Memory['retention'];
    userApproved?: boolean;
    /** Disable semantic deduplication when every source chunk needs an exact receipt. */
    deduplicate?: boolean;
    /** Disable background embedding when the caller already attempted a verified embedding. */
    generateEmbedding?: boolean;
  },
): Memory {
  const all = getMemoryStore();
  const tier = overrides?.tier ?? 'episodic';
  const domain = overrides?.domain ?? memory.domain ?? 'personal';
  const orgId = overrides?.orgId ?? memory.orgId ?? '';
  // Avatar seed memories are isolated lanes. Only apply the agent fence when
  // the caller explicitly supplies one, so ordinary Lumi memories retain the
  // existing cross-source deduplication behavior.
  const scopedAgentId = overrides?.agentId !== undefined
    ? String(overrides.agentId)
    : undefined;
  const firewall = evaluateMemoryFirewall({
    userId: memory.userId,
    content: memory.content,
    tier,
    source: overrides?.source ?? memory.source,
    domain,
    orgId,
    privacyClass: overrides?.privacyClass ?? memory.privacyClass,
    retention: overrides?.retention ?? memory.retention,
    userApproved: overrides?.userApproved ?? memory.userApproved,
  });
  if (!firewall.accepted) {
    throw new Error(`Memory blocked by firewall: ${firewall.reason}`);
  }

  // Check for contradictions with existing memories of same user+type
  const candidates = all.filter(m =>
    m.userId === memory.userId &&
    m.type === memory.type &&
    matchesMemoryScope(m, domain, orgId, scopedAgentId)
  );
  const contradictions = findContradictions(memory.content, memory.userId, memory.type, candidates);
  for (const conflicted of contradictions) {
    // Reduce confidence of the older memory — it may be outdated
    conflicted.confidence = Math.max(0.1, +(conflicted.confidence - 0.15).toFixed(2));
    conflicted.updatedAt = new Date().toISOString();
    console.log(
      `[Memory] Contradiction detected: new="${memory.content.slice(0, 50)}..." ` +
      `vs existing="${conflicted.content.slice(0, 50)}..." (confidence: ${(conflicted.confidence + 0.15).toFixed(2)}→${conflicted.confidence.toFixed(2)})`,
    );
  }

  // Deduplicate using index — only scan same userId + type
  const idx = getDedupIndex();
  const dedupCandidates = idx.get(memory.userId)?.get(memory.type) || [];
  const existing = overrides?.deduplicate === false || contradictions.length > 0
    ? undefined
    : dedupCandidates.find(m =>
        matchesMemoryScope(m, domain, orgId, scopedAgentId) && contentSimilarity(m.content, memory.content) > 0.7,
      );

  const now = new Date().toISOString();

  if (existing) {
    // Merge: increase confidence, update content if new one has higher confidence
    existing.content = memory.confidence > existing.confidence ? memory.content : existing.content;
    existing.keywords = dedupeKeywords([...existing.keywords, ...memory.keywords]);
    existing.confidence = Math.min(1, existing.confidence + 0.1);
    existing.importance = Math.max(existing.importance, overrides?.importance ?? 0.3);
    existing.updatedAt = now;
    existing.domain = domain;
    existing.orgId = orgId;
    Object.assign(existing, applyMemoryFirewallMetadata(existing, firewall));
    saveMemoryStore(all);
    return existing;
  }

  const newMemory = applyMemoryFirewallMetadata<Memory>({
    id: generateId(),
    ...memory,
    createdAt: now,
    updatedAt: now,
    lastRetrievedAt: null,
    retrieveCount: 0,
    tier,
    perspective: overrides?.perspective ?? 'owner_trait',
    importance: overrides?.importance ?? 0.3,
    parentId: overrides?.parentId ?? null,
    agentId: overrides?.agentId ?? '',
    nodeType: overrides?.nodeType ?? 'leaf',
    location: overrides?.location,
    domain,
    orgId,
  }, firewall);

  if (contradictions.length > 0) {
    const detectedAt = now;
    newMemory.conflict = {
      status: 'unresolved',
      relatedMemoryIds: contradictions.map(item => item.id),
      detectedAt,
    };
    for (const conflicted of contradictions) {
      const related = new Set([
        ...(conflicted.conflict?.relatedMemoryIds || []),
        newMemory.id,
      ]);
      conflicted.conflict = {
        status: 'unresolved',
        relatedMemoryIds: [...related],
        detectedAt: conflicted.conflict?.detectedAt || detectedAt,
      };
    }
  }

  all.push(newMemory);
  saveMemoryStore(all);

  // Background: generate embedding for semantic search
  if (overrides?.generateEmbedding !== false) attachEmbedding(newMemory).catch(() => {});

  return newMemory;
}

export function removeMemory(id: string): boolean {
  const all = getMemoryStore();
  const idx = all.findIndex(m => m.id === id);
  if (idx === -1) return false;
  all.splice(idx, 1);
  const now = new Date().toISOString();
  for (const memory of all) {
    if (!memory.conflict?.relatedMemoryIds.includes(id)) continue;
    memory.conflict.relatedMemoryIds = memory.conflict.relatedMemoryIds.filter(relatedId => relatedId !== id);
    if (memory.conflict.relatedMemoryIds.length === 0) {
      memory.conflict.status = 'resolved';
      memory.conflict.resolution = 'related_removed';
      memory.conflict.resolvedAt = now;
      delete memory.conflict.chosenMemoryId;
    }
    memory.updatedAt = now;
  }
  saveMemoryStore(all);
  return true;
}

/**
 * Update lifecycle metadata without replacing the memory record. Stable IDs are
 * required because citations, tree links, and contradiction evidence refer to
 * the original memory identity.
 */
export function updateMemoryLifecycle(input: {
  userId: string;
  memoryId: string;
  domain?: string;
  orgId?: string;
  tier: MemoryTier;
  confidence?: number;
  importance?: number;
  retention?: Memory['retention'];
  userApproved?: boolean;
}): Memory | undefined {
  const all = getMemoryStore();
  const memory = all.find(item => (
    item.id === input.memoryId
    && item.userId === input.userId
    && matchesMemoryScope(item, input.domain || 'personal', input.orgId || '')
  ));
  if (!memory) return undefined;
  memory.tier = input.tier;
  if (input.confidence !== undefined) memory.confidence = input.confidence;
  if (input.importance !== undefined) memory.importance = input.importance;
  if (input.retention !== undefined) memory.retention = input.retention;
  if (input.userApproved !== undefined) memory.userApproved = input.userApproved;
  memory.updatedAt = new Date().toISOString();
  saveMemoryStore(all);
  return memory;
}

export function resolveMemoryConflict(input: {
  userId: string;
  memoryId: string;
  resolution: 'keep_both' | 'prefer_one';
  chosenMemoryId?: string;
  domain?: string;
  orgId?: string;
}): Memory[] {
  const all = getMemoryStore();
  const target = all.find(memory => (
    memory.id === input.memoryId
    && memory.userId === input.userId
    && matchesMemoryScope(memory, input.domain || 'personal', input.orgId || '')
  ));
  if (!target?.conflict) throw new Error('Memory conflict not found');
  const groupIds = new Set([target.id, ...target.conflict.relatedMemoryIds]);
  const group = all.filter(memory => (
    groupIds.has(memory.id)
    && memory.userId === input.userId
    && matchesMemoryScope(memory, input.domain || 'personal', input.orgId || '')
  ));
  if (group.length < 2) throw new Error('Memory conflict has no related evidence');
  if (input.resolution === 'prefer_one' && !input.chosenMemoryId) {
    throw new Error('chosenMemoryId is required for prefer_one');
  }
  if (input.chosenMemoryId && !groupIds.has(input.chosenMemoryId)) {
    throw new Error('chosenMemoryId is outside this conflict group');
  }
  const resolvedAt = new Date().toISOString();
  for (const memory of group) {
    memory.conflict = {
      status: 'resolved',
      relatedMemoryIds: group.filter(item => item.id !== memory.id).map(item => item.id),
      detectedAt: memory.conflict?.detectedAt || resolvedAt,
      resolvedAt,
      resolution: input.resolution,
      ...(input.chosenMemoryId ? { chosenMemoryId: input.chosenMemoryId } : {}),
    };
    if (input.resolution === 'prefer_one') {
      memory.confidence = memory.id === input.chosenMemoryId
        ? Math.min(1, memory.confidence + 0.1)
        : Math.max(0.1, memory.confidence - 0.2);
    }
    memory.updatedAt = resolvedAt;
  }
  saveMemoryStore(all);
  return group;
}

/** Tier-based decay: core_identity never decays, episodic decays fast */
export function decayMemories(userId: string, domain?: string, orgId?: string, agentId?: string): void {
  const all = getMemoryStore();
  let changed = false;

  const decayRates: Record<MemoryTier, { amount: number; min: number }> = {
    core_identity: { amount: 0, min: 0.9 },     // Never decays
    growth: { amount: 0.02, min: 0.6 },          // Very slow
    internalized: { amount: 0.03, min: 0.3 },    // Slow
    episodic: { amount: 0.05, min: 0.1 },        // Fast
  };

  for (const m of all) {
    if (m.userId !== userId || !matchesMemoryScope(m, domain, orgId, agentId)) continue;
    const rate = decayRates[m.tier] || decayRates.episodic;
    if (rate.amount === 0) continue;
    if (m.confidence <= rate.min) continue;
    m.confidence = Math.max(rate.min, +(m.confidence - rate.amount).toFixed(2));
    changed = true;
  }

  if (changed) saveMemoryStore(all);
}

/** Get episodic memories that are ready for consolidation (unconsolidated, count >= threshold) */
export function getUnconsolidatedEpisodic(
  userId: string,
  domain?: string,
  orgId?: string,
  includeOperationalTraces: boolean = false,
  agentId?: string,
): Memory[] {
  return getMemoryStore().filter(m =>
    m.userId === userId &&
    m.tier === 'episodic' &&
    !m.parentId &&
    m.confidence >= 0.2 &&
    (includeOperationalTraces || !isOperationalTraceMemory(m)) &&
    matchesMemoryScope(m, domain, orgId, agentId)
  );
}

/** Mark episodic memories as consolidated by setting parentId */
export function markConsolidated(ids: string[], parentId: string, agentId?: string): void {
  const all = getMemoryStore();
  const parent = all.find(memory => memory.id === parentId);
  const lane = agentId !== undefined ? agentId : parent?.agentId;
  for (const m of all) {
    if (ids.includes(m.id) && matchesMemoryScope(m, undefined, undefined, lane)) {
      m.parentId = parentId;
      // Promote consolidated memories — they're now part of something bigger
      m.importance = Math.min(1, m.importance + 0.2);
    }
  }
  saveMemoryStore(all);
}

export function formatMemoriesForContext(
  memories: Memory[],
  options: { currentTurnText?: string } = {},
): string {
  if (memories.length === 0) return '';

  // Separate branches and leaves
  const branches = memories.filter(m => m.nodeType === 'branch');
  const leaves = memories.filter(m => m.nodeType !== 'branch');

  const lines: string[] = [
    '## Retrieved memory evidence',
    'Each item below is a recalled candidate from an earlier source, not part of the current user message and not unquestionable truth. The current turn and same-conversation evidence take priority.',
    'Memory confidence describes the stored extraction, not whether a current name, code, person, customer, project, or task is the same entity. Every recalled entity binding starts unconfirmed. A shared word, exact token, name fragment, code prefix, or semantic similarity is retrieval evidence only; never transfer attributes, status, plans, or actions until the user or same-conversation history explicitly establishes the identity. Ask one short clarification when that binding matters.',
    'Owner statements prove that the owner previously said something; owner observations are inferences that may be wrong; shared context is not proof of an owner trait; Lumi narrative describes Lumi and must never be used as evidence about the owner.',
  ];

  if (options.currentTurnText?.trim()) {
    lines.push('Current-turn binding status: no recalled candidate has been entity-bound by the retrieval layer; reason over the current message before using any candidate.');
  }

  const evidenceLabel = (memory: Memory): string => {
    switch (classifyMemoryEvidence(memory)) {
      case 'owner_statement': return 'owner statement';
      case 'owner_observation': return 'owner observation';
      case 'shared_context': return 'shared context';
      case 'lumi_narrative': return 'Lumi narrative';
      case 'operational_trace': return 'operational trace';
    }
  };

  const provenanceLabel = (memory: Memory): string => {
    const source = memory.knowledgeProvenance?.sourceLabel
      ? `knowledge:${memory.knowledgeProvenance.sourceLabel}`
      : (memory.source || 'legacy/unknown');
    const interaction = String(memory.sourceInteractionId || 'unknown').replace(/\s+/g, ' ').slice(0, 120);
    const recorded = memory.createdAt || memory.updatedAt || 'unknown';
    const confidence = Number.isFinite(memory.confidence)
      ? Math.max(0, Math.min(1, memory.confidence)).toFixed(2)
      : 'unknown';
    const conflict = memory.conflict?.status === 'unresolved' ? '; conflict=unresolved' : '';
    return `source=${source}; interaction=${interaction}; recorded=${recorded}; memory-confidence=${confidence}; entity-binding=unconfirmed${conflict}`;
  };

  // Group leaves by parent
  const byParent = new Map<string | null, Memory[]>();
  for (const leaf of leaves) {
    const key = leaf.parentId || null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(leaf);
  }

  // Sort branches by importance
  branches.sort((a, b) => b.importance - a.importance || b.confidence - a.confidence);

  // Output branch sections
  for (const branch of branches) {
    const children = byParent.get(branch.id) || [];
    if (children.length === 0) continue;
    lines.push(`### [topic container; not evidence] ${branch.content}`);
    children.sort((a, b) => b.importance - a.importance || b.confidence - a.confidence);
    for (const m of children) {
      lines.push(`- [${evidenceLabel(m)}] [${provenanceLabel(m)}] ${m.content}`);
    }
  }

  // Output ungrouped leaves (no parent branch)
  const orphans = byParent.get(null) || [];
  if (orphans.length > 0) {
    for (const m of orphans) {
      // Filter out branches from the root display
      if (m.nodeType !== 'branch') {
        lines.push(`- [${evidenceLabel(m)}] [${provenanceLabel(m)}] ${m.content}`);
      }
    }
  }

  return lines.join('\n');
}

// ── OpenHer-inspired Memory Crystallization ──

/**
 * Compute a dynamic memory value score (0-1) based on:
 * - Retrieve frequency (how often is this memory recalled)
 * - Recency (how recently was it used)
 * - Confidence (how sure are we)
 * - Connectedness (is it part of a branch tree)
 * - Hebbian association strength (cross-system fusion: Hebbian→crystallization)
 *
 * High-value episodic memories are candidates for auto-promotion.
 */
export function computeMemoryValue(memory: Memory, childrenCount: number = 0, hebbianBonus: number = 0): number {
  const now = Date.now();

  // Recency bonus: memories retrieved within the last 24h get a bonus
  const hoursSinceRetrieve = memory.lastRetrievedAt
    ? (now - new Date(memory.lastRetrievedAt).getTime()) / (1000 * 60 * 60)
    : 72; // Never retrieved → treat as 3 days old
  const recencyScore = Math.max(0, 1 - hoursSinceRetrieve / 72); // Decay over 72h

  // Retrieve frequency: log-scale so the 1st retrieval matters most
  const rawRetrieveScore = Math.min(1, Math.log2(memory.retrieveCount + 1) / 5); // log2(33) ≈ 5
  const evidenceClass = classifyMemoryEvidence(memory);
  // Generated narratives and operational traces must not gain durable authority
  // merely because the system repeatedly recalled its own output.
  const retrieveScore = evidenceClass === 'operational_trace'
    ? 0
    : evidenceClass === 'lumi_narrative'
      ? Math.min(0.25, rawRetrieveScore)
      : rawRetrieveScore;

  // Confidence
  const confidenceScore = memory.confidence;

  // Connectedness: having a parent or children adds value
  const connectedBonus = childrenCount > 0
    ? Math.min(0.2, childrenCount * 0.05) // Up to 0.2 bonus
    : memory.parentId ? 0.1 : 0;

  // Hebbian fusion: memories that "fire together" with many others are more valuable
  const hebbianScore = Math.min(0.15, hebbianBonus * 0.15); // Up to 0.15 bonus

  // Weighted composite — Hebbian bonus partially replaces connectedness
  const value = (
    recencyScore * 0.20 +
    retrieveScore * 0.25 +
    confidenceScore * 0.30 +
    connectedBonus * 0.10 +
    hebbianScore * 0.15
  );

  return Math.min(1, +(value).toFixed(3));
}

/** Compute the average Hebbian association strength for a memory */
function getHebbianBonus(userId: string, memoryId: string, domain?: string, orgId?: string): number {
  const userMap = coRetrievalMap.get(userId);
  if (!userMap) return 0;
  const assocMap = userMap.get(memoryId);
  if (!assocMap || assocMap.size === 0) return 0;
  const all = getMemoryStore();
  let total = 0;
  let count = 0;
  for (const [associatedId, strength] of assocMap) {
    const associated = all.find(memory => memory.id === associatedId);
    if (!associated || !matchesMemoryScope(associated, domain, orgId)) continue;
    total += strength;
    count++;
  }
  return count > 0 ? +(total / count).toFixed(3) : 0;
}

/**
 * Auto-promote high-value memories to higher tiers.
 * - Episodic → Internalized: value >= 0.65 for 3+ retrievals
 * - Internalized → Growth: value >= 0.8 for 5+ retrievals
 *
 * Cross-system fusion: intimacy lowers promotion thresholds.
 * Higher intimacy = memories crystallize more easily (the bond makes them meaningful).
 * Returns count of promoted memories.
 */
export function promoteMemories(userId: string, intimacy: number = 0, domain?: string, orgId?: string, agentId?: string): number {
  const all = getMemoryStore();
  let promoted = 0;

  // Intimacy modulation: higher intimacy → lower thresholds (up to 25% reduction)
  const intimacyMod = 1 - Math.min(0.25, intimacy * 0.25);
  const episodicThreshold = +(0.65 * intimacyMod).toFixed(2);
  const growthThreshold = +(0.80 * intimacyMod).toFixed(2);

  for (const m of all) {
    if (m.userId !== userId || !matchesMemoryScope(m, domain, orgId, agentId)) continue;

    // Count children for connectedness bonus
    const childrenCount = all.filter(c => c.parentId === m.id).length;
    const hebbianBonus = getHebbianBonus(userId, m.id, domain, orgId);
    const value = computeMemoryValue(m, childrenCount, hebbianBonus);

    if (m.tier === 'episodic' && value >= episodicThreshold && m.retrieveCount >= 3) {
      m.tier = 'internalized';
      m.importance = Math.min(1, m.importance + 0.15);
      m.updatedAt = new Date().toISOString();
      console.log(`[Memory] Promoted episodic→internalized: "${m.content.slice(0, 50)}..." (value: ${value.toFixed(2)}, intimacy: ${intimacy.toFixed(2)})`);
      promoted++;
    } else if (m.tier === 'internalized' && value >= growthThreshold && m.retrieveCount >= 5) {
      m.tier = 'growth';
      m.importance = Math.min(1, m.importance + 0.2);
      m.updatedAt = new Date().toISOString();
      console.log(`[Memory] Promoted internalized→growth: "${m.content.slice(0, 50)}..." (value: ${value.toFixed(2)}, intimacy: ${intimacy.toFixed(2)})`);
      promoted++;
    }
  }

  if (promoted > 0) saveMemoryStore(all);
  return promoted;
}

/**
 * Dynamic tier-based decay — value modulates the decay speed.
 * High-value memories resist decay; low-value ones decay faster.
 */
export function dynamicDecayMemories(userId: string, domain?: string, orgId?: string, agentId?: string): void {
  const all = getMemoryStore();
  let changed = false;

  const baseRates: Record<MemoryTier, { amount: number; min: number }> = {
    core_identity: { amount: 0, min: 0.9 },
    growth: { amount: 0.02, min: 0.6 },
    internalized: { amount: 0.03, min: 0.3 },
    episodic: { amount: 0.05, min: 0.1 },
  };

  for (const m of all) {
    if (m.userId !== userId || !matchesMemoryScope(m, domain, orgId, agentId)) continue;
    const rate = baseRates[m.tier] || baseRates.episodic;
    if (rate.amount === 0) continue;
    if (m.confidence <= rate.min) continue;

    // Value modulates decay: high-value memories resist decay
    const childrenCount = all.filter(c => c.parentId === m.id).length;
    const hebbianBonus = getHebbianBonus(userId, m.id, domain, orgId);
    const value = computeMemoryValue(m, childrenCount, hebbianBonus);
    const modulation = 1 - (value * 0.6); // value=1 → 0.4x decay, value=0 → 1x decay
    const effectiveDecay = +(rate.amount * modulation).toFixed(3);

    if (effectiveDecay <= 0) continue;
    m.confidence = Math.max(rate.min, +(m.confidence - effectiveDecay).toFixed(2));
    changed = true;
  }

  if (changed) saveMemoryStore(all);
}

// ── Semantic dedup & contradiction detection ──

// Negation patterns in Chinese and English
const NEGATION_PATTERNS = [
  /不[^过论妨仅管只论止断愧外必再会]/u, /没[有想]/u, /别/u, /否/u, /非/u,
  /\bnot\b/i, /\bdon'?t\b/i, /\bnever\b/i, /\bno\b/i, /\bcan'?t\b/i, /\bwon'?t\b/i,
];

// Common polarity-flip pairs: positive → negative
const POLARITY_PAIRS: [RegExp, string][] = [
  [/\b(?:like|likes|liked|love|loves|loved)\b/gi, 'dislike|dislikes|disliked|hate|hates|hated|does not like|do not like'],
  [/喜欢|爱|享受|热爱/g, '讨厌|恨|厌恶|反感'],
  [/好|棒|优秀|出色|赞/g, '差|烂|糟糕|坏|垃圾'],
  [/快|迅速|高效/g, '慢|缓慢|拖沓'],
  [/简单|容易/g, '复杂|困难'],
  [/美|漂亮|好看/g, '丑|难看'],
  [/有用|方便|实用/g, '没用|不便|鸡肋'],
  [/开启|打开|启用|使用/g, '关闭|禁用|停用|不用'],
  [/经常|一直|总是/g, '从不|很少|偶尔'],
];

/**
 * Extract key semantic units from text — CJK bigrams + normalized English words,
 * with negation markers preserved for polarity-aware comparison.
 */
function semanticTokens(text: string): { tokens: Set<string>; negated: Set<string> } {
  const base = tokenize(text);
  const tokens = new Set(base);
  const negated = new Set<string>();

  // Detect negated tokens: if a negation word appears within ±3 chars of a token
  const lower = text.toLowerCase();
  for (const negPat of NEGATION_PATTERNS) {
    const match = lower.match(negPat);
    if (match && match.index !== undefined) {
      const negPos = match.index;
      // Mark tokens near the negation as negated
      for (const t of base) {
        const tpos = lower.indexOf(t);
        if (tpos >= 0 && Math.abs(tpos - negPos) <= 8) {
          negated.add(t);
        }
      }
    }
  }

  return { tokens, negated };
}

/** Check if high-overlap texts have opposite polarity (contradiction) */
function hasPolarityConflict(a: string, b: string): boolean {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();

  for (const [posPat, negList] of POLARITY_PAIRS) {
    posPat.lastIndex = 0;
    const negPats = negList.split('|');
    const aHasPos = posPat.test(lowerA);
    posPat.lastIndex = 0;
    const bHasPos = posPat.test(lowerB);

    for (const negStr of negPats) {
      const negRe = new RegExp(negStr, 'i');
      const aHasNeg = negRe.test(lowerA);
      const bHasNeg = negRe.test(lowerB);

      // One text is positive, the other negative → contradiction
      if ((aHasPos && bHasNeg) || (aHasNeg && bHasPos)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Improved content similarity: combines fast lexical overlap with
 * negation-aware semantic comparison. Returns [score, hasContradiction].
 */
function contentSimilarity(a: string, b: string): number {
  const { tokens: tokA, negated: negA } = semanticTokens(a);
  const { tokens: tokB, negated: negB } = semanticTokens(b);
  if (tokA.size === 0 || tokB.size === 0) return 0;

  // Core lexical overlap (Jaccard with negation penalty)
  let overlap = 0;
  let negOverlap = 0;
  for (const w of tokA) {
    if (tokB.has(w)) {
      overlap++;
      // If one side is negated but the other isn't, reduce effective overlap
      if ((negA.has(w) && !negB.has(w)) || (!negA.has(w) && negB.has(w))) {
        negOverlap++;
      }
    }
  }

  const baseScore = overlap / Math.max(tokA.size, tokB.size);
  // Penalize negated overlaps — they indicate opposite meanings
  const penalty = overlap > 0 ? (negOverlap / overlap) * 0.5 : 0;
  return Math.max(0, baseScore - penalty);
}

/** Check if a new memory contradicts any existing memories for the same user */
function findContradictions(
  newContent: string,
  userId: string,
  memType: string,
  existingMemories: Memory[],
): Memory[] {
  const contradictions: Memory[] = [];
  const lower = newContent.toLowerCase();

  for (const existing of existingMemories) {
    if (existing.userId !== userId || existing.type !== memType) continue;

    const sim = contentSimilarity(newContent, existing.content);
    // Only check for contradiction when there's meaningful overlap
    if (sim < 0.35) continue;

    if (hasPolarityConflict(lower, existing.content.toLowerCase())) {
      contradictions.push(existing);
    }
  }

  return contradictions;
}

// ── Helpers ──

function dedupeKeywords(keywords: string[]): string[] {
  return [...new Set(keywords.map(k => k.toLowerCase()))].slice(0, 10);
}
