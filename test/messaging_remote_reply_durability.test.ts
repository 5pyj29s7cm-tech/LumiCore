import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import type { IncomingMessage } from '../server/messaging/types';

const durability = vi.hoisted(() => ({
  flush: vi.fn<() => Promise<void>>(),
}));

vi.mock('../db_layer', async importOriginal => {
  const actual = await importOriginal<typeof import('../db_layer')>();
  return {
    ...actual,
    flushDBOrThrow: durability.flush,
  };
});

let cleanup = () => {};
let routes: typeof import('../server/regions/packs/cn/messaging_routes');
let conversations: typeof import('../server/conversation/manager');
let delivery: typeof import('../server/messaging/delivery_ledger');
let journal: typeof import('../server/messaging/message_journal');
let scopes: typeof import('../server/messaging/personal_org_scope');
let confirmations: typeof import('../server/tools/pending_confirmation');
let confirmationRepository: typeof import('../server/tools/pending_confirmation_repository');
let bindings: typeof import('../server/messaging/bindings');
let orgDb: typeof import('../server/org/db');

function incoming(userId: string, text: string, messageId: string): IncomingMessage {
  return {
    platform: 'wechat',
    userId: `wx-${userId}`,
    userName: 'Durability User',
    chatId: `wx-${userId}`,
    chatType: 'private',
    messageId,
    text,
    raw: { context_token: `context-${messageId}` },
    timestamp: new Date().toISOString(),
    boundUserId: userId,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition was not reached before timeout');
}

function journalStatus(messageId: string): string {
  return journal.listMessagingJournal(50).find(item => item.messageId === messageId)?.status || '';
}

describe('remote reply durability boundary', () => {
  beforeAll(async () => {
    const app = await makeApp();
    cleanup = app.cleanup;
    [routes, conversations, delivery, journal, scopes, confirmations, confirmationRepository, bindings, orgDb] = await Promise.all([
      import('../server/regions/packs/cn/messaging_routes'),
      import('../server/conversation/manager'),
      import('../server/messaging/delivery_ledger'),
      import('../server/messaging/message_journal'),
      import('../server/messaging/personal_org_scope'),
      import('../server/tools/pending_confirmation'),
      import('../server/tools/pending_confirmation_repository'),
      import('../server/messaging/bindings'),
      import('../server/org/db'),
    ]);
  });

  beforeEach(() => {
    durability.flush.mockReset();
    durability.flush.mockResolvedValue(undefined);
    delivery.resetDeliveryLedgerForTest();
    journal.resetMessagingJournalForTest();
    scopes.resetPersonalOrganizationScopesForTest();
    confirmations.clearAllPendingConfirmationsForTests();
    confirmationRepository.resetPendingConfirmationRepositoryForTests();
    bindings.resetMessagingBindingsForTest();
  });

  afterAll(() => {
    delivery.resetDeliveryLedgerForTest();
    journal.resetMessagingJournalForTest();
    scopes.resetPersonalOrganizationScopesForTest();
    confirmations.clearAllPendingConfirmationsForTests();
    confirmationRepository.resetPendingConfirmationRepositoryForTests();
    bindings.resetMessagingBindingsForTest();
    cleanup();
  });

  it('remote_attachment_enrichment_starts_only_after_accepted_turn_flush', async () => {
    const userId = `attachment-fence-${Date.now()}-${Math.random()}`;
    const message: IncomingMessage = {
      ...incoming(userId, '请阅读附件', `attachment-fence-${Date.now()}`),
      attachments: [{ id: 'attachment-1', type: 'file', fileName: 'evidence.txt' }],
    };
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>(resolve => { releaseFlush = resolve; });
    const order: string[] = [];
    durability.flush
      .mockImplementationOnce(async () => {
        order.push('flush:accepted:start');
        await flushGate;
        order.push('flush:accepted:end');
      })
      .mockImplementation(async () => {
        order.push('flush:terminal');
      });

    routes.dispatchIncomingMessage(message, {
      enrich: async value => {
        order.push('enrich');
        return value;
      },
      reply: async () => 'attachment-reply',
    }, {
      onMessage: async value => ({ platform: value.platform, text: '附件已读取。' }),
    });

    await waitFor(() => order.includes('flush:accepted:start'));
    expect(order).toEqual(['flush:accepted:start']);
    releaseFlush();
    await waitFor(() => journalStatus(message.messageId) === 'completed');
    expect(order.indexOf('enrich')).toBeGreaterThan(order.indexOf('flush:accepted:end'));
  });

  it('failed_remote_admission_leaves_no_attachment_artifact', async () => {
    const userId = `attachment-reject-${Date.now()}-${Math.random()}`;
    const message: IncomingMessage = {
      ...incoming(userId, '请读取附件', `attachment-reject-${Date.now()}`),
      attachments: [{ id: 'attachment-reject', type: 'file', fileName: 'must-not-exist.txt' }],
    };
    let artifactCreated = false;
    durability.flush.mockRejectedValueOnce(new Error('accepted transcript storage unavailable'));

    routes.dispatchIncomingMessage(message, {
      enrich: async value => {
        artifactCreated = true;
        return value;
      },
      reply: async () => 'must-not-send',
    });

    await waitFor(() => journalStatus(message.messageId) === 'delivery_unknown');
    expect(artifactCreated).toBe(false);
  });

  it('failed_remote_admission_does_not_mutate_personal_org_scope', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const userId = `scope-reject-${suffix}`;
    const org = orgDb.createOrg('Admission Fence Firm', `admission-fence-${suffix}`, userId);
    orgDb.addMember(org.id, userId, 'owner');
    const message = incoming(userId, '查看组织案件', `scope-reject-${Date.now()}`);
    durability.flush.mockRejectedValueOnce(new Error('accepted transcript storage unavailable'));

    routes.dispatchIncomingMessage(message, {
      enrich: async value => value,
      reply: async () => 'must-not-send',
    });

    await waitFor(() => journalStatus(message.messageId) === 'delivery_unknown');
    const followUp = scopes.planPersonalOrganizationScope(
      incoming(userId, '继续整理', `scope-follow-up-${Date.now()}`),
      false,
    );
    expect(followUp.resolution.kind).toBe('personal');
  });

  it('binding_code_is_not_consumed_before_durable_remote_admission', async () => {
    const lumiUserId = `binding-fence-${Date.now()}-${Math.random()}`;
    const platformUserId = `wx-binding-fence-${Date.now()}`;
    const code = bindings.createBindingCode('wechat', lumiUserId, '', 'personal');
    const message: IncomingMessage = {
      ...incoming(lumiUserId, `绑定 Lumi ${code.code}`, `binding-fence-${Date.now()}`),
      userId: platformUserId,
      chatId: platformUserId,
      boundUserId: undefined,
    };
    let releaseFlush!: () => void;
    const flushGate = new Promise<void>(resolve => { releaseFlush = resolve; });
    durability.flush
      .mockImplementationOnce(async () => flushGate)
      .mockResolvedValue(undefined);
    const replies: string[] = [];

    routes.dispatchIncomingMessage(message, {
      enrich: async value => value,
      reply: async (_value, text) => {
        replies.push(text);
        return 'binding-reply';
      },
    });

    await waitFor(() => durability.flush.mock.calls.length === 1);
    expect(bindings.listActiveBindingCodesForUser(lumiUserId, 'wechat', 'personal'))
      .toEqual([expect.objectContaining({ code: code.code })]);
    expect(bindings.getBinding('wechat', platformUserId, platformUserId, 'private')).toBeNull();
    expect(replies).toEqual([]);

    releaseFlush();
    await waitFor(() => journalStatus(message.messageId) === 'completed');
    expect(bindings.listActiveBindingCodesForUser(lumiUserId, 'wechat', 'personal')).toEqual([]);
    expect(bindings.getBinding('wechat', platformUserId, platformUserId, 'private')).toMatchObject({
      lumiUserId,
      domain: 'personal',
    });
    expect(replies).toHaveLength(1);
  });

  it('restores a binding code after a durability failure and accepts the exact retry', async () => {
    const lumiUserId = `binding-retry-${Date.now()}-${Math.random()}`;
    const platformUserId = `wx-binding-retry-${Date.now()}`;
    const code = bindings.createBindingCode('wechat', lumiUserId, '', 'personal');
    const message: IncomingMessage = {
      ...incoming(lumiUserId, `绑定 Lumi ${code.code}`, `binding-retry-${Date.now()}`),
      userId: platformUserId,
      chatId: platformUserId,
      boundUserId: undefined,
    };
    const replies: string[] = [];
    const transport = {
      enrich: async (value: IncomingMessage) => value,
      reply: async (_value: IncomingMessage, text: string) => {
        replies.push(text);
        return 'binding-retry-reply';
      },
    };
    durability.flush.mockRejectedValueOnce(new Error('accepted binding transcript unavailable'));

    expect(routes.dispatchIncomingMessage(message, transport)).toBe(true);
    await waitFor(() => journalStatus(message.messageId) === 'failed');
    expect(bindings.listActiveBindingCodesForUser(lumiUserId, 'wechat', 'personal'))
      .toEqual([expect.objectContaining({ code: code.code })]);
    expect(bindings.getBinding('wechat', platformUserId, platformUserId, 'private')).toBeNull();
    expect(replies).toEqual([]);

    durability.flush.mockResolvedValue(undefined);
    expect(routes.dispatchIncomingMessage(message, transport)).toBe(true);
    await waitFor(() => journalStatus(message.messageId) === 'completed');
    expect(bindings.getBinding('wechat', platformUserId, platformUserId, 'private'))
      .toMatchObject({ lumiUserId, domain: 'personal' });
    expect(replies).toHaveLength(1);
  });

  it('retries only the durable binding reply after an unknown transport outcome', async () => {
    const lumiUserId = `binding-delivery-${Date.now()}-${Math.random()}`;
    const platformUserId = `wx-binding-delivery-${Date.now()}`;
    const code = bindings.createBindingCode('wechat', lumiUserId, '', 'personal');
    const message: IncomingMessage = {
      ...incoming(lumiUserId, `绑定 Lumi ${code.code}`, `binding-delivery-${Date.now()}`),
      userId: platformUserId,
      chatId: platformUserId,
      boundUserId: undefined,
    };
    let replyAttempts = 0;
    const replyTexts: string[] = [];
    const transport = {
      enrich: async (value: IncomingMessage) => value,
      reply: async (_value: IncomingMessage, text: string) => {
        replyAttempts += 1;
        replyTexts.push(text);
        if (replyAttempts === 1) throw new Error('remote transport acknowledgement lost');
        return 'binding-delivery-retry';
      },
    };

    expect(routes.dispatchIncomingMessage(message, transport)).toBe(true);
    await waitFor(() => journalStatus(message.messageId) === 'delivery_unknown');
    expect(bindings.getBinding('wechat', platformUserId, platformUserId, 'private'))
      .toMatchObject({ lumiUserId, domain: 'personal' });
    expect(bindings.listActiveBindingCodesForUser(lumiUserId, 'wechat', 'personal')).toEqual([]);

    expect(routes.dispatchIncomingMessage(message, transport)).toBe(true);
    await waitFor(() => journalStatus(message.messageId) === 'completed');
    expect(replyAttempts).toBe(2);
    expect(replyTexts[1]).toBe(replyTexts[0]);
    expect(bindings.listBindingsForUser(lumiUserId)).toHaveLength(1);
  });

  it('unrelated_remote_turn_revokes_taskless_confirmation_before_later_ok', async () => {
    const userId = `remote-taskless-${Date.now()}-${Math.random()}`;
    const conversation = conversations.getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const channelScope = confirmations.buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId: conversation.id,
    });
    await confirmationRepository.ensurePendingConfirmationPersistenceInitialized();
    await confirmations.recordPendingConfirmationDurably(
      userId,
      'client_action',
      { action: 'set_client_mode', mode: 'focus', confirmed: false },
      'wechat_bot',
      channelScope,
    );
    expect(await confirmations.getPendingConfirmationDurably(userId, channelScope)).not.toBeNull();

    const executor = vi.fn(async () => JSON.stringify({ ok: true }));
    const replies: string[] = [];
    const transport = {
      enrich: async (value: IncomingMessage) => value,
      reply: async (_value: IncomingMessage, text: string) => {
        replies.push(text);
        return `reply-${replies.length}`;
      },
    };
    const options = {
      onMessage: async (value: IncomingMessage) => ({
        platform: value.platform,
        text: value.text === '\u51e0\u70b9\u4e86' ? 'This is a new time query.' : 'Acknowledged.',
      }),
      createScopedDesktopRelay: () => executor,
    };

    const unrelated = incoming(userId, '\u51e0\u70b9\u4e86', `unrelated-${Date.now()}`);
    expect(routes.dispatchIncomingMessage(unrelated, transport, options)).toBe(true);
    await waitFor(() => journalStatus(unrelated.messageId) === 'completed');
    expect(await confirmations.getPendingConfirmationDurably(userId, channelScope)).toBeNull();

    const laterOk = incoming(userId, '\u597d\u7684', `later-ok-${Date.now()}`);
    expect(routes.dispatchIncomingMessage(laterOk, transport, options)).toBe(true);
    await waitFor(() => journalStatus(laterOk.messageId) === 'completed');

    expect(executor).toHaveBeenCalledTimes(0);
    expect(await confirmations.getPendingConfirmationDurably(userId, channelScope)).toBeNull();
    expect(replies).toHaveLength(2);
  });

  it('persists a direct exchange and flushes it before transport delivery', async () => {
    const userId = `direct-durable-${Date.now()}-${Math.random()}`;
    const message = incoming(userId, '退出组织', `direct-${Date.now()}`);
    const order: string[] = [];
    durability.flush.mockImplementation(async () => {
      const conversation = conversations.getActiveConversation(userId, 'lumi', 'personal', '');
      const hasAssistant = conversation
        ? conversations.getMessages(conversation.id).some(item => item.role === 'assistant')
        : false;
      order.push(hasAssistant ? 'flush:terminal' : 'flush:accepted');
    });

    expect(routes.dispatchIncomingMessage(message, {
      enrich: async value => value,
      reply: async () => {
        const conversation = conversations.getActiveConversation(userId, 'lumi', 'personal', '');
        const assistant = conversation
          ? conversations.getMessages(conversation.id).find(item => item.role === 'assistant')
          : null;
        order.push(`reply:${Boolean(assistant)}`);
        return 'direct-reply-id';
      },
    }, {
      onConversationUpdated: update => {
        const record = conversations.getMessages(update.conversationId)
          .find(item => item.id === update.messageId);
        order.push(`notify:${record?.role || 'missing'}`);
      },
    })).toBe(true);

    await waitFor(() => journalStatus(message.messageId) === 'completed');
    expect(order).toEqual([
      'notify:user',
      'flush:accepted',
      'flush:terminal',
      'notify:assistant',
      'reply:true',
    ]);
  });

  it('does not deliver a direct exchange when its terminal flush fails', async () => {
    const userId = `direct-unknown-${Date.now()}-${Math.random()}`;
    const message = incoming(userId, '退出组织', `direct-unknown-${Date.now()}`);
    let replies = 0;
    durability.flush
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('direct exchange storage unavailable'));

    expect(routes.dispatchIncomingMessage(message, {
      enrich: async value => value,
      reply: async () => {
        replies += 1;
        return 'must-not-send';
      },
    })).toBe(true);

    await waitFor(() => journalStatus(message.messageId) === 'delivery_unknown');
    expect(replies).toBe(0);
    expect(routes.dispatchIncomingMessage(message, {
      enrich: async value => value,
      reply: async () => {
        replies += 1;
        return 'must-not-send';
      },
    })).toBe(false);
    expect(replies).toBe(0);
  });

  it('flushes the assistant transcript and released action lease before a normal reply', async () => {
    const userId = `success-durable-${Date.now()}-${Math.random()}`;
    const message = incoming(
      userId,
      '请执行任务：使用 web_search 搜索公开资料并整理结果',
      `success-${Date.now()}`,
    );
    const order: string[] = [];
    durability.flush.mockImplementation(async () => {
      if (order.includes('callback')) {
        const conversation = conversations.getActiveConversation(userId, 'lumi', 'personal', '');
        expect(conversation?.actionContinuationState?.taskId).toBeTruthy();
        expect(conversation?.actionContinuationState?.activeRequestId).toBeFalsy();
        expect(conversation
          ? conversations.getMessages(conversation.id).some(item => item.role === 'assistant')
          : false).toBe(true);
      }
      order.push(order.includes('callback') ? 'flush:terminal' : 'flush:accepted');
    });

    routes.dispatchIncomingMessage(message, {
      enrich: async value => value,
      reply: async () => {
        const conversation = conversations.getActiveConversation(userId, 'lumi', 'personal', '');
        const assistant = conversation
          ? conversations.getMessages(conversation.id).find(item => item.role === 'assistant')
          : null;
        order.push(`reply:${Boolean(assistant)}:${Boolean(conversation?.actionContinuationState?.activeRequestId)}`);
        return 'success-reply-id';
      },
    }, {
      onMessage: async value => {
        order.push('callback');
        return { platform: value.platform, text: '已完成可持久回复。' };
      },
      onConversationUpdated: update => {
        const record = conversations.getMessages(update.conversationId)
          .find(item => item.id === update.messageId);
        order.push(`notify:${record?.role || 'missing'}`);
      },
    });

    await waitFor(() => journalStatus(message.messageId) === 'completed');
    expect(order).toEqual([
      'notify:user',
      'flush:accepted',
      'callback',
      'flush:terminal',
      'notify:assistant',
      'reply:true:false',
    ]);
  });

  it('persists and flushes the terminal failure reply before sending it', async () => {
    const userId = `failure-durable-${Date.now()}-${Math.random()}`;
    const message = incoming(userId, '请执行这个任务', `failure-${Date.now()}`);
    const order: string[] = [];
    durability.flush.mockImplementation(async () => {
      if (order.includes('pipeline:failed')) {
        const conversation = conversations.getActiveConversation(userId, 'lumi', 'personal', '');
        expect(conversation?.actionContinuationState?.taskId).toBeTruthy();
        expect(conversation?.actionContinuationState?.activeRequestId).toBeFalsy();
        expect(conversation
          ? conversations.getMessages(conversation.id).some(item => item.role === 'assistant')
          : false).toBe(true);
      }
      order.push(order.includes('pipeline:failed') ? 'flush:terminal' : 'flush:accepted');
    });

    routes.dispatchIncomingMessage(message, {
      enrich: async value => value,
      reply: async (_value, text) => {
        const conversation = conversations.getActiveConversation(userId, 'lumi', 'personal', '');
        const assistant = conversation
          ? conversations.getMessages(conversation.id).find(item => item.role === 'assistant')
          : null;
        expect(assistant?.message).toBe(text);
        order.push(`reply:${Boolean(assistant)}:${Boolean(conversation?.actionContinuationState?.activeRequestId)}`);
        return 'failure-reply-id';
      },
    }, {
      onMessage: async () => {
        order.push('pipeline:failed');
        throw new Error('model unavailable');
      },
      onConversationUpdated: update => {
        const record = conversations.getMessages(update.conversationId)
          .find(item => item.id === update.messageId);
        order.push(`persist:${record?.role || 'missing'}`);
      },
    });

    await waitFor(() => journalStatus(message.messageId) === 'completed');
    expect(order).toEqual([
      'persist:user',
      'flush:accepted',
      'pipeline:failed',
      'persist:assistant',
      'flush:terminal',
      'reply:true:false',
    ]);
  });

  it('keeps a terminal flush failure delivery-unknown and deduplicates the retry without rerunning work', async () => {
    const userId = `unknown-durable-${Date.now()}-${Math.random()}`;
    const message = incoming(
      userId,
      '请执行任务：使用 web_search 搜索资料',
      `unknown-${Date.now()}`,
    );
    let flushCount = 0;
    let pipelineExecutions = 0;
    let replies = 0;
    durability.flush.mockImplementation(async () => {
      flushCount += 1;
      if (flushCount === 2) throw new Error('durable storage unavailable');
    });

    const transport = {
      enrich: async (value: IncomingMessage) => value,
      reply: async () => {
        replies += 1;
        return 'must-not-send';
      },
    };
    const options = {
      onMessage: async (value: IncomingMessage) => {
        pipelineExecutions += 1;
        return { platform: value.platform, text: '工具任务结果' };
      },
    };

    expect(routes.dispatchIncomingMessage(message, transport, options)).toBe(true);
    await waitFor(() => journalStatus(message.messageId) === 'delivery_unknown');
    expect({ flushCount, pipelineExecutions, replies }).toEqual({
      flushCount: 2,
      pipelineExecutions: 1,
      replies: 0,
    });

    expect(routes.dispatchIncomingMessage(message, transport, options)).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect({ flushCount, pipelineExecutions, replies }).toEqual({
      flushCount: 2,
      pipelineExecutions: 1,
      replies: 0,
    });
    expect(journalStatus(message.messageId)).toBe('delivery_unknown');
  });
});
