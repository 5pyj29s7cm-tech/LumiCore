import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { makeApp, JWT_SECRET } from './helpers';
import * as LegalCases from '../server/org/legal_cases';
import * as EDB from '../server/org/db';
import { mountChatRoutes } from '../server/routes/chat_routes';
import { getActiveIndustryWorkspaceContext } from '../server/industry/workspace_context';
let app: Awaited<ReturnType<typeof makeApp>>;
const uid = 'personal-api-owner';
const ns = LegalCases.legalWorkspaceNamespace(uid);
const token = (userId = uid, orgId?: string) => jwt.sign({ uid: userId, role: 'admin', ...(orgId ? { orgId } : {}) }, JWT_SECRET);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function call(method = 'GET', body?: unknown, userId = uid, path = '', orgId?: string) {
  const response = await fetch(app.url + '/api/legal/client-case-sync' + path, { method, headers: { Authorization: 'Bearer ' + token(userId, orgId), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() as any };
}
beforeAll(async () => { app = await makeApp(); const absent = () => null; mountChatRoutes(app.apiRouter, JWT_SECRET, { getDeepSeek: absent, getGemini: absent, getOpenAI: absent, getAnthropic: absent, getQwen: absent }); });
afterAll(() => app.cleanup());
describe('authenticated personal case owner snapshots over real HTTP', () => {
  it('returns all existing cases and exact full material content without activating a case', async () => {
    const owner = 'full-content-owner', namespace = LegalCases.legalWorkspaceNamespace(owner);
    for (let i = 0; i < 55; i++) LegalCases.createCase(namespace, owner, { title: 'Virtual case ' + i });
    const item = LegalCases.createCase(namespace, owner, { title: 'Virtual full-content case' });
    LegalCases.addMaterial(namespace, owner, item.id, { type: 'note', title: 'Virtual full text', source: 'manual', content: 'Complete original '.repeat(1800) + ' FULL TAIL' });
    const scope = { userId: owner, domain: 'personal' as const, orgId: '', productLine: 'legal' };
    const before = getActiveIndustryWorkspaceContext(scope);
    const result = await call('GET', undefined, owner);
    expect(result.status).toBe(200); expect(result.data.cases).toHaveLength(56);
    const original = LegalCases.getCase(namespace, item.id, owner)!;
    expect(hash(result.data.cases.find((x: any) => x.id === item.id))).toBe(hash(original));
    expect(result.data.cases.find((x: any) => x.id === item.id).materials[0].content).toContain('FULL TAIL');
    expect(getActiveIndustryWorkspaceContext(scope)).toEqual(before);
    expect(hash(LegalCases.getCase(namespace, item.id, owner))).toBe(hash(original));
  });
  it('rejects a work-domain token and never returns another personal owner', async () => {
    const item = LegalCases.createCase(ns, uid, { title: 'Owner private' });
    expect((await call('GET', undefined, 'other-owner')).data.cases).toEqual([]);
    const org = EDB.createOrg('Virtual HTTP org', 'virtual-http-org', uid);
    expect((await call('GET', undefined, uid, '', org.id)).status).toBe(403);
    expect((await call('POST', { case: item }, uid, '', org.id)).status).toBe(403);
  });
  it('fences namespace-cleaning collisions by the exact authenticated owner', async () => {
    const first = 'collision+owner', second = 'collision_owner';
    expect(LegalCases.legalWorkspaceNamespace(first)).toBe(LegalCases.legalWorkspaceNamespace(second));
    const item = LegalCases.createCase(LegalCases.legalWorkspaceNamespace(first), first, { title: 'Do not leak' });
    expect((await call('GET', undefined, second)).data.cases).toEqual([]);
    expect((await call('POST', { case: { ...item, title: 'Stolen' } }, second)).status).toBe(403);
    expect((await call('DELETE', undefined, second, '/' + item.id)).status).toBe(403);
  });
  it('keeps the newer backend edits when a second client posts an old snapshot', async () => {
    const item = LegalCases.createCase(ns, uid, { title: 'Old title' });
    const saved = await call('POST', { case: { ...item, title: 'New title', notes: 'New complete notes', updatedAt: new Date(Date.now() + 1000).toISOString() } });
    expect(saved.status).toBe(200); expect(saved.data.case.title).toBe('New title');
    const stale = await call('POST', { case: { ...item, title: 'Stale overwrite', updatedAt: '2000-01-01T00:00:00.000Z' } });
    expect(stale.data.case.title).toBe('New title'); expect(stale.data.case.notes).toBe('New complete notes');
  });
  it('does not resurrect a removed material even from a newer snapshot', async () => {
    const item = LegalCases.createCase(ns, uid, { title: 'Material removal' });
    const material = LegalCases.addMaterial(ns, uid, item.id, { type: 'note', title: 'Remove only link', source: 'manual', content: 'Virtual private content' })!;
    const snapshot = LegalCases.getCase(ns, item.id, uid)!;
    const review = LegalCases.getMaterialReview(ns, uid, item.id, material.id)!;
    LegalCases.removeMaterial(ns, uid, item.id, material.id, review.revision);
    const reply = await call('POST', { case: { ...snapshot, updatedAt: new Date(Date.now() + 1000).toISOString() } });
    expect(reply.status).toBe(200); expect(reply.data.case.materials).toEqual([]); expect(reply.data.case.removedMaterialIds).toContain(material.id);
  });
  it('uses the complete durable deletion ledger beyond fifty entries and blocks stale resurrection', async () => {
    const item = LegalCases.createCase(ns, uid, { title: 'Deleted case' });
    expect((await call('DELETE', undefined, uid, '/' + item.id)).data).toMatchObject({ tombstoned: true, caseId: item.id });
    for (let i = 0; i < 65; i++) EDB.logAudit({ orgId: ns, userId: uid, action: 'virtual.audit', resourceType: 'test', resourceId: String(i), details: {} });
    const refresh = await call(); expect(refresh.data.removedCaseIds).toContain(item.id); expect(refresh.data.cases.some((x: any) => x.id === item.id)).toBe(false);
    expect((await call('POST', { case: item })).status).toBe(409);
    expect((await call('POST', { case: { ...item, title: 'Other owner same ID' } }, 'another-owner')).status).toBe(200);
  });
  it('tombstones a not-yet-synced local case before its delayed POST arrives', async () => {
    const id = 'virtual-unsynced-case';
    expect((await call('DELETE', undefined, uid, '/' + id)).data).toMatchObject({ deleted: false, tombstoned: true });
    expect((await call('POST', { case: { id, title: 'Late create' } })).status).toBe(409);
    expect((await call('GET', undefined, 'other-owner')).data.removedCaseIds).not.toContain(id);
  });
});
