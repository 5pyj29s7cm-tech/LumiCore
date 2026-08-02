import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, flushDBOrThrow, initDatabase, querySQL, readDB, writeDB } from '../db_layer';
import {
  addMember,
  createDepartment,
  createOrg,
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
  let legalAgentId = '';

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
    legalAgentId = `legal-agent-${suffix}`;
    db.agents.push({
      id: legalAgentId,
      ownerUid: ownerId,
      userId: ownerId,
      name: 'Legal Worker',
      category: 'analysis',
      data: '{}',
      config: '{}',
      status: 'active',
      personalityId: 'lumi',
      modelPreference: '',
      memoryScope: 'shared',
      autonomyLevel: 'reactive',
      runtimeConfig: '{}',
      runtime: 'internal',
      domain: 'work',
      orgId,
      createdAt: new Date().toISOString(),
      skillTags: ['legal', 'contract-review'],
      knowledgeDomains: ['contract-review'],
      healthStatus: 'online',
    });
    writeDB(db);
  });

  it('routes a Feishu request to a department, position, multiple members, skills, and an exact organization agent', () => {
    const position = createOrganizationPosition({
      orgId,
      actorUserId: ownerId,
      departmentId,
      name: 'Contract Review Lead',
      description: 'Owns contract review work.',
      skillTags: ['contract-review'],
      memberIds: [memberA, memberB],
      agentIds: [legalAgentId],
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
      assignedAgentIds: [legalAgentId],
      status: 'assigned',
    });
    expect(first.workItem.collaboratorMemberIds).toContain(memberB);
    expect(first.workItem.skillTags).toContain('contract-review');
  });

  it('binds external commits to immutable organization approval and resumes the same task without duplication', () => {
    const routed = routeOrganizationWork({
      orgId,
      requesterUserId: memberA,
      source: 'feishu_bot',
      platform: 'feishu',
      requestId: `feishu:${suffix}:approval`,
      idempotencyKey: `feishu-work-${suffix}:approval`,
      text: 'Publish the approved notice externally.',
      intentKind: 'public_publish',
      operation: 'mutate',
      sideEffectClass: 'external_commit',
      conversationId: `conversation-${suffix}`,
      taskId: `task-${suffix}:approval`,
      targetAgentIds: [legalAgentId],
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
    expect(decision?.workItem.status).toBe('assigned');

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
    expect(continued.workItem.status).toBe('assigned');
    expect(listOrganizationWorkItems(orgId, { taskId: `task-${suffix}:approval` })).toHaveLength(1);
  });

  it('stops agents for accepted human takeover and can explicitly return the item to an agent', () => {
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
      targetAgentIds: [legalAgentId],
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
      assignedAgentIds: [],
    });
    expect(() => setOrganizationWorkItemExecutionStatus({
      orgId,
      workItemId: routed.workItem.id,
      status: 'executing',
      actorUserId: memberA,
    })).toThrow(/owned by a human/i);

    const returnHandoff = requestOrganizationWorkHandoff({
      orgId,
      workItemId: routed.workItem.id,
      actorUserId: memberB,
      type: 'return_to_agent',
      targetAgentIds: [legalAgentId],
      reason: 'Human review finished; return automation to the verified worker.',
    });
    const returned = decideOrganizationWorkHandoff({
      orgId,
      handoffId: returnHandoff!.id,
      actorUserId: ownerId,
      decision: 'accept',
    });
    expect(returned?.workItem).toMatchObject({
      status: 'assigned',
      humanOwnerUserId: null,
      assignedAgentIds: [legalAgentId],
    });
    expect(listOrganizationWorkHandoffs(orgId, routed.workItem.id)).toHaveLength(2);
  });

  it('rejects cross-organization agent targets', () => {
    const otherOwner = `other-owner-${suffix}`;
    const otherOrg = createOrg(`Other Org ${suffix}`, `other-routing-${suffix}`, otherOwner);
    addMember(otherOrg.id, otherOwner, 'owner');
    const db = readDB();
    const foreignAgentId = `foreign-agent-${suffix}`;
    db.agents.push({
      id: foreignAgentId,
      ownerUid: otherOwner,
      name: 'Foreign Worker',
      category: 'analysis',
      data: '{}',
      status: 'active',
      domain: 'work',
      orgId: otherOrg.id,
      runtime: 'internal',
      createdAt: new Date().toISOString(),
      skillTags: ['legal'],
    });
    writeDB(db);

    expect(() => routeOrganizationWork({
      orgId,
      requesterUserId: memberA,
      source: 'feishu_bot',
      requestId: `feishu:${suffix}:foreign`,
      text: 'Route this across organizations.',
      intentKind: 'none',
      operation: 'read',
      sideEffectClass: 'none',
      targetAgentIds: [foreignAgentId],
    })).toThrow(/outside this organization/i);
  });

  it('expires an old approval when a handoff changes the immutable work-item target', () => {
    const routed = routeOrganizationWork({
      orgId,
      requesterUserId: memberA,
      source: 'feishu_bot',
      requestId: `feishu:${suffix}:approval-expiry`,
      text: 'Publish this target-changing notice.',
      intentKind: 'public_publish',
      operation: 'mutate',
      sideEffectClass: 'external_commit',
      taskId: `task-${suffix}:approval-expiry`,
      targetAgentIds: [legalAgentId],
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

  it('persists routing records and organization agent skill metadata to SQLite', async () => {
    await flushDBOrThrow();
    const workRows = await querySQL<any>(
      'SELECT * FROM org_work_items WHERE orgId = ? ORDER BY createdAt ASC',
      [orgId],
    );
    const positionRows = await querySQL<any>('SELECT * FROM org_positions WHERE orgId = ?', [orgId]);
    const agentRows = await querySQL<any>('SELECT skillTags, knowledgeDomains FROM agents WHERE id = ?', [legalAgentId]);
    expect(workRows.length).toBeGreaterThanOrEqual(3);
    expect(positionRows.some(row => row.id === positionId)).toBe(true);
    expect(JSON.parse(agentRows[0].skillTags)).toContain('contract-review');
    expect(JSON.parse(agentRows[0].knowledgeDomains)).toContain('contract-review');
    await closeDatabase();
    await initDatabase();
    expect(listOrganizationWorkApprovals(orgId).some(item => item.status === 'approved')).toBe(true);
    expect(getOrganizationWorkItem(orgId, workRows[0].id)?.orgId).toBe(orgId);
    expect(readDB().agents.find((item: any) => item.id === legalAgentId)).toMatchObject({
      skillTags: expect.arrayContaining(['contract-review']),
      knowledgeDomains: expect.arrayContaining(['contract-review']),
    });
  });
});
