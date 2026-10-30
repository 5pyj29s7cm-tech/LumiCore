import './helpers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import * as EDB from '../server/org/db';
import { mountOrgRoutes } from '../server/org/routes';
import { queryAuditPage } from '../server/org/audit_pagination';
let base = '', close = () => {}, org = '', foreign = '';
const get = (query: string, uid = 'owner', orgId = org) => fetch(base + '/api/org/audit?pagination=cursor&' + query, { headers: {
  Cookie: 'token=' + jwt.sign({ uid, username: uid, role: 'user', orgId, orgRole: 'owner' }, JWT_SECRET),
} });
beforeAll(async () => {
  const app = await makeApp(); base = app.url; close = app.cleanup; mountOrgRoutes(app.apiRouter);
  org = EDB.createOrg('Cursor fixture', 'cursor-' + Date.now(), 'owner').id;
  foreign = EDB.createOrg('Other cursor fixture', 'cursor-other-' + Date.now(), 'owner').id;
  for (const orgId of [org, foreign]) { EDB.addMember(orgId, 'owner', 'owner'); EDB.addMember(orgId, 'admin', 'admin'); EDB.addMember(orgId, 'member', 'member'); }
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  try { for (let i = 0; i < 205; i++) EDB.logAudit({ orgId: org, userId: 'fixture', action: 'cursor.read', resourceType: 'document', resourceId: String(i) }); }
  finally { now.mockRestore(); }
});
afterAll(() => { vi.restoreAllMocks(); close(); });
describe('stable audit cursor routes', () => {
  it('keeps total and exact membership stable across new insertions and reverse navigation', async () => {
    const first = await (await get('limit=100&action=cursor.read')).json(); expect(first.entries).toHaveLength(100); expect(first.total).toBe(205); expect(first.previousCursor).toBeNull();
    EDB.logAudit({ orgId: org, userId: 'fixture', action: 'cursor.read', resourceType: 'document', resourceId: 'new-after-snapshot' });
    const second = await (await get('limit=100&action=cursor.read&cursor=' + first.nextCursor)).json();
    const third = await (await get('limit=100&action=cursor.read&cursor=' + second.nextCursor)).json();
    expect(second.entries).toHaveLength(100); expect(third.entries).toHaveLength(5); expect(third.nextCursor).toBeNull();
    expect(second.total).toBe(205); expect(third.total).toBe(205);
    const all = [...first.entries, ...second.entries, ...third.entries]; expect(new Set(all.map(row => row.id)).size).toBe(205);
    expect(all.some(row => row.resourceId === 'new-after-snapshot')).toBe(false);
    const back = await (await get('limit=100&action=cursor.read&cursor=' + second.previousCursor)).json(); expect(back.entries.map(row => row.id)).toEqual(first.entries.map(row => row.id));
    expect((await (await get('limit=100&action=cursor.read')).json()).total).toBe(206);
  });
  it('handles equal timestamps deterministically and has no spurious next page at an exact multiple', () => {
    const sample = Array.from({ length: 100 }, (_, i) => ({ id: String(i).padStart(4, '0'), orgId: org, userId: 'fixture', action: 'fixture.read', resourceType: 'document', resourceId: '', details: '{}', timestamp: '2026-10-30T00:00:00Z', ipAddress: '', userAgent: '' }));
    const list = vi.spyOn(EDB, 'listAuditLog').mockReturnValue(sample);
    try { const page = queryAuditPage(org, 'owner', {}, 100); expect(page.total).toBe(100); expect(page.nextCursor).toBeNull(); expect(page.entries.map(x => x.id)).toEqual([...sample].map(x => x.id).sort().reverse()); }
    finally { list.mockRestore(); }
  });
  it('binds cursor reuse to actor, organization, filters and page size', async () => {
    const first = await (await get('limit=100&action=cursor.read')).json(); const cursor = '&cursor=' + first.nextCursor;
    for (const [query, uid, orgId] of [['limit=100&action=cursor.read' + cursor, 'admin', org], ['limit=100&action=cursor.read' + cursor, 'owner', foreign], ['limit=100' + cursor, 'owner', org], ['limit=50&action=cursor.read' + cursor, 'owner', org]] as const) {
      expect((await get(query, uid, orgId)).status).toBe(409);
    }
    expect((await get('limit=100&action=cursor.read' + cursor, 'member')).status).toBe(403);
    expect((await fetch(base + '/api/org/audit?pagination=cursor')).status).toBe(401);
  });
  it.each(['0', '-1', '101', '1.5', 'abc', 'Infinity', ''])('rejects invalid cursor-page limit %s', async limit => {
    expect((await get('limit=' + limit)).status).toBe(400);
  });
  it('rejects malformed or repeated cursor query values', async () => {
    expect((await get('cursor=garbage')).status).toBe(409); expect((await get('cursor=a&cursor=b')).status).toBe(400);
  });
  it('expires snapshots explicitly and allows a fresh query', () => {
    const first = queryAuditPage(org, 'owner', {}, 100); const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000 + 1);
    try { expect(() => queryAuditPage(org, 'owner', {}, 100, first.nextCursor!)).toThrow('Audit snapshot expired'); expect(queryAuditPage(org, 'owner', {}, 100).total).toBeGreaterThan(0); }
    finally { now.mockRestore(); }
  });
  it('invalidates a page when a frozen record is removed, instead of substituting another row', () => {
    const first = queryAuditPage(org, 'owner', {}, 100), saved = EDB.listAuditLog(org, null, 0);
    const list = vi.spyOn(EDB, 'listAuditLog').mockReturnValue(saved.filter(row => row.id !== first.entries[0].id));
    try { expect(() => queryAuditPage(org, 'owner', {}, 100, first.cursor)).toThrow('Audit snapshot expired'); }
    finally { list.mockRestore(); }
  });
  it('applies resourceId-only filtering to both old and cursor clients', async () => {
    const page = await (await get('resourceId=0')).json(); expect(page.total).toBe(1); expect(page.entries[0].resourceId).toBe('0');
    const token = jwt.sign({ uid: 'owner', username: 'owner', role: 'user', orgId: org }, JWT_SECRET);
    const legacy = await (await fetch(base + '/api/org/audit?resourceId=0', { headers: { Cookie: 'token=' + token } })).json(); expect(legacy).toHaveLength(1);
  });
});
