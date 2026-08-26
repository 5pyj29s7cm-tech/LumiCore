import { describe, expect, it } from 'vitest';
import {
  classifyActiveTaskMessage,
  formatActiveTaskRelationContext,
  resolveActiveTaskMessageRelation,
} from '../server/cognition/task_concurrency';
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

  it('cancels only an explicit cancellation or replacement', () => {
    expect(classifyActiveTaskMessage('取消当前任务', activeState)).toBe('cancel');
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
  });

  it('gives the planner root-level continuity and verification invariants', () => {
    const relation = resolveActiveTaskMessageRelation('不对，图纸单位应该是毫米', activeState, {
      activeRequestId: 'request-7',
    });
    const context = formatActiveTaskRelationContext(relation, activeState);

    expect(context).toContain('- followupIntent: execute');
    expect(context).toContain('- feedbackRelation: correction');
    expect(context).toContain('- taskId: task-1');
    expect(context).toContain('- taskRevision: 7');
    expect(context).toContain('- rootGoal: 读取桌面平面图并在 AutoCAD 里绘制');
    expect(context).toContain('worker or sub-step completion as evidence only');
    expect(context).toContain('root coordinator alone may report terminal completion');
  });
});
