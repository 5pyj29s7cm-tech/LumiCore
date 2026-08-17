import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildConversationConfirmationChannelScope,
  buildVoiceConfirmationChannelScope,
  clearAllPendingConfirmationsForTests,
  consumePendingConfirmation,
  formatPendingConfirmationPrompt,
  formatPendingConfirmationRequest,
  getPendingConfirmation,
  isConfirmationCancellation,
  isExplicitConfirmationReply,
  recordPendingConfirmation,
} from '../server/tools/pending_confirmation';

describe('One-time pending tool confirmations', () => {
  beforeEach(() => clearAllPendingConfirmationsForTests());
  afterEach(() => {
    vi.useRealTimers();
    clearAllPendingConfirmationsForTests();
  });

  it('expires an approval boundary before it can authorize a stale external commit', () => {
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
    expect(consumePendingConfirmation(
      'u-expired',
      pending.id,
      pending.toolName,
      pending.exactArgs,
      { source: 'voice', channelId: 'voice-expired', taskId: 'task-expired' },
    )).toBe(false);
  });

  it('consumes only an exact tool and argument match once', () => {
    const pending = recordPendingConfirmation('u1', 'legal_submit_filing', { caseId: 'case-1', court: 'A' });
    expect(getPendingConfirmation('u1')?.id).toBe(pending.id);
    expect(consumePendingConfirmation('u1', pending.id, 'legal_submit_filing', { caseId: 'case-2', court: 'A' })).toBe(false);
    expect(consumePendingConfirmation('u1', pending.id, 'legal_submit_filing', { court: 'A', caseId: 'case-1' })).toBe(true);
    expect(consumePendingConfirmation('u1', pending.id, 'legal_submit_filing', { court: 'A', caseId: 'case-1' })).toBe(false);
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
    expect(request).toContain('[redacted]');
    expect(request).not.toContain('super-secret-password');
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

  it('isolates confirmations by remote channel and data scope', () => {
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
    expect(consumePendingConfirmation(
      'u1',
      personal.id,
      'wechat_send_file',
      { filePath: 'D:\\personal.pdf' },
      { source: 'feishu_bot', domain: 'work', orgId: 'org-1', channelId: 'feishu-group' },
    )).toBe(false);
    expect(consumePendingConfirmation(
      'u1',
      personal.id,
      'wechat_send_file',
      { filePath: 'D:\\personal.pdf' },
      { source: 'wechat_bot', domain: 'personal', orgId: '', channelId: 'wx-private' },
    )).toBe(true);
  });

  it('does not let chat, voice, and task confirmations consume each other', () => {
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
    expect(consumePendingConfirmation(
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

  it('keeps a voice confirmation available across separate utterance request ids', () => {
    const scope = buildVoiceConfirmationChannelScope({
      domain: 'personal', orgId: '', channelId: 'voice-stable-channel', taskId: 'durable-task-id',
    });
    const pending = recordPendingConfirmation(
      'voice-stable-user',
      'wechat_send_message',
      { contact: '客户甲', message: '固定正文' },
      'voice',
      { ...scope, taskId: 'durable-task-id' },
    );

    expect(getPendingConfirmation('voice-stable-user', scope)?.id).toBe(pending.id);
    expect(consumePendingConfirmation(
      'voice-stable-user', pending.id, pending.toolName, pending.exactArgs, scope,
    )).toBe(true);
  });

  it('keeps chat confirmation scope stable across transport reconnects', () => {
    const scope = buildConversationConfirmationChannelScope({
      source: 'chat', domain: 'personal', conversationId: 'conversation-1',
    });
    const pending = recordPendingConfirmation(
      'chat-user',
      'wechat_send_message',
      { contact: '客户甲', message: '固定正文' },
      'chat',
      { ...scope, taskId: 'task-1' },
    );

    expect(scope.channelId).toBe('conversation:conversation-1');
    expect(getPendingConfirmation('chat-user', scope)?.id).toBe(pending.id);
  });

  it('recognizes a concise confirmation without treating ordinary messages as approval', () => {
    expect(isExplicitConfirmationReply('确认')).toBe(true);
    expect(isExplicitConfirmationReply('确认执行')).toBe(true);
    expect(isExplicitConfirmationReply('同意')).toBe(true);
    expect(isExplicitConfirmationReply('好的')).toBe(true);
    expect(isExplicitConfirmationReply('可以')).toBe(true);
    expect(isExplicitConfirmationReply('确认一下这个文件内容')).toBe(false);
  });

  it('recognizes natural cancellation of the pending external confirmation', () => {
    expect(isConfirmationCancellation('取消刚才的外发确认，不要发送。')).toBe(true);
    expect(isConfirmationCancellation('取消刚才给“验收占位联系人”的外发确认，不要发送，不要打开微信。请明确告诉我是否已经取消以及消息是否发出。')).toBe(true);
    expect(isConfirmationCancellation('取消')).toBe(true);
    expect(isConfirmationCancellation('取消订单')).toBe(false);
    expect(isConfirmationCancellation('取消明天下午的会议')).toBe(false);
  });
});
