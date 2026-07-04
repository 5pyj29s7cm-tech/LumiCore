import './helpers';
import { beforeEach, describe, expect, it } from 'vitest';

describe('Lumi turn dispatch', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('treats task center as a first-class channel and work surface', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');

    const dispatch = buildLumiTurnDispatch({
      userId: 'turn_dispatch_task_user',
      text: '生成一份客户交付任务包',
      channel: 'task',
      source: 'task',
      operationMode: 'chat',
      targetIsLumi: true,
    });

    expect(dispatch.channel).toBe('task');
    expect(dispatch.surface).toBe('work');
    expect(dispatch.boundary).toBe('task_center');
    expect(dispatch.flow.channel).toBe('task');
    expect(dispatch.flow.effectiveOperationMode).toBe('assistant');
    expect(dispatch.flow.allowToolUseForTurn).toBe(true);
    expect(dispatch.promptOverlay).toContain('same Lumi');
  });

  it('routes work-domain chat through the work boundary even when source is chat', async () => {
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');

    const task = createWorkTakeoverTask({
      userId: 'turn_dispatch_work_user',
      domain: 'work',
      orgId: 'org-dispatch',
      category: 'store',
      title: '接管店铺账号',
      nextActions: ['整理账号风险'],
      source: 'wechat',
      status: 'in_progress',
    });

    const dispatch = buildLumiTurnDispatch({
      userId: 'turn_dispatch_work_user',
      text: '下一步呢',
      channel: 'chat',
      source: 'chat',
      domain: 'work',
      orgId: 'org-dispatch',
      operationMode: 'chat',
      targetIsLumi: true,
    });

    expect(dispatch.surface).toBe('work');
    expect(dispatch.boundary).toBe('work_takeover');
    expect(dispatch.flow.workTakeover.latestTask?.id).toBe(task.id);
    expect(dispatch.flow.workTakeover.shouldResumeTask).toBe(true);
  });

  it('keeps casual chat conversational instead of forcing an active task', async () => {
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');

    createWorkTakeoverTask({
      userId: 'turn_dispatch_casual_user',
      category: 'customer',
      title: '客户跟进',
      nextActions: ['准备回复'],
      source: 'wechat',
      status: 'in_progress',
    });

    const dispatch = buildLumiTurnDispatch({
      userId: 'turn_dispatch_casual_user',
      text: '我现在有点乱，陪我聊两句',
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
      targetIsLumi: true,
    });

    expect(dispatch.surface).toBe('chat');
    expect(dispatch.boundary).toBe('conversation');
    expect(dispatch.flow.allowToolUseForTurn).toBe(false);
    expect(dispatch.promptOverlay).toContain('conversation-first');
  });
});
