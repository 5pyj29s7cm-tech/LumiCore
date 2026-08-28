import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JWT_SECRET, makeApp } from './helpers';
import { addMember, createDepartment, createOrg } from '../server/org/db';
import { mountOrgRoutes } from '../server/org/routes';
import { routeOrganizationWork } from '../server/org/work_routing';

describe('organization work routing REST authorization', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ownerId = `routing-api-owner-${suffix}`;
  const memberA = `routing-api-member-a-${suffix}`;
  const memberB = `routing-api-member-b-${suffix}`;
  const unrelatedMember = `routing-api-unrelated-${suffix}`;
  const viewerId = `routing-api-viewer-${suffix}`;
  let orgId = '';
  let departmentId = '';
  let baseUrl = '';
  let cleanup = () => {};

  function headers(userId: string): Record<string, string> {
    const token = jwt.sign({ uid: userId, username: userId, role: 'user', orgId }, JWT_SECRET);
    return { 'Content-Type': 'application/json', Cookie: `token=${token}` };
  }

  beforeAll(async () => {
    const app = await makeApp();
    baseUrl = app.url;
    cleanup = app.cleanup;
    mountOrgRoutes(app.apiRouter);
    const org = createOrg(`Routing API ${suffix}`, `routing-api-${suffix}`, ownerId);
    orgId = org.id;
    addMember(orgId, ownerId, 'owner');
    addMember(orgId, memberA, 'member');
    addMember(orgId, memberB, 'member');
    addMember(orgId, unrelatedMember, 'member');
    addMember(orgId, viewerId, 'viewer');
    departmentId = createDepartment(orgId, 'Operations').id;
  });

  afterAll(() => cleanup());

  it('allows only administrators to configure positions and routing rules', async () => {
    const denied = await fetch(`${baseUrl}/api/org/org/${orgId}/positions`, {
      method: 'POST',
      headers: headers(memberA),
      body: JSON.stringify({ name: 'Unauthorized Position' }),
    });
    expect(denied.status).toBe(403);

    const created = await fetch(`${baseUrl}/api/org/org/${orgId}/positions`, {
      method: 'POST',
      headers: headers(ownerId),
      body: JSON.stringify({
        name: 'Operations Lead',
        departmentId,
        memberIds: [memberA, memberB],
        skillTags: ['operations'],
      }),
    });
    expect(created.status).toBe(201);
    const position = await created.json();

    const ruleResponse = await fetch(`${baseUrl}/api/org/org/${orgId}/work-routing/rules`, {
      method: 'POST',
      headers: headers(ownerId),
      body: JSON.stringify({
        name: 'Operations route',
        keywords: ['operations-task'],
        positionId: position.id,
        priority: 10,
        approvalMode: 'admin',
      }),
    });
    expect(ruleResponse.status).toBe(201);
    expect(await ruleResponse.json()).toMatchObject({ positionId: position.id, enabled: true });

    const memberList = await fetch(`${baseUrl}/api/org/org/${orgId}/work-routing/rules`, {
      headers: headers(memberA),
    });
    expect(memberList.status).toBe(200);
    expect((await memberList.json()).length).toBeGreaterThan(0);
  });

  it('limits work-item visibility and gates approval decisions', async () => {
    const routed = routeOrganizationWork({
      orgId,
      requesterUserId: memberA,
      source: 'feishu_bot',
      requestId: `api-approval-${suffix}`,
      text: 'Publish this operations-task externally.',
      intentKind: 'public_publish',
      operation: 'mutate',
      sideEffectClass: 'external_commit',
      taskId: `api-task-${suffix}`,
    });
    expect(routed.workItem.status).toBe('waiting_approval');

    const unrelated = await fetch(`${baseUrl}/api/org/org/${orgId}/work-items/${routed.workItem.id}`, {
      headers: headers(unrelatedMember),
    });
    expect(unrelated.status).toBe(403);

    const requester = await fetch(`${baseUrl}/api/org/org/${orgId}/work-items/${routed.workItem.id}`, {
      headers: headers(memberA),
    });
    expect(requester.status).toBe(200);

    const deniedDecision = await fetch(`${baseUrl}/api/org/org/${orgId}/work-approvals/${routed.approval!.id}/decision`, {
      method: 'POST',
      headers: headers(memberA),
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(deniedDecision.status).toBe(403);

    const approved = await fetch(`${baseUrl}/api/org/org/${orgId}/work-approvals/${routed.approval!.id}/decision`, {
      method: 'POST',
      headers: headers(ownerId),
      body: JSON.stringify({ decision: 'approve', reason: 'Approved by owner.' }),
    });
    expect(approved.status).toBe(200);
    expect((await approved.json()).workItem.status).toBe('waiting_human');
  });

  it('allows an assigned human to accept takeover while hiding unrelated handoffs', async () => {
    const routed = routeOrganizationWork({
      orgId,
      requesterUserId: memberA,
      source: 'feishu_bot',
      requestId: `api-handoff-${suffix}`,
      text: 'Handle this internal operations package.',
      intentKind: 'none',
      operation: 'read',
      sideEffectClass: 'none',
      targetMemberId: memberA,
    });
    const requested = await fetch(`${baseUrl}/api/org/org/${orgId}/work-items/${routed.workItem.id}/handoffs`, {
      method: 'POST',
      headers: headers(memberA),
      body: JSON.stringify({
        type: 'human_takeover',
        targetMemberId: memberB,
        reason: 'Member B owns the source originals.',
      }),
    });
    expect(requested.status).toBe(201);
    const handoff = await requested.json();

    const accepted = await fetch(`${baseUrl}/api/org/org/${orgId}/work-handoffs/${handoff.id}/decision`, {
      method: 'POST',
      headers: headers(memberB),
      body: JSON.stringify({ decision: 'accept' }),
    });
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).workItem).toMatchObject({
      status: 'waiting_human',
      humanOwnerUserId: memberB,
    });

    const unrelated = await fetch(`${baseUrl}/api/org/org/${orgId}/work-handoffs`, {
      headers: headers(unrelatedMember),
    });
    expect(unrelated.status).toBe(200);
    expect(await unrelated.json()).toEqual([]);

    const viewerCreate = await fetch(`${baseUrl}/api/org/org/${orgId}/work-items/${routed.workItem.id}/handoffs`, {
      method: 'POST',
      headers: headers(viewerId),
      body: JSON.stringify({
        type: 'human_takeover',
        targetMemberId: viewerId,
        reason: 'Viewer must not take over work.',
      }),
    });
    expect(viewerCreate.status).toBe(403);
  });
});
