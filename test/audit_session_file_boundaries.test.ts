import { makeApp, JWT_SECRET, COOKIE_OPTS } from './helpers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { mountAuthRoutes } from '../server/routes/auth';
import { requireOrganizationBranchAuth } from '../server/middleware/auth';
import { addMember, createOrg, removeMember } from '../server/org/db';
import { getDataPath } from '../server/config/data_path';

describe('audited user sessions and file boundaries', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  let orgId: string;
  const uid = 'audit-boundary-member';
  const personal = jwt.sign({ uid, username: uid, role: 'user' }, JWT_SECRET);
  let organization: string;
  let branch: string;
  let getSocketAuth: typeof import('../server/runtime/socket').getSocketAuth;

  beforeAll(async () => {
    app = await makeApp();
    orgId = createOrg('Boundary fixtures', 'audit-boundary-fixtures', uid).id;
    addMember(orgId, uid, 'member');
    organization = jwt.sign({ uid, username: uid, role: 'user', orgId }, JWT_SECRET);
    branch = jwt.sign({ uid, username: uid, role: 'admin', orgId, tokenType: 'organization_branch', branchId: 'fixture-branch' }, JWT_SECRET);
    mountAuthRoutes(app.apiRouter, JWT_SECRET, COOKIE_OPTS);
    app.apiRouter.get('/branch-session-probe', requireOrganizationBranchAuth, (req, res) => res.json({ branchId: req.user!.branchId }));
    app.apiRouter.use((req, res, next) => {
      if (req.header('x-test-remote-peer') === '1') {
        Object.defineProperty(req.socket, 'remoteAddress', { configurable: true, value: '192.0.2.20' });
        res.once('finish', () => { delete (req.socket as any).remoteAddress; });
      }
      next();
    });
    app.apiRouter.use((await import('../routes/files')).default);
    getSocketAuth = (await import('../server/runtime/socket')).getSocketAuth;
    const directory = getDataPath(path.join('org', orgId, 'knowledge'));
    fs.mkdirSync(directory, { recursive: true });
    for (const [name, body] of Object.entries({ 'note.html': '<p>Harmless review document</p>', 'drawing.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'note.txt': 'Plain review document', 'unknown.bin': 'unknown format' })) {
      fs.writeFileSync(path.join(directory, name), body);
    }
  });

  afterAll(() => app?.cleanup());

  async function request(route: string, token: string, body?: any, extraHeaders = {}) {
    return fetch(`${app.url}/api${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  }

  it('keeps ordinary organization switching functional in both directions', async () => {
    const switched = await request('/auth/switch-org', personal, { orgId });
    expect(switched.status).toBe(200);
    expect(jwt.verify((await switched.json()).token, JWT_SECRET)).toMatchObject({ uid, orgId, orgRole: 'member' });
    const cleared = await request('/auth/switch-org', organization, { orgId: null });
    expect(cleared.status).toBe(200);
    expect(jwt.verify((await cleared.json()).token, JWT_SECRET)).not.toHaveProperty('orgId');
  });

  it('rejects branch credentials before ordinary HTTP routes or token issuance', async () => {
    for (const org of [null, orgId]) {
      const result = await request('/auth/switch-org', branch, { orgId: org });
      expect(result.status).toBe(403);
      expect(result.headers.get('set-cookie')).toBeNull();
      expect(await result.json()).not.toHaveProperty('token');
    }
    for (const route of ['/auth/me', '/auth/biometric/list', '/auth/orgs', '/files/list']) {
      expect((await request(route, branch)).status, route).toBe(403);
    }
    expect((await request('/branch-session-probe', branch)).status).toBe(200);
    expect((await request('/branch-session-probe', personal)).status).toBe(403);
  });

  it('applies the same credential type policy to Socket auth and cookies', () => {
    for (const token of [personal, organization, branch]) {
      for (const handshake of [{ auth: { token } }, { headers: { cookie: `token=${token}` } }]) {
        const result = getSocketAuth({ data: {}, handshake }, JWT_SECRET);
        if (token === branch) expect(result).toBeNull();
        else expect(result).toMatchObject({ uid });
      }
    }
  });

  it('requires administrator and actual local peer for each host-path import', async () => {
    const administrator = jwt.sign({ uid, username: uid, role: 'admin' }, JWT_SECRET);
    for (const route of ['/files/obsidian/connect', '/files/obsidian/sync', '/files/import-paths']) {
      expect((await request(route, personal, {})).status).toBe(403);
      expect((await request(route, administrator, {}, { 'x-test-remote-peer': '1', 'X-Forwarded-For': '127.0.0.1' })).status).toBe(403);
      // Allowed callers reach body validation without any host path being read.
      expect([400, 404]).toContain((await request(route, administrator, {})).status);
    }
  });

  it.each(['note.html', 'drawing.svg', 'unknown.bin'])('downloads %s with sandbox and MIME protections', async name => {
    const result = await request(`/files/download/${name}?inline=1`, organization);
    expect(result.status).toBe(200);
    expect(result.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(result.headers.get('x-content-type-options')).toBe('nosniff');
    expect(result.headers.get('content-security-policy')).toContain("sandbox; default-src 'none'");
    expect(result.headers.get('content-security-policy')).not.toContain('allow-same-origin');
    await result.arrayBuffer();
  });

  it('preserves passive previews and rejects cross-organization reads', async () => {
    expect((await request('/files/list', organization)).status).toBe(200);
    expect((await request('/files/info/note.txt', organization)).status).toBe(200);
    const result = await request('/files/download/note.txt?inline=1', organization);
    expect(result.status).toBe(200);
    expect(result.headers.get('content-disposition')).toBe('inline');
    expect(result.headers.get('content-type')).toContain('text/plain');
    expect(await result.text()).toBe('Plain review document');
    expect((await request('/files/download/note.txt?domain=work', personal)).status).toBe(403);
    expect((await request('/files/download/note.txt?orgId=another-organization', organization)).status).toBe(403);
  });

  it('lets a former member leave the old org while still enforcing target membership', async () => {
    const revokedId = 'revoked-boundary-member';
    addMember(orgId, revokedId, 'member');
    const revokedToken = jwt.sign({ uid: revokedId, role: 'user', orgId }, JWT_SECRET);
    removeMember(orgId, revokedId);
    const result = await request('/auth/switch-org', revokedToken, { orgId: null });
    expect(result.status).toBe(200);
    expect(jwt.verify((await result.json()).token, JWT_SECRET)).not.toHaveProperty('orgId');
    const denied = await request('/auth/switch-org', revokedToken, { orgId });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('set-cookie')).toBeNull();
    expect((await request('/files/list', revokedToken)).status).toBe(403);
    const otherOrgId = createOrg('Other membership', 'audit-other-membership', revokedId).id;
    addMember(otherOrgId, revokedId, 'member');
    const switched = await request('/auth/switch-org', revokedToken, { orgId: otherOrgId });
    expect(switched.status).toBe(200);
    expect(jwt.verify((await switched.json()).token, JWT_SECRET)).toMatchObject({ uid: revokedId, orgId: otherOrgId });
  });
});
