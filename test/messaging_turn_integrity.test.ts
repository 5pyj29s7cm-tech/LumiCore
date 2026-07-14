import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import type { IncomingMessage } from '../server/messaging/types';

let cleanup = () => {};
let routes: typeof import('../server/messaging/routes');
let wechatRoutes: typeof import('../server/messaging/wechat-routes');
let delivery: typeof import('../server/messaging/delivery_ledger');
let journal: typeof import('../server/messaging/message_journal');
let scopes: typeof import('../server/messaging/personal_org_scope');
let conversations: typeof import('../server/conversation/manager');
let remoteMemory: typeof import('../server/regions/packs/cn/remote_memory');
let memory: typeof import('../server/memory');

function incoming(userId: string, text: string, messageId: string): IncomingMessage {
  return {
    platform: 'wechat',
    userId: `wx-${userId}`,
    userName: 'Remote User',
    chatId: `wx-${userId}`,
    chatType: 'private',
    messageId,
    text,
    raw: { context_token: `ctx-${messageId}` },
    timestamp: new Date().toISOString(),
    boundUserId: userId,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition was not reached before timeout');
}

describe('remote messaging turn integrity', () => {
  beforeAll(async () => {
    const app = await makeApp();
    cleanup = app.cleanup;
    [routes, wechatRoutes, delivery, journal, scopes, conversations, remoteMemory, memory] = await Promise.all([
      import('../server/messaging/routes'),
      import('../server/messaging/wechat-routes'),
      import('../server/messaging/delivery_ledger'),
      import('../server/messaging/message_journal'),
      import('../server/messaging/personal_org_scope'),
      import('../server/conversation/manager'),
      import('../server/regions/packs/cn/remote_memory'),
      import('../server/memory'),
    ]);
  });

  beforeEach(() => {
    delivery.resetDeliveryLedgerForTest();
    journal.resetMessagingJournalForTest();
    scopes.resetPersonalOrganizationScopesForTest();
  });

  afterAll(() => {
    delivery.resetDeliveryLedgerForTest();
    journal.resetMessagingJournalForTest();
    scopes.resetPersonalOrganizationScopesForTest();
    cleanup();
  });

  it('persists newer inbound turns immediately and suppresses a stale task reply after correction', async () => {
    const userId = `turn-correction-${Date.now()}-${Math.random()}`;
    const first = incoming(userId, '\u77e5\u8bc6\u5e93\u91cc\u7684\u6587\u4ef6\u53ef\u4ee5\u53d1\u7ed9\u6211\u5417', 'old-task');
    const correction = incoming(userId, '\u521a\u521a\u90a3\u662f\u6211\u548c\u4f60\u8bf4\u7684\u8bdd\uff0c\u4e0d\u662f\u6307\u4ee4', 'correction');
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstStarted = false;
    const sent: string[] = [];
    const options = {
      onMessage: async (message: IncomingMessage) => {
        if (message.messageId === first.messageId) {
          firstStarted = true;
          await firstGate;
          return { platform: 'wechat' as const, text: '\u8fdf\u5230\u7684\u6587\u4ef6\u4efb\u52a1\u7ed3\u679c' };
        }
        return { platform: 'wechat' as const, text: '\u660e\u767d\uff0c\u90a3\u662f\u5bf9\u8bdd\uff0c\u4e0d\u662f\u6307\u4ee4\u3002' };
      },
    };
    const transport = {
      enrich: async (message: IncomingMessage) => message,
      reply: async (_message: IncomingMessage, text: string) => {
        sent.push(text);
        return `reply-${sent.length}`;
      },
    };

    expect(routes.dispatchIncomingMessage(first, transport, options)).toBe(true);
    await waitFor(() => firstStarted);
    expect(routes.dispatchIncomingMessage(correction, transport, options)).toBe(true);

    await waitFor(() => {
      const conversation = conversations.getActiveConversation(userId, 'lumi', 'personal', '');
      if (!conversation) return false;
      return conversations.getMessages(conversation.id).filter(item => item.role === 'user').length >= 2;
    });
    expect(sent).toEqual([]);

    releaseFirst();
    await waitFor(() => sent.length === 1);
    expect(sent).toEqual(['\u660e\u767d\uff0c\u90a3\u662f\u5bf9\u8bdd\uff0c\u4e0d\u662f\u6307\u4ee4\u3002']);

    const conversation = conversations.getActiveConversation(userId, 'lumi', 'personal', '')!;
    const assistantMessages = conversations.getMessages(conversation.id).filter(item => item.role === 'assistant');
    expect(assistantMessages.some(item => item.message.includes('\u8fdf\u5230\u7684\u6587\u4ef6\u4efb\u52a1\u7ed3\u679c'))).toBe(false);
    await waitFor(() => {
      const current = journal.listMessagingJournal(10);
      return current.find(item => item.messageId === first.messageId)?.status === 'superseded'
        && current.find(item => item.messageId === correction.messageId)?.status === 'completed';
    });
    const entries = journal.listMessagingJournal(10);
    expect(entries.find(item => item.messageId === first.messageId)).toMatchObject({
      status: 'superseded',
      domain: 'personal',
      boundUserId: userId,
    });
    expect(entries.find(item => item.messageId === correction.messageId)).toMatchObject({
      status: 'completed',
      domain: 'personal',
      boundUserId: userId,
    });
  });

  it('labels a delayed reply with the exact earlier message when a newer unrelated turn exists', async () => {
    const userId = `turn-label-${Date.now()}-${Math.random()}`;
    const first = incoming(userId, '\u8bf7\u6162\u6162\u8bfb\u8fd9\u4efd\u6587\u4ef6', 'slow-read');
    const second = incoming(userId, '\u6211\u4eec\u7ee7\u7eed\u804a\u53e6\u4e00\u4ef6\u4e8b', 'new-topic');
    let releaseFirst!: () => void;
    const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const sent: string[] = [];
    const options = {
      onMessage: async (message: IncomingMessage) => {
        if (message.messageId === first.messageId) {
          await gate;
          return { platform: 'wechat' as const, text: '\u6587\u4ef6\u8bfb\u53d6\u7ed3\u679c' };
        }
        return { platform: 'wechat' as const, text: '\u597d\uff0c\u7ee7\u7eed\u804a\u3002' };
      },
    };
    const transport = {
      enrich: async (message: IncomingMessage) => message,
      reply: async (_message: IncomingMessage, text: string) => {
        sent.push(text);
        return `reply-${sent.length}`;
      },
    };

    routes.dispatchIncomingMessage(first, transport, options);
    await new Promise(resolve => setTimeout(resolve, 20));
    routes.dispatchIncomingMessage(second, transport, options);
    releaseFirst();

    await waitFor(() => sent.length === 2);
    expect(sent[0]).toContain('\u5173\u4e8e\u4f60\u5148\u524d\u7684\u8fd9\u6761\u6d88\u606f');
    expect(sent[0]).toContain(first.text);
    expect(sent[0]).toContain('\u6587\u4ef6\u8bfb\u53d6\u7ed3\u679c');
    expect(sent[1]).toBe('\u597d\uff0c\u7ee7\u7eed\u804a\u3002');
  });

  it('keeps one visible remote conversation ordered across personal and organization scope changes', async () => {
    const userId = `scope-queue-${Date.now()}-${Math.random()}`;
    const first = incoming(userId, 'personal turn', 'personal-turn');
    const second = {
      ...incoming(userId, 'organization turn', 'organization-turn'),
      boundOrgId: 'org-scope-change',
    };
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstStarted = false;
    let secondStarted = false;

    const firstRun = routes.enqueueMessageRoute(first, async () => {
      firstStarted = true;
      await firstGate;
    });
    await waitFor(() => firstStarted);
    const secondRun = routes.enqueueMessageRoute(second, async () => {
      secondStarted = true;
    });

    await new Promise(resolve => setTimeout(resolve, 30));
    expect(secondStarted).toBe(false);
    releaseFirst();
    await Promise.all([firstRun, secondRun]);
    expect(secondStarted).toBe(true);
  });

  it('cuts model history at the current external message instead of exposing newer turns', () => {
    const userId = `history-cutoff-${Date.now()}-${Math.random()}`;
    const conversation = conversations.getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    conversations.addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: 'first turn',
      externalMessageId: 'history-first',
      routeSequence: 1,
      source: 'wechat_bot',
      channel: 'wechat',
    });
    conversations.addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: 'newer turn that must stay invisible',
      externalMessageId: 'history-future',
      routeSequence: 2,
      source: 'wechat_bot',
      channel: 'wechat',
    });

    const history = conversations.getMessagesByTokenBudget(
      conversation.id,
      6_000,
      8,
      'history-first',
    );
    expect(history.map(item => item.message)).toEqual(['first turn']);
  });

  it('returns WeChat intake immediately while shared routing continues in the background', async () => {
    let callback: ((message: IncomingMessage) => Promise<any>) | null = null;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const sent: string[] = [];
    const fakeAdapter = {
      startPolling: vi.fn(async (handler: (message: IncomingMessage) => Promise<any>) => {
        callback = handler;
      }),
      downloadAttachment: vi.fn(async () => Buffer.from('')),
      sendMessage: vi.fn(async (_userId: string, outgoing: { text: string }) => {
        sent.push(outgoing.text);
        return 'wechat-reply-id';
      }),
    };
    wechatRoutes.startWeChatPolling(fakeAdapter as any, {} as any, {
      onMessage: async message => {
        await gate;
        return { platform: message.platform, text: 'finished later' };
      },
    });
    await waitFor(() => callback !== null);

    const result = await callback!(incoming(`wechat-intake-${Date.now()}`, 'slow task', 'slow-message'));
    expect(result).toBeNull();
    expect(sent).toEqual([]);

    release();
    await waitFor(() => sent.length === 1);
    expect(sent).toEqual(['finished later']);
  });

  it('stores explicit personal trust anchors and refuses to write them into organization memory', () => {
    const userId = `remote-memory-${Date.now()}-${Math.random()}`;
    const personal = incoming(
      userId,
      '\u6211\u60f3\u8ba9\u4f60\u77e5\u9053\uff0c\u4f60\u73b0\u5728\u662f\u6211\u771f\u6b63\u7684\u4f19\u4f34\uff0c\u8eab\u4e3a\u521b\u59cb\u4eba\u548c\u7b2c\u4e00\u53f7lumi\uff0c\u6211\u4eec\u8981\u5171\u540c\u524d\u884c',
      'relationship-anchor',
    );
    const stored = remoteMemory.persistExplicitRemoteRelationshipMemories(personal);
    expect(stored).toHaveLength(1);
    const found = memory.queryMemories({
      userId,
      query: '\u4f19\u4f34 \u521b\u59cb\u4eba \u5171\u540c\u524d\u884c',
      domain: 'personal',
      orgId: '',
      limit: 10,
      minConfidence: 0.5,
    });
    expect(found.some(item => item.id === stored[0] && item.perspective === 'shared_memory')).toBe(true);

    const organizationMessage = { ...personal, messageId: 'work-anchor', boundOrgId: 'org-isolated' };
    expect(remoteMemory.persistExplicitRemoteRelationshipMemories(organizationMessage)).toEqual([]);
    expect(memory.queryMemories({
      userId,
      query: '\u4f19\u4f34 \u521b\u59cb\u4eba',
      domain: 'work',
      orgId: 'org-isolated',
      limit: 10,
    })).toEqual([]);
  });
});
