
import { Memory, MemoryTier } from '../types';

import { assertMemoryParent, type MemoryOwnerScope } from '../repository';
import { getMemoryStore, saveMemoryStore } from './state';
import { isOperationalTraceMemory, classifyMemoryEvidence, matchesMemoryScope } from './evidence';
import { getHebbianBonus } from './associations';

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

/** Validate the complete batch before committing its parent links. */
export function markConsolidated(ids: string[], parentId: string, agentId?: string): void {
  const all = getMemoryStore();
  const parent = all.find(memory => memory.id === parentId);
  if (!parent || (agentId !== undefined && (parent.agentId || '') !== agentId)) {
    throw new RangeError('Cannot move: circular reference or parent not found');
  }
  const scope: MemoryOwnerScope = {
    userId: parent.userId, domain: parent.domain === 'work' ? 'work' : 'personal',
    orgId: parent.orgId || '', agentId: parent.agentId || '',
  };
  const selectedIds = new Set(ids);
  const children = all.filter(memory => selectedIds.has(memory.id)
    && matchesMemoryScope(memory, scope.domain, scope.orgId, scope.agentId, scope.userId));
  for (const memory of children) assertMemoryParent(scope, { ...memory, parentId }, all);
  for (const memory of children) {
    memory.parentId = parentId;
    memory.importance = Math.min(1, memory.importance + .2);
  }
  if (children.length) saveMemoryStore(all);
}

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

  for (const { memory: m, value } of memoryValues(all, userId, domain, orgId, agentId)) {


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

  for (const { memory: m, value } of memoryValues(all, userId, domain, orgId, agentId)) {
    const rate = baseRates[m.tier] || baseRates.episodic;
    if (rate.amount === 0) continue;
    if (m.confidence <= rate.min) continue;

    // High-value memories resist decay.
    const modulation = 1 - (value * 0.6); // value=1 → 0.4x decay, value=0 → 1x decay
    const effectiveDecay = +(rate.amount * modulation).toFixed(3);

    if (effectiveDecay <= 0) continue;
    m.confidence = Math.max(rate.min, +(m.confidence - effectiveDecay).toFixed(2));
    changed = true;
  }

  if (changed) saveMemoryStore(all);
}

/** Evaluate one accepted owner snapshot; avoid rescanning or cloning all memories per node. */
function* memoryValues(all: Memory[], userId: string, domain?: string, orgId?: string, agentId?: string) {
  const owned = all.filter(memory => matchesMemoryScope(memory, domain, orgId, agentId, userId));
  const byId = new Map(owned.map(memory => [memory.id, memory]));
  const children = new Map<string, number>();
  for (const memory of owned) if (memory.parentId) children.set(memory.parentId, (children.get(memory.parentId) || 0) + 1);
  for (const memory of owned) yield { memory, value: computeMemoryValue(memory, children.get(memory.id) || 0,
    getHebbianBonus(userId, memory.id, byId, domain, orgId, agentId)) };
}
