import { Memory, MemoryEvidenceClass, MemoryQuery, isMemoryAvatarAgentId } from '../types';

import { isTestMemory, isMalformedBehavioralMemory, isDerivedLearningMemory } from '../provenance';

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
    || source.startsWith('quarantine:')
    || isMalformedBehavioralMemory(memory)
    || isDerivedLearningMemory(memory)
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

export function matchesMemoryQueryFilters(memory: Memory, query: MemoryQuery): boolean {
  if (!query.includeOperationalTraces && isTestMemory(memory)) return false;
  if (!query.includeSuperseded && memory.conflict?.status === 'resolved'
    && memory.conflict.resolution === 'prefer_one' && memory.conflict.chosenMemoryId !== memory.id) return false;
  if (query.includeOperationalTraces !== true && isOperationalTraceMemory(memory)) return false;
  if (query.evidenceClasses && !query.evidenceClasses.includes(classifyMemoryEvidence(memory))) return false;
  if (!matchesMemoryScope(memory, query.domain, query.orgId, query.agentId, query.userId)) return false;
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
  return true;
}

export function matchesMemoryScope(
  memory: Memory, domain?: string, orgId?: string, agentId?: string, userId?: string,
): boolean {
  return (!userId || memory.userId === userId)
    && (domain === undefined || (memory.domain || 'personal') === domain)
    && (orgId === undefined || (memory.orgId || '') === orgId)
    && (agentId === undefined ? !isMemoryAvatarScoped(memory) : (memory.agentId || '') === agentId);
}

export function isMemoryAvatarScoped(memory: Pick<Memory, 'agentId'>): boolean {
  return isMemoryAvatarAgentId(memory.agentId);
}
