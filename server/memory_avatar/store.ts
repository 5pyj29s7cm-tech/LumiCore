import { randomUUID } from 'node:crypto';
import { readDB, writeDB } from '../../db_layer';
import { addMemory } from '../memory';

export interface MemoryAvatarRecord {
  id: string;
  userId: string;
  name: string;
  relationshipType: string;
  status: 'active' | 'archived';
  payload: Record<string, any>;
  personalityConfig: Record<string, any>;
  evidenceMap: Array<{ memoryIndex: number; grade: string; source: string }>;
  seedMemories: Array<Record<string, any>>;
  narrative?: string;
  isFrozen: boolean;
  createdAt: string;
  updatedAt: string;
}

function parsePayload(value: unknown): Record<string, any> {
  if (value && typeof value === 'object') return { ...(value as Record<string, any>) };
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return {};
}

function normalize(row: any): MemoryAvatarRecord {
  const payload = parsePayload(row?.payload);
  return {
    ...row,
    id: String(row?.id || ''),
    userId: String(row?.userId || ''),
    name: String(row?.name || 'Memory'),
    relationshipType: String(row?.relationshipType || 'close_friend'),
    status: row?.status === 'archived' ? 'archived' : 'active',
    payload,
    personalityConfig: payload.personalityConfig && typeof payload.personalityConfig === 'object' ? payload.personalityConfig : {},
    evidenceMap: Array.isArray(payload.evidenceMap) ? payload.evidenceMap : [],
    seedMemories: Array.isArray(payload.seedMemories) ? payload.seedMemories : [],
    narrative: typeof payload.narrative === 'string' ? payload.narrative : '',
    isFrozen: payload.isFrozen !== false,
    createdAt: String(row?.createdAt || ''),
    updatedAt: String(row?.updatedAt || row?.createdAt || ''),
  };
}

export function listMemoryAvatars(userId: string, includeArchived = false): MemoryAvatarRecord[] {
  const rows = (readDB().memoryAvatars || [])
    .filter((row: any) => String(row.userId || '') === userId)
    .map(normalize);
  return includeArchived ? rows : rows.filter(row => row.status === 'active');
}

export function getMemoryAvatar(userId: string, id: string): MemoryAvatarRecord | null {
  const row = (readDB().memoryAvatars || []).find((candidate: any) => (
    String(candidate.id || '') === id && String(candidate.userId || '') === userId
  ));
  return row ? normalize(row) : null;
}

export function createMemoryAvatar(input: {
  userId: string;
  name: string;
  relationshipType: string;
  personalityConfig: Record<string, any>;
  evidenceMap?: any[];
  seedMemories?: any[];
  narrative?: string;
}): MemoryAvatarRecord {
  const db = readDB();
  if (!Array.isArray(db.memoryAvatars)) db.memoryAvatars = [];
  const now = new Date().toISOString();
  const id = `memory_avatar_${randomUUID()}`;
  const payload = {
    personalityConfig: input.personalityConfig || {},
    evidenceMap: Array.isArray(input.evidenceMap) ? input.evidenceMap.slice(0, 100) : [],
    seedMemories: Array.isArray(input.seedMemories) ? input.seedMemories.slice(0, 50) : [],
    narrative: String(input.narrative || '').slice(0, 2000),
    isFrozen: true,
  };
  const row = {
    id,
    userId: input.userId,
    name: String(input.name || 'Memory').trim().slice(0, 120) || 'Memory',
    relationshipType: String(input.relationshipType || 'close_friend').trim() || 'close_friend',
    status: 'active',
    payload,
    createdAt: now,
    updatedAt: now,
  };
  db.memoryAvatars.push(row);
  writeDB(db);

  // Seed memories are scoped to the avatar ID. They never enter Lumi's
  // shared memory lane, which keeps the companion private and tool-free.
  for (const [index, seed] of payload.seedMemories.entries()) {
    if (!seed || typeof seed !== 'object' || !String(seed.content || '').trim()) continue;
    addMemory({
      userId: input.userId,
      type: ['preference', 'fact', 'habit', 'knowledge'].includes(String(seed.type)) ? String(seed.type) : 'fact',
      content: String(seed.content).slice(0, 1000),
      keywords: Array.isArray(seed.keywords) ? seed.keywords.slice(0, 12) : [],
      confidence: Math.min(0.95, Math.max(0.1, Number(seed.confidence) || 0.6)),
      sourceInteractionId: `memory-avatar-import:${id}:${index}`,
    } as any, {
      domain: 'personal',
      orgId: '',
      agentId: id,
      source: 'memory_avatar_import',
      privacyClass: 'private',
      userApproved: true,
    } as any);
  }
  return normalize(row);
}

export function archiveMemoryAvatar(userId: string, id: string): boolean {
  const db = readDB();
  const row = (db.memoryAvatars || []).find((candidate: any) => (
    String(candidate.id || '') === id && String(candidate.userId || '') === userId
  ));
  if (!row) return false;
  row.status = 'archived';
  row.updatedAt = new Date().toISOString();
  writeDB(db);
  return true;
}
