import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildPendingConfirmationPersistenceRecord,
  buildTransportNeutralConfirmationScope,
  clearAllPendingConfirmationsForTests,
  confirmationArgumentsMatch,
  consumePendingConfirmationDurably,
  formatPendingConfirmationPrompt,
  formatPendingConfirmationRequest,
  getPendingConfirmation,
  hydratePendingConfirmationFromPersistence,
  isConfirmationCancellation,
  isExplicitConfirmationReply,
  pendingConfirmationMatchesExactProposal,
  recordPendingConfirmation,
} from '../server/tools/pending_confirmation';

describe('One-time pending tool confirmations', () => {
  beforeEach(() => clearAllPendingConfirmationsForTests());
  afterEach(() => {
    vi.useRealTimers();
    clearAllPendingConfirmationsForTests();
  });

  it('expires an approval boundary before it can authorize a stale external commit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const pending = recordPendingConfirmation(
      'u-expired',
      'wechat_send_message',
      { recipient: 'Alice', text: 'Original immutable payload' },
      'voice',
      { channelId: 'voice-expired', taskId: 'task-expired' },
    );

    vi.advanceTimersByTime(10 * 60_000 + 1);

    expect(getPendingConfirmation('u-expired', {
      source: 'voice',
      channelId: 'voice-expired',
      taskId: 'task-expired',
    })).toBeNull();
    expect(await consumePendingConfirmationDurably(
      'u-expired',
      pending.id,
      pending.toolName,
      pending.exactArgs,
      { source: 'voice', channelId: 'voice-expired', taskId: 'task-expired' },
    )).toBe(false);
  });

  it('consumes only an exact tool and argument match once', async () => {
    const pending = recordPendingConfirmation('u1', 'legal_submit_filing', { caseId: 'case-1', court: 'A' });
    expect(getPendingConfirmation('u1')?.id).toBe(pending.id);
    expect(await consumePendingConfirmationDurably('u1', pending.id, 'legal_submit_filing', { caseId: 'case-2', court: 'A' })).toBe(false);
    expect(await consumePendingConfirmationDurably('u1', pending.id, 'legal_submit_filing', { court: 'A', caseId: 'case-1' })).toBe(true);
    expect(await consumePendingConfirmationDurably('u1', pending.id, 'legal_submit_filing', { court: 'A', caseId: 'case-1' })).toBe(false);
  });

  it('redacts credentials before placing pending details in a model prompt', () => {
    const pending = recordPendingConfirmation('u1', 'web_login', {
      username: 'owner',
      password: 'super-secret-password',
    });
    const prompt = formatPendingConfirmationPrompt(pending);
    expect(prompt).toContain('owner');
    expect(prompt).toContain('[redacted]');
    expect(prompt).not.toContain('super-secret-password');
    expect(pending.exactArgs.password).toBe('super-secret-password');
    expect(pending.safeArgs.password).toBe('[redacted]');

    const request = formatPendingConfirmationRequest(pending);
    expect(request).toContain('Confirmation is required');
    expect(request).toContain('owner');
    expect(request).not.toContain('password');
    expect(request).not.toContain('super-secret-password');
  });

  it.each(['chat', 'voice'])('keeps executor instructions out of the %s confirmation while binding the exact action', async source => {
    const args = {
      task: '把 WPS 窗口切到前台。读取会议安排.docx，先停留在文档页面等我下一步指令。',
      max_steps: 20,
      target_application: 'WPS Office',
    };
    const pending = recordPendingConfirmation('private-instructions', 'computer_use', args, source, {
      actionIntent: '帮我把会议安排打印出来。',
    });
    const request = formatPendingConfirmationRequest(pending);
    expect(request).toContain('会议安排');
    expect(request).toContain('WPS Office');
    expect(request).toContain('确认');
    for (const internal of [args.task, 'computer_use', 'max_steps', 'target_application', pending.payloadDigest, pending.id]) {
      expect(request).not.toContain(internal);
    }
    expect(pending.exactArgs).toEqual(args);
    expect(formatPendingConfirmationPrompt(pending)).toContain(args.task);
    expect(await consumePendingConfirmationDurably('private-instructions', pending.id, pending.toolName, { ...args, max_steps: 21 })).toBe(false);
    expect(await consumePendingConfirmationDurably('private-instructions', pending.id, pending.toolName, args)).toBe(true);
  });

  it('keeps the recipient and message reviewable without dumping executor fields', () => {
    const pending = recordPendingConfirmation('message-review', 'wechat_send_message', {
      contact: '客户甲', message: '明天上午十点开会。',
      task: '先调用工具再判断终态', max_steps: 20,
    }, 'chat', { actionIntent: '把会议时间发给客户甲' });
    const request = formatPendingConfirmationRequest(pending);
    expect(request).toContain('客户甲');
    expect(request).toContain('明天上午十点开会。');
    expect(request).not.toContain('先调用工具');
    expect(request).not.toContain('max_steps');
    expect(request).not.toContain(pending.payloadDigest);
  });

  it('keeps a cancellation plus explicit no-write safety clause out of model routing', () => {
    expect(isConfirmationCancellation('Cancel this task. Do not write any file.')).toBe(true);
    expect(isConfirmationCancellation('取消当前任务，不要再写入任何文件。')).toBe(true);
    expect(isConfirmationCancellation('terminate this task')).toBe(true);
    expect(isConfirmationCancellation('终止当前任务')).toBe(true);
    expect(isConfirmationCancellation('取消订单 20260830')).toBe(false);
    expect(isConfirmationCancellation('终止订单 20260830')).toBe(false);
  });

  it('binds an exact proposal to its task and immutable origin request', () => {
    const args = { path: 'C:\\Temp\\corrected.txt', content: 'exact content' };
    const pending = recordPendingConfirmation(
      'u-exact-proposal',
      'write_file',
      args,
      'chat',
      {
        channelId: 'conversation:exact-proposal',
        taskId: 'task-exact-proposal',
        originRequestId: 'request-exact-proposal',
      },
    );

    expect(confirmationArgumentsMatch(args, {
      content: 'exact content',
      path: 'C:\\Temp\\corrected.txt',
    })).toBe(true);
    expect(pendingConfirmationMatchesExactProposal(
      pending,
      'write_file',
      { content: 'exact content', path: 'C:\\Temp\\corrected.txt' },
      { taskId: 'task-exact-proposal', originRequestId: 'request-exact-proposal' },
    )).toBe(true);
    expect(pendingConfirmationMatchesExactProposal(
      pending,
      'write_file',
      args,
      { taskId: 'task-exact-proposal', originRequestId: 'different-request' },
    )).toBe(false);
    expect(pendingConfirmationMatchesExactProposal(
      pending,
      'write_file',
      { ...args, content: 'tampered' },
      { taskId: 'task-exact-proposal', originRequestId: 'request-exact-proposal' },
    )).toBe(false);
  });

  it('binds and displays the exact self-improvement patch and activation identity', () => {
    const common = {
      proposalId: 'improvement_exact_1',
      expectedBaseCommit: 'a'.repeat(40),
      expectedDeliveryBranch: 'main',
      commitMessage: 'improve docs',
    };
    const sharedPrefix = [
      'diff --git a/docs/a.md b/docs/a.md',
      '--- a/docs/a.md',
      '+++ b/docs/a.md',
      '@@ -1 +1 @@',
      `-${'x'.repeat(520)}`,
    ].join('\n');
    const first = recordPendingConfirmation('self-review', 'self_improvement_stage_patch', {
      ...common,
      patch: `${sharedPrefix}\n+safe tail\n`,
    });
    const request = formatPendingConfirmationRequest(first);
    expect(first.safeArgs.patchReview).toMatchObject({
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      changedPaths: ['docs/a.md'],
      fullPatch: expect.stringContaining('+safe tail'),
    });
    expect(request).toContain('+safe tail');
    const modelPrompt = formatPendingConfirmationPrompt(first);
    expect(modelPrompt).toContain('omitted from model continuation');
    expect(modelPrompt).not.toContain('+safe tail');

    clearAllPendingConfirmationsForTests();
    const changedTail = recordPendingConfirmation('self-review', 'self_improvement_stage_patch', {
      ...common,
      patch: `${sharedPrefix}\n+malicious tail\n`,
    });
    expect(changedTail.payloadDigest).not.toBe(first.payloadDigest);
    expect(changedTail.safeArgs.patchReview.sha256).not.toBe(first.safeArgs.patchReview.sha256);

    clearAllPendingConfirmationsForTests();
    const activation = recordPendingConfirmation('self-review', 'self_improvement_activate', {
      proposalId: 'improvement_exact_1',
      expectedRepositoryId: 'b'.repeat(64),
      expectedBaseCommit: 'a'.repeat(40),
      expectedDeliveryBranch: 'main',
      expectedStagedBranch: 'lumi/self-improvement/improvement-exact-1',
      expectedStagedCommit: 'c'.repeat(40),
      expectedTreeDigest: 'd'.repeat(64),
      expectedPatchDigest: 'e'.repeat(64),
      expectedVerificationProfile: 'standard',
      expectedChangedPaths: ['docs/a.md'],
    });
    const activationRequest = formatPendingConfirmationRequest(activation);
    for (const expected of ['b'.repeat(64), 'c'.repeat(40), 'd'.repeat(64), 'docs/a.md']) {
      expect(activationRequest).toContain(expected);
    }
  });

  it('keeps the original action context for deterministic continuation', () => {
    const pending = recordPendingConfirmation(
      'u1',
      'desktop_run_command',
      { command: 'safe-example' },
      'voice',
      { actionIntent: '运行刚才确认的命令' },
    );
    expect(pending.actionIntent).toBe('运行刚才确认的命令');
    expect(pending.exactArgs).toEqual({ command: 'safe-example' });
  });

  it('does not let a re-plan replace the pending boundary of the same task', () => {
    const original = recordPendingConfirmation(
      'u1',
      'wechat_send_message',
      { recipient: '文件传输助手', text: '原始消息' },
      'voice',
      { channelId: 'voice-1', taskId: 'task-1', actionIntent: '发送原始消息' },
    );
    const replanned = recordPendingConfirmation(
      'u1',
      'desktop_keyboard_press',
      { keys: ['ENTER'] },
      'voice',
      { channelId: 'voice-1', taskId: 'task-1', actionIntent: '模型改写后的动作' },
    );

    expect(replanned.id).toBe(original.id);
    expect(replanned.toolName).toBe('wechat_send_message');
    expect(replanned.exactArgs).toEqual({ recipient: '文件传输助手', text: '原始消息' });
  });

  it('isolates confirmations by remote channel and data scope', async () => {
    const personal = recordPendingConfirmation(
      'u1',
      'wechat_send_file',
      { filePath: 'D:\\personal.pdf' },
      'wechat_bot',
      { domain: 'personal', orgId: '', channelId: 'wx-private' },
    );
    const work = recordPendingConfirmation(
      'u1',
      'legal_submit_filing',
      { caseId: 'case-1' },
      'feishu_bot',
      { domain: 'work', orgId: 'org-1', channelId: 'feishu-group' },
    );

    expect(getPendingConfirmation('u1', {
      source: 'wechat_bot', domain: 'personal', orgId: '', channelId: 'wx-private',
    })?.id).toBe(personal.id);
    expect(getPendingConfirmation('u1', {
      source: 'feishu_bot', domain: 'work', orgId: 'org-1', channelId: 'feishu-group',
    })?.id).toBe(work.id);
    expect(await consumePendingConfirmationDurably(
      'u1',
      personal.id,
      'wechat_send_file',
      { filePath: 'D:\\personal.pdf' },
      { source: 'feishu_bot', domain: 'work', orgId: 'org-1', channelId: 'feishu-group' },
    )).toBe(false);
    expect(await consumePendingConfirmationDurably(
      'u1',
      personal.id,
      'wechat_send_file',
      { filePath: 'D:\\personal.pdf' },
      { source: 'wechat_bot', domain: 'personal', orgId: '', channelId: 'wx-private' },
    )).toBe(true);
  });

  it('does not let chat, voice, and task confirmations consume each other', async () => {
    const chat = recordPendingConfirmation(
      'u1',
      'desktop_open',
      { target: 'WPS' },
      'chat',
      { domain: 'personal', channelId: 'chat-1', taskId: 'task-chat' },
    );
    const voice = recordPendingConfirmation(
      'u1',
      'desktop_open',
      { target: 'AutoCAD' },
      'voice',
      { domain: 'personal', channelId: 'voice-1', taskId: 'task-voice' },
    );

    expect(getPendingConfirmation('u1', {
      source: 'task',
      domain: 'personal',
      channelId: 'task-1',
      taskId: 'task-chat',
    })).toBeNull();
    expect(await consumePendingConfirmationDurably(
      'u1',
      chat.id,
      chat.toolName,
      chat.exactArgs,
      { source: 'voice', domain: 'personal', channelId: 'voice-1', taskId: 'task-chat' },
    )).toBe(false);
    expect(getPendingConfirmation('u1', {
      source: 'chat',
      domain: 'personal',
      channelId: 'chat-1',
      taskId: 'task-chat',
    })?.id).toBe(chat.id);
    expect(getPendingConfirmation('u1', {
      source: 'voice',
      domain: 'personal',
      channelId: 'voice-1',
      taskId: 'task-voice',
    })?.id).toBe(voice.id);
  });

  it('keeps a voice confirmation available across separate utterance request ids', async () => {
    const scope = buildTransportNeutralConfirmationScope({
      domain: 'personal', orgId: '', conversationId: 'voice-stable-channel', taskId: 'durable-task-id',
    });
    const pending = recordPendingConfirmation(
      'voice-stable-user',
      'wechat_send_message',
      { contact: '客户甲', message: '固定正文' },
      'voice',
      { ...scope, taskId: 'durable-task-id' },
    );

    expect(getPendingConfirmation('voice-stable-user', scope)?.id).toBe(pending.id);
    expect(await consumePendingConfirmationDurably(
      'voice-stable-user', pending.id, pending.toolName, pending.exactArgs, scope,
    )).toBe(true);
  });

  it('keeps chat confirmation scope stable across transport reconnects', () => {
    const scope = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId: 'conversation-1',
      taskId: 'task-1',
      originRequestId: 'request-1',
    });
    const pending = recordPendingConfirmation(
      'chat-user',
      'wechat_send_message',
      { contact: '客户甲', message: '固定正文' },
      'chat',
      scope,
    );

    expect(scope.channelId).toBe('conversation:conversation-1');
    expect(getPendingConfirmation('chat-user', scope)?.id).toBe(pending.id);
  });

  it('does not let a later unrelated request adopt a task-bound confirmation', async () => {
    const exactScope = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId: 'conversation-confirmation-owner',
      taskId: 'task-owner',
      originRequestId: 'request-owner',
    });
    const pending = recordPendingConfirmation(
      'chat-owner',
      'wechat_send_message',
      { contact: 'Alice', message: 'Immutable payload' },
      'chat',
      exactScope,
    );
    const wrongOrigin = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId: 'conversation-confirmation-owner',
      taskId: 'task-owner',
      originRequestId: 'request-later-unrelated',
    });
    const noTask = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId: 'conversation-confirmation-owner',
    });

    expect(getPendingConfirmation('chat-owner', wrongOrigin)).toBeNull();
    expect(getPendingConfirmation('chat-owner', noTask)).toBeNull();
    expect(await consumePendingConfirmationDurably(
      'chat-owner', pending.id, pending.toolName, pending.exactArgs, wrongOrigin,
    )).toBe(false);
    expect(await consumePendingConfirmationDurably(
      'chat-owner', pending.id, pending.toolName, pending.exactArgs, exactScope,
    )).toBe(true);
  });

  it('keeps a fresh taskless confirmation consumable after its first receipt creates the task', async () => {
    const channelScope = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId: 'conversation-model-owned-task',
    });
    const pending = recordPendingConfirmation(
      'chat-fresh-task',
      'desktop_run_command',
      { command: 'immutable-command' },
      'chat',
      { ...channelScope, originRequestId: 'request-that-proposed-command' },
    );
    const laterTaskScope = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId: 'conversation-model-owned-task',
      taskId: 'task-created-from-blocked-receipt',
      originRequestId: 'request-that-proposed-command',
    });

    expect(getPendingConfirmation('chat-fresh-task', laterTaskScope)).toBeNull();
    expect(getPendingConfirmation('chat-fresh-task', channelScope)?.id).toBe(pending.id);
    expect(await consumePendingConfirmationDurably(
      'chat-fresh-task', pending.id, pending.toolName, pending.exactArgs, channelScope,
    )).toBe(true);
  });

  it('recognizes a concise confirmation without treating ordinary messages as approval', () => {
    expect(isExplicitConfirmationReply('确认')).toBe(true);
    expect(isExplicitConfirmationReply('确认了')).toBe(true);
    expect(isExplicitConfirmationReply('确认执行')).toBe(true);
    expect(isExplicitConfirmationReply('同意')).toBe(true);
    expect(isExplicitConfirmationReply('好的')).toBe(true);
    expect(isExplicitConfirmationReply('可以')).toBe(true);
    expect(isExplicitConfirmationReply('确认一下这个文件内容')).toBe(false);
  });

  it('provides one transport-neutral conversation scope for voice-to-text confirmation', async () => {
    const scope = buildTransportNeutralConfirmationScope({
      domain: 'personal',
      conversationId: 'conversation-cross-channel',
      taskId: 'task-cross-channel',
      originRequestId: 'request-cross-channel',
    });
    const pending = recordPendingConfirmation(
      'cross-channel-user',
      'desktop_open',
      { target: 'WPS' },
      'voice',
      scope,
    );

    expect(scope.source).toBeUndefined();
    expect(scope.channelId).toBe('conversation:conversation-cross-channel');
    expect(getPendingConfirmation('cross-channel-user', scope)?.id).toBe(pending.id);
    expect(await consumePendingConfirmationDurably(
      'cross-channel-user',
      pending.id,
      pending.toolName,
      pending.exactArgs,
      scope,
    )).toBe(true);
  });

  it('defines a storage-safe persistence envelope and verifies decrypted arguments on hydration', () => {
    const pending = recordPendingConfirmation(
      'persistent-user',
      'wechat_send_message',
      { contact: 'Alice', message: 'Exact body', apiToken: 'secret-token' },
      'voice',
      {
        domain: 'personal',
        channelId: 'conversation:persistent-conversation',
        taskId: 'persistent-task',
        originRequestId: 'persistent-request',
      },
    );
    const stored = buildPendingConfirmationPersistenceRecord(
      pending,
      'vault:v1:encrypted-exact-args',
      '2026-08-27T00:00:01.000Z',
    );

    expect(stored).toMatchObject({
      schemaVersion: 1,
      revision: 1,
      status: 'pending',
      exactArgsCiphertext: 'vault:v1:encrypted-exact-args',
      source: 'voice',
      channelId: 'conversation:persistent-conversation',
    });
    expect(JSON.stringify(stored)).not.toContain('secret-token');
    expect(hydratePendingConfirmationFromPersistence(stored, pending.exactArgs))
      .toEqual(pending);
    expect(hydratePendingConfirmationFromPersistence(stored, {
      ...pending.exactArgs,
      message: 'Tampered body',
    })).toBeNull();
    expect(hydratePendingConfirmationFromPersistence({
      ...stored,
      safeArgs: { contact: 'Mallory', message: 'Misleading body' },
    }, pending.exactArgs)).toBeNull();
    expect(hydratePendingConfirmationFromPersistence({
      ...stored,
      status: 'consumed',
      revision: 2,
    }, pending.exactArgs)).toBeNull();
  });

  it('recognizes natural cancellation of the pending external confirmation', () => {
    expect(isConfirmationCancellation('取消刚才的外发确认，不要发送。')).toBe(true);
    expect(isConfirmationCancellation('取消刚才给“验收占位联系人”的外发确认，不要发送，不要打开微信。请明确告诉我是否已经取消以及消息是否发出。')).toBe(true);
    expect(isConfirmationCancellation('取消')).toBe(true);
    expect(isConfirmationCancellation('取消订单')).toBe(false);
    expect(isConfirmationCancellation('取消明天下午的会议')).toBe(false);
  });
});
