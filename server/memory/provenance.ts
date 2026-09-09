import { readDB, writeDB } from '../../db_layer';
import type { Memory } from './types';

export function isTestLearningSource(source?: string): boolean {
  return /^(?:(?:local_)?acceptance(?:_harness)?|e2e|probe|smoke|test)(?:[-_:]|$)/i.test(String(source || '').trim());
}

/** Only explicit test identifiers are inferred for legacy records without provenance. */
export function isTestMemory(memory: Pick<Memory, 'sourceInteractionId' | 'content'>): boolean {
  return isTestLearningSource(memory.sourceInteractionId)
    || /\bLC-(?:TASK|SKILL|WORKFLOW)-|this is isolated read-only verification/i.test(memory.content);
}

export function isOwnerEvolutionEvidence(memory: Memory): boolean {
  return memory.nodeType !== 'branch' && memory.perspective === 'owner_trait'
    && !isTestMemory(memory) && ['chat', 'voice', 'manual'].includes(memory.source || '')
    && !memory.agentId?.startsWith('memory_avatar_');
}

/** Preserve original records; remove confirmed test material from ordinary learning. */
export function repairTestMemoryProvenance(): number {
  const db = readDB();
  const marker = 'memory_test_provenance_repair_v1';
  if (db.settings?.some(row => row.key === marker)) return 0;
  const interactions = new Map<string, any>((db.interactions || []).map(row => [row.id, row]));
  const changes: any[] = [];
  for (const memory of db.memories || []) {
    const origin = interactions.get(memory.sourceInteractionId);
    if (!isTestMemory(memory) && !isTestLearningSource(origin?.source)) continue;
    changes.push({ id: memory.id, sourceInteractionId: memory.sourceInteractionId, perspective: memory.perspective, retention: memory.retention });
    memory.sourceInteractionId = `test:legacy:${memory.sourceInteractionId}`;
    memory.perspective = 'shared_memory';
    memory.retention = 'session';
  }
  // Repair only profiles with an unambiguous test phrase, retaining the exact
  // previous state for recovery. Do not guess that ordinary technical interests are tests.
  const profiles: any[] = [];
  for (const row of db.settings || []) {
    if (!row.key.startsWith('personality_user_state:')) continue;
    try {
      const state = JSON.parse(row.value);
      if (!/this is isolated read-only verification|LC-(?:TASK|SKILL|WORKFLOW)-/i.test(JSON.stringify(state.growthState || {}))) continue;
      profiles.push({ key: row.key, value: row.value });
      delete state.growthState;
      state.lastEvolvedAt = null;
      row.value = JSON.stringify(state);
    } catch { /* Invalid unrelated state is left untouched. */ }
  }
  db.settings ||= [];
  db.settings.push({ key: marker, value: JSON.stringify({ at: new Date().toISOString(), memories: changes, profiles }) });
  writeDB(db);
  return changes.length;
}
