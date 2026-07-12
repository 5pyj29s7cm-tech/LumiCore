import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import { addMember, createOrg } from '../server/org/db';
import { createBindingCode, consumeBindingCode, resetMessagingBindingsForTest } from '../server/messaging/bindings';
import { getMessagingConfig } from '../server/messaging/config';
import { FeishuAdapter } from '../server/messaging/feishu';
import { WeChatClawBotAdapter } from '../server/messaging/wechat-clawbot';
import { getActiveWeChatAdapter, setActiveWeChatAdapter } from '../server/messaging/wechat_runtime';
import {
  listFeishuFileTargets,
  listPersonalWeChatFileTargets,
  sendLocalFileToFeishu,
  sendLocalFileToPersonalWeChat,
} from '../server/messaging/file_transfer';
import { readDB } from '../db_layer';

describe('cross-workspace messaging file transfer', () => {
  let cleanup = () => {};

  beforeAll(async () => {
    const app = await makeApp();
    cleanup = app.cleanup;
    resetMessagingBindingsForTest();
  });

  afterAll(() => {
    resetMessagingBindingsForTest();
    cleanup();
  });

  it('sends a personal local file only to the member bound organization Feishu chat and audits it', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userId = `file-owner-${suffix}`;
    const orgId = createOrg('File Transfer Org', `file-transfer-${suffix}`, userId).id;
    addMember(orgId, userId, 'owner');
    const code = createBindingCode('feishu', userId, orgId);
    const binding = consumeBindingCode('feishu', code.code, 'ou-file-owner', 'oc-file-target', 'group')!;
    const filePath = path.join(os.tmpdir(), `lumi-file-transfer-${suffix}.txt`);
    fs.writeFileSync(filePath, 'court evidence file', 'utf8');

    const config = getMessagingConfig().feishu;
    const previous = { ...config };
    Object.assign(config, { appId: 'app-test', appSecret: 'secret-test', enabled: true, transport: 'long_connection' });
    const sendSpy = vi.spyOn(FeishuAdapter.prototype, 'sendFile').mockResolvedValue('om-file-sent');

    try {
      expect(listFeishuFileTargets(userId, orgId)).toEqual([
        expect.objectContaining({ bindingId: binding.id, orgId, chatId: 'oc-file-target', chatType: 'group' }),
      ]);
      const result = await sendLocalFileToFeishu({
        userId,
        filePath,
        orgId,
        bindingId: binding.id,
        sourceDomain: 'personal',
      });

      expect(result).toMatchObject({
        messageId: 'om-file-sent',
        fileName: path.basename(filePath),
        sourceDomain: 'personal',
        target: { bindingId: binding.id, orgId, chatId: 'oc-file-target' },
      });
      expect(sendSpy).toHaveBeenCalledWith('oc-file-target', expect.any(Buffer), path.basename(filePath));
      const audit = (readDB().auditLog || []).find((item: any) =>
        item.orgId === orgId
        && item.userId === userId
        && item.action === 'messaging.file.transfer_to_feishu'
        && item.resourceId === 'om-file-sent',
      );
      expect(JSON.parse(audit?.details || '{}')).toMatchObject({
        sourceDomain: 'personal',
        targetPlatform: 'feishu',
        targetChatId: 'oc-file-target',
      });
    } finally {
      sendSpy.mockRestore();
      Object.assign(config, previous);
      fs.rmSync(filePath, { force: true });
    }
  });

  it('lets the same authorized Lumi send an organization file to its bound personal WeChat conversation', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userId = `wechat-file-owner-${suffix}`;
    const orgId = createOrg('WeChat Transfer Org', `wechat-transfer-${suffix}`, userId).id;
    addMember(orgId, userId, 'owner');
    const code = createBindingCode('wechat', userId, '', 'personal');
    const binding = consumeBindingCode('wechat', code.code, 'wx-personal-owner', 'wx-personal-owner', 'private')!;
    const filePath = path.join(os.tmpdir(), `lumi-wechat-transfer-${suffix}.pdf`);
    fs.writeFileSync(filePath, 'court notice attachment', 'utf8');
    const adapter = new WeChatClawBotAdapter({
      botToken: 'wechat-transfer-token',
      botId: 'wechat-transfer-bot@im.bot',
      baseUrl: 'https://example.test',
      enabled: true,
    });
    adapter.parseEvent({
      message_id: 12345,
      from_user_id: 'wx-personal-owner',
      to_user_id: 'wechat-transfer-bot@im.bot',
      message_type: 1,
      message_state: 2,
      context_token: 'wechat-transfer-context',
      item_list: [{ type: 1, text_item: { text: '发给我' } }],
    });
    const previousAdapter = getActiveWeChatAdapter();
    const sendSpy = vi.spyOn(adapter, 'sendFile').mockResolvedValue('wx-provider-message-id');
    setActiveWeChatAdapter(adapter);

    try {
      expect(listPersonalWeChatFileTargets(userId)).toEqual([
        expect.objectContaining({ bindingId: binding.id, platformUserId: 'wx-personal-owner' }),
      ]);
      const result = await sendLocalFileToPersonalWeChat({
        userId,
        filePath,
        sourceOrgId: orgId,
      });

      expect(result).toMatchObject({
        messageId: 'wx-provider-message-id',
        sourceDomain: 'work',
        method: 'wechat_ilink_file_api',
        target: { bindingId: binding.id, platformUserId: 'wx-personal-owner' },
      });
      expect(sendSpy).toHaveBeenCalledWith('wx-personal-owner', expect.any(Buffer), path.basename(filePath));
      const audit = (readDB().auditLog || []).find((item: any) =>
        item.orgId === orgId
        && item.userId === userId
        && item.action === 'messaging.file.transfer_to_personal_wechat'
        && item.resourceId === 'wx-provider-message-id',
      );
      expect(JSON.parse(audit?.details || '{}')).toMatchObject({
        sourceDomain: 'work',
        targetPlatform: 'wechat',
        targetBindingId: binding.id,
        verificationMethod: 'wechat_ilink_provider_ack',
      });
    } finally {
      sendSpy.mockRestore();
      setActiveWeChatAdapter(previousAdapter);
      fs.rmSync(filePath, { force: true });
    }
  });
});
