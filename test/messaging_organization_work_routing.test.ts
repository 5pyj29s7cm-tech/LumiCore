import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB, writeDB } from '../db_layer';
import type { IncomingMessage } from '../server/messaging/types';
import {
  authorizeMessagingGroup,
  consumeBindingCode,
  createBindingCode,
  resetMessagingBindingsForTest,
} from '../server/messaging/bindings';
import { addMember, createDepartment, createOrg } from '../server/org/db';
import {
  createOrganizationPosition,
  createOrganizationWorkRoutingRule,
  decideOrganizationWorkApproval,
  listOrganizationWorkItems,
} from '../server/org/work_routing';
import { processWithPersonality } from '../server/regions/packs/cn/messaging_routes';

describe('remote organization work routing integration', () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ownerId = `remote-routing-owner-${suffix}`;
  const memberA = `remote-routing-member-a-${suffix}`;
  const memberB = `remote-routing-member-b-${suffix}`;
  let orgId = '';
  let agentId = '';

  function message(
    text: string,
    messageId: string,
    mentionedUserIds: string[] = [],
    senderUserId = memberA,
  ): IncomingMessage {
    return {
      platform: 'feishu',
      userId: `ou-${senderUserId}`,
      userName: senderUserId === ownerId ? 'Remote Owner' : 'Remote Member A',
      chatId: `oc-${suffix}`,
      chatType: 'group',
      botMentioned: true,
      mentionedUserIds,
      messageId,
      text,
      boundUserId: senderUserId,
      boundOrgId: orgId,
      raw: {},
      timestamp: new Date().toISOString(),
    };
  }

  beforeAll(async () => {
    await initDatabase();
    resetMessagingBindingsForTest();
    const org = createOrg(`Remote Routing ${suffix}`, `remote-routing-${suffix}`, ownerId);
    orgId = org.id;
    addMember(orgId, ownerId, 'owner');
    addMember(orgId, memberA, 'member');
    addMember(orgId, memberB, 'member');
    const department = createDepartment(orgId, 'Contract Team');
    const db = readDB();
    for (const membership of db.orgMemberships.filter((item: any) => item.orgId === orgId)) {
      if ([memberA, memberB].includes(membership.userId)) membership.departmentId = department.id;
    }
    agentId = `remote-legal-agent-${suffix}`;
    db.agents.push({
      id: agentId,
      ownerUid: ownerId,
      userId: ownerId,
      name: 'Remote Legal Worker',
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
      skillTags: ['contract-review'],
      knowledgeDomains: ['contract-review'],
      healthStatus: 'online',
    });
    writeDB(db);
    const position = createOrganizationPosition({
      orgId,
      actorUserId: ownerId,
      departmentId: department.id,
      name: 'Contract Review',
      skillTags: ['contract-review'],
      memberIds: [memberA, memberB],
      agentIds: [agentId],
    });
    createOrganizationWorkRoutingRule({
      orgId,
      actorUserId: ownerId,
      name: 'Feishu contract review',
      priority: 100,
      platforms: ['feishu'],
      keywords: ['contract-review'],
      positionId: position.id,
      approvalMode: 'none',
    });
    createOrganizationWorkRoutingRule({
      orgId,
      actorUserId: ownerId,
      name: 'Explicit Feishu administrator approval',
      priority: 110,
      platforms: ['feishu'],
      keywords: ['approval-required'],
      positionId: position.id,
      approvalMode: 'admin',
    });
    for (const [lumiUserId, platformUserId] of [
      [memberB, `ou-${memberB}`],
      [ownerId, `ou-${ownerId}`],
    ]) {
      const code = createBindingCode('feishu', lumiUserId, orgId, 'work');
      expect(consumeBindingCode('feishu', code.code, platformUserId, `private-${platformUserId}`, 'private')).toBeTruthy();
    }
    authorizeMessagingGroup({
      platform: 'feishu',
      chatId: `oc-${suffix}`,
      orgId,
      createdBy: ownerId,
      allowedPlatformUserIds: [`ou-${memberA}`, `ou-${memberB}`, `ou-${ownerId}`],
    });
  });

  it('creates and completes one durable work item around a bound callback without bypassing organization routing', async () => {
    const messageId = `remote-route-${suffix}`;
    let callbackCalls = 0;
    const reply = await processWithPersonality(
      message('Please complete contract-review for the organization.', messageId),
      {
        onMessage: async () => {
          callbackCalls += 1;
          return { platform: 'feishu', text: 'Contract review callback completed.' };
        },
      },
    );
    expect(reply).toBe('Contract review callback completed.');
    expect(callbackCalls).toBe(1);
    const items = listOrganizationWorkItems(orgId).filter(item => item.requestId === `feishu_bot:${messageId}`);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      status: 'completed',
      assignedMemberId: memberA,
      assignedAgentIds: [agentId],
    });
    expect(items[0].collaboratorMemberIds).toContain(memberB);
    expect(items[0].taskId).toBeTruthy();
    const db = readDB();
    const task = db.conversationActionTasks.find((item: any) => item.id === items[0].taskId);
    expect(task).toBeTruthy();
    expect(JSON.parse(task.context).executionPlan).toBeTruthy();
  });

  it('never lets the legacy callback execute an external commit after administrator approval', async () => {
    const requestId = `remote-approval-${suffix}`;
    let callbackCalls = 0;
    const blockedReply = await processWithPersonality(
      message('Publish this approval-required notice to the public website.', requestId),
      {
        onMessage: async () => {
          callbackCalls += 1;
          return { platform: 'feishu', text: 'Published callback must not run before approval.' };
        },
      },
    );
    expect(blockedReply).toContain('等待组织管理员审批');
    expect(callbackCalls).toBe(0);
    const [workItem] = listOrganizationWorkItems(orgId).filter(item => item.requestId === `feishu_bot:${requestId}`);
    expect(workItem.status).toBe('waiting_approval');
    const approval = readDB().orgWorkApprovals.find((item: any) => item.id === workItem.approvalId);
    expect(approval.status).toBe('pending');
    decideOrganizationWorkApproval({
      orgId,
      approvalId: approval.id,
      actorUserId: ownerId,
      decision: 'approve',
      reason: 'Approved for this immutable work item revision.',
    });

    const continuedReply = await processWithPersonality(
      message('continue', `${requestId}-continue`),
      {
        onMessage: async () => {
          callbackCalls += 1;
          return { platform: 'feishu', text: 'Approved work resumed.' };
        },
      },
    );
    expect(continuedReply).toContain('not complete');
    expect(continuedReply).toContain('no verified terminal receipt');
    expect(callbackCalls).toBe(0);
    const sameTaskItems = listOrganizationWorkItems(orgId, { taskId: workItem.taskId });
    expect(sameTaskItems).toHaveLength(1);
    expect(sameTaskItems[0]).toMatchObject({
      id: workItem.id,
      status: 'blocked',
      lastBlocker: 'The external commit has no verified terminal receipt.',
    });
  });

  it('skips redundant organization self-approval without allowing the legacy callback to commit', async () => {
    const requestId = `remote-owner-no-approval-${suffix}`;
    let callbackCalls = 0;
    const reply = await processWithPersonality(
      message('Publish this approval-required owner notice to the public website.', requestId, [], ownerId),
      {
        onMessage: async () => {
          callbackCalls += 1;
          return { platform: 'feishu', text: 'Owner-authorized callback ran.' };
        },
      },
    );

    expect(reply).not.toContain('等待组织管理员审批');
    expect(reply).toContain('no verified terminal receipt');
    expect(callbackCalls).toBe(0);
    const [workItem] = listOrganizationWorkItems(orgId).filter(item => item.requestId === `feishu_bot:${requestId}`);
    expect(workItem.approvalId).toBeNull();
    expect(workItem.status).not.toBe('waiting_approval');
  });

  it('runs deterministic organization knowledge commands inside the same task and receipt route', async () => {
    const messageId = `remote-kb-${suffix}`;
    const reply = await processWithPersonality(
      message('查询组织知识库 no-such-routing-article', messageId),
      {
        llmGetters: {
          getDeepSeek: () => { throw new Error('deterministic organization command must not call a model'); },
          getGemini: () => { throw new Error('deterministic organization command must not call a model'); },
        },
      },
    );
    expect(reply).toContain('组织知识库');
    const [item] = listOrganizationWorkItems(orgId).filter(candidate => candidate.requestId === `feishu_bot:${messageId}`);
    expect(item).toMatchObject({ status: 'completed', source: 'feishu_bot' });
    const db = readDB();
    const receipt = db.conversationActionReceipts.find((candidate: any) => (
      candidate.taskId === item.taskId && candidate.toolName === 'organization_business_command'
    ));
    expect(receipt).toMatchObject({ outcome: 'verified_success' });
  });

  it('maps multiple Feishu mentions to exact bound organization members without cross-identity guessing', async () => {
    const messageId = `remote-mentions-${suffix}`;
    const reply = await processWithPersonality(
      message(
        'Please complete contract-review with the mentioned organization members.',
        messageId,
        [`ou-${memberB}`, `ou-${ownerId}`, 'ou-unbound-outsider'],
      ),
      {
        onMessage: async () => ({ platform: 'feishu', text: 'Mentioned-member route completed.' }),
      },
    );
    expect(reply).toBe('Mentioned-member route completed.');
    const [item] = listOrganizationWorkItems(orgId).filter(candidate => candidate.requestId === `feishu_bot:${messageId}`);
    expect(item.assignedMemberId).toBe(memberB);
    expect(item.collaboratorMemberIds).toContain(ownerId);
    expect(item.collaboratorMemberIds).not.toContain('ou-unbound-outsider');
    expect(item.assignedAgentIds).toContain(agentId);
  });
});
