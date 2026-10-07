import { readDatabaseTables, commitDatabaseTables } from '../../../db_layer';
import { Memory } from '../types';

const memorySessions = new WeakMap<Memory[], ReturnType<typeof readDatabaseTables<'memories'>>>();

export function getMemoryStore(): Memory[] {
  const db = readDatabaseTables(["memories"]);
  if (!db.memories) db.memories = [];
  memorySessions.set(db.memories, db);
  return db.memories;
}

export function saveMemoryStore(memories: Memory[]): void {
  const db = memorySessions.get(memories) || readDatabaseTables(["memories"]);
  db.memories = memories;
  commitDatabaseTables(db);
}

export function markMemoriesRetrieved(memories: Memory[]): void {
  if (memories.length === 0) return;
  const now = new Date().toISOString();
  const store = getMemoryStore();
  for (const memory of memories) {
    const stored = store.find(candidate => candidate.id === memory.id);
    if (stored) {
      stored.lastRetrievedAt = now;
      stored.retrieveCount = (stored.retrieveCount || 0) + 1;
    }
  }
  saveMemoryStore(store);
}
