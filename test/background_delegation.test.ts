import { describe, expect, it } from 'vitest';
import {
  buildDelegationAck,
  formatBackgroundDelegationFailure,
  hasExplicitBackgroundDelegationPreference,
  shouldDelegateWorkInBackground,
} from '../server/agents/background_delegation';

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

  it('keeps an implicit continuation in the foreground even when it looks moderate', () => {
    const decision = shouldDelegateWorkInBackground({
      ...BASE,
      text: '执行绘图',
      continuationContext: true,
    });

    expect(decision).toEqual({
      shouldDelegate: false,
      reason: 'foreground_task_continuation',
    });
  });

  it('still delegates a continuation when the current message explicitly requests background work', () => {
    const decision = shouldDelegateWorkInBackground({
      ...BASE,
      text: '后台继续这个任务',
      continuationContext: true,
    });

    expect(decision).toEqual({
      shouldDelegate: true,
      reason: 'explicit_background_preference',
    });
  });

  it.each([
    '你刚刚是在后台做检查吗，我不回你你怎么不理我',
    '你刚才为什么在后台处理？',
    '后台程序现在运行得怎么样？',
    '检查一下后台进程',
  ])('does not confuse a background question or app inspection with delegation: %s', (text) => {
    expect(hasExplicitBackgroundDelegationPreference(text)).toBe(false);
    const decision = shouldDelegateWorkInBackground({
      ...BASE,
      text,
      complexity: 'moderate',
    });
    expect(decision.shouldDelegate).toBe(false);
    expect(['background_meta_inquiry', 'background_app_inspection']).toContain(decision.reason);
  });

  it.each([
    '后台继续这个任务',
    '把这项工作放到后台处理',
    '这个不用等，交给子 agent 处理',
  ])('recognizes an actual background delegation command: %s', (text) => {
    expect(hasExplicitBackgroundDelegationPreference(text)).toBe(true);
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

    expect(shouldDelegateWorkInBackground({
      ...BASE,
      text: '请打开 Windows 计算器，打开后核验当前活动窗口。',
      complexity: 'moderate',
      capabilityLane: 'desktop_control',
    })).toEqual({ shouldDelegate: false, reason: 'desktop_control_foreground' });
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

  it('keeps explicit no-new-task status recall in the foreground', () => {
    const decision = shouldDelegateWorkInBackground({
      ...BASE,
      text: '\u540c\u6b65\u9a8c\u6536\uff1a\u8bf7\u7528\u4e00\u53e5\u8bdd\u786e\u8ba4\u4f60\u8fd8\u8bb0\u5f97\u56db\u53f7\u6848\u4ef6\u7684\u6848\u4ef6ID\u548c\u4e89\u8bae\u91d1\u989d\uff0c\u4e0d\u8981\u521b\u5efa\u65b0\u4efb\u52a1\uff0c\u4e0d\u8981\u8c03\u7528\u5916\u90e8\u5e73\u53f0\u3002',
      category: 'question',
      complexity: 'moderate',
    });

    expect(decision).toEqual({
      shouldDelegate: false,
      reason: 'explicit_foreground_only',
    });
  });

  it('builds a concise foreground acknowledgement', () => {
    const ack = buildDelegationAck(['法律检索员', '文书整理员'], 'bg_123');
    expect(ack).toContain('法律检索员、文书整理员');
    expect(ack).toContain('bg_123');
    expect(ack).toContain('继续和你聊天');
  });

  it('does not expose the internal no-worker error to the user', () => {
    const message = formatBackgroundDelegationFailure(
      new Error('No worker agent accepted the delegated task.'),
      true,
    );
    expect(message).toContain('后台执行单元暂时不可用');
    expect(message).not.toContain('No worker agent accepted');
  });
});
