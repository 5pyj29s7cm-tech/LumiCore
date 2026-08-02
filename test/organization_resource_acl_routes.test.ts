import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JWT_SECRET, makeApp } from './helpers';
import { addMember, createDepartment, createOrg } from '../server/org/db';
import { mountOrgRoutes } from '../server/org/routes';
import { registerOrganizationDevice } from '../server/org/resource_acl';

describe('organization resource authorization REST enforcement', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ownerId = `acl-api-owner-${suffix}`;
  const memberA = `acl-api-member-a-${suffix}`;
  const memberB = `acl-api-member-b-${suffix}`;
  const outsider = `acl-api-outsider-${suffix}`;
  const otherOwner = `acl-api-other-owner-${suffix}`;
  let orgId = '';
  let otherOrgId = '';
  let departmentId = '';
  let baseUrl = '';
  let cleanup = () => {};

  function headers(userId: string, targetOrgId = orgId): Record<string, string> {
    const token = jwt.sign({ uid: userId, username: userId, role: 'user', orgId: targetOrgId }, JWT_SECRET);
    return { 'Content-Type': 'application/json', Cookie: `token=${token}` };
  }

  beforeAll(async () => {
    const app = await makeApp();
    baseUrl = app.url;
    cleanup = app.cleanup;
    mountOrgRoutes(app.apiRouter);
    orgId = createOrg(`ACL API ${suffix}`, `acl-api-${suffix}`, ownerId).id;
    otherOrgId = createOrg(`ACL API Other ${suffix}`, `acl-api-other-${suffix}`, otherOwner).id;
    addMember(orgId, ownerId, 'owner');
    addMember(orgId, memberA, 'member');
    addMember(orgId, memberB, 'member');
    addMember(orgId, outsider, 'member');
    addMember(otherOrgId, otherOwner, 'owner');
    departmentId = createDepartment(orgId, 'Confidential').id;
  });

  afterAll(() => cleanup());

  it('filters restricted knowledge from list, detail, search, and statistics', async () => {
    const marker = `acl-secret-keyword-${suffix}`;
    const createdResponse = await fetch(`${baseUrl}/api/org/kb/articles`, {
      method: 'POST',
      headers: headers(memberA),
      body: JSON.stringify({
        title: `Restricted article ${suffix}`,
        content: `${marker} confidential organization knowledge`,
        category: 'restricted-test',
        status: 'published',
        index: false,
        access: {
          classification: 'restricted',
          grants: [{ subjectType: 'member', subjectId: memberB, permissions: ['read'] }],
        },
      }),
    });
    expect(createdResponse.status).toBe(201);
    const article = await createdResponse.json();

    const memberList = await fetch(`${baseUrl}/api/org/kb/articles`, { headers: headers(memberB) });
    expect(memberList.status).toBe(200);
    expect((await memberList.json()).some((item: any) => item.id === article.id)).toBe(true);

    const outsiderList = await fetch(`${baseUrl}/api/org/kb/articles`, { headers: headers(outsider) });
    expect((await outsiderList.json()).some((item: any) => item.id === article.id)).toBe(false);
    const outsiderDetail = await fetch(`${baseUrl}/api/org/kb/articles/${article.id}`, { headers: headers(outsider) });
    expect(outsiderDetail.status).toBe(404);
    const outsiderSearch = await fetch(`${baseUrl}/api/org/kb/search`, {
      method: 'POST',
      headers: headers(outsider),
      body: JSON.stringify({ query: marker, limit: 10 }),
    });
    expect(outsiderSearch.status).toBe(200);
    expect((await outsiderSearch.json()).some((item: any) => item.articleId === article.id)).toBe(false);
    const outsiderStats = await fetch(`${baseUrl}/api/org/kb/stats`, { headers: headers(outsider) });
    expect(outsiderStats.status).toBe(200);
    expect((await outsiderStats.json()).articleHealth.some((item: any) => item.articleId === article.id)).toBe(false);

    const forbiddenUpdate = await fetch(`${baseUrl}/api/org/kb/articles/${article.id}`, {
      method: 'PUT',
      headers: headers(memberB),
      body: JSON.stringify({ title: 'Read grant must not imply write' }),
    });
    expect(forbiddenUpdate.status).toBe(404);
  });

  it('protects restricted legal matters and rejects cross-organization path access', async () => {
    const createdResponse = await fetch(`${baseUrl}/api/org/legal/cases`, {
      method: 'POST',
      headers: headers(memberA),
      body: JSON.stringify({
        title: `Restricted matter ${suffix}`,
        party: 'Confidential client',
        access: {
          classification: 'department',
          departmentId,
          grants: [],
        },
      }),
    });
    expect(createdResponse.status).toBe(201);
    const caseFile = await createdResponse.json();

    const outsiderList = await fetch(`${baseUrl}/api/org/legal/cases`, { headers: headers(outsider) });
    expect((await outsiderList.json()).cases.some((item: any) => item.id === caseFile.id)).toBe(false);
    const outsiderDetail = await fetch(`${baseUrl}/api/org/legal/cases/${caseFile.id}`, { headers: headers(outsider) });
    expect(outsiderDetail.status).toBe(404);
    const ownerDetail = await fetch(`${baseUrl}/api/org/legal/cases/${caseFile.id}`, { headers: headers(ownerId) });
    expect(ownerDetail.status).toBe(200);

    const crossOrg = await fetch(`${baseUrl}/api/org/org/${orgId}/resources/legal_case/${caseFile.id}/policy`, {
      headers: headers(otherOwner, otherOrgId),
    });
    expect(crossOrg.status).toBe(403);
  });

  it('never accepts secret material in credential metadata and never returns the reference locator', async () => {
    const rejected = await fetch(`${baseUrl}/api/org/org/${orgId}/credential-references`, {
      method: 'POST',
      headers: headers(ownerId),
      body: JSON.stringify({
        name: 'Unsafe connector',
        provider: 'feishu',
        credentialRef: 'settings:messaging.feishu',
        apiKey: 'must-not-cross-api',
      }),
    });
    expect(rejected.status).toBe(400);

    const created = await fetch(`${baseUrl}/api/org/org/${orgId}/credential-references`, {
      method: 'POST',
      headers: headers(ownerId),
      body: JSON.stringify({
        name: `Safe connector ${suffix}`,
        provider: 'feishu',
        credentialRef: `settings:messaging.feishu.${suffix}`,
        purpose: 'Send approved organization messages',
        grants: [{ subjectType: 'member', subjectId: memberB, permissions: ['read', 'credential_use'] }],
      }),
    });
    expect(created.status).toBe(201);
    const metadata = await created.json();
    expect(metadata).not.toHaveProperty('credentialRef');
    expect(JSON.stringify(metadata)).not.toContain(`settings:messaging.feishu.${suffix}`);
    const visible = await fetch(`${baseUrl}/api/org/org/${orgId}/credential-references`, { headers: headers(memberB) });
    expect(visible.status).toBe(200);
    expect(await visible.json()).toEqual([expect.objectContaining({ id: metadata.id, hasReference: true })]);
  });

  it('allows administrators to revoke exact devices while denying member device administration', async () => {
    const device = registerOrganizationDevice({
      orgId,
      branchId: `acl_api_branch_${suffix}`,
      userId: memberA,
    });
    const denied = await fetch(`${baseUrl}/api/org/org/${orgId}/devices`, { headers: headers(memberA) });
    expect(denied.status).toBe(403);
    const listed = await fetch(`${baseUrl}/api/org/org/${orgId}/devices`, { headers: headers(ownerId) });
    expect(listed.status).toBe(200);
    expect((await listed.json()).some((item: any) => item.id === device.id)).toBe(true);
    const revoked = await fetch(`${baseUrl}/api/org/org/${orgId}/devices/${device.id}`, {
      method: 'PUT',
      headers: headers(ownerId),
      body: JSON.stringify({ status: 'revoked' }),
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ id: device.id, status: 'revoked' });
  });
});
