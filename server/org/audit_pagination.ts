import { randomUUID } from 'node:crypto';
import { queryAuditLog, type AuditFilter } from './audit';

const TTL_MS = 10 * 60_000, MAX_SNAPSHOTS = 64, MAX_IDS = 100_000;
type Snapshot = { scope: string; ids: string[]; limit: number; expires: number };
const snapshots = new Map<string, Snapshot>();
export class AuditPageError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}
const expired = () => new AuditPageError('Audit snapshot expired or unavailable. Refresh the audit snapshot.', 409);

/** Bounded, short-lived, actor-scoped snapshots. New audit events never shift an existing page. */
export function queryAuditPage(orgId: string, actorId: string, filters: AuditFilter, limit = 100, cursor = '') {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AuditPageError('Audit page limit must be between 1 and 100.', 400);
  const now = Date.now();
  for (const [key, value] of snapshots) if (value.expires <= now) snapshots.delete(key);
  const scope = JSON.stringify([orgId, actorId, ...(['userId', 'action', 'resourceType', 'resourceId', 'from', 'to'] as const).map(key => filters[key] || '')]);
  let snapshot: Snapshot, key: string, offset = 0;
  if (cursor) {
    const match = /^([a-f0-9-]{36})\.(0|[1-9]\d*)$/.exec(cursor);
    if (!match) throw expired();
    key = match[1]; offset = Number(match[2]);
    const stored = snapshots.get(key);
    if (!stored || stored.scope !== scope || stored.limit !== limit || !Number.isSafeInteger(offset)
      || offset % limit !== 0 || (offset > 0 && offset >= stored.ids.length)) throw expired();
    snapshot = stored;
  } else {
    const rows = queryAuditLog(orgId, filters, Number.MAX_SAFE_INTEGER);
    if (rows.length > MAX_IDS) throw new AuditPageError('Too many audit entries for one snapshot. Narrow the audit filters.', 413);
    rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id));
    const count = () => [...snapshots.values()].reduce((sum, value) => sum + value.ids.length, 0);
    while (snapshots.size >= MAX_SNAPSHOTS || count() + rows.length > MAX_IDS) snapshots.delete(snapshots.keys().next().value!);
    key = randomUUID(); snapshot = { scope, ids: rows.map(row => row.id), limit, expires: now + TTL_MS };
    snapshots.set(key, snapshot);
  }
  // Resolve the frozen IDs against current data: a removed row invalidates its page, never substitutes another record.
  const ids = snapshot.ids.slice(offset, offset + limit), wanted = new Set(ids);
  const current = new Map(queryAuditLog(orgId, filters, Number.MAX_SAFE_INTEGER).filter(row => wanted.has(row.id)).map(row => [row.id, row]));
  if (ids.some(id => !current.has(id))) { snapshots.delete(key); throw expired(); }
  return {
    entries: ids.map(id => current.get(id)!), total: snapshot.ids.length, offset, cursor: `${key}.${offset}`,
    nextCursor: offset + limit < snapshot.ids.length ? `${key}.${offset + limit}` : null,
    previousCursor: offset > 0 ? `${key}.${Math.max(0, offset - limit)}` : null,
    expiresAt: new Date(snapshot.expires).toISOString(),
  };
}
