import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JWT_SECRET, makeApp } from './helpers';
import * as OrgDB from '../server/org/db';
import { mountPreferencesRoutes } from '../server/routes/preferences_routes';

describe('personal and organization Lumi appearance preferences', () => {
  let cleanup = () => {};
  let baseUrl = '';
  let orgId = '';
  const ownerId = `pet-owner-${Date.now()}`;
  const viewerId = `pet-viewer-${Date.now()}`;

  const token = (userId: string, work: boolean) => jwt.sign({
    uid: userId,
    username: userId,
    role: 'user',
    ...(work ? { orgId } : {}),
  }, JWT_SECRET);
  const headers = (userId: string, work: boolean) => ({
    'Content-Type': 'application/json',
    Cookie: `token=${token(userId, work)}`,
  });

  beforeAll(async () => {
    const app = await makeApp();
    cleanup = app.cleanup;
    baseUrl = app.url;
    const org = OrgDB.createOrg('Pet Scope Org', `pet-scope-${Date.now()}`, ownerId);
    orgId = org.id;
    OrgDB.addMember(orgId, ownerId, 'owner');
    OrgDB.addMember(orgId, viewerId, 'viewer');
    mountPreferencesRoutes(app.apiRouter, JWT_SECRET);
  });

  afterAll(() => cleanup());

  it('keeps personal appearance separate from the shared organization appearance', async () => {
    const personalSave = await fetch(`${baseUrl}/api/preferences/pet`, {
      method: 'PUT',
      headers: headers(ownerId, false),
      body: JSON.stringify({ pet: { id: 'personal-avatar' }, accessories: ['personal-hat'] }),
    });
    const orgSave = await fetch(`${baseUrl}/api/preferences/pet`, {
      method: 'PUT',
      headers: headers(ownerId, true),
      body: JSON.stringify({ pet: { id: 'company-avatar' }, accessories: ['company-badge'] }),
    });
    expect(personalSave.ok).toBe(true);
    expect(orgSave.ok).toBe(true);

    const personal = await fetch(`${baseUrl}/api/preferences/pet`, { headers: headers(ownerId, false) });
    const work = await fetch(`${baseUrl}/api/preferences/pet`, { headers: headers(viewerId, true) });
    expect(await personal.json()).toMatchObject({ pet: { id: 'personal-avatar' }, accessories: ['personal-hat'] });
    expect(await work.json()).toMatchObject({ pet: { id: 'company-avatar' }, accessories: ['company-badge'] });
  });

  it('keeps organization appearance administrator-managed', async () => {
    const response = await fetch(`${baseUrl}/api/preferences/pet`, {
      method: 'PUT',
      headers: headers(viewerId, true),
      body: JSON.stringify({ pet: { id: 'viewer-overwrite' }, accessories: [] }),
    });
    expect(response.status).toBe(403);
  });
});
