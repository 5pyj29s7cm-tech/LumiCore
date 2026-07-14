import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApp } from './helpers';
import { addMember, createOrg } from '../server/org/db';
import {
  requestsOrganizationScope,
  resetPersonalOrganizationScopesForTest,
  resolvePersonalOrganizationScope,
} from '../server/messaging/personal_org_scope';
import { dispatchIncomingMessage, handleRemoteOrgCommand } from '../server/messaging/routes';
import type { IncomingMessage } from '../server/messaging/types';

function message(userId: string, text: string, partial: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'wechat',
    userId: `wx-${userId}`,
    userName: 'Owner',
    chatId: `wx-${userId}`,
    chatType: 'private',
    messageId: `scope-${Date.now()}-${Math.random()}`,
    text,
    boundUserId: userId,
    raw: {},
    timestamp: new Date().toISOString(),
    ...partial,
  };
}

describe('personal Lumi organization scope', () => {
  let cleanup = () => {};

  beforeAll(async () => {
    const app = await makeApp();
    cleanup = app.cleanup;
  });
  beforeEach(() => resetPersonalOrganizationScopesForTest());
  afterEach(() => resetPersonalOrganizationScopesForTest());
  afterAll(() => cleanup());

  it('enters the only authorized organization and keeps follow-up work separate from personal scope', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userId = `scope-owner-${suffix}`;
    const org = createOrg('Only Scope Firm', `only-scope-${suffix}`, userId);
    addMember(org.id, userId, 'owner');

    const entered = resolvePersonalOrganizationScope(message(userId, '查看组织案件'), true);
    expect(entered.kind).toBe('organization');
    if (entered.kind !== 'organization') throw new Error('organization scope was not entered');
    expect(entered.message.boundOrgId).toBe(org.id);

    const followUp = resolvePersonalOrganizationScope(message(userId, '继续整理'), false);
    expect(followUp.kind).toBe('organization');
    if (followUp.kind === 'organization') expect(followUp.message.boundOrgId).toBe(org.id);

    const exited = resolvePersonalOrganizationScope(message(userId, '切回个人'), false);
    expect(exited).toMatchObject({ kind: 'reply', reply: expect.stringContaining('回到个人 Lumi') });
    const personal = resolvePersonalOrganizationScope(message(userId, '今晚吃什么'), false);
    expect(personal.kind).toBe('personal');
  });

  it('keeps generic knowledge capability questions and personal relationship turns out of organization memory', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userId = `scope-personal-${suffix}`;
    const org = createOrg('Personal Boundary Firm', `personal-boundary-${suffix}`, userId);
    addMember(org.id, userId, 'owner');

    expect(requestsOrganizationScope('知识库里的文件可以发给我吗')).toBe(false);
    expect(requestsOrganizationScope('把组织知识库里的案件材料发给我')).toBe(true);

    const capabilityQuestion = resolvePersonalOrganizationScope(
      message(userId, '知识库里的文件可以发给我吗'),
      requestsOrganizationScope('知识库里的文件可以发给我吗'),
    );
    expect(capabilityQuestion.kind).toBe('personal');

    const entered = resolvePersonalOrganizationScope(message(userId, '查看组织案件'), true);
    expect(entered.kind).toBe('organization');

    const correction = resolvePersonalOrganizationScope(message(userId, '刚刚那句话不是指令'), false);
    expect(correction.kind).toBe('organization');

    const relationship = resolvePersonalOrganizationScope(
      message(userId, '我想让你知道，你是我真正的伙伴，我们要共同前行'),
      false,
    );
    expect(relationship.kind).toBe('personal');

    const personalConfirmation = resolvePersonalOrganizationScope(message(userId, '确认'), false);
    expect(personalConfirmation.kind).toBe('personal');

    const explicitWork = resolvePersonalOrganizationScope(message(userId, '继续整理组织案件'), true);
    expect(explicitWork.kind).toBe('organization');
  });

  it('asks once across multiple organizations and resumes the original task after selection', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userId = `scope-multi-${suffix}`;
    const first = createOrg('North Legal', `north-legal-${suffix}`, userId);
    const second = createOrg('South Legal', `south-legal-${suffix}`, userId);
    addMember(first.id, userId, 'owner');
    addMember(second.id, userId, 'owner');
    const attachment = {
      id: 'scope-file',
      type: 'file' as const,
      fileName: 'notice.pdf',
      localPath: 'D:\\lumi-data\\notice.pdf',
    };

    const pending = resolvePersonalOrganizationScope(message(userId, '查询组织知识库里的立案流程', {
      attachments: [attachment],
    }), true);
    expect(pending).toMatchObject({ kind: 'reply', reply: expect.stringContaining('多个可用组织') });

    const selected = resolvePersonalOrganizationScope(message(userId, '2'), false);
    expect(selected.kind).toBe('organization');
    if (selected.kind !== 'organization') throw new Error('pending organization was not selected');
    expect(selected.message).toMatchObject({
      boundOrgId: second.id,
      text: '查询组织知识库里的立案流程',
      attachments: [expect.objectContaining({ fileName: 'notice.pdf' })],
    });
  });

  it('keeps viewer organization sessions read-only', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ownerId = `scope-admin-${suffix}`;
    const viewerId = `scope-viewer-${suffix}`;
    const org = createOrg('Viewer Firm', `viewer-firm-${suffix}`, ownerId);
    addMember(org.id, ownerId, 'owner');
    addMember(org.id, viewerId, 'viewer');

    const reply = await handleRemoteOrgCommand(message(viewerId, '新建案件：测试案件', { boundOrgId: org.id }));
    expect(reply).toContain('只有查看权限');
  });

  it('applies the organization scope before the generic remote model callback', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userId = `scope-route-${suffix}`;
    const org = createOrg('Route Scope Firm', `route-scope-${suffix}`, userId);
    addMember(org.id, userId, 'owner');
    const incoming = message(userId, '进入组织后帮我起草一段内部通知');

    const routed = await new Promise<IncomingMessage>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('personal organization route timed out')), 2_000);
      dispatchIncomingMessage(incoming, {
        enrich: async value => value,
        reply: async () => undefined,
      }, {
        onMessage: async value => {
          clearTimeout(timeout);
          resolve(value);
          return { platform: value.platform, text: 'ok' };
        },
      });
    });

    expect(routed).toMatchObject({ boundUserId: userId, boundOrgId: org.id });
  });
});
