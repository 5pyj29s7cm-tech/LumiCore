import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { toolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import {
  classifyRemoteLegalNoticeIntakeIntent,
  handleRemoteLegalNoticeIntake,
} from '../server/messaging/legal_notice_intake';
import * as LegalCases from '../server/org/legal_cases';
import { addMember, createOrg } from '../server/org/db';
import { readDB } from '../db_layer';
import type { IncomingMessage } from '../server/messaging/types';

function message(partial: Partial<IncomingMessage>): IncomingMessage {
  return {
    platform: 'feishu',
    userId: 'ou_test',
    userName: 'Tester',
    chatId: 'oc_test',
    chatType: 'private',
    messageId: `msg_${Date.now()}`,
    text: '',
    raw: {},
    timestamp: new Date().toISOString(),
    ...partial,
  };
}

describe('remote messaging legal notice intake', () => {
  let cleanup = () => {};

  beforeAll(async () => {
    const app = await makeApp();
    cleanup = app.cleanup;
    if (!toolRegistry.get('legal_process_notice_link') || !toolRegistry.get('legal_message_intake_to_case')) {
      registerLegalTools(toolRegistry);
    }
  });

  afterAll(() => cleanup());

  it('archives forwarded Feishu court SMS links into the bound legal case workspace', async () => {
    const userId = 'remote-lawyer';
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const orgId = createOrg('Remote Legal Notice', `remote-legal-notice-${suffix}`, userId).id;
    addMember(orgId, userId, 'owner');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html><body>上海市黄浦区人民法院 开庭通知 （2026）沪0101民初123号 2026年7月15日开庭。</body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    try {
      const reply = await handleRemoteLegalNoticeIntake(message({
        boundOrgId: orgId,
        boundUserId: userId,
        text: '请建案并归档以下通知：【人民法院】上海市黄浦区人民法院通知：（2026）沪0101民初123号将于2026年7月15日开庭，请查看 https://court.example.test/notice/123',
      }));

      expect(reply).toContain('远程法律消息已入案');
      expect(reply).toContain('平台：飞书');
      expect(reply).toContain('链接已读取/下载并保存留痕');
      expect(reply).toContain('案件闭环状态');
      expect(reply).toContain('上海市黄浦区人民法院');

      const cases = LegalCases.listCases(orgId, '沪0101民初123号', 3);
      expect(cases.length).toBeGreaterThan(0);
      const caseFile = cases[0];
      expect(caseFile.court).toContain('上海市黄浦区人民法院');
      expect(caseFile.materials.some(material =>
        material.title.includes('飞书法律消息原文')
        && material.content.includes('court.example.test'),
      )).toBe(true);
      expect(caseFile.materials.some(material =>
        material.title.includes('远程消息链接材料')
        && material.content.includes('开庭通知'),
      )).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('archives explicit bound WeChat legal intake messages even without a notice link', async () => {
    const userId = 'remote-lawyer';
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const orgId = createOrg('Remote Legal Message', `remote-legal-message-${suffix}`, userId).id;
    addMember(orgId, userId, 'owner');

    const reply = await handleRemoteLegalNoticeIntake(message({
      platform: 'wechat',
      userName: '阿陆',
      boundOrgId: orgId,
      boundUserId: userId,
      text: '请发给 Lumi 入案：张三诉李四买卖合同纠纷，证据有合同、送货单、微信催款记录，后续需要整理起诉材料。',
      attachments: [{
        id: 'wechat-case-file',
        type: 'file',
        fileName: '送货单.pdf',
        localPath: 'D:\\lumi-data\\messaging\\wechat\\送货单.pdf',
        extractedText: '送货单编号 SH-2026-07，收货人李四。',
      }],
    }));

    expect(reply).toContain('远程法律消息已入案');
    expect(reply).toContain('平台：微信');
    expect(reply).toContain('发送人：阿陆');
    expect(reply).toContain('案件闭环状态');

    const cases = LegalCases.listCases(orgId, '买卖合同纠纷', 3);
    expect(cases.length).toBeGreaterThan(0);
    expect(cases[0].materials.some(material =>
      material.title.includes('微信法律消息原文')
      && material.content.includes('微信催款记录'),
    )).toBe(true);
    expect(cases[0].materials.some(material =>
      material.title === '远程附件：送货单.pdf'
      && material.localPath?.endsWith('送货单.pdf')
      && material.content.includes('SH-2026-07')
      && material.source === 'wechat',
    )).toBe(true);
  });

  it('lets a personal WeChat Lumi enter its unique organization case and create a scoped hearing reminder', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userId = `personal-wechat-lawyer-${suffix}`;
    const orgId = createOrg('Personal WeChat Law Firm', `personal-wechat-law-${suffix}`, userId).id;
    addMember(orgId, userId, 'owner');
    const caseNumber = '（2027）沪0101民初321号';
    const caseFile = LegalCases.createCase(orgId, userId, {
      title: '张三诉李四买卖合同纠纷',
      caseNumber,
      stage: 'filing',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(`<html><body>上海市黄浦区人民法院 ${caseNumber} 开庭时间：2027年8月15日 09:30</body></html>`, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    try {
      const incoming = message({
        platform: 'wechat',
        userId: 'wechat-personal-owner',
        chatId: 'wechat-personal-owner',
        boundUserId: userId,
        text: `请归档到已有案件：【人民法院】${caseNumber} 有新的开庭通知，请查看 https://court.example.test/notice/personal-321`,
      });
      const reply = await handleRemoteLegalNoticeIntake(incoming);

      expect(reply).toContain('远程法律消息已入案');
      expect(reply).toContain(`案件ID：${caseFile.id}`);
      expect(reply).toContain('案件提醒：已生成/更新');
      expect(incoming.boundOrgId).toBe(orgId);
      const refreshed = LegalCases.getCase(orgId, caseFile.id)!;
      expect(refreshed.hearingDate).toBe('2027-08-15 09:30');
      expect(refreshed.materials.some(material => material.content.includes('court.example.test/notice/personal-321'))).toBe(true);

      const db = readDB();
      const reminder = (db.reminders || []).find((item: any) =>
        item.userId === userId
        && item.orgId === orgId
        && item.domain === 'work'
        && String(item.sourceInteractionId || '').includes(caseFile.id),
      );
      expect(reminder?.content).toContain('开庭');
      expect((db.notifications || []).some((item: any) =>
        item.userId === userId && item.type === 'legal_notice' && item.message.includes('2027-08-15 09:30'),
      )).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('does not mistake the WeChat attachment system prompt for a legal intake request', async () => {
    const reply = await handleRemoteLegalNoticeIntake(message({
      platform: 'wechat',
      boundUserId: `personal-music-${Date.now()}`,
      text: [
        '帮我看看这个歌单。',
        '',
        '以下是用户通过个人微信发送的真实附件内容。个人绑定的附件保持在个人域；只有法院通知唯一匹配到组织案件时才可跨域归档。',
        '## 附件：周末歌单.txt',
        '解析文本：爵士、民谣、轻音乐',
      ].join('\n'),
      attachments: [{
        id: 'music-list',
        type: 'file',
        fileName: '周末歌单.txt',
        extractedText: '爵士、民谣、轻音乐',
      }],
    }));

    expect(reply).toBeNull();
  });

  it('keeps legal-looking attachments read-only when the user only asks for analysis', async () => {
    const userId = `read-only-legal-${Date.now()}`;
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const orgId = createOrg('Read Only Attachment', `read-only-attachment-${suffix}`, userId).id;
    addMember(orgId, userId, 'owner');
    const before = LegalCases.listCases(orgId, '', 20, userId).length;

    const reply = await handleRemoteLegalNoticeIntake(message({
      platform: 'wechat',
      boundUserId: userId,
      boundOrgId: orgId,
      text: '分析一下这份附件',
      attachments: [{
        id: 'dispatch-letter',
        type: 'file',
        fileName: '派遣函-灵序科技.pdf',
        extractedText: '某人民法院案件材料，包含案号（2026）沪0101民初888号。',
      }],
    }));

    expect(reply).toBeNull();
    expect(LegalCases.listCases(orgId, '', 20, userId)).toHaveLength(before);

    const syntheticAttachmentLabel = await handleRemoteLegalNoticeIntake(message({
      platform: 'wechat',
      boundUserId: userId,
      boundOrgId: orgId,
      text: '[附件] 新建案件流程-法院材料.pdf',
      attachments: [{
        id: 'synthetic-attachment-label',
        type: 'file',
        fileName: '新建案件流程-法院材料.pdf',
        extractedText: '某人民法院案件材料，包含案号（2026）沪0101民初889号。',
      }],
    }));
    expect(syntheticAttachmentLabel).toBeNull();
    expect(LegalCases.listCases(orgId, '', 20, userId)).toHaveLength(before);

    const explicitlyReadOnly = await handleRemoteLegalNoticeIntake(message({
      platform: 'wechat',
      boundUserId: userId,
      boundOrgId: orgId,
      text: '不要归档，也不要建案，只分析附件',
      attachments: [{
        id: 'dispatch-letter-read-only',
        type: 'file',
        fileName: '派遣函-灵序科技.pdf',
        extractedText: '某人民法院案件材料，包含案号（2026）沪0101民初888号。',
      }],
    }));
    expect(explicitlyReadOnly).toBeNull();
    expect(LegalCases.listCases(orgId, '', 20, userId)).toHaveLength(before);
  });

  it('archives into an existing case but never creates one from archive wording alone', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userId = `archive-existing-only-${suffix}`;
    const orgId = createOrg('Archive Existing Only', `archive-existing-${suffix}`, userId).id;
    addMember(orgId, userId, 'owner');
    const missingCaseNumber = '（2026）沪0101民初901号';

    const missingReply = await handleRemoteLegalNoticeIntake(message({
      platform: 'wechat',
      boundUserId: userId,
      boundOrgId: orgId,
      text: `请归档这份法院通知，案号${missingCaseNumber}`,
      attachments: [{
        id: 'archive-missing-case',
        type: 'file',
        fileName: '法院通知.pdf',
        extractedText: `上海市黄浦区人民法院送达通知，案号${missingCaseNumber}`,
      }],
    }));

    expect(missingReply).toContain('没有创建新案件');
    expect(LegalCases.listCases(orgId, '', 20, userId)).toHaveLength(0);

    const existingCaseNumber = '（2026）沪0101民初902号';
    const existing = LegalCases.createCase(orgId, userId, {
      title: '甲公司诉乙公司合同纠纷',
      caseNumber: existingCaseNumber,
      stage: 'filing',
    });
    const beforeMaterials = existing.materials.length;
    const archivedReply = await handleRemoteLegalNoticeIntake(message({
      platform: 'wechat',
      boundUserId: userId,
      boundOrgId: orgId,
      text: `请归档到已有案件，案号${existingCaseNumber}`,
      attachments: [{
        id: 'archive-existing-case',
        type: 'file',
        fileName: '补充送达通知.pdf',
        extractedText: `上海市黄浦区人民法院补充送达通知，案号${existingCaseNumber}`,
      }],
    }));

    expect(archivedReply).toContain(`案件ID：${existing.id}`);
    expect(LegalCases.getCase(orgId, existing.id, userId)!.materials.length).toBeGreaterThan(beforeMaterials);
    expect(LegalCases.listCases(orgId, '', 20, userId)).toHaveLength(1);
  });

  it('requires unambiguous creation wording instead of treating open as create', () => {
    expect(classifyRemoteLegalNoticeIntakeIntent('open the attached case file and analyze it')).toBe('none');
    expect(classifyRemoteLegalNoticeIntakeIntent('create a new case and archive this notice')).toBe('create_case');
    expect(classifyRemoteLegalNoticeIntakeIntent('不要归档，也不要建案，只分析附件')).toBe('none');
    expect(classifyRemoteLegalNoticeIntakeIntent('不要分析，直接建案并归档')).toBe('create_case');
  });

  it('asks unbound WeChat users to bind before writing legal notice links into cases', async () => {
    const reply = await handleRemoteLegalNoticeIntake(message({
      platform: 'wechat',
      text: '请归档：【人民法院】你有一份开庭通知，请查看 https://court.example.test/notice/456',
    }));

    expect(reply).toContain('识别到这是一条法院短信/通知链接');
    expect(reply).toContain('绑定 Lumi');
  });

  it('asks unbound WeCom users to bind before writing legal notice links into cases', async () => {
    const reply = await handleRemoteLegalNoticeIntake(message({
      platform: 'wecom',
      text: '请归档：【人民法院】你有一份送达通知，请查看 https://court.example.test/notice/789',
    }));

    expect(reply).toContain('当前企微账号还没有绑定');
    expect(reply).toContain('绑定 Lumi');
  });
});
