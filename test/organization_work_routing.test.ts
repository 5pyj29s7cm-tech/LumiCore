import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, flushDBOrThrow, initDatabase, querySQL, readDB, writeDB } from '../db_layer';
import {
  addMember,
  createDepartment,
  createOrg,
  updateMemberRole,
} from '../server/org/db';
import {
  createOrganizationPosition,
  createOrganizationWorkRoutingRule,
  decideOrganizationWorkApproval,
  decideOrganizationWorkHandoff,
  getOrganizationWorkItem,
  listOrganizationWorkApprovals,
  listOrganizationWorkHandoffs,
  listOrganizationWorkItems,
  requestOrganizationWorkHandoff,
  routeOrganizationWork,
  setOrganizationWorkItemExecutionStatus,
} from '../server/org/work_routing';

describe('durable organization business routing', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ownerId = `routing-owner-${suffix}`;
  const memberA = `routing-member-a-${suffix}`;
  const memberB = `routing-member-b-${suffix}`;
  let orgId = '';
  let departmentId = '';
  let positionId = '';

  beforeAll(async () => {
    await initDatabase();
    const org = createOrg(`Routing Org ${suffix}`, `routing-org-${suffix}`, ownerId);
    orgId = org.id;
    addMember(orgId, ownerId, 'owner');
    addMember(orgId, memberA, 'member');
    addMember(orgId, memberB, 'member');
    const department = createDepartment(orgId, 'Legal Operations');
    departmentId = department.id;
    const db = readDB();
    const membershipA = db.orgMemberships.find((item: any) => item.orgId === orgId && item.userId === memberA);
    const membershipB = db.orgMemberships.find((item: any) => item.orgId === orgId && item.userId === memberB);
    membershipA.departmentId = departmentId;
    membershipB.departmentId = departmentId;
    writeDB(db);
  });

  it('routes a Feishu request to a department, position, multiple members, and skills', () => {
    const position = createOrganizationPosition({
      orgId,
      actorUserId: ownerId,
      departmentId,
      name: 'Contract Review Lead',
      description: 'Owns contract review work.',
      skillTags: ['contract-review'],
      memberIds: [memberA, memberB],
      isManager: true,
    });
    positionId = position.id;
    const rule = createOrganizationWorkRoutingRule({
      orgId,
      actorUserId: ownerId,
      name: 'Contract review route',
      priority: 50,
      platforms: ['feishu'],
      keywords: ['contract-review'],
      departmentId,
      positionId,
      approvalMode: 'none',
    });

    const first = routeOrganizationWork({
      orgId,
      requesterUserId: memberA,
      source: 'feishu_bot',
      platform: 'feishu',
      requestId: `feishu:${suffix}:1`,
      idempotencyKey: `feishu-work-${suffix}:1`,
      text: 'Please run contract-review for this agreement.',
      intentKind: 'none',
      operation: 'read',
      sideEffectClass: 'none',
      conversationId: `conversation-${suffix}`,
      taskId: `task-${suffix}:1`,
    });
    const replay = routeOrganizationWork({
      orgId,
      requesterUserId: memberA,
      source: 'feishu_bot',
      platform: 'feishu',
      requestId: `feishu:${suffix}:1`,
      idempotencyKey: `feishu-work-${suffix}:1`,
      text: 'Changed replay text must not create another work item.',
      intentKind: 'none',
      operation: 'read',
      sideEffectClass: 'none',
      taskId: `task-${suffix}:1`,
    });

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.workItem.id).toBe(first.workItem.id);
    expect(first.routingRule?.id).toBe(rule.id);
    expect(first.workItem).toMatchObject({
      departmentId,
      positionId,
      assignedMemberId: memberA,
      status: 'waiting_human',
    });
    expect(first.workItem.collaboratorMemberIds).toContain(memberB);
    expect(first.workItem.skillTags).toContain('contract-review');
  });

  it('does not invent an approval for an external commit without an explicit approval rule', () => {
    const routed = routeOrganizationWork({
      orgId,
      requesterUserId: memberB,
      source: 'feishu_bot',
      platform: 'feishu',
      requestId: `feishu:${suffix}:default-no-approval`,
      text: 'Publish this ordinary organization notice externally.',
      intentKind: 'public_publish',
      operation: 'mutate',
      sideEffectClass: 'external_commit',
      taskId: `task-${suffix}:default-no-approval`,
      targetMemberId: memberB,
    });

    expect(routed.approval).toBeNull();
    expect(routed.workItem).toMatchObject({ status: 'waiting_human', approvalId: null });
  });

  it('binds explicitly configured approvals to an immutable work item and resumes without duplication', () => {
    createOrganizationWorkRoutingRule({
      orgId,
      actorUserId: ownerId,
      name: 'Explicit administrator approval route',
      priority: 100,
      platforms: ['feishu'],
      keywords: ['approval-required'],
      positionId,
      approvalMode: 'admin',
    });
    const routed = routeOrganizationWork({
      orgId,
      requesterUserId: memberA,
      source: 'feishu_bot',
      platform: 'feishu',
      requestId: `feishu:${suffix}:approval`,
      idempotencyKey: `feishu-work-${suffix}:approval`,
      text: 'Publish this approval-required notice externally.',
      intentKind: 'public_publish',
      operation: 'mutate',
      sideEffectClass: 'external_commit',
      conversationId: `conversation-${suffix}`,
      taskId: `task-${suffix}:approval`,
    });
    expect(routed.workItem.status).toBe('waiting_approval');
    expect(routed.approval).toMatchObject({
      workItemId: routed.workItem.id,
      workItemRevision: 1,
      status: 'pending',
    });
    expect(routed.approval?.actionDigest).toMatch(/^[a-f0-9]{64}$/);

    const decision = decideOrganizationWorkApproval({
      orgId,
      approvalId: routed.approval!.id,
      actorUserId: ownerId,
      decision: 'approve',
      reason: 'Approved for execution.',
    });
    expect(decision?.workItem.status).toBe('waiting_human');

    const continued = routeOrganizationWork({
      orgId,
      requesterUserId: memberA,
      source: 'feishu_bot',
      requestId: `feishu:${suffix}:continue`,
      text: 'continue',
      intentKind: 'none',
      operation: 'read',
      sideEffectClass: 'none',
      conversationId: `conversation-${suffix}`,
      taskId: `task-${suffix}:approval`,
    });
    expect(continued.created).toBe(false);
    expect(continued.workItem.id).toBe(routed.workItem.id);
    expect(continued.workItem.status).toBe('waiting_human');
    expect(listOrganizationWorkItems(orgId, { taskId: `task-${suffix}:approval` })).toHaveLength(1);
  });

  it('does not require an organization administrator to approve their own routed request', () => {
    const routed = routeOrganizationWork({
      orgId,
      requesterUserId: ownerId,
      source: 'feishu_bot',
      platform: 'feishu',
      requestId: `feishu:${suffix}:owner-self-approval`,
      text: 'Publish this approval-required owner notice externally.',
      intentKind: 'public_publish',
      operation: 'mutate',
      sideEffectClass: 'external_commit',
      conversationId: `conversation-${suffix}-owner`,
      taskId: `task-${suffix}:owner-self-approval`,
    });

    expect(routed.approval).toBeNull();
    expect(routed.workItem).toMatchObject({
      requesterUserId: ownerId,
      status: 'waiting_human',
      approvalId: null,
    });
    expect(listOrganizationWorkApprovals(orgId).some(item => item.workItemId === routed.workItem.id)).toBe(false);
  });

  it('releases a legacy self-approval when the requester is now an organization administrator', () => {
    const legacyAdminId = `routing-legacy-admin-${suffix}`;
    addMember(orgId, legacyAdminId, 'member');
    const routed = routeOrganizationWork({
      orgId,
      requesterUserId: legacyAdminId,
      source: 'feishu_bot',
      platform: 'feishu',
      requestId: `feishu:${suffix}:legacy-self-approval`,
      text: 'Publish this approval-required legacy organization notice externally.',
      intentKind: 'public_publish',
      operation: 'mutate',
      sideEffectClass: 'external_commit',
      taskId: `task-${suffix}:legacy-self-approval`,
    });
    expect(routed.workItem.status).toBe('waiting_approval');
    expect(routed.approval?.status).toBe('pending');
    updateMemberRole(orgId, legacyAdminId, 'admin');

    const continued = routeOrganizationWork({
      orgId,
      requesterUserId: legacyAdminId,
      source: 'feishu_bot',
      requestId: `feishu:${suffix}:legacy-self-approval-continue`,
      text: 'continue',
      intentKind: 'none',
      operation: 'read',
      sideEffectClass: 'none',
      taskId: routed.workItem.taskId,
    });

    expect(continued.created).toBe(false);
    expect(continued.workItem).toMatchObject({ id: routed.workItem.id, status: 'waiting_human' });
    expect(continued.approval).toMatchObject({ status: 'approved', decidedBy: legacyAdminId });
  });

  it('moves an accepted human takeover to the exact organization member', () => {
    const routed = routeOrganizationWork({
      orgId,
      requesterUserId: memberA,
      source: 'feishu_bot',
      requestId: `feishu:${suffix}:handoff`,
      text: 'Analyze this internal package.',
      intentKind: 'none',
      operation: 'read',
      sideEffectClass: 'none',
      taskId: `task-${suffix}:handoff`,
      targetMemberId: memberA,
    });
    const takeover = requestOrganizationWorkHandoff({
      orgId,
      workItemId: routed.workItem.id,
      actorUserId: memberA,
      type: 'human_takeover',
      targetMemberId: memberB,
      reason: 'Member B must review the source originals.',
    });
    expect(takeover?.status).toBe('pending');
    const accepted = decideOrganizationWorkHandoff({
      orgId,
      handoffId: takeover!.id,
      actorUserId: memberB,
      decision: 'accept',
    });
    expect(accepted?.workItem).toMatchObject({
      status: 'waiting_human',
      humanOwnerUserId: memberB,
      assignedMemberId: memberB,
    });
    expect(() => setOrganizationWorkItemExecutionStatus({
      orgId,
      workItemId: routed.workItem.id,
      status: 'executing',
      actorUserId: memberA,
    })).toThrow(/owned by a human/i);

    expect(listOrganizationWorkHandoffs(orgId, routed.workItem.id)).toHaveLength(1);
  });

  it('rejects cross-organization member targets', () => {
    const otherOwner = `other-owner-${suffix}`;
    const otherOrg = createOrg(`Other Org ${suffix}`, `other-routing-${suffix}`, otherOwner);
    addMember(otherOrg.id, otherOwner, 'owner');
    const foreignMemberId = `foreign-member-${suffix}`;
    addMember(otherOrg.id, foreignMemberId, 'member');

    expect(() => routeOrganizationWork({
      orgId,
      requesterUserId: memberA,
      source: 'feishu_bot',
      requestId: `feishu:${suffix}:foreign`,
      text: 'Route this across organizations.',
      intentKind: 'none',
      operation: 'read',
      sideEffectClass: 'none',
      targetMemberId: foreignMemberId,
    })).toThrow(/does not belong to this organization/i);
  });

  it('expires an old approval when a handoff changes the immutable work-item target', () => {
    const routed = routeOrganizationWork({
      orgId,
      requesterUserId: memberA,
      source: 'feishu_bot',
      platform: 'feishu',
      requestId: `feishu:${suffix}:approval-expiry`,
      text: 'Publish this approval-required target-changing notice.',
      intentKind: 'public_publish',
      operation: 'mutate',
      sideEffectClass: 'external_commit',
      taskId: `task-${suffix}:approval-expiry`,
    });
    const handoff = requestOrganizationWorkHandoff({
      orgId,
      workItemId: routed.workItem.id,
      actorUserId: memberA,
      type: 'human_takeover',
      targetMemberId: memberB,
      reason: 'The target changed to a human reviewer before publication.',
    });
    decideOrganizationWorkHandoff({
      orgId,
      handoffId: handoff!.id,
      actorUserId: memberB,
      decision: 'accept',
    });
    const oldApproval = listOrganizationWorkApprovals(orgId).find(item => item.id === routed.approval!.id);
    expect(oldApproval?.status).toBe('expired');
    expect(() => decideOrganizationWorkApproval({
      orgId,
      approvalId: routed.approval!.id,
      actorUserId: ownerId,
      decision: 'approve',
    })).toThrow(/terminal decision/i);
  });

  it('persists routing records and position skill metadata to SQLite', async () => {
    await flushDBOrThrow();
    const workRows = await querySQL<any>(
      'SELECT * FROM org_work_items WHERE orgId = ? ORDER BY createdAt ASC',
      [orgId],
    );
    const positionRows = await querySQL<any>('SELECT * FROM org_positions WHERE orgId = ?', [orgId]);
    expect(workRows.length).toBeGreaterThanOrEqual(3);
    const persistedPosition = positionRows.find(row => row.id === positionId);
    expect(persistedPosition).toBeTruthy();
    expect(JSON.parse(persistedPosition.payload).skillTags).toContain('contract-review');
    await closeDatabase();
    await initDatabase();
    expect(listOrganizationWorkApprovals(orgId).some(item => item.status === 'approved')).toBe(true);
    expect(getOrganizationWorkItem(orgId, workRows[0].id)?.orgId).toBe(orgId);
  });
});
