import { updateMemoryRow, type MemoryOwnerScope } from '../repository';

import { Memory, MemoryTier } from '../types';
import { applyMemoryFirewallMetadata, evaluateMemoryFirewall } from '../firewall';

import { hasCurrentMemoryEmbedding, invalidateMemoryEmbedding, memoryEmbeddingInputHash } from '../embedding_identity';

import { getMemoryStore, saveMemoryStore } from './state';
import { matchesMemoryScope } from './evidence';
import { embeddingNamespace, attachEmbedding, refreshMemoryEmbedding } from './embeddings';
import { contentSimilarity, findContradictions, dedupeKeywords } from './text';

function generateId(): string {
  return `mem_${crypto.randomUUID()}`;
}

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
  const contradictions = findContradictions(memory.content, candidates);
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
  const existing = overrides?.deduplicate === false || contradictions.length > 0
    ? undefined
    : candidates.find(m => contentSimilarity(m.content, memory.content) > 0.7);

  const now = new Date().toISOString();

  if (existing) {
    // Merge: increase confidence, update content if new one has higher confidence
    const previousInput = memoryEmbeddingInputHash(existing);
    existing.content = memory.confidence > existing.confidence ? memory.content : existing.content;
    existing.keywords = dedupeKeywords([...existing.keywords, ...memory.keywords]);
    existing.confidence = Math.min(1, existing.confidence + 0.1);
    existing.importance = Math.max(existing.importance, overrides?.importance ?? 0.3);
    existing.updatedAt = now;
    existing.domain = domain;
    existing.orgId = orgId;
    Object.assign(existing, applyMemoryFirewallMetadata(existing, firewall));
    if (memoryEmbeddingInputHash(existing) !== previousInput) {
      invalidateMemoryEmbedding(existing);
      if (overrides?.generateEmbedding !== false) void attachEmbedding(existing).catch(() => {});
    }
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

  if (newMemory.embedding && newMemory.embeddingNamespace) {
    newMemory.embeddingContentHash = memoryEmbeddingInputHash(newMemory);
    if (!hasCurrentMemoryEmbedding(newMemory)) invalidateMemoryEmbedding(newMemory);
  }

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

export function updateScopedMemory(
  scope: MemoryOwnerScope,
  id: string,
  patch: Partial<Pick<Memory, 'content' | 'keywords' | 'confidence' | 'type' | 'parentId' | 'nodeType'>>,
): Memory | undefined {
  let reindex = false;
  const memory = updateMemoryRow(scope, id, draft => {
    const previous = memoryEmbeddingInputHash(draft);
    for (const key of ['content', 'keywords', 'confidence', 'type', 'parentId', 'nodeType'] as const) {
      if (patch[key] !== undefined) (draft as any)[key] = patch[key];
    }
    draft.updatedAt = new Date().toISOString();
    reindex = memoryEmbeddingInputHash(draft) !== previous;
    if (reindex) invalidateMemoryEmbedding(draft);
  });
  if (memory && reindex) refreshMemoryEmbedding(memory);
  return memory;
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
  if (input.chosenMemoryId && !group.some(memory => memory.id === input.chosenMemoryId)) {
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
