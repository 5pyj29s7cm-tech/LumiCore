import { readDB, writeDB } from '../../db_layer';
import { Memory, MemoryQuery, MemoryType, MemoryTier, MemoryPerspective } from './types';
import { applyMemoryFirewallMetadata, evaluateMemoryFirewall } from './firewall';

function getMemoryStore(): Memory[] {
  const db = readDB();
  if (!db.memories) db.memories = [];
  return db.memories;
}

// ── Embedding / Vector Search ──

/** LRU cache for embeddings: text → vector. Avoids re-embedding the same content. */
const embeddingCache = new Map<string, number[]>();
const EMBEDDING_CACHE_MAX = 500;

function cacheEmbedding(text: string, vec: number[]) {
  if (embeddingCache.size >= EMBEDDING_CACHE_MAX) {
    const first = embeddingCache.keys().next().value;
    if (first) embeddingCache.delete(first);
  }
  embeddingCache.set(text, vec);
}

function getCachedEmbedding(text: string): number[] | undefined {
  return embeddingCache.get(text);
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

/** Generate embedding vector via OpenAI text-embedding-3-small. Returns null if API unavailable. */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  // Check cache first
  const cached = getCachedEmbedding(text);
  if (cached) return cached;

  const apiKey = process.env.OPENAI_API_KEY || '';
  if (!apiKey) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 8000) }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;

    const json = await res.json() as any;
    const vec = json.data?.[0]?.embedding;
    if (vec && Array.isArray(vec) && vec.length > 0) {
      cacheEmbedding(text, vec);
      return vec;
    }
    return null;
  } catch {
    return null; // API unavailable — silent fallback to keyword search
  }
}

/** Async background embedding generation — updates memory in-place */
async function attachEmbedding(memory: Memory): Promise<void> {
  if (memory.embedding && memory.embedding.length > 0) return;
  const text = `${memory.type}: ${memory.content} ${memory.keywords.join(' ')}`;
  const vec = await generateEmbedding(text);
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
      if (mem && matchesMemoryScope(mem, domain, orgId)) result.push(mem);
    }
  }
  return result;
}

function matchesMemoryScope(memory: Memory, domain?: string, orgId?: string): boolean {
  if (domain !== undefined && (memory.domain || 'personal') !== domain) return false;
  if (orgId !== undefined && (memory.orgId || '') !== orgId) return false;
  return true;
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

  const cutoffB = q.before ? new Date(q.before).getTime() : 0;
  const cutoffA = q.after ? new Date(q.after).getTime() : 0;

  // Single-pass filter combining all conditions
  let memories = all.filter(m => {
    if (q.userId && m.userId !== q.userId) return false;
    if (q.agentId !== undefined && (m.agentId || '') !== q.agentId) return false;
    if (q.type && m.type !== q.type) return false;
    if (q.minConfidence !== undefined && m.confidence < q.minConfidence) return false;
    if (q.tier && m.tier !== q.tier) return false;
    if (q.perspective && m.perspective !== q.perspective) return false;
    if (q.minImportance !== undefined && m.importance < q.minImportance) return false;
    if (q.unconsolidatedOnly && m.parentId) return false;
    if (q.parentId !== undefined && m.parentId !== q.parentId) return false;
    if (q.nodeType && m.nodeType !== q.nodeType) return false;
    if (q.before && new Date(m.createdAt).getTime() > cutoffB) return false;
    if (q.after && new Date(m.createdAt).getTime() < cutoffA) return false;
    if (q.location !== undefined && (m.location || '') !== q.location) return false;
    if (q.domain !== undefined && (m.domain || 'personal') !== q.domain) return false;
    if (q.orgId !== undefined && (m.orgId || '') !== q.orgId) return false;
    return true;
  });

  // Tier-based priority: core_identity always first, then growth, then internalized, then episodic
  const tierPriority: Record<string, number> = {
    core_identity: 0,
    growth: 1,
    internalized: 2,
    episodic: 3,
  };

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
        const tierDiff = (tierPriority[a.m.tier] || 3) - (tierPriority[b.m.tier] || 3);
        if (Math.abs(tierDiff) >= 2) return tierDiff;
        return b.score - a.score;
      });
    memories = scored.map(({ m }) => m);
  } else {
    // Sort by tier priority, then importance, then confidence, then recency
    // Apply personality-driven perspective bias to priority sorting
    memories.sort((a, b) => {
      const tierDiff = (tierPriority[a.tier] || 3) - (tierPriority[b.tier] || 3);
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
      const assoc = getAssociatedMemories(m.id, q.userId, ASSOCIATION_THRESHOLD, q.domain, q.orgId);
      for (const am of assoc) {
        if (!resultIdSet.has(am.id) && matchesMemoryScope(am, q.domain, q.orgId)) {
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

  // Mark as retrieved (including associated ones)
  const now = new Date().toISOString();
  const store = getMemoryStore();
  for (const m of result) {
    const stored = store.find(s => s.id === m.id);
    if (stored) {
      stored.lastRetrievedAt = now;
      stored.retrieveCount = (stored.retrieveCount || 0) + 1;
    }
  }
  if (result.length > 0) saveMemoryStore(store);

  return result;
}

/** Async vector-based semantic search. Falls back to keyword search if embeddings unavailable. */
export async function queryMemoriesVector(q: MemoryQuery): Promise<Memory[]> {
  if (!q.query || !q.useVector) {
    return queryMemories(q);
  }

  // Generate query embedding
  const queryVec = await generateEmbedding(q.query);
  if (!queryVec) {
    // Embeddings unavailable — fall back to keyword search
    return queryMemories({ ...q, useVector: false });
  }

  // Score all keyword-filtered results with cosine similarity
  const keywordResults = queryMemories({ ...q, useVector: false });
  const scored = keywordResults
    .map(m => {
      if (!m.embedding || m.embedding.length === 0) {
        return { m, score: relevanceScore(q.query!, m) }; // fallback for unembedded memories
      }
      const cos = cosineSimilarity(queryVec, m.embedding);
      return { m, score: +(cos * m.confidence).toFixed(4) };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  const limit = q.limit || 5;
  return scored.slice(0, limit).map(({ m }) => m);
}

/** Pre-generate embeddings for all existing memories that lack them. One-time migration. */
export async function backfillEmbeddings(userId?: string): Promise<number> {
  const all = getMemoryStore();
  const targets = all.filter(m => !m.embedding && (!userId || m.userId === userId));
  let count = 0;
  for (const m of targets) {
    const vec = await generateEmbedding(`${m.type}: ${m.content} ${m.keywords.join(' ')}`);
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
  },
): Memory {
  const all = getMemoryStore();
  const tier = overrides?.tier ?? 'episodic';
  const domain = overrides?.domain ?? memory.domain ?? 'personal';
  const orgId = overrides?.orgId ?? memory.orgId ?? '';
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
    matchesMemoryScope(m, domain, orgId)
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
  const existing = dedupCandidates.find(m =>
    matchesMemoryScope(m, domain, orgId) && contentSimilarity(m.content, memory.content) > 0.7,
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
    applyMemoryFirewallMetadata(existing, firewall);
    saveMemoryStore(all);
    return existing;
  }

  const newMemory: Memory = {
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
  };
  applyMemoryFirewallMetadata(newMemory, firewall);

  all.push(newMemory);
  saveMemoryStore(all);

  // Background: generate embedding for semantic search
  attachEmbedding(newMemory).catch(() => {});

  return newMemory;
}

export function removeMemory(id: string): boolean {
  const all = getMemoryStore();
  const idx = all.findIndex(m => m.id === id);
  if (idx === -1) return false;
  all.splice(idx, 1);
  saveMemoryStore(all);
  return true;
}

/** Tier-based decay: core_identity never decays, episodic decays fast */
export function decayMemories(userId: string, domain?: string, orgId?: string): void {
  const all = getMemoryStore();
  let changed = false;

  const decayRates: Record<MemoryTier, { amount: number; min: number }> = {
    core_identity: { amount: 0, min: 0.9 },     // Never decays
    growth: { amount: 0.02, min: 0.6 },          // Very slow
    internalized: { amount: 0.03, min: 0.3 },    // Slow
    episodic: { amount: 0.05, min: 0.1 },        // Fast
  };

  for (const m of all) {
    if (m.userId !== userId || !matchesMemoryScope(m, domain, orgId)) continue;
    const rate = decayRates[m.tier] || decayRates.episodic;
    if (rate.amount === 0) continue;
    if (m.confidence <= rate.min) continue;
    m.confidence = Math.max(rate.min, +(m.confidence - rate.amount).toFixed(2));
    changed = true;
  }

  if (changed) saveMemoryStore(all);
}

/** Get episodic memories that are ready for consolidation (unconsolidated, count >= threshold) */
export function getUnconsolidatedEpisodic(userId: string, domain?: string, orgId?: string): Memory[] {
  return getMemoryStore().filter(m =>
    m.userId === userId &&
    m.tier === 'episodic' &&
    !m.parentId &&
    m.confidence >= 0.2 &&
    (domain ? (m.domain || 'personal') === domain : true) &&
    (orgId !== undefined ? (m.orgId || '') === orgId : true)
  );
}

/** Mark episodic memories as consolidated by setting parentId */
export function markConsolidated(ids: string[], parentId: string): void {
  const all = getMemoryStore();
  for (const m of all) {
    if (ids.includes(m.id)) {
      m.parentId = parentId;
      // Promote consolidated memories — they're now part of something bigger
      m.importance = Math.min(1, m.importance + 0.2);
    }
  }
  saveMemoryStore(all);
}

export function formatMemoriesForContext(memories: Memory[]): string {
  if (memories.length === 0) return '';

  // Separate branches and leaves
  const branches = memories.filter(m => m.nodeType === 'branch');
  const leaves = memories.filter(m => m.nodeType !== 'branch');

  const lines: string[] = [];

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
    lines.push(`### ${branch.content}`);
    children.sort((a, b) => b.importance - a.importance || b.confidence - a.confidence);
    for (const m of children) {
      lines.push(`- ${m.content}`);
    }
  }

  // Output ungrouped leaves (no parent branch)
  const orphans = byParent.get(null) || [];
  if (orphans.length > 0) {
    for (const m of orphans) {
      // Filter out branches from the root display
      if (m.nodeType !== 'branch') {
        lines.push(`- ${m.content}`);
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
  const retrieveScore = Math.min(1, Math.log2(memory.retrieveCount + 1) / 5); // log2(33) ≈ 5

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
export function promoteMemories(userId: string, intimacy: number = 0, domain?: string, orgId?: string): number {
  const all = getMemoryStore();
  let promoted = 0;

  // Intimacy modulation: higher intimacy → lower thresholds (up to 25% reduction)
  const intimacyMod = 1 - Math.min(0.25, intimacy * 0.25);
  const episodicThreshold = +(0.65 * intimacyMod).toFixed(2);
  const growthThreshold = +(0.80 * intimacyMod).toFixed(2);

  for (const m of all) {
    if (m.userId !== userId || !matchesMemoryScope(m, domain, orgId)) continue;

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
export function dynamicDecayMemories(userId: string, domain?: string, orgId?: string): void {
  const all = getMemoryStore();
  let changed = false;

  const baseRates: Record<MemoryTier, { amount: number; min: number }> = {
    core_identity: { amount: 0, min: 0.9 },
    growth: { amount: 0.02, min: 0.6 },
    internalized: { amount: 0.03, min: 0.3 },
    episodic: { amount: 0.05, min: 0.1 },
  };

  for (const m of all) {
    if (m.userId !== userId || !matchesMemoryScope(m, domain, orgId)) continue;
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
    const negPats = negList.split('|');
    const aHasPos = posPat.test(lowerA);
    const bHasPos = posPat.test(lowerB);

    for (const negStr of negPats) {
      const negRe = new RegExp(negStr, 'g');
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

// ── Cross-Agent Memory Sharing ──

/**
 * Borrow high-value memories from other agents that match the given topic.
 * Only returns memories marked crossAgentShare:true, and respects sharedToAgentIds.
 *
 * This enables the "wisdom of the swarm" — agents learn from each other's
 * crystallized insights without sharing raw episodic context.
 */
export function borrowAgentMemories(
  requestingAgentId: string,
  topic: string,
  userId: string,
  limit: number = 5,
): Memory[] {
  const all = getMemoryStore();
  const topicTokens = new Set(tokenize(topic.toLowerCase()));

  const candidates: Array<{ memory: Memory; score: number }> = [];

  for (const m of all) {
    // Skip own memories
    if (m.agentId === requestingAgentId) continue;
    // Skip if not cross-agent shareable
    if (!m.crossAgentShare) continue;
    // Respect targeted sharing
    if (m.sharedToAgentIds && m.sharedToAgentIds.length > 0) {
      if (!m.sharedToAgentIds.includes(requestingAgentId) && !m.sharedToAgentIds.includes('*')) {
        continue;
      }
    }
    // Must be same user
    if (m.userId !== userId) continue;
    // Only high-tier memories (growth, internalized) are worth borrowing
    if (m.tier !== 'growth' && m.tier !== 'internalized' && m.tier !== 'core_identity') continue;
    // Minimum importance threshold
    if (m.importance < 0.6) continue;

    // Score by topic relevance
    const memTokens = new Set(m.keywords.map(k => k.toLowerCase()));
    let overlap = 0;
    for (const t of topicTokens) {
      if (memTokens.has(t)) overlap++;
    }
    // Also check content for substring match
    const contentLower = m.content.toLowerCase();
    for (const t of topicTokens) {
      if (contentLower.includes(t)) overlap += 0.5;
    }

    if (overlap > 0) {
      // Weight by tier and importance
      const tierWeight = m.tier === 'core_identity' ? 1.5 : m.tier === 'growth' ? 1.2 : 0.9;
      const score = overlap * tierWeight * m.importance;
      candidates.push({ memory: m, score });
    }
  }

  // Sort by score descending, take top N
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit).map(c => c.memory);
}

/**
 * Auto-mark high-value memories as cross-agent shareable.
 * Called after memory promotion/crystallization.
 * Growth-tier memories and internalized memories with importance > 0.7 get auto-shared.
 */
export function autoMarkCrossAgentShare(userId: string, domain?: string, orgId?: string): number {
  const all = getMemoryStore();
  let marked = 0;

  for (const m of all) {
    if (m.userId !== userId || !matchesMemoryScope(m, domain, orgId)) continue;
    if (m.crossAgentShare) continue; // Already marked

    if (m.tier === 'growth') {
      m.crossAgentShare = true;
      marked++;
    } else if (m.tier === 'internalized' && m.importance > 0.7) {
      m.crossAgentShare = true;
      marked++;
    }
  }

  if (marked > 0) saveMemoryStore(all);
  return marked;
}

// ── Helpers ──

function dedupeKeywords(keywords: string[]): string[] {
  return [...new Set(keywords.map(k => k.toLowerCase()))].slice(0, 10);
}
