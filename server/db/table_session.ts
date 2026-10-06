import { isDeepStrictEqual } from 'node:util';
import { cloneDatabaseValue } from './snapshot_changes';

export class DatabaseWriteConflict extends Error {
  constructor(path: string) { super('Concurrent database write conflicts with staged change: ' + path); this.name = 'DatabaseWriteConflict'; }
}

const plain = (value: any): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const copy = <T>(value: T): T => cloneDatabaseValue(value);
const sessionKey = Symbol('bounded-database-session');
interface Session { keys: Set<string>; before: Record<string, any>; draft: Record<string, any>; root: Record<string, any>; }

/** Detached, lazy table snapshots. No live rows or unselected root fields escape. */
export function createTableSession<T extends string>(root: Record<string, any>, keys: readonly T[]): Record<T, any> {
  if (!keys.length || new Set(keys).size !== keys.length) throw new Error('Select distinct database tables');
  const session: Session = { keys: new Set(keys), before: Object.create(null), draft: Object.create(null), root };
  const target = Object.create(null);
  Object.defineProperty(target, sessionKey, { value: session, enumerable: true });
  for (const key of keys) Object.defineProperty(target, key, { enumerable: true, configurable: true,
    get() { if (!Object.hasOwn(session.draft, key)) { session.before[key] = copy(root[key]); session.draft[key] = copy(session.before[key]); } return session.draft[key]; },
    set(value) { if (!Object.hasOwn(session.before, key)) session.before[key] = copy(root[key]); session.draft[key] = value; },
  });
  return new Proxy(target, {
    get(obj, key, receiver) { if (typeof key === 'string' && !session.keys.has(key)) { if (key === 'toJSON') return undefined; throw new Error('Database table is outside selected scope: ' + key); } return Reflect.get(obj, key, receiver); },
    set(obj, key, value, receiver) { if (typeof key !== 'string' || !session.keys.has(key)) throw new Error('Database write is outside selected scope: ' + String(key)); return Reflect.set(obj, key, value, receiver); },
    deleteProperty() { throw new Error('Database table fields cannot be deleted; stage a replacement'); },
    defineProperty() { throw new Error('Database table scope cannot be extended'); },
    setPrototypeOf() { throw new Error('Database table scope cannot be extended'); },
  });
}

function rowKey(groups: any[][], location: string): ((row: any) => string) | undefined {
  const rows = groups.flat();
  const field = ['id', 'uid', 'key', 'fingerprint'].find(key => rows.every(row => plain(row) && typeof row[key] === 'string' && row[key]) && groups.every(group => new Set(group.map(row => row[key])).size === group.length));
  if (field) return row => row[field];
  if (location === 'knowledgeFiles' && rows.every(row => plain(row) && typeof row.filename === 'string' && row.filename)) {
    const identity = (row: any) => JSON.stringify([row.filename, row.userId || '', row.domain || (row.orgId ? 'work' : 'personal'), row.orgId || '']);
    if (groups.every(group => new Set(group.map(identity)).size === group.length)) return identity;
  }
  return undefined;
}

/** Three-way merge: independent fields survive; competing edits fail before acceptance. */
function merge(before: any, next: any, current: any, location: string): any {
  if (isDeepStrictEqual(before, next)) return current;
  if (isDeepStrictEqual(current, before) || isDeepStrictEqual(current, next)) return copy(next);
  if (plain(before) && plain(next) && plain(current)) {
    const result = { ...current };
    for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
      if (isDeepStrictEqual(before[key], next[key]) && Object.hasOwn(before, key) === Object.hasOwn(next, key)) continue;
      const value = merge(before[key], next[key], current[key], location + '.' + key);
      if (Object.hasOwn(next, key)) result[key] = value; else delete result[key];
    }
    return result;
  }
  if (Array.isArray(before) && Array.isArray(next) && Array.isArray(current)) {
    const key = rowKey([before, next, current], location);
    if (key) {
      const oldRows = new Map(before.map(row => [key(row), row]));
      const nextRows = new Map(next.map(row => [key(row), row]));
      const currentRows = new Map(current.map(row => [key(row), row]));
      const updates = new Map<string, any>();
      for (const id of new Set([...oldRows.keys(), ...nextRows.keys()])) {
        const old = oldRows.get(id), staged = nextRows.get(id), live = currentRows.get(id);
        if (isDeepStrictEqual(old, staged)) continue;
        if (!staged) {
          if (live && !isDeepStrictEqual(live, old)) throw new DatabaseWriteConflict(location + '[' + id + ']');
          updates.set(id, undefined);
        } else if (!old) {
          if (live && !isDeepStrictEqual(live, staged)) throw new DatabaseWriteConflict(location + '[' + id + ']');
          updates.set(id, copy(staged));
        } else {
          if (!live) throw new DatabaseWriteConflict(location + '[' + id + ']');
          updates.set(id, merge(old, staged, live, location + '[' + id + ']'));
        }
      }
      const result = current.flatMap(row => updates.has(key(row)) ? updates.get(key(row)) ? [updates.get(key(row))] : [] : [row]);
      for (const [id, value] of updates) if (value && !currentRows.has(id)) result.push(value);
      return result;
    }
  }
  throw new DatabaseWriteConflict(location);
}

export const isTableSession = (value: any): boolean => Boolean(value?.[sessionKey]);

/** Validate and stage all table deltas before exposing any change to persistence. */
export function prepareTableCommit(value: any, current: Record<string, any>): { changes: Record<string, any>; accept(): void } {
  const session: Session | undefined = value?.[sessionKey];
  if (!session) throw new Error('Database commit requires a selected-table session');
  for (const key of Object.keys(value)) if (!session.keys.has(key)) throw new Error('Database write is outside selected scope: ' + key);
  const changes: Record<string, any> = Object.create(null), accepted: Record<string, any> = Object.create(null);
  for (const key of Object.keys(value)) {
    // Accessor evaluation makes spread replacements and ordinary sessions obey the same fence.
    const staged = copy(value[key]);
    if (!Object.hasOwn(session.before, key)) throw new Error('Database table was not staged: ' + key);
    if (!isDeepStrictEqual(session.before[key], staged)) changes[key] = merge(session.before[key], staged, current[key], key);
    accepted[key] = staged;
  }
  return { changes, accept() { for (const key of Object.keys(accepted)) session.before[key] = copy(accepted[key]); } };
}
