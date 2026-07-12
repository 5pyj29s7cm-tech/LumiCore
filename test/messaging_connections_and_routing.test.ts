import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApp } from './helpers';
import type { IncomingMessage } from '../server/messaging/types';

let bindings: typeof import('../server/messaging/bindings');
let delivery: typeof import('../server/messaging/delivery_ledger');
let routes: typeof import('../server/messaging/routes');
let connections: typeof import('../server/messaging/connections');
let messagingConfig: typeof import('../server/messaging/config');
let orgDb: typeof import('../server/org/db');
let cleanup = () => {};

function incoming(partial: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'feishu',
    userId: 'ou-routing-user',
    userName: 'Routing User',
    chatId: 'oc-private',
    chatType: 'private',
    messageId: `message-${Date.now()}-${Math.random()}`,
    text: '普通问候',
    raw: {},
    timestamp: new Date().toISOString(),
    ...partial,
  };
}

async function captureRoutedMessage(message: IncomingMessage): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('messaging route timed out')), 2_000);
    const accepted = routes.dispatchIncomingMessage(message, {
      enrich: async value => value,
      reply: async () => undefined,
    }, {
      onMessage: async value => {
        clearTimeout(timeout);
        resolve(value);
        return { platform: value.platform, text: 'ok' };
      },
    });
    if (!accepted) {
      clearTimeout(timeout);
      reject(new Error('message was rejected as a duplicate'));
    }
  });
}

describe('messaging long connections and organization routing', () => {
  beforeAll(async () => {
    const app = await makeApp();
    cleanup = app.cleanup;
    [bindings, delivery, routes, connections, messagingConfig, orgDb] = await Promise.all([
      import('../server/messaging/bindings'),
      import('../server/messaging/delivery_ledger'),
      import('../server/messaging/routes'),
      import('../server/messaging/connections'),
      import('../server/messaging/config'),
      import('../server/org/db'),
    ]);
  });

  beforeEach(() => {
    bindings.resetMessagingBindingsForTest();
    delivery.resetDeliveryLedgerForTest();
  });

  afterAll(() => {
    bindings.resetMessagingBindingsForTest();
    delivery.resetDeliveryLedgerForTest();
    cleanup();
  });

  it('keeps stored secrets when settings forms submit blank secret fields', () => {
    messagingConfig.updateMessagingConfig({
      appId: 'cli_0123456789abcdef',
      appSecret: 'feishu-secret',
      transport: 'long_connection',
    });
    messagingConfig.updateMessagingConfig({ appId: 'cli_0123456789abcdef', appSecret: undefined });
    expect(messagingConfig.getMessagingConfig().feishu.appSecret).toBe('feishu-secret');
    expect(messagingConfig.getMessagingConfig().feishu.enabled).toBe(true);

    messagingConfig.updateMessagingConfig({
      wecom: {
        mode: 'aibot_long_connection',
        botId: 'bot-routing-test',
        botSecret: 'wecom-secret',
      },
    });
    messagingConfig.updateMessagingConfig({ wecom: { botSecret: undefined } });
    expect(messagingConfig.getMessagingConfig().wecom.botSecret).toBe('wecom-secret');
    expect(messagingConfig.getMessagingConfig().wecom.enabled).toBe(true);
  });

  it('defaults new installs to long connections while preserving legacy webhook configs', () => {
    const fallback: import('../server/messaging/config').MessagingConfig = {
      feishu: { appId: '', appSecret: '', transport: 'long_connection', enabled: false },
      wecom: {
        mode: 'aibot_long_connection',
        botId: '',
        botSecret: '',
        corpId: '',
        agentId: '',
        appSecret: '',
        token: '',
        encodingAESKey: '',
        enabled: false,
      },
      wechat: { botToken: '', botId: '', baseUrl: 'https://ilinkai.weixin.qq.com', enabled: false },
    };
    const fresh = messagingConfig.normalizeMessagingConfig(null, fallback);
    expect(fresh.feishu.transport).toBe('long_connection');
    expect(fresh.wecom.mode).toBe('aibot_long_connection');

    const legacy = messagingConfig.normalizeMessagingConfig({
      feishu: { appId: 'cli_0123456789abcdef', appSecret: 'secret', verificationToken: 'verify' } as any,
      wecom: {
        corpId: 'ww-legacy',
        agentId: '100001',
        appSecret: 'secret',
        token: 'token',
        encodingAESKey: 'a'.repeat(43),
      } as any,
    }, fallback);
    expect(legacy.feishu.transport).toBe('webhook');
    expect(legacy.wecom.mode).toBe('app_webhook');
    expect(legacy.feishu.enabled).toBe(true);
    expect(legacy.wecom.enabled).toBe(true);
  });

  it('requires all webhook verification credentials before reporting a connector ready', () => {
    messagingConfig.updateMessagingConfig({
      appId: 'cli_0123456789abcdef',
      appSecret: 'secret',
      verificationToken: '',
      transport: 'webhook',
    });
    expect(messagingConfig.getMessagingConfig().feishu.enabled).toBe(false);
    messagingConfig.updateMessagingConfig({ verificationToken: 'verify-token' });
    expect(messagingConfig.getMessagingConfig().feishu.enabled).toBe(true);

    messagingConfig.updateMessagingConfig({
      wecom: {
        mode: 'app_webhook',
        corpId: 'ww-test',
        agentId: '100001',
        appSecret: 'secret',
        token: '',
        encodingAESKey: '',
      },
    });
    expect(messagingConfig.getMessagingConfig().wecom.enabled).toBe(false);
    messagingConfig.updateMessagingConfig({ wecom: { token: 'callback-token', encodingAESKey: 'a'.repeat(43) } });
    expect(messagingConfig.getMessagingConfig().wecom.enabled).toBe(true);
  });

  it('deduplicates delivery receipts across an in-memory ledger reload', () => {
    expect(delivery.acceptMessageOnce('feishu', 'persistent-message')).toBe(true);
    delivery.reloadDeliveryLedgerForTest();
    expect(delivery.acceptMessageOnce('feishu', 'persistent-message')).toBe(false);
    expect(delivery.acceptMessageOnce('wecom', 'persistent-message')).toBe(true);
  });

  it('routes the same platform identity to different organizations by exact group scope', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const lumiUserId = `lumi-user-${suffix}`;
    const platformUserId = `ou-${suffix}`;
    const orgA = orgDb.createOrg('Routing A', `routing-a-${suffix}`, lumiUserId);
    const orgB = orgDb.createOrg('Routing B', `routing-b-${suffix}`, lumiUserId);
    orgDb.addMember(orgA.id, lumiUserId, 'owner');
    orgDb.addMember(orgB.id, lumiUserId, 'owner');

    const privateCode = bindings.createBindingCode('feishu', lumiUserId, orgA.id);
    bindings.consumeBindingCode('feishu', privateCode.code, platformUserId, 'oc-private', 'private');
    const groupCode = bindings.createBindingCode('feishu', lumiUserId, orgB.id);
    bindings.consumeBindingCode('feishu', groupCode.code, platformUserId, 'oc-group-b', 'group');

    const privateMessage = await captureRoutedMessage(incoming({ userId: platformUserId, chatId: 'oc-private' }));
    const groupMessage = await captureRoutedMessage(incoming({ userId: platformUserId, chatId: 'oc-group-b', chatType: 'group' }));
    const unboundGroup = await captureRoutedMessage(incoming({ userId: platformUserId, chatId: 'oc-group-unbound', chatType: 'group' }));

    expect(privateMessage.boundOrgId).toBe(orgA.id);
    expect(groupMessage.boundOrgId).toBe(orgB.id);
    expect(unboundGroup.boundOrgId).toBeUndefined();

    orgDb.removeMember(orgB.id, lumiUserId);
    const revoked = await captureRoutedMessage(incoming({ userId: platformUserId, chatId: 'oc-group-b', chatType: 'group' }));
    expect(revoked.boundOrgId).toBeUndefined();
  });

  it('parses WeCom long-connection text, voice, file, and mixed messages', () => {
    const base = {
      msgid: 'msg-1',
      chatid: 'chat-1',
      chattype: 'group',
      from: { userid: 'zhangsan', name: '张三' },
      create_time: 1_783_828_800,
    };
    const textMessage = connections.parseWeComLongConnectionMessage({ body: { ...base, msgtype: 'text', text: { content: '请总结案件' } } } as any);
    expect(textMessage).toMatchObject({ text: '请总结案件', chatType: 'group', userId: 'zhangsan' });

    const voiceMessage = connections.parseWeComLongConnectionMessage({ body: { ...base, msgid: 'msg-2', msgtype: 'voice', voice: { content: '整理会议纪要' } } } as any);
    expect(voiceMessage?.text).toBe('整理会议纪要');

    const fileMessage = connections.parseWeComLongConnectionMessage({ body: { ...base, msgid: 'msg-3', msgtype: 'file', file: { filename: '证据.pdf', url: 'https://example.test/file', aeskey: 'key', size: 2048 } } } as any);
    expect(fileMessage?.attachments?.[0]).toMatchObject({ type: 'file', fileName: '证据.pdf', downloadUrl: 'https://example.test/file', encryptionKey: 'key', fileSize: 2048 });

    const mixedMessage = connections.parseWeComLongConnectionMessage({ body: { ...base, msgid: 'msg-4', msgtype: 'mixed', mixed: { msg_item: [{ msgtype: 'text', text: { content: '看这张图' } }, { msgtype: 'image', image: { url: 'https://example.test/image', aeskey: 'image-key' } }] } } } as any);
    expect(mixedMessage?.text).toBe('看这张图');
    expect(mixedMessage?.attachments?.[0]).toMatchObject({ type: 'image', downloadUrl: 'https://example.test/image' });
  });
});
