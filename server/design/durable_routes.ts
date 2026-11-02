import type { RequestHandler, Router } from 'express';
import { readDatabaseTables, commitDatabaseTables, flushDBOrThrow } from '../../db_layer';
import { runSerializedMutation } from '../persistence/durable_scope_mutation';
import { requireUserSession } from '../middleware/auth';
import { personalInteriorProjectScope } from './projects';

const selectionSetting = 'interior_active_projects_v1';
type Snapshot = { rows: Record<string, any[]>; selection: unknown };
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function selections(db: any): Record<string, unknown> {
  try {
    const value = JSON.parse(db.settings.find((row: any) => row.key === selectionSetting)?.value || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}
function capture(scope: string, userId: string): Snapshot {
  const db = readDatabaseTables(['interiorProjects', 'interiorProjectAssets', 'auditLog', 'settings']);
  return {
    rows: Object.fromEntries(['interiorProjects', 'interiorProjectAssets', 'auditLog']
      .map(table => [table, db[table].filter((row: any) => row.orgId === scope)])),
    selection: selections(db)[`${scope}::${userId}`],
  };
}
/** Revert only unchanged writes from this operation; preserve concurrent scopes and rows. */
function restore(before: Snapshot, after: Snapshot, scope: string, userId: string): void {
  const db = readDatabaseTables(['interiorProjects', 'interiorProjectAssets', 'auditLog', 'settings']);
  for (const table of Object.keys(before.rows)) {
    const old = new Map(before.rows[table].map(row => [row.id, row]));
    const written = new Map(after.rows[table].map(row => [row.id, row]));
    db[table] = db[table].flatMap((row: any) => {
      if (!written.has(row.id) || equal(old.get(row.id), written.get(row.id)) || !equal(row, written.get(row.id))) return [row];
      return old.has(row.id) ? [old.get(row.id)] : [];
    });
    for (const [id, row] of old) {
      if (!written.has(id) && !db[table].some((item: any) => item.id === id)) db[table].push(row);
    }
  }
  const key = `${scope}::${userId}`, current = selections(db);
  if (!equal(before.selection, after.selection) && equal(current[key], after.selection)) {
    if (before.selection === undefined) delete current[key]; else current[key] = before.selection;
    const row = db.settings.find((item: any) => item.key === selectionSetting);
    if (row) row.value = JSON.stringify(current);
    else db.settings.push({ key: selectionSetting, value: JSON.stringify(current) });
  }
  commitDatabaseTables(db);
}

/** Tools and HTTP use the same scope lock and rollback boundary. */
export function runDurableInteriorProjectMutation<T>(
  scope: string, userId: string, assertCurrent: () => void, mutate: () => T | Promise<T>,
): Promise<T> {
  return runSerializedMutation(`interior-project:${scope}`, async () => {
    assertCurrent();
    const before = capture(scope, userId);
    let saved = false;
    try {
      const result = await mutate();
      assertCurrent();
      await flushDBOrThrow();
      saved = true;
      assertCurrent();
      return result;
    } catch (error) {
      if (!saved) restore(before, capture(scope, userId), scope, userId);
      throw error;
    }
  });
}

/** Project writes share main's save-before-response contract in either personal or organization context. */
export function durableInteriorProjectRouter(base: Router): Pick<Router, 'get' | 'post' | 'put' | 'delete'> {
  const register = (method: 'post' | 'put' | 'delete') => ((route: string, ...handlers: RequestHandler[]) => {
    const body = handlers.at(-1)!, guards = handlers.slice(0, -1);
    return base[method](route, ...guards, (req, res, next) => {
      const userId = req.user!.uid;
      const scope = req.user!.orgId || personalInteriorProjectScope(userId);
      return runSerializedMutation(`interior-project:${scope}`, async () => {
        for (const guard of guards) {
          let admitted = false;
          guard(req, res, () => { admitted = true; });
          if (!admitted) return;
        }
        const before = capture(scope, userId), json = res.json.bind(res);
        let response: unknown, captured = false, saved = false;
        let after = before;
        res.json = ((value: unknown) => {
          if (res.statusCode >= 400) return json(value);
          response = structuredClone(value); captured = true; return res;
        }) as typeof res.json;
        try {
          await body(req, res, next);
          after = capture(scope, userId);
          if (!captured || res.headersSent) { restore(before, after, scope, userId); return; }
          await flushDBOrThrow();
          saved = true;
          let valid = false;
          requireUserSession(req, res, () => { valid = true; });
          if (valid) return json(response);
        } catch (error) {
          if (!saved) restore(before, capture(scope, userId), scope, userId);
          if (!res.headersSent) return json.call(res.status(503), {
            error: 'The project change could not be saved.', code: 'PERSISTENCE_UNAVAILABLE',
          });
        } finally { res.json = json; }
      }).catch(next);
    });
  }) as Router['post'];
  return { get: base.get.bind(base), post: register('post'), put: register('put'), delete: register('delete') };
}
