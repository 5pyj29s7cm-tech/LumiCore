import { readDatabaseTables, commitDatabaseTables } from '../../db_layer';
import { cloneDatabaseValue } from '../db/snapshot_changes';
import { isMemoryAvatarAgentId, type Memory } from './types';
import type { Reminder } from './store/reminders';

export type MemoryOwnerScope = { userId: string; domain: 'personal' | 'work'; orgId: string; agentId?: string };
type Tables = { memories: Memory; reminders: Reminder };

function belongs(row: { userId: string; domain?: string; orgId?: string; agentId?: string }, scope: MemoryOwnerScope): boolean {
  return Boolean(scope.userId) && row.userId === scope.userId
    && (row.domain || 'personal') === scope.domain && (row.orgId || '') === scope.orgId
    && (scope.agentId === undefined ? !isMemoryAvatarAgentId(row.agentId) : (row.agentId || '') === scope.agentId);
}

function rows<K extends keyof Tables>(table: K): Tables[K][] { return readDatabaseTables([table])[table] || []; }
function owned<K extends keyof Tables>(table: K, scope: MemoryOwnerScope, id: string): Tables[K] | undefined {
  return rows(table).find(row => row.id === id && belongs(row, scope));
}
export function listMemoryRows(scope: MemoryOwnerScope): Memory[] { return cloneDatabaseValue(rows('memories').filter(row => belongs(row, scope))); }
export function getMemoryRow(scope: MemoryOwnerScope, id: string): Memory | undefined { return cloneDatabaseValue(owned('memories', scope, id)); }
export function listReminderRows(scope: MemoryOwnerScope): Reminder[] { return cloneDatabaseValue(rows('reminders').filter(row => belongs(row, scope))); }

export function assertMemoryParent(scope: MemoryOwnerScope, memory: Memory, all: Memory[]): void {
  const seen = new Set([memory.id]);
  let parentId = memory.parentId;
  while (parentId) {
    if (seen.has(parentId)) throw new RangeError('Cannot move: circular reference or parent not found');
    seen.add(parentId);
    const parent = all.find(row => row.id === parentId && belongs(row, scope)
      && (row.agentId || '') === (memory.agentId || ''));
    if (!parent) throw new RangeError('Cannot move: circular reference or parent not found');
    parentId = parent.parentId;
  }
}

/** Callbacks see one detached owned row. Refused writes cannot alter the live table. */
function updateRow<K extends keyof Tables>(table: K, scope: MemoryOwnerScope, id: string, update: (row: Tables[K]) => void): Tables[K] | undefined {
  const db = readDatabaseTables([table]), all: Tables[K][] = db[table] || [];
  const current = all.find(row => row.id === id && belongs(row, scope));
  if (!current) return undefined;
  const draft = cloneDatabaseValue(current);
  update(draft);
  const next = cloneDatabaseValue(draft);
  if (next.id !== current.id || !belongs(next, scope)
    || (table === 'memories' && ((next as Memory).agentId || '') !== ((current as Memory).agentId || ''))) {
    throw new Error('Memory storage identity cannot be changed');
  }
  if (table === 'memories' && (next as Memory).parentId !== (current as Memory).parentId) {
    assertMemoryParent(scope, next as Memory, all as Memory[]);
  }
  commitDatabaseTables({ ...db, [table]: all.map(row => row === current ? next : row) });
  return cloneDatabaseValue(next);
}
export function updateMemoryRow(scope: MemoryOwnerScope, id: string, update: (row: Memory) => void): Memory | undefined { return updateRow('memories', scope, id, update); }
export function updateReminderRow(scope: MemoryOwnerScope, id: string, update: (row: Reminder) => void): Reminder | undefined { return updateRow('reminders', scope, id, update); }
export function insertMemoryRow(scope: MemoryOwnerScope, memory: Memory): Memory {
  const db = readDatabaseTables(["memories"]), all: Memory[] = db.memories || [];
  if (!belongs(memory, scope) || all.some(row => row.id === memory.id)) throw new Error('Invalid memory insertion identity');
  const next = cloneDatabaseValue(memory);
  assertMemoryParent(scope, next, all);
  commitDatabaseTables({ ...db, memories: [...all, next] });
  return cloneDatabaseValue(next);
}
export function removeReminderRow(scope: MemoryOwnerScope, id: string): boolean {
  const db = readDatabaseTables(["reminders"]), all: Reminder[] = db.reminders || [];
  const row = all.find(row => row.id === id && belongs(row, scope));
  if (!row) return false;
  commitDatabaseTables({ ...db, reminders: all.filter(item => item !== row) });
  return true;
}
