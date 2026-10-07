import { Memory } from '../types';

import { classifyMemoryEvidence } from './evidence';

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
    'When quoting a recalled identifier, marker, path, code or exact location, copy its characters verbatim. Do not decorate, translate, insert spaces, or invent a variant. If uncertain, say so.',
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
