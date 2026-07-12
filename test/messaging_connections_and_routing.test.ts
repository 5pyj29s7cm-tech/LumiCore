import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeApp } from './helpers';
import type { IncomingMessage } from '../server/messaging/types';

let bindings: typeof import('../server/messaging/bindings');
let delivery: typeof import('../server/messaging/delivery_ledger');
let routes: typeof import('../server/messaging/routes');
let wechatRoutes: typeof import('../server/messaging/wechat-routes');
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
    [bindings, delivery, routes, wechatRoutes, connections, messagingConfig, orgDb] = await Promise.all([
      import('../server/messaging/bindings'),
      import('../server/messaging/delivery_ledger'),
      import('../server/messaging/routes'),
      import('../server/messaging/wechat-routes'),
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
    delivery.completeMessageDelivery('feishu', 'persistent-message');
    delivery.reloadDeliveryLedgerForTest();
    expect(delivery.acceptMessageOnce('feishu', 'persistent-message')).toBe(false);
    expect(delivery.acceptMessageOnce('wecom', 'persistent-message')).toBe(true);
  });

  it('releases failed message leases so the same platform delivery can retry', () => {
    expect(delivery.acceptMessageOnce('feishu', 'retry-message')).toBe(true);
    expect(delivery.acceptMessageOnce('feishu', 'retry-message')).toBe(false);
    delivery.releaseMessageDelivery('feishu', 'retry-message');
    expect(delivery.acceptMessageOnce('feishu', 'retry-message')).toBe(true);
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
    const groupPeerMessage = await captureRoutedMessage(incoming({ userId: `group-peer-${suffix}`, chatId: 'oc-group-b', chatType: 'group' }));
    const unboundGroup = await captureRoutedMessage(incoming({ userId: platformUserId, chatId: 'oc-group-unbound', chatType: 'group' }));

    expect(privateMessage.boundOrgId).toBe(orgA.id);
    expect(groupMessage.boundOrgId).toBe(orgB.id);
    expect(groupPeerMessage.boundOrgId).toBeUndefined();
    expect(unboundGroup.boundOrgId).toBeUndefined();

    orgDb.removeMember(orgB.id, lumiUserId);
    const revoked = await captureRoutedMessage(incoming({ userId: platformUserId, chatId: 'oc-group-b', chatType: 'group' }));
    expect(revoked.boundOrgId).toBeUndefined();
  });

  it('isolates bindings for multiple members in the same group', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const lumiUserA = `lumi-group-a-${suffix}`;
    const lumiUserB = `lumi-group-b-${suffix}`;
    const orgA = orgDb.createOrg('Group A', `group-a-${suffix}`, lumiUserA);
    const orgB = orgDb.createOrg('Group B', `group-b-${suffix}`, lumiUserB);
    orgDb.addMember(orgA.id, lumiUserA, 'owner');
    orgDb.addMember(orgB.id, lumiUserB, 'owner');

    const first = bindings.createBindingCode('wecom', lumiUserA, orgA.id);
    bindings.consumeBindingCode('wecom', first.code, 'member-a', 'shared-group', 'group');
    const second = bindings.createBindingCode('wecom', lumiUserB, orgB.id);
    bindings.consumeBindingCode('wecom', second.code, 'member-b', 'shared-group', 'group');

    expect(bindings.getBinding('wecom', 'member-a', 'shared-group', 'group')?.orgId).toBe(orgA.id);
    expect(bindings.getBinding('wecom', 'member-b', 'shared-group', 'group')?.orgId).toBe(orgB.id);
    expect(bindings.getBinding('wecom', 'member-c', 'shared-group', 'group')).toBeNull();
    expect(bindings.getBinding('wecom', 'member-a', 'private-chat', 'private')).toBeNull();
    expect(bindings.listBindingsForUser(lumiUserA).filter((item: any) => item.chatId === 'shared-group')).toHaveLength(1);
    expect(bindings.listBindingsForUser(lumiUserB).filter((item: any) => item.chatId === 'shared-group')).toHaveLength(1);
  });

  it('routes simultaneous Feishu group messages to each member without identity crossover', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ownerId = `feishu-owner-${suffix}`;
    const memberId = `feishu-member-${suffix}`;
    const org = orgDb.createOrg('Concurrent Feishu Org', `concurrent-feishu-${suffix}`, ownerId);
    orgDb.addMember(org.id, ownerId, 'owner');
    orgDb.addMember(org.id, memberId, 'member');

    const ownerCode = bindings.createBindingCode('feishu', ownerId, org.id);
    const memberCode = bindings.createBindingCode('feishu', memberId, org.id);
    bindings.consumeBindingCode('feishu', ownerCode.code, 'ou-owner', 'oc-concurrent', 'group');
    bindings.consumeBindingCode('feishu', memberCode.code, 'ou-member', 'oc-concurrent', 'group');

    const [ownerMessage, memberMessage] = await Promise.all([
      captureRoutedMessage(incoming({ userId: 'ou-owner', chatId: 'oc-concurrent', chatType: 'group', threadId: 'thread-shared' })),
      captureRoutedMessage(incoming({ userId: 'ou-member', chatId: 'oc-concurrent', chatType: 'group', threadId: 'thread-shared' })),
    ]);

    expect(ownerMessage).toMatchObject({ boundUserId: ownerId, boundOrgId: org.id });
    expect(memberMessage).toMatchObject({ boundUserId: memberId, boundOrgId: org.id });
    expect(routes.messagingConversationAgentId(ownerMessage)).not.toBe(routes.messagingConversationAgentId(memberMessage));
  });

  it('supports personal WeChat identity binding without organization access', () => {
    const lumiUserId = `personal-wechat-${Date.now()}-${Math.random()}`;
    const code = bindings.createBindingCode('wechat', lumiUserId, '', 'personal');
    expect(code.code).toMatch(/^[A-F0-9]{12}$/);
    expect(bindings.parseMessagingBindingCommand('绑定 Lumi V_3XJS8J')).toEqual({ kind: 'bind', code: 'V_3XJS8J' });
    expect(bindings.parseMessagingBindingCommand('我已经绑定成功了')).toEqual({ kind: 'status' });
    const consumed = bindings.consumeBindingCode('wechat', code.code, 'wx-personal-user', 'wx-personal-user', 'private');

    expect(consumed).toMatchObject({
      lumiUserId,
      orgId: '',
      domain: 'personal',
      platformUserId: 'wx-personal-user',
    });
    expect(bindings.getBinding('wechat', 'wx-personal-user', 'wx-personal-user', 'private')?.domain).toBe('personal');
  });

  it('answers WeChat binding status from persisted state instead of model agreement', () => {
    const message = incoming({
      platform: 'wechat',
      userId: 'wx-status-user',
      chatId: 'wx-status-user',
      text: '我已经绑定成功了',
    });
    expect(wechatRoutes.handleWeChatBindingCommand(message)).toContain('尚未绑定');

    const lumiUserId = `wechat-status-${Date.now()}-${Math.random()}`;
    const code = bindings.createBindingCode('wechat', lumiUserId, '', 'personal');
    expect(wechatRoutes.handleWeChatBindingCommand({
      ...message,
      text: `绑定 Lumi ${code.code}`,
    })).toContain('绑定成功');
    expect(wechatRoutes.handleWeChatBindingCommand(message)).toContain('已连接到你的个人 Lumi');
  });

  it('uses the main Lumi chat for personal WeChat and isolates group members and threads', () => {
    const personal = incoming({
      platform: 'wechat',
      userId: 'wx-user',
      chatId: 'wx-user',
      boundUserId: `lumi-personal-${Date.now()}`,
      boundOrgId: undefined,
    });
    expect(routes.messagingConversationAgentId(personal)).toBe('lumi');

    const groupA = incoming({ chatType: 'group', chatId: 'group-1', userId: 'member-a', threadId: 'thread-1' });
    const groupB = incoming({ chatType: 'group', chatId: 'group-1', userId: 'member-b', threadId: 'thread-1' });
    const groupAOtherThread = incoming({ chatType: 'group', chatId: 'group-1', userId: 'member-a', threadId: 'thread-2' });
    expect(routes.messagingConversationAgentId(groupA)).not.toBe(routes.messagingConversationAgentId(groupB));
    expect(routes.messagingConversationAgentId(groupA)).not.toBe(routes.messagingConversationAgentId(groupAOtherThread));

    let emitted: any = null;
    const update = routes.persistBoundMessagingExchange(personal, '收到', value => { emitted = value; });
    expect(update).toMatchObject({ agentId: 'lumi', domain: 'personal', orgId: '', source: 'wechat_bot' });
    expect(emitted).toEqual(update);
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
