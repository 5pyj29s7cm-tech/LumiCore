import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, flushDBOrThrow, initDatabase, readDB } from '../db_layer';
import { addMember, createDepartment, createOrg } from '../server/org/db';
import { createOrganizationPosition } from '../server/org/work_routing';
import {
  authorizeOrganizationDevice,
  authorizeOrganizationResource,
  createOrganizationCredentialReference,
  getOrganizationResourcePolicy,
  listOrganizationCredentialReferences,
  registerOrganizationDevice,
  resolveOrganizationCredentialReference,
  setOrganizationResourcePolicy,
  updateOrganizationDevice,
} from '../server/org/resource_acl';
import * as OrganizationKnowledge from '../server/org/kb';
import * as LegalCases from '../server/org/legal_cases';

describe('organization resource ACL, credential references, and devices', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ownerId = `acl-owner-${suffix}`;
  const memberA = `acl-member-a-${suffix}`;
  const memberB = `acl-member-b-${suffix}`;
  const viewerId = `acl-viewer-${suffix}`;
  let orgId = '';
  let otherOrgId = '';
  let departmentId = '';
  let positionId = '';

  beforeAll(async () => {
    await initDatabase();
    orgId = createOrg(`ACL Org ${suffix}`, `acl-org-${suffix}`, ownerId).id;
    otherOrgId = createOrg(`ACL Other ${suffix}`, `acl-other-${suffix}`, `other-${ownerId}`).id;
    addMember(orgId, ownerId, 'owner');
    addMember(orgId, memberA, 'member');
    addMember(orgId, memberB, 'member');
    addMember(orgId, viewerId, 'viewer');
    addMember(otherOrgId, `other-${ownerId}`, 'owner');
    departmentId = createDepartment(orgId, 'Restricted Operations').id;
    const db = readDB();
    db.orgMemberships.find((item: any) => item.orgId === orgId && item.userId === memberA).departmentId = departmentId;
    positionId = createOrganizationPosition({
      orgId,
      actorUserId: ownerId,
      departmentId,
      name: `Reviewer ${suffix}`,
      memberIds: [memberA],
    }).id;
  });

  it('applies restricted grants, position grants, viewer read-only, and deny precedence', () => {
    const resourceId = `article-${suffix}`;
    setOrganizationResourcePolicy({
      orgId,
      actorUserId: ownerId,
      resourceType: 'knowledge_article',
      resourceId,
      ownerUserId: ownerId,
      classification: 'restricted',
      grants: [
        { subjectType: 'position', subjectId: positionId, permissions: ['read', 'write'] },
        { subjectType: 'member', subjectId: memberA, permissions: ['write'], effect: 'deny' },
        { subjectType: 'member', subjectId: viewerId, permissions: ['write'] },
      ],
    });

    expect(authorizeOrganizationResource({
      orgId, actorUserId: memberA, resourceType: 'knowledge_article', resourceId, permission: 'read', ownerUserId: ownerId,
    }).allowed).toBe(true);
    expect(authorizeOrganizationResource({
      orgId, actorUserId: memberA, resourceType: 'knowledge_article', resourceId, permission: 'write', ownerUserId: ownerId,
    })).toMatchObject({ allowed: false, reason: 'matching_deny_grant' });
    expect(authorizeOrganizationResource({
      orgId, actorUserId: memberB, resourceType: 'knowledge_article', resourceId, permission: 'read', ownerUserId: ownerId,
    }).allowed).toBe(false);
    expect(authorizeOrganizationResource({
      orgId, actorUserId: viewerId, resourceType: 'knowledge_article', resourceId, permission: 'write', ownerUserId: ownerId,
    })).toMatchObject({ allowed: false, reason: 'viewer_is_read_only' });
    expect(getOrganizationResourcePolicy(otherOrgId, 'knowledge_article', resourceId)).toEqual({ policy: null, grants: [] });
  });

  it('stores only an approved secure-store reference and never exposes it through public metadata', () => {
    expect(() => createOrganizationCredentialReference({
      orgId,
      actorUserId: ownerId,
      name: 'Bad credential input',
      provider: 'feishu',
      credentialRef: 'settings:messaging.feishu',
      apiKey: 'must-never-be-stored',
    } as any)).toThrow(/Secret values are forbidden/);

    const created = createOrganizationCredentialReference({
      orgId,
      actorUserId: ownerId,
      name: `Feishu connector ${suffix}`,
      provider: 'feishu',
      credentialRef: `settings:messaging.feishu.${suffix}`,
      purpose: 'Organization messaging connector',
      grants: [{ subjectType: 'member', subjectId: memberA, permissions: ['read', 'credential_use'] }],
    });
    expect(created).not.toHaveProperty('credentialRef');
    expect(JSON.stringify(created)).not.toContain(`settings:messaging.feishu.${suffix}`);
    expect(listOrganizationCredentialReferences(orgId, memberA)).toEqual([expect.objectContaining({ id: created.id, hasReference: true })]);
    expect(resolveOrganizationCredentialReference({ orgId, actorUserId: memberA, credentialId: created.id }))
      .toBe(`settings:messaging.feishu.${suffix}`);
    expect(() => resolveOrganizationCredentialReference({ orgId, actorUserId: memberB, credentialId: created.id }))
      .toThrow(/Resource access denied/);
  });

  it('keeps device identity immutable and prevents revoked devices from self-reactivating', () => {
    const branchId = `branch_acl_${suffix}`;
    const device = registerOrganizationDevice({ orgId, branchId, userId: memberA, label: 'Member A laptop' });
    expect(authorizeOrganizationDevice({ orgId, branchId, userId: memberA, permission: 'sync_write' }).id).toBe(device.id);
    expect(() => registerOrganizationDevice({ orgId: otherOrgId, branchId, userId: `other-${ownerId}` }))
      .toThrow(/another organization member/);

    const revoked = updateOrganizationDevice({
      orgId,
      actorUserId: ownerId,
      deviceId: device.id,
      status: 'revoked',
    });
    expect(revoked?.status).toBe('revoked');
    expect(() => authorizeOrganizationDevice({ orgId, branchId, userId: memberA, permission: 'sync_write' }))
      .toThrow(/not active/);
    expect(() => registerOrganizationDevice({ orgId, branchId, userId: memberA }))
      .toThrow(/revoked/);
  });

  it('enforces the same ACL below REST for knowledge and legal-case service calls', () => {
    const article = OrganizationKnowledge.createArticle(orgId, ownerId, {
      title: `Service restricted article ${suffix}`,
      content: `service-layer-secret-${suffix}`,
      status: 'published',
    }, { index: false });
    setOrganizationResourcePolicy({
      orgId,
      actorUserId: ownerId,
      resourceType: 'knowledge_article',
      resourceId: article.id,
      ownerUserId: ownerId,
      classification: 'restricted',
      grants: [{ subjectType: 'member', subjectId: memberA, permissions: ['read'] }],
    });
    expect(OrganizationKnowledge.listArticles(orgId).some(item => item.id === article.id)).toBe(false);
    expect(OrganizationKnowledge.listArticles(orgId, undefined, memberA).some(item => item.id === article.id)).toBe(true);
    expect(OrganizationKnowledge.listArticles(orgId, undefined, memberB).some(item => item.id === article.id)).toBe(false);
    expect(() => OrganizationKnowledge.updateArticle(orgId, memberA, article.id, { title: 'Must not update' }, { index: false }))
      .toThrow(/Resource access denied/);

    const caseFile = LegalCases.createCase(orgId, ownerId, { title: `Service restricted case ${suffix}` });
    setOrganizationResourcePolicy({
      orgId,
      actorUserId: ownerId,
      resourceType: 'legal_case',
      resourceId: caseFile.id,
      ownerUserId: ownerId,
      classification: 'restricted',
      grants: [{ subjectType: 'member', subjectId: memberA, permissions: ['read'] }],
    });
    expect(LegalCases.listCases(orgId, caseFile.title, 5)).toEqual([]);
    expect(LegalCases.listCases(orgId, caseFile.title, 5, memberA).map(item => item.id)).toEqual([caseFile.id]);
    expect(LegalCases.listCases(orgId, caseFile.title, 5, memberB)).toEqual([]);
    expect(LegalCases.addMaterial(orgId, memberA, caseFile.id, {
      type: 'note', title: 'Forbidden material', content: 'Must not be written', source: 'tool',
    })).toBeNull();
  });

  it('restores policies, grants, credential metadata, and device revocation after a database restart', async () => {
    await flushDBOrThrow();
    await closeDatabase();
    await initDatabase();
    const db = readDB();
    expect(db.orgResourcePolicies.some((item: any) => item.orgId === orgId)).toBe(true);
    expect(db.orgResourceGrants.some((item: any) => item.orgId === orgId)).toBe(true);
    expect(db.orgCredentialReferences.some((item: any) => item.orgId === orgId && item.status === 'active')).toBe(true);
    expect(db.orgDevices.some((item: any) => item.orgId === orgId && item.status === 'revoked')).toBe(true);
  });
});
