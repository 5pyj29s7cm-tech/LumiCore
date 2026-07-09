import { describe, expect, it } from 'vitest';
import { buildDelegationAck, shouldDelegateWorkInBackground } from '../server/agents/background_delegation';

const BASE = {
  text: '整理这个案件文件夹并生成代理词和证据目录',
  category: 'command',
  complexity: 'moderate' as const,
  allowToolUse: true,
  clientActionOnly: false,
  selfRepair: false,
  sanctuary: false,
  directDesktop: false,
  prefersSequentialWorkflow: false,
  availableAgentCount: 2,
};

describe('background delegation', () => {
  it('delegates moderate or complex work to background agents', () => {
    const decision = shouldDelegateWorkInBackground(BASE);
    expect(decision.shouldDelegate).toBe(true);
    expect(decision.reason).toBe('work_complexity_moderate');
  });

  it('honors explicit background delegation preference', () => {
    const decision = shouldDelegateWorkInBackground({
      ...BASE,
      text: '这个不用等，交给子agent后台处理',
      complexity: 'simple',
    });
    expect(decision.shouldDelegate).toBe(true);
    expect(decision.reason).toBe('explicit_background_preference');
  });

  it('keeps simple foreground chat and visible desktop work in the foreground', () => {
    expect(shouldDelegateWorkInBackground({
      ...BASE,
      text: '你觉得这个想法怎么样',
      category: 'question',
      complexity: 'simple',
    }).shouldDelegate).toBe(false);

    expect(shouldDelegateWorkInBackground({
      ...BASE,
      directDesktop: true,
    }).shouldDelegate).toBe(false);
  });

  it('keeps foreground WeChat sends out of background delegation', () => {
    const send = shouldDelegateWorkInBackground({
      ...BASE,
      text: '\u6253\u5f00\u5fae\u4fe1\u7ed9\u963f\u9646\u53d1\u665a\u5b89',
      complexity: 'moderate',
    });
    const followup = shouldDelegateWorkInBackground({
      ...BASE,
      text: '\u76f4\u63a5\u53d1\u665a\u5b89',
      complexity: 'simple',
    });

    expect(send).toEqual({ shouldDelegate: false, reason: 'foreground_messaging_send' });
    expect(followup).toEqual({ shouldDelegate: false, reason: 'foreground_messaging_send' });
  });

  it('keeps foreground WeChat chat reading out of background delegation', () => {
    const read = shouldDelegateWorkInBackground({
      ...BASE,
      text: '\u6253\u5f00\u5fae\u4fe1\u770b\u770b\u6211\u548c\u963f\u9646\u6700\u8fd1\u7684\u804a\u5929\u5185\u5bb9',
      complexity: 'moderate',
    });

    expect(read).toEqual({ shouldDelegate: false, reason: 'foreground_messaging_read' });
  });

  it('builds a concise foreground acknowledgement', () => {
    const ack = buildDelegationAck(['法律检索员', '文书整理员'], 'bg_123');
    expect(ack).toContain('法律检索员、文书整理员');
    expect(ack).toContain('bg_123');
    expect(ack).toContain('继续和你聊天');
  });
});
