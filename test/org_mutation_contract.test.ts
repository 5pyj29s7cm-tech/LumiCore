import './helpers';
import jwt from 'jsonwebtoken';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { makeApp, JWT_SECRET } from './helpers';
import * as DB from '../db_layer';
import * as EDB from '../server/org/db';
import * as KB from '../server/org/kb';
import { mountOrgRoutes } from '../server/org/routes';
let base = '', cleanup = () => { }, orgId = '';
const hdr = (uid: string) => ({ 'Content-Type': 'application/json', Cookie: 'token=' + jwt.sign({ uid, username: uid, role: 'user', orgId }, JWT_SECRET) });
beforeAll(async () => { const fixture = await makeApp(); base = fixture.url; cleanup = fixture.cleanup; mountOrgRoutes(fixture.apiRouter); orgId = EDB.createOrg('Audit only', 'audit-only-' + Date.now(), 'audit-owner').id; EDB.addMember(orgId, 'audit-owner', 'owner'); EDB.addMember(orgId, 'audit-admin', 'admin'); });
afterAll(() => { vi.restoreAllMocks(); cleanup(); });
describe('organization mutation authorization and durability', () => {
    it('rejects an administrator promoting their own membership to owner', async () => { const r = await fetch(base + '/api/org/org/' + orgId + '/members/audit-admin/role', { method: 'PUT', headers: hdr('audit-admin'), body: JSON.stringify({ role: 'owner' }) }); expect(r.status).toBe(403); expect(EDB.getMember(orgId, 'audit-admin')?.role).toBe('admin'); });
    it('rejects an administrator demoting the organization owner', async () => { const r = await fetch(base + '/api/org/org/' + orgId + '/members/audit-owner/role', { method: 'PUT', headers: hdr('audit-admin'), body: JSON.stringify({ role: 'viewer' }) }); expect(r.status).toBe(403); expect(EDB.getMember(orgId, 'audit-owner')?.role).toBe('owner'); });
    it('does not publish a token or organization after the save barrier fails', async () => { const save = vi.spyOn(DB, 'flushDBOrThrow').mockRejectedValue(new Error('audit unavailable barrier')); const token = jwt.sign({ uid: 'audit-new-owner', username: 'audit-new-owner', role: 'user' }, JWT_SECRET); const r = await fetch(base + '/api/org/org', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'token=' + token }, body: JSON.stringify({ name: 'Audit pending org', slug: 'audit-pending-' + Date.now() }) }); expect(r.status).toBe(503); expect(save).toHaveBeenCalled(); expect(r.headers.get('set-cookie')).toBeNull(); expect(EDB.listUserOrgs('audit-new-owner')).toEqual([]); save.mockRestore(); });
    it('rejects invalid role strings, owner invitations and owner removal', async () => {
        for (const [route, method, body, expected] of [
            ['members/audit-admin/role', 'PUT', { role: 'superuser' }, 400],
            ['members/audit-owner', 'DELETE', undefined, 403],
            ['members', 'POST', { userId: 'audit-joiner', role: 'owner' }, 403],
            ['invitations', 'POST', { role: 'owner' }, 403],
        ] as const) {
            const r = await fetch(base + '/api/org/org/' + orgId + '/' + route, { method, headers: hdr('audit-admin'), body: body ? JSON.stringify(body) : undefined });
            expect(r.status).toBe(expected);
        }
        expect(EDB.getMember(orgId, 'audit-owner')?.role).toBe('owner');
    });
    it('keeps a valid member unchanged when role persistence fails', async () => {
        EDB.addMember(orgId, 'audit-member', 'member');
        const save = vi.spyOn(DB, 'flushDBOrThrow').mockRejectedValue(new Error('failed save'));
        try {
            const r = await fetch(base + '/api/org/org/' + orgId + '/members/audit-member/role', { method: 'PUT', headers: hdr('audit-owner'), body: JSON.stringify({ role: 'viewer' }) });
            expect(r.status).toBe(503);
            expect(EDB.getMember(orgId, 'audit-member')?.role).toBe('member');
        }
        finally {
            save.mockRestore();
        }
    });
    it('restores a deleted organization and memberships when saving fails', async () => {
        const save = vi.spyOn(DB, 'flushDBOrThrow').mockRejectedValue(new Error('failed deletion save'));
        try {
            const r = await fetch(base + '/api/org/org/' + orgId, { method: 'DELETE', headers: hdr('audit-owner') });
            expect(r.status).toBe(503);
            expect(EDB.getOrgById(orgId)?.ownerUid).toBe('audit-owner');
            expect(EDB.getMember(orgId, 'audit-owner')?.role).toBe('owner');
            expect(EDB.getMember(orgId, 'audit-admin')?.role).toBe('admin');
        }
        finally {
            save.mockRestore();
        }
    });
    it('does not overwrite a concurrent row revision while compensating a failed save', async () => {
        EDB.addMember(orgId, 'audit-concurrent', 'member');
        const save = vi.spyOn(DB, 'flushDBOrThrow').mockImplementation(async () => {
            EDB.getMember(orgId, 'audit-concurrent')!.role = 'admin';
            throw new Error('failed while another writer changed the row');
        });
        try {
            const r = await fetch(base + '/api/org/org/' + orgId + '/members/audit-concurrent/role', { method: 'PUT', headers: hdr('audit-owner'), body: JSON.stringify({ role: 'viewer' }) });
            expect(r.status).toBe(503);
            expect(EDB.getMember(orgId, 'audit-concurrent')?.role).toBe('admin');
        }
        finally {
            save.mockRestore();
        }
    });
    it('does not start article indexing when its creation cannot be saved', async () => {
        const save = vi.spyOn(DB, 'flushDBOrThrow').mockRejectedValue(new Error('failed article save'));
        const index = vi.spyOn(KB, 'indexArticle').mockResolvedValue(3);
        try {
            const r = await fetch(base + '/api/org/kb/articles', { method: 'POST', headers: hdr('audit-owner'), body: JSON.stringify({ title: 'Uncommitted article', content: 'Only committed content may be indexed' }) });
            expect(r.status).toBe(503);
            expect(index).not.toHaveBeenCalled();
            expect(EDB.listKbArticles(orgId).some(article => article.title === 'Uncommitted article')).toBe(false);
        }
        finally {
            save.mockRestore();
            index.mockRestore();
        }
    });
    it('awaits asynchronous indexing before publishing and compensates a failed save', async () => {
        const article = KB.createArticle(orgId, 'audit-owner', { title: 'Index fixture', content: 'Original content' }, { index: false });
        const index = vi.spyOn(KB, 'indexArticle').mockImplementation(async () => {
            await Promise.resolve();
            EDB.updateKbArticle(orgId, article.id, { content: 'Unsaved index revision' });
            return 3;
        });
        const save = vi.spyOn(DB, 'flushDBOrThrow').mockRejectedValue(new Error('failed asynchronous save'));
        try {
            const r = await fetch(base + '/api/org/kb/articles/' + article.id + '/index', { method: 'POST', headers: hdr('audit-owner') });
            expect(r.status).toBe(503);
            expect(save).toHaveBeenCalled();
            expect(EDB.getKbArticle(orgId, article.id)?.content).toBe('Original content');
        }
        finally {
            save.mockRestore();
            index.mockRestore();
        }
    });
    it('transfers owner identity and roles through one durable operation', async () => {
        const created = EDB.createOrg('Transfer fixture', 'transfer-' + Date.now(), 'transfer-owner');
        EDB.addMember(created.id, 'transfer-owner', 'owner');
        EDB.addMember(created.id, 'transfer-next', 'member');
        const token = jwt.sign({ uid: 'transfer-owner', username: 'owner', role: 'user', orgId: created.id }, JWT_SECRET);
        const r = await fetch(base + '/api/org/org/' + created.id + '/ownership', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'token=' + token }, body: JSON.stringify({ newOwnerUserId: 'transfer-next' }) });
        expect(r.status).toBe(200);
        expect(EDB.getOrgById(created.id)?.ownerUid).toBe('transfer-next');
        expect(EDB.getMember(created.id, 'transfer-next')?.role).toBe('owner');
        expect(EDB.getMember(created.id, 'transfer-owner')?.role).toBe('admin');
    });
});
