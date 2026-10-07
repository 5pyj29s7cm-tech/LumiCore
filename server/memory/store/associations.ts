import { readDatabaseTables, commitDatabaseTables } from '../../../db_layer';
import { Memory, MemoryQuery } from '../types';

import { getMemoryStore } from './state';
import { matchesMemoryQueryFilters, matchesMemoryScope } from './evidence';

// When memories are retrieved in the same query, their pairwise association strengthens.
// Over time, this builds an organic associative network that mirrors the user's mental model.

type CoRetrievalMap = Map<string, Map<string, Map<string, number>>>;

// userId → memoryId → (associatedMemoryId → strength 0-1)

let coRetrievalMap: CoRetrievalMap = new Map();

const ASSOCIATION_STRENGTH_INCREMENT = 0.08;

// Per co-retrieval boost
const ASSOCIATION_DECAY_RATE = 0.02;

// Per decay cycle
const ASSOCIATION_THRESHOLD = 0.25;

/** Persist co-retrieval map to DB */
function saveCoRetrievalMap(): void {
  try {
    const db = readDatabaseTables(["memoryAssociations"]);
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
    commitDatabaseTables(db);
  } catch {}
}

/** Hebbian strengthen: increment association strength between all pairs in a co-retrieved set */
export function strengthenAssociations(userId: string, memoryIds: string[]): void {
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

  saveCoRetrievalMap();
}

/** Persist every strength change, including edges that cross the storage threshold. */
export function decayMemoryAssociations(userId: string): number {
  const userMap = coRetrievalMap.get(userId);
  if (!userMap) return 0;
  const sizeBefore = userMap.size;
  let changed = false;
  for (const [memoryId, associations] of userMap) {
    for (const [otherId, strength] of associations) {
      const next = +(strength - ASSOCIATION_DECAY_RATE).toFixed(3);
      if (next <= 0) associations.delete(otherId); else associations.set(otherId, next);
      changed = true;
    }
    if (associations.size === 0) userMap.delete(memoryId);
  }
  if (userMap.size === 0) coRetrievalMap.delete(userId);
  if (changed) saveCoRetrievalMap();
  return sizeBefore - userMap.size;
}

/** Replace the accepted graph on reload; failed reads preserve the current graph. */
export function initMemoryAssociations(): void {
  try {
    const db = readDatabaseTables(["memoryAssociations"]);
    const next: CoRetrievalMap = new Map();
    for (const row of db.memoryAssociations || []) {
      if (!next.has(row.userId)) next.set(row.userId, new Map());
      const userMap = next.get(row.userId)!;
      for (const [from, to] of [[row.memA, row.memB], [row.memB, row.memA]]) {
        if (!userMap.has(from)) userMap.set(from, new Map());
        userMap.get(from)!.set(to, row.strength);
      }
    }
    coRetrievalMap = next;
  } catch {}
}

export function getAssociatedMemories(
  memoryId: string, userId: string, threshold = ASSOCIATION_THRESHOLD,
  domain?: string, orgId?: string, includeOperationalTraces = false, agentId?: string,
): Memory[] {
  return findAssociatedMemories(
    new Map(getMemoryStore().map(memory => [memory.id, memory])), memoryId,
    { userId, domain, orgId, includeOperationalTraces, agentId }, threshold,
  );
}

/** Share the caller's accepted snapshot and complete query fence during enrichment. */
export function findAssociatedMemories(
  memories: ReadonlyMap<string, Memory>, memoryId: string,
  query: MemoryQuery & { userId: string }, threshold = ASSOCIATION_THRESHOLD,
): Memory[] {
  const source = memories.get(memoryId);
  if (!source || !matchesMemoryQueryFilters(source, query)) return [];
  const associations = coRetrievalMap.get(query.userId)?.get(memoryId);
  if (!associations) return [];
  return [...associations].flatMap(([id, strength]) => {
    const memory = memories.get(id);
    return strength >= threshold && memory && matchesMemoryQueryFilters(memory, query) ? [memory] : [];
  });
}

/** Compute the average Hebbian association strength for a memory */
export function getHebbianBonus(userId: string, memoryId: string, memories: ReadonlyMap<string, Memory>, domain?: string, orgId?: string, agentId?: string): number {
  const userMap = coRetrievalMap.get(userId);
  if (!userMap) return 0;
  const assocMap = userMap.get(memoryId);
  if (!assocMap || assocMap.size === 0) return 0;
  let total = 0;
  let count = 0;
  for (const [associatedId, strength] of assocMap) {
    const associated = memories.get(associatedId);
    if (!associated || !matchesMemoryScope(associated, domain, orgId, agentId, userId)) continue;
    total += strength;
    count++;
  }
  return count > 0 ? +(total / count).toFixed(3) : 0;
}
