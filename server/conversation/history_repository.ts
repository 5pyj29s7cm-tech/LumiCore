import { projectConversationReceiptHistory } from './receipt_history';
import { readDB, writeDB } from '../../db_layer';
import { cloneDatabaseValue } from '../db/snapshot_changes';
import type { ConversationOwner } from './lifecycle';

export interface InteractionHistoryFilter {
  domain?: string;
  orgId?: string;
  conversationId?: string;
  conversationIds?: readonly string[];
  mode?: string;
  role?: string;
  after?: string;
  before?: string;
  order?: 'newest' | 'oldest';
  limit?: number;
}

/** Read detached history for one owner; callers cannot obtain another table. */
export function listUserInteractions(userId: string, filter: InteractionHistoryFilter = {}): any[] {
  if (!userId) return [];
  const ids = filter.conversationIds ? new Set(filter.conversationIds) : null;
  let rows = (readDB().interactions || []).filter((row: any) => row.userId === userId
    && (filter.domain === undefined || (row.domain || 'personal') === filter.domain)
    && (filter.orgId === undefined || (row.orgId || '') === filter.orgId)
    && (filter.conversationId === undefined || row.conversationId === filter.conversationId)
    && (!ids || ids.has(row.conversationId))
    && (!filter.mode || row.mode === filter.mode)
    && (!filter.role || row.role === filter.role)
    && (!filter.after || row.timestamp >= filter.after)
    && (!filter.before || row.timestamp < filter.before));
  if (filter.order) {
    const direction = filter.order === 'newest' ? -1 : 1;
    rows.sort((a: any, b: any) => direction * (new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime()));
  }
  if (filter.limit && Number.isFinite(filter.limit) && filter.limit > 0) rows = rows.slice(0, Math.trunc(filter.limit));
  return cloneDatabaseValue(rows);
}

/** The transport may append a plain message, never choose its storage owner. */
export function appendUserInteraction(userId: string, content: unknown, role: unknown): any {
  if (!userId) throw new Error('Interaction owner is required');
  const db = readDB();
  const row = { id: crypto.randomUUID(), userId, content, role, timestamp: new Date().toISOString() };
  const next = cloneDatabaseValue(row);
  writeDB({ ...db, interactions: [...(db.interactions || []), next] });
  return cloneDatabaseValue(next);
}

/** Identity-only check: reading authorization never repairs or writes a conversation. */
export function ownedConversationExists(conversationId: string, owner: ConversationOwner): boolean {
  return Boolean(conversationId && owner.userId) && (readDB().conversations || []).some(row => row.id === conversationId
    && row.userId === owner.userId && (!owner.agentId || row.agentId === owner.agentId)
    && (owner.domain === 'work'
      ? row.domain === 'work' && String(row.orgId || '') === String(owner.orgId || '')
      : row.domain !== 'work' && !row.orgId));
}

function workspaceMatches(row: any, owner: ConversationOwner): boolean {
  return owner.domain === 'work' ? Boolean(owner.orgId) && row.orgId === owner.orgId : !row.orgId;
}

/** Preserve transport 404/403 responses without exposing a foreign conversation. */
export function conversationAccessStatus(id: string, owner: ConversationOwner): 'missing' | 'forbidden' | 'allowed' {
  const row = (readDB().conversations || []).find(item => item.id === id);
  if (!row) return 'missing';
  if (!owner.userId) return 'forbidden';
  return row.userId === owner.userId && (!owner.agentId || row.agentId === owner.agentId)
    && workspaceMatches(row, owner) ? 'allowed' : 'forbidden';
}

/** Bounded display metadata only; task state and summary repair stay in the manager. */
export function listConversationHeaders(owner: ConversationOwner, limit?: number): any[] {
  if (!owner.userId) return [];
  let rows = (readDB().conversations || []).filter(row => row.userId === owner.userId
    && (!owner.agentId || row.agentId === owner.agentId) && workspaceMatches(row, owner));
  rows.sort((a, b) => new Date(b.lastActiveAt).getTime() - new Date(a.lastActiveAt).getTime());
  if (limit !== undefined) rows = rows.slice(0, limit);
  return cloneDatabaseValue(rows.map(({ id, title, messageCount, lastActiveAt, createdAt, status, domain }: any) => ({ id, title, messageCount, lastActiveAt, createdAt, status, domain })));
}

/** Stable request history with receipt projection; duplicate legacy pairs use indexed lookup. */
export function listConversationReceiptHistory(conversationId: string, limit = 1000): any[] {
  const db = readDB();
  const rows = (db.interactions || []).map((row: any, insertionOrder: number) => ({ row, insertionOrder }))
    .filter(({ row }: any) => row.conversationId === conversationId)
    .sort((a: any, b: any) => {
      const timestampDelta = new Date(a.row.timestamp).getTime() - new Date(b.row.timestamp).getTime();
      if (timestampDelta) return timestampDelta;
      const aSequence = Number(a.row.routeSequence), bSequence = Number(b.row.routeSequence);
      if (Number.isFinite(aSequence) && Number.isFinite(bSequence) && aSequence !== bSequence) return aSequence - bSequence;
      return a.insertionOrder - b.insertionOrder;
    }).map(({ row }: any) => row);
  const splitUsers = new Map<string, number[]>(), assistants = new Map<string, number[]>();
  for (const row of rows) {
    const time = new Date(row.timestamp).getTime();
    if (!Number.isFinite(time)) continue;
    const index = row.role === 'assistant' ? assistants
      : row.role === 'user' && !String(row.response || '').trim() ? splitUsers : null;
    if (!index) continue;
    const key = String(row.message || row.content || '').trim();
    const times = index.get(key) || []; times.push(time); index.set(key, times);
  }
  for (const times of [...splitUsers.values(), ...assistants.values()]) times.sort((a, b) => a - b);
  const hasSibling = (index: Map<string, number[]>, text: string, time: number): boolean => {
    const times = index.get(text) || [];
    if (!Number.isFinite(time)) return false;
    let low = 0, high = times.length;
    while (low < high) { const mid = (low + high) >>> 1; if (times[mid] <= time - 2000) low = mid + 1; else high = mid; }
    return low < times.length && times[low] < time + 2000;
  };
  const visible = rows.filter((row: any) => {
    const response = String(row.response || '').trim();
    if (row.role !== 'user' || !response) return true;
    const time = new Date(row.timestamp).getTime();
    return !hasSibling(splitUsers, String(row.message || row.content || '').trim(), time)
      && !hasSibling(assistants, response, time);
  }).slice(-limit);
  return cloneDatabaseValue(projectConversationReceiptHistory(db, visible));
}
