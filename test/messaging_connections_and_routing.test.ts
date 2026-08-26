import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sqlite3 from 'sqlite3';
import { makeApp } from './helpers';
import type { IncomingMessage } from '../server/messaging/types';
import { buildModelCapabilityPolicy } from '../server/cognition/capability_selection';

let bindings: typeof import('../server/messaging/bindings');
let delivery: typeof import('../server/messaging/delivery_ledger');
let ingressPolicy: typeof import('../server/messaging/ingress_policy');
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
    [bindings, delivery, ingressPolicy, routes, wechatRoutes, connections, messagingConfig, orgDb] = await Promise.all([
      import('../server/messaging/bindings'),
      import('../server/messaging/delivery_ledger'),
      import('../server/messaging/ingress_policy'),
      import('../server/messaging/routes'),
      import('../server/messaging/wechat-routes'),
      import('../server/messaging/connections'),
      import('../server/messaging/config'),
      import('../server/org/db'),
    ]);
    const [{ toolRegistry }, { registerAllTools }] = await Promise.all([
      import('../server/tools/registry'),
      import('../server/tools/definitions'),
    ]);
    registerAllTools(toolRegistry);
  });

  beforeEach(() => {
    bindings.resetMessagingBindingsForTest();
    delivery.resetDeliveryLedgerForTest();
    ingressPolicy.resetMessagingIngressPolicyForTest();
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
    bindings.authorizeMessagingGroup({
      platform: 'feishu',
      chatId: 'oc-group-b',
      orgId: orgB.id,
      createdBy: lumiUserId,
    });

    const privateMessage = await captureRoutedMessage(incoming({ userId: platformUserId, chatId: 'oc-private' }));
    const groupMessage = await captureRoutedMessage(incoming({
      userId: platformUserId,
      chatId: 'oc-group-b',
      chatType: 'group',
      botMentioned: true,
    }));

    expect(privateMessage.boundOrgId).toBe(orgA.id);
    expect(groupMessage.boundOrgId).toBe(orgB.id);
    expect(routes.dispatchIncomingMessage(incoming({
      userId: `group-peer-${suffix}`,
      chatId: 'oc-group-b',
      chatType: 'group',
      botMentioned: true,
    }), { enrich: async value => value, reply: async () => undefined })).toBe(false);
    expect(routes.dispatchIncomingMessage(incoming({
      userId: platformUserId,
      chatId: 'oc-group-unbound',
      chatType: 'group',
      botMentioned: true,
    }), { enrich: async value => value, reply: async () => undefined })).toBe(false);

    orgDb.removeMember(orgB.id, lumiUserId);
    expect(routes.dispatchIncomingMessage(incoming({
      userId: platformUserId,
      chatId: 'oc-group-b',
      chatType: 'group',
      botMentioned: true,
    }), { enrich: async value => value, reply: async () => undefined })).toBe(false);
  });

  it('isolates bindings for multiple members in the same group', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const lumiUserA = `lumi-group-a-${suffix}`;
    const lumiUserB = `lumi-group-b-${suffix}`;
    const orgA = orgDb.createOrg('Group A', `group-a-${suffix}`, lumiUserA);
    const orgB = orgDb.createOrg('Group B', `group-b-${suffix}`, lumiUserB);
    orgDb.addMember(orgA.id, lumiUserA, 'owner');
    orgDb.addMember(orgB.id, lumiUserB, 'owner');
    orgDb.addMember(orgA.id, lumiUserB, 'member');

    const first = bindings.createBindingCode('wecom', lumiUserA, orgA.id);
    bindings.consumeBindingCode('wecom', first.code, 'member-a', 'private-a', 'private');
    const second = bindings.createBindingCode('wecom', lumiUserB, orgB.id);
    bindings.consumeBindingCode('wecom', second.code, 'member-b', 'private-b', 'private');
    bindings.authorizeMessagingGroup({
      platform: 'wecom',
      chatId: 'shared-group',
      orgId: orgA.id,
      createdBy: lumiUserA,
    });

    expect(bindings.getBinding('wecom', 'member-a', 'shared-group', 'group')?.orgId).toBe(orgA.id);
    expect(bindings.getBinding('wecom', 'member-b', 'shared-group', 'group')?.orgId).toBe(orgA.id);
    expect(bindings.getBinding('wecom', 'member-c', 'shared-group', 'group')).toBeNull();
    expect(bindings.getBinding('wecom', 'member-a', 'private-chat', 'private')).toBeNull();
    expect(bindings.listBindingsForUser(lumiUserA).filter((item: any) => item.chatType === 'group')).toHaveLength(0);
    expect(bindings.listBindingsForUser(lumiUserB).filter((item: any) => item.chatType === 'group')).toHaveLength(0);
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
    bindings.consumeBindingCode('feishu', ownerCode.code, 'ou-owner', 'oc-owner-private', 'private');
    bindings.consumeBindingCode('feishu', memberCode.code, 'ou-member', 'oc-member-private', 'private');
    bindings.authorizeMessagingGroup({
      platform: 'feishu',
      chatId: 'oc-concurrent',
      orgId: org.id,
      createdBy: ownerId,
    });

    const [ownerMessage, memberMessage] = await Promise.all([
      captureRoutedMessage(incoming({ userId: 'ou-owner', chatId: 'oc-concurrent', chatType: 'group', threadId: 'thread-shared', botMentioned: true })),
      captureRoutedMessage(incoming({ userId: 'ou-member', chatId: 'oc-concurrent', chatType: 'group', threadId: 'thread-shared', botMentioned: true })),
    ]);

    expect(ownerMessage).toMatchObject({ boundUserId: ownerId, boundOrgId: org.id });
    expect(memberMessage).toMatchObject({ boundUserId: memberId, boundOrgId: org.id });
    expect(routes.messagingConversationAgentId(ownerMessage)).not.toBe(routes.messagingConversationAgentId(memberMessage));
  });

  it('supports personal WeChat identity binding without a fixed organization assignment', () => {
    const lumiUserId = `personal-wechat-${Date.now()}-${Math.random()}`;
    const code = bindings.createBindingCode('wechat', lumiUserId, '', 'personal');
    expect(code.code).toMatch(/^[A-F0-9]{12}$/);
    expect(bindings.parseMessagingBindingCommand('绑定 Lumi V_3XJS8J')).toEqual({ kind: 'bind', code: 'V_3XJS8J' });
    expect(bindings.parseMessagingBindingCommand('Bind Lumi V_3XJS8J')).toEqual({ kind: 'bind', code: 'V_3XJS8J' });
    expect(bindings.parseMessagingBindingCommand('Already bound?')).toEqual({ kind: 'status' });
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

  it('answers WeChat binding status from persisted state instead of model agreement', async () => {
    const message = incoming({
      platform: 'wechat',
      userId: 'wx-status-user',
      chatId: 'wx-status-user',
      text: '我已经绑定成功了',
    });
    expect(wechatRoutes.handleWeChatBindingCommand(message)).toContain('尚未绑定');

    const lumiUserId = `wechat-status-${Date.now()}-${Math.random()}`;
    const code = bindings.createBindingCode('wechat', lumiUserId, '', 'personal');
    const bindingMessage = {
      ...message,
      messageId: `wechat-binding-${Date.now()}`,
      text: `绑定 Lumi ${code.code}`,
    };
    expect(wechatRoutes.handleWeChatBindingCommand(bindingMessage)).toBeNull();
    const bindingReply = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('durable WeChat binding timed out')), 2_000);
      routes.dispatchIncomingMessage(bindingMessage, {
        enrich: async value => value,
        reply: async (_value, text) => {
          clearTimeout(timeout);
          resolve(text);
          return 'wechat-binding-reply';
        },
      });
    });
    expect(bindingReply).toContain('绑定成功');
    expect(wechatRoutes.handleWeChatBindingCommand(message)).toContain('已连接到你的个人 Lumi');
  });

  it('uses the main Lumi chat for personal WeChat and isolates group members and threads', async () => {
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
    expect(update?.messageId).toMatch(/^msg_/);
    expect(emitted).toEqual(update);

    const conversations = await import('../server/conversation/manager');
    const messages = conversations.getMessages(update!.conversationId);
    expect(messages.slice(-2).map((item: any) => ({ source: item.source, channel: item.channel }))).toEqual([
      { source: 'wechat_bot', channel: 'wechat' },
      { source: 'wechat_bot', channel: 'wechat' },
    ]);
    expect(messages.slice(-2).map((item: any) => item.requestId)).toEqual([
      `wechat_bot:${personal.messageId}`,
      `wechat_bot:${personal.messageId}`,
    ]);
    expect(messages.at(-1)?.id).toBe(update?.messageId);
  });

  it('rejects a remote action turn while an earlier exact transcript owns the task pointer', async () => {
    const userId = `wechat-turn-owner-${Date.now()}-${Math.random()}`;
    const first = incoming({
      platform: 'wechat',
      userId: `wx-${userId}`,
      chatId: `wx-${userId}`,
      boundUserId: userId,
      messageId: `first-${Date.now()}`,
      text: 'Open the browser.',
    });
    const firstUpdate = routes.persistBoundMessagingMessage(first, 'user', first.text)!;
    const conversations = await import('../server/conversation/manager');
    const firstRequestId = `wechat_bot:${first.messageId}`;
    const firstPreparation = conversations.prepareConversationActionExecution({
      conversationId: firstUpdate.conversationId,
      userId,
      userText: first.text,
      requestId: firstRequestId,
      userMessageId: firstUpdate.messageId,
      toolPolicy: {
        allowedTools: ['desktop_open'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 4,
      },
      forceTask: true,
    });
    expect(firstPreparation.kind).toBe('new');

    const second = incoming({
      ...first,
      messageId: `second-${Date.now()}`,
      text: 'Open the calculator.',
    });
    const reply = await routes.processWithPersonality(second);
    const { CN_TASK_EXECUTION_MESSAGES } = await import('../server/regions/packs/cn/voice_fast_path_messages');

    expect(reply).toBe(CN_TASK_EXECUTION_MESSAGES.actionTurnBusy);
    expect(conversations.getOrCreateActiveConversation(userId, 'lumi', 'personal', '')).toMatchObject({
      pendingActionContinuation: { requestId: firstRequestId },
      actionContinuationState: {
        taskId: firstPreparation.state?.taskId,
        activeRequestId: firstRequestId,
      },
    });
  });

  it('persists remote provenance and structured tool evidence through SQLite', async () => {
    const userId = `wechat-evidence-${Date.now()}-${Math.random()}`;
    const message = incoming({
      platform: 'wechat',
      userId: `wx-${userId}`,
      chatId: `wx-${userId}`,
      boundUserId: userId,
      text: '\u628a\u9879\u76ee\u8ba1\u52122026\u53d1\u7ed9\u6211',
    });
    const toolCalls = [{
      id: 'wechat-file-evidence',
      name: 'wechat_send_file',
      arguments: { filePath: 'C:\\Users\\owner\\Desktop\\\u9879\u76ee\u8ba1\u52122026.docx' },
      result: JSON.stringify({
        sent: true,
        verificationStatus: 'provider_accepted',
        fileName: '\u9879\u76ee\u8ba1\u52122026.docx',
        messageId: 'wx-file-evidence',
      }),
    }];

    const update = routes.persistBoundMessagingMessage(
      message,
      'assistant',
      '\u9879\u76ee\u8ba1\u52122026.docx \u5df2\u53d1\u9001\u3002',
      undefined,
      toolCalls,
    );
    const conversations = await import('../server/conversation/manager');
    const inMemory = conversations.getMessages(update!.conversationId).at(-1)!;
    expect(inMemory.toolCalls).toEqual(toolCalls);
    expect(routes.buildRemoteRuntimeEvidenceContext([inMemory])).toContain('wechat_send_file');
    expect(routes.buildRemoteRuntimeEvidenceContext([inMemory])).toContain('sent=true');

    const failedContext = routes.buildRemoteRuntimeEvidenceContext([{
      toolCalls: [{
        name: 'wechat_send_file',
        arguments: {},
        result: 'Message bubble verification failed',
      }],
    }]);
    expect(failedContext).toContain('wechat_send_file: failed or incomplete');
    expect(failedContext).not.toContain('wechat_send_file: completed');

    const unknownContext = routes.buildRemoteRuntimeEvidenceContext([{
      toolCalls: [{
        name: 'desktop_open',
        arguments: { target: 'WPS' },
        result: 'relay returned without a structured receipt',
      }],
    }]);
    expect(unknownContext).toContain('desktop_open: result recorded (completion unverified)');
    expect(unknownContext).not.toContain('desktop_open: completed');

    const { flushDB } = await import('../db_layer');
    const { getDataPath } = await import('../server/config/data_path');
    await flushDB();
    const row = await new Promise<any>((resolve, reject) => {
      const database = new sqlite3.Database(getDataPath('lumi.db'));
      database.get(
        'SELECT source, channel, toolCalls FROM interactions WHERE id = ?',
        [inMemory.id],
        (error, value) => {
          database.close();
          if (error) reject(error);
          else resolve(value);
        },
      );
    });

    expect(row).toMatchObject({ source: 'wechat_bot', channel: 'wechat' });
    expect(JSON.parse(row.toolCalls)).toEqual(toolCalls);
  });

  it('routes bound remote turns through the same Lumi mode and capability graph', () => {
    const base = {
      userId: 'remote-plan-user',
      source: 'wechat_bot',
      domain: 'personal' as const,
      orgId: '',
      identityBound: true,
      canWriteOrganization: true,
    };

    const greeting = routes.buildRemoteLumiExecutionPlan({
      ...base,
      text: '在吗',
      operationMode: 'assistant',
    });
    expect(greeting.dispatch.boundary).toBe('conversation');
    expect(greeting.execution.allowToolUse).toBe(true);
    const greetingModelPolicy = buildModelCapabilityPolicy(greeting.execution);
    expect(greetingModelPolicy.forbiddenTools).not.toContain('*');
    expect(greetingModelPolicy.allowedTools).toEqual(expect.arrayContaining([
      'client_get_state',
      'desktop_open',
      'wechat_send_message',
    ]));

    const knowledgeFileCapabilityQuestion = routes.buildRemoteLumiExecutionPlan({
      ...base,
      text: '\u77e5\u8bc6\u5e93\u91cc\u7684\u6587\u4ef6\u53ef\u4ee5\u53d1\u7ed9\u6211\u5417',
      operationMode: 'assistant',
    });
    expect(knowledgeFileCapabilityQuestion.dispatch.boundary).toBe('conversation');
    expect(knowledgeFileCapabilityQuestion.execution.allowToolUse).toBe(true);
    const knowledgeModelPolicy = buildModelCapabilityPolicy(knowledgeFileCapabilityQuestion.execution);
    expect(knowledgeModelPolicy.forbiddenTools).not.toContain('*');
    expect(knowledgeModelPolicy.allowedTools).toEqual(expect.arrayContaining([
      'read_file',
      'wechat_send_file',
    ]));

    const chatAction = routes.buildRemoteLumiExecutionPlan({
      ...base,
      text: '操作桌面打开微信',
      operationMode: 'chat',
    });
    expect(chatAction.dispatch.flow.autoPromoteToAssistant).toBe(true);
    expect(chatAction.dispatch.flow.effectiveOperationMode).toBe('chat');
    expect(chatAction.execution.allowToolUse).toBe(true);
    expect(chatAction.execution.maxIterations).toBeGreaterThan(3);
    expect(chatAction.execution.toolRoute?.categories).toContain('messaging');
    expect(buildModelCapabilityPolicy(chatAction.execution).allowedTools).toEqual(expect.arrayContaining([
      'client_get_state',
      'client_action',
      'desktop_open',
    ]));
    expect(buildModelCapabilityPolicy(chatAction.execution).forbiddenTools).toContain('wechat_send_message');

    const clientCheck = routes.buildRemoteLumiExecutionPlan({
      ...base,
      text: '给客户端做个自检',
      operationMode: 'assistant',
    });
    expect(clientCheck.dispatch.flow.selfRepairTurn).toBe(true);
    const clientModelPolicy = buildModelCapabilityPolicy(clientCheck.execution);
    expect(clientModelPolicy.allowedTools).toEqual(expect.arrayContaining([
      'client_get_state',
      'client_health_check',
      'desktop_open',
    ]));
    expect(clientModelPolicy.forbiddenTools).not.toContain('*');
    expect(clientModelPolicy.maxIterations).toBeGreaterThan(3);

    const modeSwitch = routes.buildRemoteLumiExecutionPlan({
      ...base,
      text: '切换到自主模式',
      operationMode: 'assistant',
    });
    expect(modeSwitch.dispatch.flow.requestedMode).toBe('autonomous');
    expect(modeSwitch.dispatch.flow.effectiveOperationMode).toBe('assistant');
    const modeSwitchModelPolicy = buildModelCapabilityPolicy(modeSwitch.execution);
    expect(modeSwitchModelPolicy.allowedTools).toEqual(expect.arrayContaining([
      'client_get_state',
      'client_action',
      'desktop_open',
    ]));
  });

  it('keeps unbound remote senders off private tools and organization viewers off write tools', () => {
    const unbound = routes.buildRemoteLumiExecutionPlan({
      userId: 'anonymous',
      text: '打开我的桌面微信',
      source: 'wechat_bot',
      domain: 'personal',
      orgId: '',
      operationMode: 'chat',
      identityBound: false,
      canWriteOrganization: false,
    });
    expect(unbound.dispatch.boundary).toBe('conversation');
    expect(unbound.dispatch.flow.allowToolUseForTurn).toBe(false);
    expect(unbound.execution.allowToolUse).toBe(false);
    expect(unbound.execution.toolPolicy.forbiddenTools).toContain('*');

    const viewer = routes.buildRemoteLumiExecutionPlan({
      userId: 'org-viewer',
      text: '把这份材料导入案件并发送到个人微信',
      source: 'feishu_bot',
      domain: 'work',
      orgId: 'org-view-only',
      operationMode: 'assistant',
      identityBound: true,
      canWriteOrganization: false,
    });
    expect(viewer.execution.toolPolicy.forbiddenTools).toEqual(expect.arrayContaining([
      'legal_case_workspace',
      'legal_import_materials_to_kb',
      'wechat_send_file',
    ]));
  });

  it('applies a personal WeChat mode switch through the scoped desktop relay without an LLM round trip', async () => {
    const userId = `wechat-mode-${Date.now()}-${Math.random()}`;
    const { updateClientState } = await import('../server/client/self_model');
    updateClientState(userId, { platform: 'desktop', mode: 'assistant' });
    const calls: Array<{ name: string; args: Record<string, any> }> = [];
    const scopes: Array<{ userId: string; source: string; domain: string; orgId: string }> = [];
    const message = incoming({
      platform: 'wechat',
      userId: `wx-${userId}`,
      chatId: `wx-${userId}`,
      boundUserId: userId,
      text: '切换到自主模式',
    });

    const reply = await routes.processWithPersonality(message, {
      createScopedDesktopRelay: (relayUserId, source, domain, orgId) => {
        scopes.push({ userId: relayUserId, source, domain, orgId });
        return async (name, args) => {
          calls.push({ name, args });
          if (args.action === 'set_client_mode') {
            updateClientState(userId, { platform: 'desktop', mode: args.mode });
          }
          return JSON.stringify({ ok: true, action: args.action, mode: args.mode });
        };
      },
    });

    expect(reply).toBe('已切到自主模式。');
    expect(scopes).toEqual([{ userId, source: 'wechat_bot', domain: 'personal', orgId: '' }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      name: 'client_action',
      args: expect.objectContaining({ action: 'set_client_mode', mode: 'autonomous', confirmed: false }),
    });
    expect(calls[1]).toEqual({
      name: 'client_action',
      args: { action: 'refresh_client_state' },
    });
    const { getStoredOperationMode } = await import('../server/cognition/operation_mode_store');
    expect(getStoredOperationMode(userId)).toBe('autonomous');
  });

  it('persists remote execution plans and answers later status turns from the durable receipt ledger', async () => {
    const userId = `wechat-ledger-${Date.now()}-${Math.random()}`;
    const { updateClientState } = await import('../server/client/self_model');
    const { readDB } = await import('../db_layer');
    updateClientState(userId, { platform: 'desktop', mode: 'assistant' });
    const first = incoming({
      platform: 'wechat',
      userId: `wx-${userId}`,
      chatId: `wx-${userId}`,
      boundUserId: userId,
      messageId: `mode-ledger-${Date.now()}`,
      text: '\u5207\u6362\u5230\u81ea\u4e3b\u6a21\u5f0f',
    });
    const createScopedDesktopRelay = () => async (_name: string, args: Record<string, any>) => {
      if (args.action === 'set_client_mode') {
        updateClientState(userId, { platform: 'desktop', mode: args.mode });
      }
      return JSON.stringify({ ok: true, action: args.action, mode: args.mode });
    };

    expect(await routes.processWithPersonality(first, { createScopedDesktopRelay })).toBe('\u5df2\u5207\u5230\u81ea\u4e3b\u6a21\u5f0f\u3002');
    const afterExecution: any = readDB();
    const tasks = (afterExecution.conversationActionTasks || []).filter((item: any) => item.userId === userId);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: 'completed', completionSource: 'tool_receipt' });
    const taskContext = JSON.parse(tasks[0].context);
    expect(taskContext.executionPlan).toMatchObject({
      taskId: tasks[0].id,
      decisionAuthority: 'semantic_planner',
      scriptAuthority: 'adapter_only',
    });
    const receipts = (afterExecution.conversationActionReceipts || [])
      .filter((item: any) => item.taskId === tasks[0].id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      toolName: 'client_action',
      requestId: `wechat_bot:${first.messageId}`,
      outcome: 'verified_success',
    });

    const status = incoming({
      platform: 'wechat',
      userId: `wx-${userId}`,
      chatId: `wx-${userId}`,
      boundUserId: userId,
      messageId: `status-ledger-${Date.now()}`,
      text: '\u521a\u624d\u90a3\u4e2a\u4efb\u52a1\u5b8c\u6210\u4e86\u5417',
    });
    const statusReply = await routes.processWithPersonality(status, {
      createScopedDesktopRelay,
      llmGetters: {
        getDeepSeek: () => { throw new Error('status query must not call a model'); },
        getGemini: () => { throw new Error('status query must not call a model'); },
      },
    });
    expect(statusReply).toContain('\u5df2\u5b8c\u6210');
    const afterStatus: any = readDB();
    expect((afterStatus.conversationActionTasks || []).filter((item: any) => item.userId === userId)).toHaveLength(1);
    expect((afterStatus.conversationActionReceipts || []).filter((item: any) => item.taskId === tasks[0].id)).toHaveLength(1);
  });

  it('uses the exact shared normalized intent and tool policy for remote and local chat entrances', async () => {
    const { buildLumiExecutionPipeline } = await import('../server/cognition/execution_pipeline');
    const { toolRegistry } = await import('../server/tools/registry');
    const text = '\u770b\u4e00\u4e0b\u5f20\u52c7\u6700\u8fd1\u7ed9\u6211\u53d1\u4ec0\u4e48\u6d88\u606f\u4e86';
    const remote = routes.buildRemoteLumiExecutionPlan({
      userId: 'pipeline-equivalence-user',
      text,
      source: 'feishu_bot',
      domain: 'personal',
      orgId: '',
      operationMode: 'assistant',
      identityBound: true,
      canWriteOrganization: true,
    });
    const local = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-equivalence-user',
        text,
        channel: 'chat',
        source: 'chat',
        domain: 'personal',
        orgId: '',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry: toolRegistry,
      source: 'chat',
    });
    expect(remote.normalizedIntent).toEqual(local.normalizedIntent);
    expect(remote.execution.toolPolicy).toEqual(local.execution.toolPolicy);
    expect(remote.execution.toolRoute?.toolNames).toEqual(local.execution.toolRoute?.toolNames);
    expect(remote.normalizedIntent.operation).toBe('read');
  });

  it('keeps attachment processing instructions out of the synchronized chat history', async () => {
    const userId = `clean-attachment-chat-${Date.now()}-${Math.random()}`;
    const value = incoming({
      platform: 'wechat',
      userId: `wx-${userId}`,
      chatId: `wx-${userId}`,
      boundUserId: userId,
      text: [
        '帮我看看这个文件。',
        '',
        '以下是用户通过个人微信发送的真实附件内容。这里是系统处理说明。',
        '## 附件：notes.txt',
        '解析文本：internal attachment context',
      ].join('\n'),
      attachments: [{ id: 'clean-file', type: 'file', fileName: 'notes.txt', extractedText: 'internal attachment context' }],
    });
    const update = routes.persistBoundMessagingExchange(value, '看过了');
    const conversations = await import('../server/conversation/manager');
    const messages = conversations.getMessages(update!.conversationId);
    const userMessage = messages.find(item => item.role === 'user');

    expect(userMessage?.message).toBe('帮我看看这个文件。\n附件：notes.txt');
    expect(userMessage?.message).not.toContain('系统处理说明');
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
