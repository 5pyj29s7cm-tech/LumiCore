import type { RequestHandler, Router, Response } from 'express';
import { readDB, writeDB, flushDBOrThrow } from '../../db_layer';
import { cloneDatabaseValue } from '../db/snapshot_changes';
import { requireUserSession } from '../middleware/auth';
import { runSerializedMutation } from '../persistence/durable_scope_mutation';
import { getInvitationByCode } from './db';
type Rows = Record<string, any[]>;
function capture(orgId: string, prior: Rows = {}): Rows {
    const rows: Rows = {};
    if (!orgId)
        return rows;
    const db = readDB();
    const articles = new Set([...(db.orgKbArticles || []).filter((row: any) => row.orgId === orgId), ...(prior.orgKbArticles || [])].map((row: any) => row.id));
    for (const [table, value] of Object.entries(db)) {
        if (!Array.isArray(value))
            continue;
        const selected = value.filter(row => row && (row.orgId === orgId || table === 'organizations' && row.id === orgId || table === 'orgKbEmbeddings' && articles.has(row.articleId)));
        if (selected.length)
            rows[table] = cloneDatabaseValue(selected);
    }
    return rows;
}
/** Compensate only this operation's unchanged rows, never a concurrent writer's rows. */
function restore(before: Rows, after: Rows): void {
    if (JSON.stringify(before) === JSON.stringify(after))
        return;
    const db = readDB();
    const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
        const old = new Map((before[table] || []).map(row => [row.id, row]));
        const written = new Map((after[table] || []).map(row => [row.id, row]));
        const current: any[] = db[table] || [];
        const restored = current.flatMap(row => {
            if (!written.has(row.id) || equal(old.get(row.id), written.get(row.id)) || !equal(row, written.get(row.id)))
                return [row];
            return old.has(row.id) ? [cloneDatabaseValue(old.get(row.id))] : [];
        });
        for (const [id, row] of old)
            if (!written.has(id) && !restored.some(item => item.id === id))
                restored.push(cloneDatabaseValue(row));
        db[table] = restored;
    }
    writeDB(db);
}
export function afterOrganizationSave(res: Response, publish: () => void): void {
    (res.locals.organizationOutbox ||= []).push(publish);
}
/** Org routes publish a response, cookie and events only after the same save barrier. */
export function durableOrganizationRouter(base: Router): Pick<Router, 'get' | 'post' | 'put' | 'delete'> {
    const register = (method: 'post' | 'put' | 'delete') => ((route: string, ...handlers: RequestHandler[]) => {
        // A search is a read even though its query is carried in a POST body.
        if (route === '/org/kb/search')
            return base[method](route, ...handlers);
        const body = handlers.at(-1)!;
        const guards = handlers.slice(0, -1);
        return base[method](route, ...guards, (req, res, next) => {
            const orgId = route === '/org/org' ? '' : req.params.orgId || (req.params.code ? getInvitationByCode(req.params.code)?.orgId : '') || req.user?.orgId || '';
            const key = route === '/org/org' ? 'organization:create' : 'organization:' + orgId;
            return runSerializedMutation(key, async () => {
                for (const guard of guards) {
                    let admitted = false;
                    guard(req, res, () => { admitted = true; });
                    if (!admitted)
                        return;
                }
                const before = capture(orgId);
                const json = res.json.bind(res), cookie = res.cookie.bind(res);
                let response: unknown, captured = false;
                const cookies: any[][] = [];
                res.locals.organizationOutbox = [];
                res.json = ((value: unknown) => {
                    if (res.statusCode >= 400)
                        return json(value);
                    response = cloneDatabaseValue(value);
                    captured = true;
                    return res;
                }) as typeof res.json;
                res.cookie = ((...args: any[]) => { cookies.push(args); return res; }) as typeof res.cookie;
                let after: Rows = {};
                let saved = false;
                let mutationCaptured = false;
                let savedOrgId = orgId;
                const resolveScope = () => savedOrgId || res.locals.organizationMutationScope || '';
                try {
                    await body(req, res, next);
                    if (!captured || res.headersSent) {
                        if (resolveScope())
                            restore(before, capture(resolveScope(), before));
                        return;
                    }
                    savedOrgId = resolveScope() || String((response as any)?.id || '');
                    after = capture(savedOrgId, before);
                    mutationCaptured = true;
                    await flushDBOrThrow();
                    saved = true;
                    // A revoked/deleted organization is the requested result; recheck the
                    // session without requiring the membership that this operation removed.
                    let valid = false;
                    requireUserSession(req, res, () => { valid = true; });
                    if (!valid)
                        return;
                    for (const args of cookies)
                        cookie(...args as [
                            string,
                            string,
                            any
                        ]);
                    for (const publish of res.locals.organizationOutbox) {
                        try {
                            publish();
                        }
                        catch (error) {
                            console.error('[Organization] Committed notification failed:', error);
                        }
                    }
                    return json(response);
                }
                catch (error) {
                    // Deletion has an empty after-snapshot; it still needs compensation.
                    // Once the barrier succeeds, publication errors must never undo data.
                    if (!saved && resolveScope())
                        restore(before, mutationCaptured ? after : capture(resolveScope(), before));
                    const status = (error as any)?.statusCode || 503;
                    if (!res.headersSent)
                        return json.call(res.status(status), {
                            error: status === 503 ? 'Organization change could not be saved.' : (error as Error).message,
                            code: status === 503 ? 'PERSISTENCE_UNAVAILABLE' : 'ORGANIZATION_OPERATION_REJECTED',
                        });
                }
                finally {
                    res.json = json;
                    res.cookie = cookie;
                    delete res.locals.organizationOutbox;
                    delete res.locals.organizationMutationScope;
                }
            }).catch(next);
        });
    }) as Router['post'];
    return { get: base.get.bind(base), post: register('post'), put: register('put'), delete: register('delete') };
}
