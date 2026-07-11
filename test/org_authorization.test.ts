import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import * as OrgDB from '../server/org/db';
import { requireAuth, requireOrgMember, requireOrgRole } from '../server/middleware/auth';

let cleanup = () => {};
let baseUrl = '';
let orgA = '';
let orgB = '';
const userId = `org-auth-user-${Date.now()}`;

function tokenFor(role: string): string {
  return jwt.sign({ uid: userId, username: userId, role: 'user', orgId: orgA, orgRole: role }, JWT_SECRET);
}

async function get(path: string, token: string) {
  return fetch(`${baseUrl}/api${path}`, { headers: { Cookie: `token=${token}` } });
}

describe('Organization authorization boundary', () => {
  beforeAll(async () => {
    const app = await makeApp();
    cleanup = app.cleanup;
    baseUrl = app.url;

    const a = OrgDB.createOrg('Authorization A', `auth-a-${Date.now()}`, userId);
    const b = OrgDB.createOrg('Authorization B', `auth-b-${Date.now()}`, 'other-owner');
    orgA = a.id;
    orgB = b.id;
    OrgDB.addMember(orgA, userId, 'member');

    app.apiRouter.get('/org-member-probe/:orgId', requireAuth, requireOrgMember, (_req, res) => res.json({ ok: true }));
    app.apiRouter.get('/org-owner-probe/:orgId', requireAuth, requireOrgRole('owner'), (_req, res) => res.json({ ok: true }));
  });

  afterAll(() => cleanup());

  it('allows an active member to access the organization in the token', async () => {
    const response = await get(`/org-member-probe/${orgA}`, tokenFor('member'));
    expect(response.status).toBe(200);
  });

  it('rejects a different orgId even when the token has an organization role', async () => {
    const response = await get(`/org-member-probe/${orgB}`, tokenFor('owner'));
    expect(response.status).toBe(403);
  });

  it('uses the live membership role instead of trusting a stale owner claim', async () => {
    const response = await get(`/org-owner-probe/${orgA}`, tokenFor('owner'));
    expect(response.status).toBe(403);
  });
});
