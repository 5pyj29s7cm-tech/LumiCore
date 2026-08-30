import { describe, expect, it } from 'vitest';
import {
  classifyActiveTaskMessage,
  formatActiveTaskRelationContext,
  resolveActiveTaskMessageRelation,
} from '../server/cognition/task_concurrency';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import type { ConversationActionContinuationState } from '../server/cognition/action_continuation';

const activeState: ConversationActionContinuationState = {
  version: 2,
  taskId: 'task-1',
  status: 'executing',
  latestInstruction: '读取桌面平面图并在 AutoCAD 里绘制',
  goal: '读取桌面平面图并在 AutoCAD 里绘制',
  appTarget: 'AutoCAD',
  sourcePaths: [],
  latestBlocker: '',
  unfinished: true,
  evidenceTools: [],
  assistantState: '',
  toolSummaries: [],
  revision: 7,
  activeRequestId: 'request-7',
  updatedAt: new Date().toISOString(),
};

describe('active task message relation', () => {
  it('keeps status and confirmation on the existing task', () => {
    expect(classifyActiveTaskMessage('怎么样了', activeState)).toBe('status');
    expect(classifyActiveTaskMessage('确认', activeState)).toBe('continue');
    expect(classifyActiveTaskMessage('继续执行', activeState)).toBe('continue');
  });

  it('keeps a global runtime-work query independent from the adjacent action', () => {
    for (const state of [activeState, null]) {
      expect(resolveActiveTaskMessageRelation('\u4f60\u73b0\u5728\u6709\u5728\u6267\u884c\u7684\u4efb\u52a1\u5417', state, {
        activeRequestId: state ? 'request-7' : undefined,
      })).toMatchObject({
        relation: 'queue',
        taskRelation: 'new',
        feedback: 'new_task',
        binding: 'new_task',
        operation: 'enqueue',
        reason: 'independent_instruction',
      });
    }
  });

  it('binds an actionable client-mode correction to the same unfinished task', () => {
    const correction = '\u6211\u8bf4\u7684\u662f\u5207\u6362\u5ba2\u6237\u7aef\u804a\u5929\u6a21\u5f0f';
    const clientTask: ConversationActionContinuationState = {
      ...activeState,
      taskId: 'task-client-mode',
      status: 'blocked',
      goal: '\u5207\u6362\u5ba2\u6237\u7aef\u6a21\u5f0f',
      latestInstruction: '\u5207\u6362\u5230\u6307\u6325\u4e2d\u5fc3',
      latestBlocker: 'client_action receipt missing',
      activeRequestId: 'request-client-mode',
      revision: 4,
      unfinished: true,
    };

    expect(normalizeActionIntent(correction)).toMatchObject({
      kind: 'client_navigation',
      target: 'chat',
      clientAction: 'set_client_mode',
      relation: 'correction',
    });
    expect(resolveActiveTaskMessageRelation(correction, clientTask, {
      activeRequestId: 'request-client-mode',
    })).toMatchObject({
      relation: 'continue',
      taskRelation: 'correct',
      feedback: 'correction',
      binding: 'active_task',
      operation: 'replan',
      taskId: 'task-client-mode',
      revision: 4,
      targetRequestId: 'request-client-mode',
      preservesRootGoal: true,
    });
  });

  it('starts actionable corrections without a task as new work and detaches unrelated work', () => {
    const correction = '\u6211\u8bf4\u7684\u662f\u5207\u6362\u5ba2\u6237\u7aef\u804a\u5929\u6a21\u5f0f';
    expect(resolveActiveTaskMessageRelation(correction, null)).toMatchObject({
      relation: 'queue',
      taskRelation: 'new',
      feedback: 'new_task',
      binding: 'new_task',
      operation: 'enqueue',
      preservesRootGoal: false,
    });

    const clientTask: ConversationActionContinuationState = {
      ...activeState,
      taskId: 'task-client-mode',
      status: 'blocked',
      goal: '\u5207\u6362\u5ba2\u6237\u7aef\u6a21\u5f0f',
      latestInstruction: '\u5207\u6362\u5230\u6307\u6325\u4e2d\u5fc3',
      unfinished: true,
    };
    expect(resolveActiveTaskMessageRelation('\u4eca\u5929\u5929\u6c14\u600e\u4e48\u6837', clientTask)).toMatchObject({
      relation: 'queue',
      taskRelation: 'new',
      feedback: 'new_task',
      binding: 'new_task',
      operation: 'enqueue',
      preservesRootGoal: false,
    });
  });

  it('cancels only an explicit cancellation or replacement', () => {
    expect(classifyActiveTaskMessage('取消当前任务', activeState)).toBe('cancel');
    expect(classifyActiveTaskMessage('Cancel this task. Do not write any file.', activeState)).toBe('cancel');
    expect(classifyActiveTaskMessage("Cancel this task. Don't write any file.", activeState)).toBe('cancel');
    expect(classifyActiveTaskMessage('Cancel this task. Don’t write any file.', activeState)).toBe('cancel');
    expect(classifyActiveTaskMessage('停止这个，改成打开 WPS', activeState)).toBe('replace');
  });

  it('queues independent work without destroying the active ledger', () => {
    expect(classifyActiveTaskMessage('顺便帮我整理一下会议纪要', activeState)).toBe('queue');
    expect(classifyActiveTaskMessage('今天天气怎么样', activeState)).toBe('queue');
  });

  it('distinguishes adjacent feedback and binds it to task identity and revision', () => {
    const cases = [
      ['怎么样了', 'status', 'inspect'],
      ['继续执行', 'continue', 'resume'],
      ['修', 'continue', 'resume'],
      ['修复这些问题', 'continue', 'resume'],
      ['重试', 'retry', 'retry'],
      ['不对，图纸单位应该是毫米', 'correction', 'replan'],
      ['我说的是打开设置，不是打开壁纸', 'correction', 'replan'],
      ['确认', 'accept', 'verify'],
      ['取消当前任务', 'cancel', 'cancel'],
      ['停止这个，改成打开 WPS', 'replace', 'supersede'],
    ] as const;

    for (const [text, feedback, operation] of cases) {
      expect(resolveActiveTaskMessageRelation(text, activeState, {
        activeRequestId: 'request-7',
      })).toMatchObject({
        feedback,
        operation,
        binding: 'active_task',
        taskId: 'task-1',
        revision: 7,
        targetRequestId: 'request-7',
      });
    }
  });

  it('keeps all long formal file-target corrections on the same task', () => {
    const root = 'C:\\Users\\ExampleUser\\LumiCore\\formal-client-e2e-artifacts\\LUMI-E2E-correction-lifecycle';
    const targets = [0, 1, 2, 3].map(index => `${root}\\target-${index}.txt`);
    const waitingState: ConversationActionContinuationState = {
      ...activeState,
      status: 'waiting_confirmation',
      latestInstruction: `create ${targets[0]}`,
      sourcePaths: [targets[0]],
      activeRequestId: undefined,
    };
    const corrections = [
      `不是 ${targets[0]}，把同一个任务的目标改成 ${targets[1]}，内容保持不变；不要沿用或重试旧目标。`,
      `再纠正一次：不要 ${targets[1]}，改成 ${targets[2]}，仍是同一个任务且内容不变。`,
      `最后一次纠正：拒绝 ${targets[2]}，最终目标是 ${targets[3]}，内容不变；等待我的确认。`,
    ];

    for (const text of corrections) {
      expect(resolveActiveTaskMessageRelation(text, waitingState)).toMatchObject({
        feedback: 'correction',
        taskRelation: 'correct',
        operation: 'replan',
        binding: 'active_task',
        taskId: 'task-1',
      });
    }
  });

  it('projects every turn onto the canonical seven-way task relation', () => {
    const cases = [
      ['清理一下', 'continue'],
      ['不是这份', 'correct'],
      ['确认了', 'confirm'],
      ['停止', 'cancel'],
      ['你在干嘛', 'status'],
      ['怎么说', 'repeat'],
      ['你刚才卡住了，重新说一下', 'repeat'],
      ['打开一份新的会议纪要', 'new'],
    ] as const;

    for (const [text, taskRelation] of cases) {
      expect(resolveActiveTaskMessageRelation(text, activeState, {
        activeRequestId: 'request-7',
      })).toMatchObject({ taskRelation });
    }
  });

  it('does not absorb a complete new task into an older active task', () => {
    expect(resolveActiveTaskMessageRelation('打开壁纸状态', activeState, {
      activeRequestId: 'request-7',
    })).toMatchObject({
      relation: 'queue',
      feedback: 'new_task',
      binding: 'new_task',
      operation: 'enqueue',
      preservesRootGoal: false,
    });
    expect(resolveActiveTaskMessageRelation('好的，帮我写一份新的会议纪要', activeState, {
      activeRequestId: 'request-7',
    }).feedback).toBe('new_task');
    expect(resolveActiveTaskMessageRelation('处理退款申请 20260826', activeState, {
      activeRequestId: 'request-7',
    }).feedback).toBe('new_task');
    expect(resolveActiveTaskMessageRelation('谁让你打开这个窗口的', activeState, {
      activeRequestId: 'request-7',
    })).toMatchObject({ relation: 'queue', binding: 'new_task' });
  });

  it('binds an exact filename supplied after WPS target rejection to the same task', () => {
    const wpsState: ConversationActionContinuationState = {
      ...activeState,
      taskId: 'task-wps-analysis',
      status: 'blocked',
      goal: '请分析当前 WPS 活动窗口里的演示文稿。',
      latestInstruction: '不是这份文件',
      appTarget: 'WPS',
      latestBlocker: '用户已拒绝当前文件候选。',
      activeRequestId: undefined,
      revision: 3,
    };

    expect(resolveActiveTaskMessageRelation(
      '准确文件名是 WPS-Quarterly-Review-Final.pptx，在桌面。请继续分析。',
      wpsState,
    )).toMatchObject({
      relation: 'continue',
      taskRelation: 'continue',
      feedback: 'continue',
      binding: 'active_task',
      taskId: 'task-wps-analysis',
      revision: 3,
      operation: 'resume',
    });
  });

  it('does not attach a current runtime request to a stale durable pointer', () => {
    const relation = resolveActiveTaskMessageRelation('怎么样了', activeState, {
      activeRequestId: 'request-new',
    });
    expect(relation).toMatchObject({
      feedback: 'status',
      binding: 'active_task',
      targetRequestId: 'request-new',
    });
    expect(relation.taskId).toBeUndefined();
    expect(relation.revision).toBeUndefined();
  });

  it('recognizes a natural pause request as cancellation of the adjacent action', () => {
    expect(resolveActiveTaskMessageRelation('等一下，你先停下', activeState, {
      activeRequestId: 'request-7',
    })).toMatchObject({ feedback: 'cancel', operation: 'cancel', binding: 'active_task' });
  });

  it('rejects stale request, task, or revision controls before mutation', () => {
    expect(resolveActiveTaskMessageRelation('重试', activeState, {
      activeRequestId: 'request-7',
      controlTargetRequestId: 'request-6',
    })).toMatchObject({ binding: 'stale', operation: 'reject_stale', reason: 'control_target_request_mismatch' });

    expect(resolveActiveTaskMessageRelation('继续执行', activeState, {
      activeRequestId: 'request-7',
      controlTargetTaskId: 'task-other',
    })).toMatchObject({ binding: 'stale', reason: 'control_target_task_mismatch' });

    expect(resolveActiveTaskMessageRelation('确认', activeState, {
      activeRequestId: 'request-7',
      controlTargetTaskId: 'task-1',
      controlTargetRevision: 6,
    })).toMatchObject({ binding: 'stale', reason: 'control_target_revision_mismatch' });
  });

  it('rejects an explicit runtime target when no matching request is active', () => {
    expect(resolveActiveTaskMessageRelation('取消当前任务', {
      ...activeState,
      activeRequestId: undefined,
      unfinished: false,
    }, {
      controlTargetRequestId: 'request-that-is-no-longer-active',
    })).toMatchObject({
      feedback: 'cancel',
      binding: 'stale',
      operation: 'reject_stale',
      reason: 'control_target_request_mismatch',
    });
  });

  it('labels a completed durable task status lookup as previous_task', () => {
    const relation = resolveActiveTaskMessageRelation("what's the result?", {
      ...activeState,
      status: 'completed',
      unfinished: false,
      activeRequestId: undefined,
      revision: 8,
    });
    expect(relation).toMatchObject({
      relation: 'status',
      feedback: 'status',
      binding: 'previous_task',
      operation: 'inspect',
      taskId: 'task-1',
      revision: 8,
    });
    expect(relation.targetRequestId).toBeUndefined();
  });

  it('binds a cancellation safety restatement to the terminal previous task as a no-op target', () => {
    const relation = resolveActiveTaskMessageRelation('Cancel this task. Do not write any file.', {
      ...activeState,
      status: 'completed',
      unfinished: false,
      activeRequestId: undefined,
      revision: 8,
    });
    expect(relation).toMatchObject({
      relation: 'cancel',
      taskRelation: 'cancel',
      feedback: 'cancel',
      binding: 'previous_task',
      operation: 'cancel',
      taskId: 'task-1',
      revision: 8,
    });
  });

  it('binds a repeated confirmation to the terminal previous task without reviving it', () => {
    const completed = {
      ...activeState,
      status: 'completed' as const,
      unfinished: false,
      activeRequestId: undefined,
      revision: 8,
    };
    expect(resolveActiveTaskMessageRelation('确认了', completed)).toMatchObject({
      relation: 'continue',
      taskRelation: 'confirm',
      feedback: 'accept',
      binding: 'previous_task',
      operation: 'verify',
      taskId: 'task-1',
      revision: 8,
      reason: 'durable_previous_action',
    });
    expect(resolveActiveTaskMessageRelation('确认了', completed, {
      controlTargetRequestId: 'request-7',
    })).toMatchObject({
      binding: 'stale',
      reason: 'control_target_request_mismatch',
    });
    expect(resolveActiveTaskMessageRelation('确认了', completed, {
      controlTargetRequestId: 'request-7',
      controlTargetTaskId: 'task-1',
      controlTargetRevision: 8,
    })).toMatchObject({
      binding: 'previous_task',
      taskId: 'task-1',
      revision: 8,
    });
  });

  it('accepts an exact task/revision fence when the prior request lease is gone', () => {
    const completed = {
      ...activeState,
      status: 'completed' as const,
      unfinished: false,
      activeRequestId: undefined,
      revision: 8,
    };
    expect(resolveActiveTaskMessageRelation("what's the result?", completed, {
      controlTargetRequestId: 'request-7',
      controlTargetTaskId: 'task-1',
      controlTargetRevision: 8,
    })).toMatchObject({
      binding: 'previous_task',
      operation: 'inspect',
      taskId: 'task-1',
      revision: 8,
    });

    const idleUnfinished = {
      ...activeState,
      status: 'blocked' as const,
      unfinished: true,
      activeRequestId: undefined,
      revision: 9,
    };
    expect(resolveActiveTaskMessageRelation('取消当前任务', idleUnfinished, {
      controlTargetRequestId: 'request-7',
      controlTargetTaskId: 'task-1',
      controlTargetRevision: 9,
    })).toMatchObject({
      binding: 'active_task',
      operation: 'cancel',
      taskId: 'task-1',
      revision: 9,
    });
  });

  it('still rejects an idle durable control with only an old request or a mismatched fence', () => {
    const idleUnfinished = {
      ...activeState,
      status: 'blocked' as const,
      unfinished: true,
      activeRequestId: undefined,
      revision: 9,
    };
    expect(resolveActiveTaskMessageRelation('取消当前任务', idleUnfinished, {
      controlTargetRequestId: 'request-7',
    })).toMatchObject({ binding: 'stale', reason: 'control_target_request_mismatch' });
    expect(resolveActiveTaskMessageRelation('取消当前任务', idleUnfinished, {
      controlTargetRequestId: 'request-7',
      controlTargetTaskId: 'task-other',
      controlTargetRevision: 9,
    })).toMatchObject({ binding: 'stale', reason: 'control_target_request_mismatch' });
    expect(resolveActiveTaskMessageRelation('取消当前任务', idleUnfinished, {
      controlTargetRequestId: 'request-7',
      controlTargetTaskId: 'task-1',
      controlTargetRevision: 8,
    })).toMatchObject({ binding: 'stale', reason: 'control_target_request_mismatch' });
  });

  it('keeps adjacent reply repetition conversational instead of reviving the task', () => {
    expect(resolveActiveTaskMessageRelation('你刚才卡住了，重新说一下', activeState, {
      activeRequestId: 'request-7',
    })).toMatchObject({
      relation: 'queue',
      feedback: 'repeat',
      binding: 'conversation',
      operation: 'repeat',
    });
    expect(resolveActiveTaskMessageRelation('怎么说', null)).toMatchObject({
      relation: 'queue',
      feedback: 'repeat',
      binding: 'conversation',
      operation: 'repeat',
    });
  });

  it('keeps a status-shaped ordinary question unbound when there is no current or recent task', () => {
    for (const text of ['你在干啥', '你在做什么']) {
      expect(resolveActiveTaskMessageRelation(text, null)).toMatchObject({
        relation: 'status',
        taskRelation: 'status',
        feedback: 'status',
        binding: 'conversation',
        operation: 'inspect',
        reason: 'no_bindable_action',
      });
      expect(resolveActiveTaskMessageRelation(text, null).targetRequestId).toBeUndefined();
    }
  });

  it('keeps a bare acknowledgement conversational when no action is pending', () => {
    const completed = {
      ...activeState,
      status: 'completed' as const,
      unfinished: false,
      activeRequestId: undefined,
      revision: 8,
    };
    expect(resolveActiveTaskMessageRelation('\u597d\u7684', completed, {
      controlTargetRequestId: 'request-7',
    })).toMatchObject({
      relation: 'queue',
      taskRelation: 'new',
      feedback: 'new_task',
      binding: 'new_task',
      operation: 'enqueue',
      reason: 'independent_instruction',
    });

    expect(resolveActiveTaskMessageRelation('\u597d\u7684', {
      ...activeState,
      status: 'blocked' as const,
      activeRequestId: undefined,
    }, {
      controlTargetRequestId: 'request-7',
    })).toMatchObject({
      feedback: 'new_task',
      binding: 'new_task',
    });
  });

  it('still binds a bare acknowledgement to an action waiting for confirmation', () => {
    expect(resolveActiveTaskMessageRelation('\u597d\u7684', {
      ...activeState,
      status: 'waiting_confirmation' as const,
      activeRequestId: undefined,
    })).toMatchObject({
      relation: 'continue',
      taskRelation: 'confirm',
      feedback: 'accept',
      binding: 'active_task',
      operation: 'verify',
      taskId: 'task-1',
    });
  });

  it('gives the planner root-level continuity and verification invariants', () => {
    const relation = resolveActiveTaskMessageRelation('不对，图纸单位应该是毫米', activeState, {
      activeRequestId: 'request-7',
    });
    const context = formatActiveTaskRelationContext(relation, activeState);

    expect(context).toContain('- followupIntent: execute');
    expect(context).toContain('- feedbackRelation: correction');
    expect(context).toContain('- taskRelation: correct');
    expect(context).toContain('- taskId: task-1');
    expect(context).toContain('- taskRevision: 7');
    expect(context).toContain('- rootGoal: 读取桌面平面图并在 AutoCAD 里绘制');
    expect(context).toContain('an individual step completing as evidence only');
    expect(context).toContain('LumiCore may report terminal completion only after checking the whole goal');
  });
});
