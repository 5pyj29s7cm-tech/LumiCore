import { describe, expect, it } from 'vitest';
import {
  buildRecentActionContinuationBridge,
  classifyConversationActionFollowupIntent,
  type ConversationActionContinuationState,
} from '../server/cognition/action_continuation';
import {
  isImmediateAssistantRestatementRequest,
  normalizeActionIntent,
} from '../server/cognition/normalized_action_intent';
import { resolveActiveTaskMessageRelation } from '../server/cognition/task_concurrency';
import { resolveExactConversationCorrection } from '../server/conversation/exact_correction';

const baseState: ConversationActionContinuationState = {
  version: 2,
  taskId: 'task-wps-review',
  status: 'executing',
  latestInstruction: '分析当前 WPS 演示文稿并给出结论',
  goal: '分析当前 WPS 演示文稿并给出结论',
  appTarget: 'WPS',
  sourcePaths: [],
  latestBlocker: '',
  unfinished: true,
  evidenceTools: [],
  assistantState: '',
  toolSummaries: [],
  revision: 4,
  activeRequestId: 'request-busy',
  updatedAt: new Date().toISOString(),
};

const waitingState: ConversationActionContinuationState = {
  ...baseState,
  status: 'waiting_confirmation',
  assistantState: '准备读取当前演示文稿，是否确认？',
};

const blockedTargetState: ConversationActionContinuationState = {
  ...baseState,
  status: 'blocked',
  activeRequestId: undefined,
  latestInstruction: '不是这份文件',
  latestBlocker: '用户否定了当前文件候选。',
};

const completedState: ConversationActionContinuationState = {
  ...baseState,
  status: 'completed',
  unfinished: false,
  activeRequestId: undefined,
  revision: 5,
};

describe('canonical seven-way task relation matrix', () => {
  const cases = [
    {
      name: 'continue an unfinished task',
      text: '继续执行',
      state: baseState,
      expected: {
        taskRelation: 'continue', feedback: 'continue', binding: 'active_task', operation: 'resume',
      },
      followup: 'execute',
    },
    {
      name: 'continue by supplying the exact filename after target rejection',
      text: '准确文件名是 Lumi-路演终稿.pptx，在桌面。请继续分析。',
      state: blockedTargetState,
      expected: {
        taskRelation: 'continue', feedback: 'continue', binding: 'active_task', operation: 'resume',
      },
      followup: 'execute',
    },
    {
      name: 'continue by supplying an exact path after target rejection',
      text: '路径是 D:\\演示资料\\Lumi-路演终稿.pptx',
      state: blockedTargetState,
      expected: {
        taskRelation: 'continue', feedback: 'continue', binding: 'active_task', operation: 'resume',
      },
      followup: 'execute',
    },
    {
      name: 'start a new explicit absolute-path analysis instead of filling the old target slot',
      text: '分析 D:\\新任务\\另一份合同.pdf',
      state: blockedTargetState,
      expected: {
        taskRelation: 'new', feedback: 'new_task', binding: 'new_task', operation: 'enqueue',
        preservesRootGoal: false,
      },
      followup: 'none',
    },
    {
      name: 'start a new explicit absolute-path open instead of filling the old target slot',
      text: '打开 D:\\新任务\\另一份合同.pdf',
      state: blockedTargetState,
      expected: {
        taskRelation: 'new', feedback: 'new_task', binding: 'new_task', operation: 'enqueue',
        preservesRootGoal: false,
      },
      followup: 'none',
    },
    {
      name: 'correct the current target',
      text: '不是这个',
      state: baseState,
      expected: {
        taskRelation: 'correct', feedback: 'correction', binding: 'active_task', operation: 'replan',
      },
      followup: 'execute',
    },
    {
      name: 'confirm the exact waiting action',
      text: '确认了',
      state: waitingState,
      expected: {
        taskRelation: 'confirm', feedback: 'accept', binding: 'active_task', operation: 'verify',
      },
      followup: 'execute',
    },
    {
      name: 'cancel despite a busy foreground request',
      text: '停止',
      state: baseState,
      expected: {
        relation: 'cancel', taskRelation: 'cancel', feedback: 'cancel', binding: 'active_task', operation: 'cancel',
        targetRequestId: 'request-busy',
      },
      followup: 'none',
    },
    {
      name: 'inspect an unfinished task without mutating it',
      text: '你在干嘛',
      state: baseState,
      expected: {
        relation: 'status', taskRelation: 'status', feedback: 'status', binding: 'active_task', operation: 'inspect',
      },
      followup: 'status',
    },
    {
      name: 'inspect the latest terminal task',
      text: '你在干嘛',
      state: completedState,
      expected: {
        relation: 'status', taskRelation: 'status', feedback: 'status', binding: 'previous_task', operation: 'inspect',
      },
      followup: 'status',
    },
    {
      name: 'repeat after a task is complete',
      text: '怎么说',
      state: completedState,
      expected: {
        taskRelation: 'repeat', feedback: 'repeat', binding: 'conversation', operation: 'repeat',
      },
      followup: 'repeat',
    },
    {
      name: 'repeat instead of reviving unfinished work',
      text: '怎么说',
      state: baseState,
      expected: {
        taskRelation: 'repeat', feedback: 'repeat', binding: 'conversation', operation: 'repeat',
      },
      followup: 'repeat',
    },
    {
      name: 'repeat a stalled adjacent answer instead of reviving unfinished work',
      text: '你刚才卡住了，重新说一下',
      state: baseState,
      expected: {
        taskRelation: 'repeat', feedback: 'repeat', binding: 'conversation', operation: 'repeat',
      },
      followup: 'repeat',
    },
    {
      name: 'start a concrete new artifact without hijacking unfinished work',
      text: '请创建 D:\\交付\\新的会议纪要.md，并写入今天的结论',
      state: baseState,
      expected: {
        taskRelation: 'new', feedback: 'new_task', binding: 'new_task', operation: 'enqueue',
        preservesRootGoal: false,
      },
      followup: 'none',
    },
    {
      name: 'start a concrete client navigation without hijacking unfinished work',
      text: '打开设置界面',
      state: baseState,
      expected: {
        taskRelation: 'new', feedback: 'new_task', binding: 'new_task', operation: 'enqueue',
        preservesRootGoal: false,
      },
      followup: 'none',
    },
  ] as const;

  for (const scenario of cases) {
    it(scenario.name, () => {
      expect(resolveActiveTaskMessageRelation(
        scenario.text,
        scenario.state,
        { activeRequestId: scenario.state.activeRequestId },
      )).toMatchObject(scenario.expected);
      expect(classifyConversationActionFollowupIntent(scenario.text, scenario.state))
        .toBe(scenario.followup);
    });
  }

  it('keeps a repeated terminal confirmation idempotently bound to the previous task', () => {
    expect(resolveActiveTaskMessageRelation('确认了', completedState)).toMatchObject({
      taskRelation: 'confirm',
      feedback: 'accept',
      binding: 'previous_task',
      operation: 'verify',
      taskId: 'task-wps-review',
      revision: 5,
    });
  });

  it('fails closed when a restart lost the exact pending confirmation envelope', () => {
    const restartBlocked: ConversationActionContinuationState = {
      ...blockedTargetState,
      latestBlocker: 'reconfirmation_required: exact pending action unavailable',
    };
    expect(resolveActiveTaskMessageRelation('确认', restartBlocked)).toMatchObject({
      taskRelation: 'status',
      feedback: 'status',
      operation: 'inspect',
    });
    expect(classifyConversationActionFollowupIntent('确认', restartBlocked)).toBe('status');
  });

  it('keeps normalized intent precedence consistent for status, correction, and new writes', () => {
    expect(normalizeActionIntent('你在干嘛')).toMatchObject({
      kind: 'status_query', operation: 'status', relation: 'status', sideEffectClass: 'none',
    });
    // Target correction is intentionally task-state dependent: the normalized
    // action layer stays neutral, then TaskCapsule + task_concurrency bind it
    // to the unfinished task instead of making it a globally non-executing
    // explanation intent.
    expect(normalizeActionIntent('不是这个文件，应该是 Lumi-路演终稿.pptx')).toMatchObject({
      kind: 'none', relation: 'new', sideEffectClass: 'none',
    });
    expect(normalizeActionIntent('请创建 D:\\交付\\新的会议纪要.md，并写入今天的结论')).toMatchObject({
      kind: 'desktop_operation', operation: 'create', relation: 'new', sideEffectClass: 'local_write',
    });
  });
});

describe('adjacent assistant reply restatement boundary', () => {
  const history = [
    { role: 'user', message: '帮我分析旧任务。' },
    { role: 'assistant', message: '旧任务还在等待文件。' },
    { role: 'user', message: '你是谁？' },
    { role: 'assistant', message: '我是 Lumi，你的常驻智能伙伴。' },
  ];

  it.each(['怎么说', '你刚才怎么说的', '再说一遍', '重新说', '你刚才卡住了，重新说一下'])(
    '%s repeats only the immediately preceding assistant reply',
    text => {
      expect(isImmediateAssistantRestatementRequest(text)).toBe(true);
      const bridge = buildRecentActionContinuationBridge(text, history, baseState);
      expect(bridge).toContain('- followupIntent: repeat');
      expect(bridge).toContain('我是 Lumi，你的常驻智能伙伴。');
      expect(bridge).not.toContain('旧任务还在等待文件。');
      expect(resolveExactConversationCorrection(text, history)).toBe('我是 Lumi，你的常驻智能伙伴。');
    },
  );

  it('selects the newest eligible user-visible reply and skips tool or guard rows', () => {
    const filteredHistory = [
      { role: 'assistant', message: '这是更早的普通用户可见回复。' },
      { role: 'user', message: '随后到达但还没有普通助手回复的消息。' },
      {
        role: 'tool',
        type: 'tool',
        message: '工具执行中间行，不应复述。',
      },
      {
        role: 'assistant',
        message: '这是最近一条用户可见的最终回复。',
        // Final transcript rows carry audit receipts in this product; that
        // metadata must not make their user-visible text disappear.
        toolCalls: [{ name: 'read_file', result: 'ok' }],
      },
      {
        role: 'assistant',
        type: 'status',
        message: 'thinking',
        cognitiveIntent: 'agent_status',
      },
      {
        role: 'assistant',
        message: '',
        toolCalls: [{ name: 'read_file', result: 'ok' }],
      },
      {
        role: 'assistant',
        message: '这一轮没有记录到成功的真实工具执行。',
        cognitiveIntent: 'work_product_guard',
      },
    ];
    const bridge = buildRecentActionContinuationBridge('重新说', filteredHistory, baseState);
    expect(bridge).toContain('这是最近一条用户可见的最终回复。');
    expect(bridge).not.toContain('工具执行中间行');
    expect(bridge).not.toContain('thinking');
    expect(bridge).not.toContain('这一轮没有记录到成功');
    expect(resolveExactConversationCorrection('重新说', filteredHistory))
      .toBe('这是最近一条用户可见的最终回复。');
  });

  it.each(['这个词怎么说', '英文怎么说', 'LumiCore 用英文怎么说'])(
    '%s remains a content question rather than a repeat control',
    text => {
      expect(isImmediateAssistantRestatementRequest(text)).toBe(false);
      expect(resolveActiveTaskMessageRelation(text, baseState).taskRelation).toBe('new');
    },
  );

  it('returns the no-repeat path when no eligible assistant reply exists', () => {
    const ineligibleHistory = [
      {
        role: 'tool',
        type: 'tool',
        message: '工具行。',
      },
      { role: 'user', message: '再说一遍。' },
    ];
    expect(buildRecentActionContinuationBridge('重新说', ineligibleHistory, baseState)).toBe('');
    expect(resolveExactConversationCorrection('重新说', ineligibleHistory)).toBeNull();
  });
});
