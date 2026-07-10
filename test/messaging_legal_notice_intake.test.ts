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
    if (!toolRegistry.get('legal_process_notice_link')) {
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

      expect(reply).toContain('已收到飞书转发的法院短信链接');
      expect(reply).toContain('已读取或下载并保存留痕');
      expect(reply).toContain('上海市黄浦区人民法院');

      const cases = LegalCases.listCases(orgId, '沪0101民初123号', 3);
      expect(cases.length).toBeGreaterThan(0);
      const caseFile = cases[0];
      expect(caseFile.court).toContain('上海市黄浦区人民法院');
      expect(caseFile.materials.some(material =>
        material.title.includes('微信/飞书转发法院短信原文')
        && material.content.includes('court.example.test'),
      )).toBe(true);
      expect(caseFile.materials.some(material =>
        material.title.includes('微信/飞书转发法院通知链接材料')
        && material.content.includes('开庭通知'),
      )).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
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
