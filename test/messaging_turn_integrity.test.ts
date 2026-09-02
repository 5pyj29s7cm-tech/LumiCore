import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApp } from './helpers';
import type { IncomingMessage } from '../server/messaging/types';

let cleanup = () => {};
let routes: typeof import('../server/messaging/routes');
let wechatRoutes: typeof import('../server/messaging/wechat-routes');
let delivery: typeof import('../server/messaging/delivery_ledger');
let journal: typeof import('../server/messaging/message_journal');
let scopes: typeof import('../server/messaging/personal_org_scope');
let pendingLegal: typeof import('../server/messaging/legal_notice_pending');
let conversations: typeof import('../server/conversation/manager');
let remoteMemory: typeof import('../server/regions/packs/cn/remote_memory');
let memory: typeof import('../server/memory');
let dbLayer: typeof import('../db_layer');

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
    [routes, wechatRoutes, delivery, journal, scopes, pendingLegal, conversations, remoteMemory, memory, dbLayer] = await Promise.all([
      import('../server/messaging/routes'),
      import('../server/messaging/wechat-routes'),
      import('../server/messaging/delivery_ledger'),
      import('../server/messaging/message_journal'),
      import('../server/messaging/personal_org_scope'),
      import('../server/messaging/legal_notice_pending'),
      import('../server/conversation/manager'),
      import('../server/regions/packs/cn/remote_memory'),
      import('../server/memory'),
      import('../db_layer'),
    ]);
  });

  beforeEach(() => {
    delivery.resetDeliveryLedgerForTest();
    journal.resetMessagingJournalForTest();
    scopes.resetPersonalOrganizationScopesForTest();
    pendingLegal.resetPendingLegalNoticesForTest();
  });

  afterAll(() => {
    delivery.resetDeliveryLedgerForTest();
    journal.resetMessagingJournalForTest();
    scopes.resetPersonalOrganizationScopesForTest();
    pendingLegal.resetPendingLegalNoticesForTest();
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

  it('suppresses every delayed reply once a newer unrelated turn is accepted', async () => {
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

    await waitFor(() => sent.length === 1);
    expect(sent).toEqual(['\u597d\uff0c\u7ee7\u7eed\u804a\u3002']);
    await waitFor(() => journal.listMessagingJournal(10)
      .find(item => item.messageId === first.messageId)?.status === 'superseded');
  });

  it('removes an obsolete assistant row when a newer turn arrives during the terminal flush', async () => {
    const userId = `terminal-flush-race-${Date.now()}-${Math.random()}`;
    const first = incoming(userId, '先回答旧问题', 'terminal-flush-old');
    const second = incoming(userId, '改为只回答新问题', 'terminal-flush-new');
    let releaseTerminalFlush!: () => void;
    const terminalFlushGate = new Promise<void>(resolve => { releaseTerminalFlush = resolve; });
    let terminalFlushReached = false;
    const originalFlush = dbLayer.flushDBOrThrow;
    const flushSpy = vi.spyOn(dbLayer, 'flushDBOrThrow').mockImplementation(async () => {
      const conversation = conversations.getActiveConversation(userId, 'lumi', 'personal', '');
      const hasOldAssistant = Boolean(conversation && conversations.getMessages(conversation.id)
        .some(item => item.role === 'assistant' && item.message.includes('旧回复绝不能保留')));
      if (hasOldAssistant && !terminalFlushReached) {
        terminalFlushReached = true;
        await terminalFlushGate;
      }
      await originalFlush();
    });
    const sent: string[] = [];
    const transport = {
      enrich: async (message: IncomingMessage) => message,
      reply: async (_message: IncomingMessage, text: string) => {
        sent.push(text);
        return `flush-race-${sent.length}`;
      },
    };
    const options = {
      onMessage: async (message: IncomingMessage) => ({
        platform: 'wechat' as const,
        text: message.messageId === first.messageId ? '旧回复绝不能保留' : '只保留新回复',
      }),
    };

    routes.dispatchIncomingMessage(first, transport, options);
    await waitFor(() => terminalFlushReached);
    routes.dispatchIncomingMessage(second, transport, options);
    releaseTerminalFlush();
    await waitFor(() => sent.length === 1, 5_000);

    expect(sent).toEqual(['只保留新回复']);
    const conversation = conversations.getActiveConversation(userId, 'lumi', 'personal', '')!;
    const assistantMessages = conversations.getMessages(conversation.id).filter(item => item.role === 'assistant');
    expect(assistantMessages.some(item => item.message.includes('旧回复绝不能保留'))).toBe(false);
    expect(assistantMessages.some(item => item.message.includes('只保留新回复'))).toBe(true);
    flushSpy.mockRestore();
  });

  it('aborts an active remote model request when the next user message arrives', async () => {
    const userId = `turn-abort-${Date.now()}-${Math.random()}`;
    const first = incoming(userId, '你好，我们随便聊两句', 'active-model-turn');
    const second = incoming(userId, '我们换个话题', 'replacement-model-turn');
    let firstStarted = false;
    let firstAborted = false;
    const sent: string[] = [];
    const create = vi.fn(async (params: any, requestOptions?: { signal?: AbortSignal }) => {
      const latestUserText = [...(params.messages || [])].reverse()
        .find((item: any) => item.role === 'user')?.content || '';
      if (String(latestUserText).includes(first.text)) {
        firstStarted = true;
        return new Promise((_resolve, reject) => {
          const signal = requestOptions?.signal;
          const abort = () => {
            firstAborted = true;
            const error = new Error('superseded');
            error.name = 'AbortError';
            reject(error);
          };
          if (signal?.aborted) abort();
          else signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return {
        choices: [{ message: { content: '只回复最新消息' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    });
    const transport = {
      enrich: async (message: IncomingMessage) => message,
      reply: async (_message: IncomingMessage, text: string) => {
        sent.push(text);
        return `reply-${sent.length}`;
      },
    };
    const options = {
      llmGetters: {
        getDeepSeek: () => ({ chat: { completions: { create } } }),
      },
    };

    routes.dispatchIncomingMessage(first, transport, options);
    await waitFor(() => firstStarted);
    routes.dispatchIncomingMessage(second, transport, options);

    await waitFor(() => firstAborted);
    await waitFor(() => sent.length === 1, 5_000);
    expect(sent).toEqual(['只回复最新消息']);
  });

  it('keeps exact filenames and paths from persisted file receipts', () => {
    const exactPath = 'C:\\Users\\ExampleUser\\Desktop\\Lumi_\u8def\u6f14.pptx';
    const context = routes.buildRemoteRuntimeEvidenceContext([{
      toolCalls: [{
        name: 'desktop_list_files',
        result: JSON.stringify({
          originalCount: 26,
          entries: [{ name: 'Lumi_\u8def\u6f14.pptx', path: exactPath }],
        }),
      }],
    }]);

    expect(context).toContain('name="Lumi_\u8def\u6f14.pptx"');
    expect(context).toContain(JSON.stringify(exactPath));
    expect(context).toContain('immutable identifiers');
    expect(context).not.toContain('Lumi\u8def\u6f14.pptx');
  });

  it('keeps exact file identities from array receipts without treating ordinary item names as files', () => {
    const exactPath = 'D:\\客户资料\\合同_最终版.docx';
    const fileContext = routes.buildRemoteRuntimeEvidenceContext([{
      toolCalls: [{
        name: 'desktop_list_files',
        result: JSON.stringify([{ name: '合同_最终版.docx', path: exactPath }]),
      }],
    }]);
    expect(fileContext).toContain('name="合同_最终版.docx"');
    expect(fileContext).toContain(JSON.stringify(exactPath));

    const nonFileContext = routes.buildRemoteRuntimeEvidenceContext([{
      toolCalls: [{
        name: 'runtime_work_status',
        result: JSON.stringify({ items: [{ name: '整理客户资料' }] }),
      }],
    }]);
    expect(nonFileContext).not.toContain('exact file identities');
    expect(nonFileContext).not.toContain('name="整理客户资料"');
  });

  it('carries a verified single-file read target into the next remote turn without trusting model prose', () => {
    const exactPath = 'D:\\客户资料\\合同_终审版.docx';
    const inventedPath = 'D:\\模型猜测\\合同.docx';
    const requestId = 'wechat_bot:read-one-current';
    const context = routes.buildRemoteRuntimeEvidenceContext([{
      role: 'assistant',
      requestId,
      message: `我猜文件可能在 ${inventedPath}`,
      toolCalls: [{
        name: 'read_file',
        arguments: { path: exactPath },
        result: JSON.stringify({ content: `document body mentioning ${inventedPath}` }),
        adapterStarted: true,
        taskId: 'remote-read-task',
        requestId,
        terminalVerification: {
          status: 'verified',
          strategy: 'terminal_receipt',
          reason: 'the exact file returned content',
        },
        envelope: {
          version: 1,
          status: 'verified_success',
          toolName: 'read_file',
          taskId: 'remote-read-task',
          turnId: requestId,
          requestId,
          idempotencyKey: 'read-one',
          targetIdentity: exactPath,
          completedAt: new Date().toISOString(),
          result: { fileName: '合同_终审版.docx', path: exactPath },
          verification: { status: 'verified', reason: 'terminal receipt' },
        },
      }],
    }, {
      role: 'user',
      requestId: 'wechat_bot:read-one-followup',
      message: '继续处理刚才那个文件。',
    }]);

    expect(context).toContain('read_file: exact file identities from execution envelope');
    expect(context).toContain('name="合同_终审版.docx"');
    expect(context).toContain(JSON.stringify(exactPath));
    expect(context).not.toContain(inventedPath);
  });

  it('prefers the current terminal creation receipt and rejects a mismatched task envelope', () => {
    const receiptPath = 'D:\\交付\\报告_最终版.md';
    const staleEnvelopePath = 'D:\\交付\\报告_草稿.md';
    const wrongTaskPath = 'D:\\其他任务\\报告.md';
    const requestId = 'wechat_bot:create-one-current';
    const context = routes.buildRemoteRuntimeEvidenceContext([{
      role: 'assistant',
      requestId,
      message: `模型文本声称 ${staleEnvelopePath}`,
      toolCalls: [{
        name: 'write_file',
        arguments: { path: staleEnvelopePath, content: 'report' },
        result: JSON.stringify({ path: staleEnvelopePath }),
        receipt: { fileName: '报告_最终版.md', outputPath: receiptPath },
        adapterStarted: true,
        taskId: 'remote-create-task',
        requestId,
        terminalVerification: {
          status: 'verified',
          strategy: 'artifact',
          reason: 'created artifact exists',
        },
        envelope: {
          version: 1,
          status: 'verified_success',
          toolName: 'write_file',
          taskId: 'remote-create-task',
          turnId: requestId,
          requestId,
          idempotencyKey: 'create-one',
          targetIdentity: staleEnvelopePath,
          completedAt: new Date().toISOString(),
          result: { path: staleEnvelopePath },
          verification: { status: 'verified', reason: 'artifact exists' },
        },
      }, {
        name: 'write_file',
        arguments: { path: wrongTaskPath, content: 'wrong task' },
        result: JSON.stringify({ path: wrongTaskPath }),
        receipt: { outputPath: wrongTaskPath },
        adapterStarted: true,
        taskId: 'remote-create-task',
        requestId,
        terminalVerification: {
          status: 'verified',
          strategy: 'artifact',
          reason: 'unrelated artifact',
        },
        envelope: {
          version: 1,
          status: 'verified_success',
          toolName: 'write_file',
          taskId: 'different-task',
          turnId: requestId,
          requestId,
          idempotencyKey: 'wrong-task',
          targetIdentity: wrongTaskPath,
          completedAt: new Date().toISOString(),
          result: { path: wrongTaskPath },
          verification: { status: 'verified', reason: 'other task' },
        },
      }],
    }, {
      role: 'user',
      requestId: 'wechat_bot:create-one-followup',
      message: '把刚创建的文件发给我。',
    }]);

    expect(context).toContain('write_file: exact file identities from terminal receipt');
    expect(context).toContain('name="报告_最终版.md"');
    expect(context).toContain(JSON.stringify(receiptPath));
    expect(context).not.toContain(staleEnvelopePath);
    expect(context).not.toContain(wrongTaskPath);
  });

  it('keeps attachment content in the actual model turn while routing only on current user wording', async () => {
    const userId = `attachment-model-context-${Date.now()}-${Math.random()}`;
    const message = {
      ...incoming(userId, '分析一下这份附件', 'attachment-model-context'),
      attachments: [{
        id: 'legal-looking-analysis',
        type: 'file' as const,
        fileName: '派遣函_最终版.pdf',
        extractedText: '某人民法院材料，仅要求分析，不得自动创建案件。',
      }],
    };
    const capturedRequests: any[] = [];
    const sent: string[] = [];
    const create = vi.fn(async (params: any) => {
      capturedRequests.push(params);
      return {
        choices: [{ message: { content: '附件分析结果' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    });

    routes.dispatchIncomingMessage(message, {
      enrich: async current => ({
        ...current,
        text: [
          current.text,
          '以下是用户通过个人微信发送的真实附件内容。',
          '## 附件：派遣函_最终版.pdf',
          '解析文本：某人民法院材料，仅要求分析，不得自动创建案件。',
        ].join('\n'),
      }),
      reply: async (_current, text) => {
        sent.push(text);
        return 'attachment-model-reply';
      },
    }, {
      llmGetters: {
        getDeepSeek: () => ({ chat: { completions: { create } } }),
      },
    });

    await waitFor(() => capturedRequests.length > 0, 5_000);
    await waitFor(() => sent.length === 1, 5_000);
    const modelTurn = capturedRequests.find(params => {
      const lastUser = [...(params.messages || [])].reverse().find((item: any) => item.role === 'user');
      return String(lastUser?.content || '').includes('派遣函_最终版.pdf');
    });
    expect(modelTurn).toBeTruthy();
    const lastUser = [...modelTurn.messages].reverse().find((item: any) => item.role === 'user');
    expect(lastUser.content).toContain('某人民法院材料，仅要求分析，不得自动创建案件。');
    expect(routes.buildRemoteTurnIntentText({ ...message, text: lastUser.content })).toBe('分析一下这份附件');
    expect(JSON.stringify(modelTurn.tools || [])).not.toContain('legal_message_intake_to_case');
  });

  it('sanitizes an internal execution guard before a remote reply is persisted or sent', async () => {
    const userId = `guard-boundary-${Date.now()}-${Math.random()}`;
    const message = incoming(userId, '\u4f60\u597d\uff0c\u4ecb\u7ecd\u4e00\u4e0b\u81ea\u5df1', 'guard-boundary');
    const internalGuard = 'No successful current-turn tool execution was recorded for that execution-status claim.';
    const sent: string[] = [];
    const transport = {
      enrich: async (incomingMessage: IncomingMessage) => incomingMessage,
      reply: async (_message: IncomingMessage, text: string) => {
        sent.push(text);
        return 'guard-safe-reply';
      },
    };

    routes.dispatchIncomingMessage(message, transport, {
      onMessage: async incomingMessage => ({
        platform: incomingMessage.platform,
        text: internalGuard,
      }),
    });

    await waitFor(() => sent.length === 1);
    expect(sent[0]).toContain('\u666e\u901a\u5bf9\u8bdd');
    expect(sent[0]).not.toMatch(
      /No successful current-turn tool execution|\u8fd9\u4e00\u8f6e\u6ca1\u6709\u8bb0\u5f55\u5230\u6210\u529f\u7684\u771f\u5b9e\u5de5\u5177\u6267\u884c/u,
    );
    const conversation = conversations.getActiveConversation(userId, 'lumi', 'personal', '')!;
    const assistant = conversations.getMessages(conversation.id)
      .filter(item => item.role === 'assistant')
      .at(-1);
    expect(assistant?.message).toBe(sent[0]);
  });

  it('does not let a verified receipt from an older request prove a new remote claim', async () => {
    for (const taskText of ['继续。', '把文件发给客户。']) {
      const result = await routes.finalizeMessagingResponseForDelivery({
        taskText,
        responseText: '文件已发送成功。',
        source: 'wechat_bot',
        taskId: 'remote-task-current',
        requestId: 'remote-request-current',
        toolRecords: [{
          name: 'wechat_send_file',
          arguments: { target: 'customer' },
          result: JSON.stringify({ ok: true, status: 'verified', sent: true }),
          taskId: 'remote-task-current',
          requestId: 'remote-request-older',
          terminalVerification: {
            status: 'verified',
            strategy: 'provider_ack',
            reason: 'an older provider acknowledgement',
          },
        }],
      });

      expect(result.finalization.blocked).toBe(true);
      expect(result.finalization.text).toContain('没有取得发送成功的确认');
      expect(result.finalization.text).not.toMatch(/已发送成功|No successful|current-turn|execution-status/iu);
      expect(result.finalization.text).not.toContain('older provider acknowledgement');
    }
  });

  it('releases a remote status request before accepting the next plain chat turn', async () => {
    const userId = `status-release-${Date.now()}-${Math.random()}`;
    const conversation = conversations.getOrCreateActiveConversation(userId, 'lumi', 'personal', '');
    const seedRequestId = `wechat_bot:status-release-seed-${Date.now()}`;
    const seedUserMessageId = conversations.addMessage({
      userId,
      agentId: 'lumi',
      conversationId: conversation.id,
      role: 'user',
      content: '打开一个不存在的文件。',
      domain: 'personal',
      source: 'wechat_bot',
      channel: 'wechat',
      requestId: seedRequestId,
      deferActionPreparation: true,
    });
    const seeded = conversations.prepareConversationActionExecution({
      conversationId: conversation.id,
      userId,
      userText: '打开一个不存在的文件。',
      requestId: seedRequestId,
      userMessageId: seedUserMessageId,
      toolPolicy: {
        allowedTools: ['desktop_open'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 4,
      },
      forceTask: true,
    });
    expect(seeded.state?.taskId).toBeTruthy();
    conversations.settleConversationActionExecutionRequest(
      conversation.id,
      userId,
      seedRequestId,
      'The requested file was not found.',
    );

    const status = incoming(userId, '现在这个任务进度怎么样？', `status-release-query-${Date.now()}`);
    const nextChat = incoming(userId, '我们聊点别的。', `status-release-chat-${Date.now()}`);
    const sent: string[] = [];
    const onMessage = vi.fn(async (message: IncomingMessage) => ({
      platform: message.platform,
      text: '可以，聊点别的。',
    }));
    const transport = {
      enrich: async (message: IncomingMessage) => message,
      reply: async (_message: IncomingMessage, text: string) => {
        sent.push(text);
        return `reply-${sent.length}`;
      },
    };

    routes.dispatchIncomingMessage(status, transport, { onMessage });
    await waitFor(() => sent.length === 1);
    const afterStatus = conversations.getActiveConversation(userId, 'lumi', 'personal', '')!;
    expect(afterStatus.pendingActionContinuation).toBeUndefined();

    routes.dispatchIncomingMessage(nextChat, transport, { onMessage });
    await waitFor(() => sent.length === 2);
    expect(sent[1]).toBe('可以，聊点别的。');
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('ends a dismissed remote exchange without re-entering the model or attachment workflow', async () => {
    const userId = `dismissed-turn-${Date.now()}-${Math.random()}`;
    const message = incoming(userId, '没事了，你退下吧', 'dismissed-turn');
    pendingLegal.savePendingLegalNotice({
      userId,
      message,
      messageText: '请归档上一份法院通知',
      candidates: [{ orgId: 'old-org', orgName: '旧目标' }],
    });
    expect(pendingLegal.getPendingLegalNotice(message, userId)).not.toBeNull();
    const sent: string[] = [];
    const onMessage = vi.fn(async () => ({ platform: 'wechat' as const, text: '不应生成' }));

    routes.dispatchIncomingMessage(message, {
      enrich: async incomingMessage => incomingMessage,
      reply: async (_incomingMessage, text) => {
        sent.push(text);
        return 'dismissed-reply';
      },
    }, { onMessage });

    await waitFor(() => sent.length === 1);
    expect(sent).toEqual(['好，有需要再叫我。']);
    expect(onMessage).not.toHaveBeenCalled();
    expect(pendingLegal.getPendingLegalNotice(message, userId)).toBeNull();
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

  it('remote_history_keeps_prior_identical_user_turn_after_excluding_current_message_id', () => {
    const message = {
      ...incoming(`identical-history-${Date.now()}`, '同一句话', 'current-identical'),
      userMessagePersisted: true,
      userMessageId: 'current-row-id',
    };
    const history = routes.buildRemoteConversationHistory([
      {
        role: 'user',
        message: '同一句话',
        externalMessageId: 'prior-identical',
        requestId: 'wechat_bot:prior-identical',
      },
      {
        role: 'assistant',
        message: '上一轮的回答',
        externalMessageId: 'prior-identical',
        requestId: 'wechat_bot:prior-identical',
      },
      {
        role: 'user',
        message: '同一句话',
        externalMessageId: 'current-identical',
        requestId: 'wechat_bot:current-identical',
      },
    ], message);

    expect(history).toEqual([
      { role: 'user', content: '同一句话' },
      { role: 'assistant', content: '上一轮的回答' },
    ]);
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

  it('sends only the latest same-chat turn through the real WeChat polling transport', async () => {
    let callback: ((message: IncomingMessage) => Promise<any>) | null = null;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstStarted = false;
    const sent: Array<{ text: string; replyTo: string }> = [];
    const fakeAdapter = {
      startPolling: vi.fn(async (handler: (message: IncomingMessage) => Promise<any>) => {
        callback = handler;
      }),
      downloadAttachment: vi.fn(async () => Buffer.from('')),
      sendMessage: vi.fn(async (_userId: string, outgoing: { text: string; replyTo: string }) => {
        sent.push({ text: outgoing.text, replyTo: outgoing.replyTo });
        return `wechat-latest-${sent.length}`;
      }),
    };
    const userId = `wechat-latest-${Date.now()}-${Math.random()}`;
    const first = incoming(userId, '先处理旧任务', 'wechat-old-turn');
    const latest = incoming(userId, '不用旧任务了，只回答这条', 'wechat-latest-turn');
    wechatRoutes.startWeChatPolling(fakeAdapter as any, {} as any, {
      onMessage: async message => {
        if (message.messageId === first.messageId) {
          firstStarted = true;
          await firstGate;
          return { platform: message.platform, text: '旧轮结果不应外发' };
        }
        return { platform: message.platform, text: '这是最新轮回复' };
      },
    });
    await waitFor(() => callback !== null);

    expect(await callback!(first)).toBeNull();
    await waitFor(() => firstStarted);
    expect(await callback!(latest)).toBeNull();
    releaseFirst();

    await waitFor(() => sent.length === 1, 5_000);
    expect(sent).toEqual([{ text: '这是最新轮回复', replyTo: latest.messageId }]);
    expect(fakeAdapter.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not supersede a slow reply in a different visible conversation', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let firstStarted = false;
    const sent: Array<{ messageId: string; text: string }> = [];
    const first = incoming(`independent-a-${Date.now()}`, '第一位用户的慢消息', 'independent-a');
    const second = incoming(`independent-b-${Date.now()}`, '第二位用户的新消息', 'independent-b');
    const transport = {
      enrich: async (message: IncomingMessage) => message,
      reply: async (message: IncomingMessage, text: string) => {
        sent.push({ messageId: message.messageId, text });
        return `independent-${sent.length}`;
      },
    };
    const options = {
      onMessage: async (message: IncomingMessage) => {
        if (message.messageId === first.messageId) {
          firstStarted = true;
          await firstGate;
          return { platform: message.platform, text: '第一位用户的回复' };
        }
        return { platform: message.platform, text: '第二位用户的回复' };
      },
    };

    routes.dispatchIncomingMessage(first, transport, options);
    await waitFor(() => firstStarted);
    routes.dispatchIncomingMessage(second, transport, options);
    await waitFor(() => sent.some(item => item.messageId === second.messageId));
    releaseFirst();
    await waitFor(() => sent.length === 2);

    expect(sent).toEqual(expect.arrayContaining([
      { messageId: first.messageId, text: '第一位用户的回复' },
      { messageId: second.messageId, text: '第二位用户的回复' },
    ]));
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
