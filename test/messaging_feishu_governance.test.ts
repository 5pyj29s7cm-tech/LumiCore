import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, makeApp } from './helpers';
import {
  authorizeMessagingGroup,
  consumeBindingCode,
  createBindingCode,
  getBinding,
  listActiveBindingCodesForUser,
  resetMessagingBindingsForTest,
} from '../server/messaging/bindings';
import { resetDeliveryLedgerForTest } from '../server/messaging/delivery_ledger';
import {
  evaluateMessagingIngress,
  resetMessagingIngressPolicyForTest,
} from '../server/messaging/ingress_policy';
import {
  resetMessagingJournalForTest,
  listMessagingJournal,
} from '../server/messaging/message_journal';
import {
  FeishuAdapter,
  MessagingDeliveryUnknownError,
} from '../server/messaging/feishu';
import { dispatchIncomingMessage } from '../server/messaging/routes';
import { createMessagingRoutes } from '../server/messaging/routes';
import type { IncomingMessage } from '../server/messaging/types';
import { addMember, createOrg } from '../server/org/db';
import { resetVolatileExternalCommitJournalForTests } from '../server/tools/external_commit_journal';

let cleanup = () => {};
let baseUrl = '';

function incoming(partial: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: 'feishu',
    userId: 'ou-governed-member',
    userName: 'Governed Member',
    chatId: 'oc-governed-group',
    chatType: 'group',
    messageId: `governance-${Date.now()}-${Math.random()}`,
    text: 'Handle this organization task',
    botMentioned: true,
    raw: {},
    timestamp: new Date().toISOString(),
    ...partial,
  };
}

describe('Feishu group governance and delivery safety', () => {
  beforeAll(async () => {
    const app = await makeApp();
    cleanup = app.cleanup;
    baseUrl = app.url;
    app.apiRouter.use(createMessagingRoutes({
      appId: 'cli_governance_routes',
      appSecret: 'route-secret',
      transport: 'long_connection',
    }));
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    resetMessagingBindingsForTest();
    resetMessagingIngressPolicyForTest();
    resetDeliveryLedgerForTest();
    resetMessagingJournalForTest();
    resetVolatileExternalCommitJournalForTests();
  });

  afterAll(() => cleanup());

  it('uses private identity binding plus explicit organization group authorization', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ownerId = `group-owner-${suffix}`;
    const memberId = `group-member-${suffix}`;
    const org = createOrg('Governed Group', `governed-group-${suffix}`, ownerId);
    addMember(org.id, ownerId, 'owner');
    addMember(org.id, memberId, 'member');

    const code = createBindingCode('feishu', memberId, org.id);
    expect(consumeBindingCode('feishu', code.code, 'ou-governed-member', 'oc-governed-group', 'group')).toBeNull();
    expect(listActiveBindingCodesForUser(memberId, 'feishu')).toHaveLength(1);
    expect(consumeBindingCode('feishu', code.code, 'ou-governed-member', 'oc-private-member', 'private')).toMatchObject({
      lumiUserId: memberId,
      chatType: 'private',
    });

    expect(getBinding('feishu', 'ou-governed-member', 'oc-governed-group', 'group')).toBeNull();
    authorizeMessagingGroup({
      platform: 'feishu',
      chatId: 'oc-governed-group',
      orgId: org.id,
      createdBy: ownerId,
      allowedPlatformUserIds: ['ou-governed-member'],
    });
    expect(getBinding('feishu', 'ou-governed-member', 'oc-governed-group', 'group')).toMatchObject({
      lumiUserId: memberId,
      orgId: org.id,
      chatType: 'group',
    });
    expect(getBinding('feishu', 'ou-not-allowlisted', 'oc-governed-group', 'group')).toBeNull();

    const otherOwner = `other-owner-${suffix}`;
    const otherOrg = createOrg('Other Governed Group', `other-governed-${suffix}`, otherOwner);
    addMember(otherOrg.id, otherOwner, 'owner');
    expect(() => authorizeMessagingGroup({
      platform: 'feishu',
      chatId: 'oc-governed-group',
      orgId: otherOrg.id,
      createdBy: otherOwner,
    })).toThrow(/already authorized to another organization/i);
  });

  it('requires a proven bot mention, exact group authorization and per-member rate budget', () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ownerId = `mention-owner-${suffix}`;
    const memberId = `mention-member-${suffix}`;
    const org = createOrg('Mention Group', `mention-group-${suffix}`, ownerId);
    addMember(org.id, ownerId, 'owner');
    addMember(org.id, memberId, 'member');
    const code = createBindingCode('feishu', memberId, org.id);
    consumeBindingCode('feishu', code.code, 'ou-governed-member', 'oc-private-member', 'private');
    authorizeMessagingGroup({
      platform: 'feishu',
      chatId: 'oc-governed-group',
      orgId: org.id,
      createdBy: ownerId,
    });

    expect(evaluateMessagingIngress(incoming({ botMentioned: false }))).toMatchObject({
      allowed: false,
      reason: 'group_not_mentioned',
    });
    for (let index = 0; index < 10; index += 1) {
      expect(evaluateMessagingIngress(incoming(), 1_000)).toMatchObject({ allowed: true });
    }
    expect(evaluateMessagingIngress(incoming(), 1_000)).toMatchObject({
      allowed: false,
      reason: 'rate_limited',
    });
    expect(evaluateMessagingIngress(incoming({ chatId: 'oc-unapproved' }), 1_000)).toMatchObject({
      allowed: false,
      reason: 'group_not_authorized',
    });
  });

  it('detects and removes the exact bot mention from Feishu group text', () => {
    const adapter = new FeishuAdapter({
      appId: 'cli_governance_test',
      appSecret: 'secret',
      botOpenId: 'ou-lumi-bot',
    });
    const parsed = adapter.parseEvent({
      sender: { sender_id: { open_id: 'ou-governed-member' } },
      message: {
        message_id: 'om-mentioned',
        chat_id: 'oc-governed-group',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 please review' }),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou-lumi-bot' }, name: 'Lumi' }],
        create_time: String(Date.now()),
      },
    });
    expect(parsed).toMatchObject({ botMentioned: true, text: 'please review' });
    expect(parsed?.mentionedUserIds).toEqual(['ou-lumi-bot']);
  });

  it('records an unknown reply outcome as terminal and does not send an error fallback', async () => {
    const message = incoming({ chatType: 'private', chatId: 'oc-private', botMentioned: true });
    let replyCalls = 0;
    expect(dispatchIncomingMessage(message, {
      enrich: async value => value,
      reply: async () => {
        replyCalls += 1;
        throw new MessagingDeliveryUnknownError('simulated response loss');
      },
    }, {
      onMessage: async value => ({ platform: value.platform, text: 'provider reply' }),
    })).toBe(true);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (listMessagingJournal().find(item => item.messageId === message.messageId)?.status === 'delivery_unknown') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(replyCalls).toBe(1);
    expect(listMessagingJournal().find(item => item.messageId === message.messageId)).toMatchObject({
      status: 'delivery_unknown',
      error: expect.stringContaining('response loss'),
    });
    expect(dispatchIncomingMessage(message, {
      enrich: async value => value,
      reply: async () => { replyCalls += 1; },
    })).toBe(false);
    expect(replyCalls).toBe(1);
  });

  it('persists an unknown provider result and blocks the same idempotent reply from resending', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        tenant_access_token: 'tenant-token',
        expire: 7200,
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockRejectedValueOnce(new TypeError('socket closed after request write'));
    const adapter = new FeishuAdapter({ appId: 'cli_governance_test', appSecret: 'secret' });

    await expect(adapter.replyMessage('om-unknown-reply', 'same immutable reply'))
      .rejects.toBeInstanceOf(MessagingDeliveryUnknownError);
    await expect(adapter.replyMessage('om-unknown-reply', 'same immutable reply'))
      .rejects.toThrow(/automatic resend was stopped/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain('uuid=');
  });

  it('requires exact confirmation and an immutable idempotency key for manual external sends', async () => {
    const adminToken = jwt.sign({ uid: 'messaging-admin', username: 'admin', role: 'admin' }, JWT_SECRET);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
    };
    const withoutConfirmation = await fetch(`${baseUrl}/api/feishu/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ chatId: 'oc_manual_target', text: 'approved body' }),
    });
    expect(withoutConfirmation.status).toBe(409);

    const realFetch = globalThis.fetch;
    const providerCalls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('open.feishu.cn/open-apis/auth/')) {
        providerCalls.push(url);
        return new Response(JSON.stringify({
          code: 0,
          tenant_access_token: 'tenant-manual',
          expire: 7200,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('open.feishu.cn/open-apis/im/')) {
        providerCalls.push(url);
        return new Response(JSON.stringify({
          code: 0,
          data: { message_id: 'om-manual-verified' },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input, init);
    });
    const request = {
      chatId: 'oc_manual_target',
      text: 'approved body',
      confirmed: true,
      idempotencyKey: `manual-feishu-${Date.now()}`,
    };
    const first = await fetch(`${baseUrl}/api/feishu/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ success: true, messageId: 'om-manual-verified' });

    const replay = await fetch(`${baseUrl}/api/feishu/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ success: true, messageId: 'om-manual-verified' });
    expect(providerCalls).toHaveLength(2);

    const changedPayload = await fetch(`${baseUrl}/api/feishu/send`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...request, text: 'changed after confirmation' }),
    });
    expect(changedPayload.status).toBe(409);
  });
});
