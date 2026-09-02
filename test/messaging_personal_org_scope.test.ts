import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApp } from './helpers';
import { addMember, createOrg } from '../server/org/db';
import * as LegalCases from '../server/org/legal_cases';
import * as OrgKB from '../server/org/kb';
import {
  requestsOrganizationScope,
  resetPersonalOrganizationScopesForTest,
  resolvePersonalOrganizationScope,
} from '../server/messaging/personal_org_scope';
import {
  classifyRemoteCaseAttachmentWriteIntent,
  dispatchIncomingMessage,
  handleRemoteOrgCommand,
} from '../server/messaging/routes';
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

    const readOnlyAnalysis = await handleRemoteOrgCommand(message(viewerId, '不要归档到知识库，只分析附件', {
      boundOrgId: org.id,
      attachments: [{
        id: 'viewer-analysis-only',
        type: 'file',
        fileName: '现有材料.txt',
        extractedText: '仅供本轮分析的材料。',
      }],
    }));
    expect(readOnlyAnalysis).toBeNull();
    expect(OrgKB.listArticles(org.id, undefined, viewerId)).toHaveLength(0);
  });

  it('does not archive an attachment when an owner explicitly rejects the write', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userId = `scope-no-write-${suffix}`;
    const org = createOrg('No Write Analysis', `no-write-analysis-${suffix}`, userId);
    addMember(org.id, userId, 'owner');

    const reply = await handleRemoteOrgCommand(message(userId, '不要归档到知识库，也不要保存，只分析附件', {
      boundOrgId: org.id,
      attachments: [{
        id: 'owner-analysis-only',
        type: 'file',
        fileName: '只读材料.txt',
        extractedText: '这份内容只能用于分析。',
      }],
    }));

    expect(reply).toBeNull();
    expect(OrgKB.listArticles(org.id, undefined, userId)).toHaveLength(0);
    expect(classifyRemoteCaseAttachmentWriteIntent('不要归档旧材料，另请新建案件并加入这份附件')).toBe('create_case');
  });

  it('requires an explicit case write instruction before an attachment can create or change a case', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userId = `attachment-analysis-${suffix}`;
    const org = createOrg('Attachment Analysis Firm', `attachment-analysis-${suffix}`, userId);
    addMember(org.id, userId, 'owner');
    const incoming = message(userId, '分析一下这份附件', {
      boundOrgId: org.id,
      attachments: [{
        id: 'dispatch-letter',
        type: 'file',
        fileName: '派遣函-灵序科技.pdf',
        extractedText: '某法院案件材料，案号（2026）沪0101民初888号。',
      }],
    });

    expect(await handleRemoteOrgCommand(incoming)).toBeNull();
    expect(LegalCases.listCases(org.id, '', 20, userId)).toHaveLength(0);

    const missingTarget = await handleRemoteOrgCommand({
      ...incoming,
      messageId: `${incoming.messageId}-missing-target`,
      text: '把附件归档到案件：不存在的案件',
    });
    expect(missingTarget).toContain('没有创建新案件');
    expect(LegalCases.listCases(org.id, '', 20, userId)).toHaveLength(0);

    const explicitlyCreated = await handleRemoteOrgCommand({
      ...incoming,
      messageId: `${incoming.messageId}-create`,
      text: '新建案件并归档这份附件',
    });
    expect(explicitlyCreated).toContain('已创建组织案件');
    expect(LegalCases.listCases(org.id, '', 20, userId)).toHaveLength(1);
  });

  it('archives only to one reliable case identity and disambiguates multiple partial matches', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userId = `archive-disambiguation-${suffix}`;
    const org = createOrg('Archive Disambiguation', `archive-disambiguation-${suffix}`, userId);
    addMember(org.id, userId, 'owner');
    const attachment = {
      id: 'archive-disambiguation-file',
      type: 'file' as const,
      fileName: '补充证据.pdf',
      extractedText: '补充证据正文。',
    };

    const exact = LegalCases.createCase(org.id, userId, {
      title: '张三诉李四（合同纠纷）',
      caseNumber: '（2026）沪0101民初1001号',
      stage: 'filing',
    });
    const exactBefore = exact.materials.length;
    const exactReply = await handleRemoteOrgCommand(message(userId, '把附件归档到案件：张三诉李四合同纠纷', {
      boundOrgId: org.id,
      attachments: [attachment],
    }));
    expect(exactReply).toContain(`案件：${exact.title}`);
    expect(LegalCases.getCase(org.id, exact.id, userId)!.materials).toHaveLength(exactBefore + 1);

    const firstAmbiguous = LegalCases.createCase(org.id, userId, {
      title: '甲乙合同纠纷一审',
      caseNumber: '（2026）沪0101民初1002号',
      stage: 'filing',
    });
    const secondAmbiguous = LegalCases.createCase(org.id, userId, {
      title: '甲乙合同纠纷二审',
      caseNumber: '（2026）沪01民终1003号',
      stage: 'trial',
    });
    const firstBefore = firstAmbiguous.materials.length;
    const secondBefore = secondAmbiguous.materials.length;
    const ambiguousReply = await handleRemoteOrgCommand(message(userId, '把附件归档到案件：甲乙合同纠纷', {
      boundOrgId: org.id,
      attachments: [{ ...attachment, id: 'ambiguous-archive-file' }],
    }));

    expect(ambiguousReply).toContain('找到 2 个可能的已有案件');
    expect(ambiguousReply).toContain(firstAmbiguous.title);
    expect(ambiguousReply).toContain(secondAmbiguous.title);
    expect(LegalCases.getCase(org.id, firstAmbiguous.id, userId)!.materials).toHaveLength(firstBefore);
    expect(LegalCases.getCase(org.id, secondAmbiguous.id, userId)!.materials).toHaveLength(secondBefore);
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
