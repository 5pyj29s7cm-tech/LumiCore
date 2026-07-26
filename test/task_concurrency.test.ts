import { describe, expect, it } from 'vitest';
import { classifyActiveTaskMessage } from '../server/cognition/task_concurrency';
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
});
