import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { toolRegistry } from '../server/tools/registry';
import { registerLegalTools } from '../server/tools/definitions/legal_tools';
import { handleRemoteLegalNoticeIntake } from '../server/messaging/legal_notice_intake';
import * as LegalCases from '../server/org/legal_cases';
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
    const orgId = `remote-legal-notice-${Date.now()}`;
    const userId = 'remote-lawyer';
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
        text: '【人民法院】上海市黄浦区人民法院通知：（2026）沪0101民初123号将于2026年7月15日开庭，请查看 https://court.example.test/notice/123',
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
    const orgId = `remote-legal-message-${Date.now()}`;
    const userId = 'remote-lawyer';

    const reply = await handleRemoteLegalNoticeIntake(message({
      platform: 'wechat',
      userName: '阿陆',
      boundOrgId: orgId,
      boundUserId: userId,
      text: '请发给 Lumi 入案：张三诉李四买卖合同纠纷，证据有合同、送货单、微信催款记录，后续需要整理起诉材料。',
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
  });

  it('asks unbound WeChat users to bind before writing legal notice links into cases', async () => {
    const reply = await handleRemoteLegalNoticeIntake(message({
      platform: 'wechat',
      text: '【人民法院】你有一份开庭通知，请查看 https://court.example.test/notice/456',
    }));

    expect(reply).toContain('识别到这是一条法院短信/通知链接');
    expect(reply).toContain('绑定 Lumi');
  });

  it('asks unbound WeCom users to bind before writing legal notice links into cases', async () => {
    const reply = await handleRemoteLegalNoticeIntake(message({
      platform: 'wecom',
      text: '【人民法院】你有一份送达通知，请查看 https://court.example.test/notice/789',
    }));

    expect(reply).toContain('当前企微账号还没有绑定');
    expect(reply).toContain('绑定 Lumi');
  });
});
