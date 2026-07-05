import './helpers';
import { describe, expect, it } from 'vitest';

describe('work takeover continuity', () => {
  it('binds a bare continue turn to the latest active task on a work surface', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildWorkTakeoverContinuityContext, getWorkTakeoverContinuationQuickCommand } = await import('../server/work_takeover/continuity');
    await initDatabase();

    const task = createWorkTakeoverTask({
      userId: 'continuity_continue_user',
      category: 'general_work',
      title: '整理客户交付材料',
      summary: '把客户消息整理成任务包和回复草稿',
      nextActions: ['梳理需求', '准备回复草稿'],
      source: 'wechat',
      status: 'in_progress',
    });

    const context = buildWorkTakeoverContinuityContext('continuity_continue_user', '继续', {
      domain: 'personal',
      orgId: '',
      surface: 'work',
    });
    expect(context.shouldResumeTask).toBe(true);
    expect(context.strength).toBe('direct');
    expect(context.latestTask?.id).toBe(task.id);
    expect(context.routeText).toContain('工作接管');
    expect(context.promptOverlay).toContain(task.id);

    const command = getWorkTakeoverContinuationQuickCommand('下一步呢', 'continuity_continue_user', { surface: 'work' });
    expect(command?.toolCall.name).toBe('work_takeover_task_advance');
    expect(command?.toolCall.arguments.id).toBe(task.id);
  });

  it('keeps ambiguous chat turns soft on a normal chat surface', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildWorkTakeoverContinuityContext, getWorkTakeoverContinuationQuickCommand } = await import('../server/work_takeover/continuity');
    await initDatabase();

    createWorkTakeoverTask({
      userId: 'continuity_chat_user',
      category: 'general_work',
      title: '整理客户交付材料',
      nextActions: ['梳理需求'],
      source: 'wechat',
      status: 'in_progress',
    });

    const context = buildWorkTakeoverContinuityContext('continuity_chat_user', '下一步呢', { surface: 'chat' });
    expect(context.intent).toBe('advance');
    expect(context.strength).toBe('hint');
    expect(context.shouldResumeTask).toBe(false);
    expect(context.promptOverlay).toContain('may still be ordinary chat');
    expect(getWorkTakeoverContinuationQuickCommand('下一步呢', 'continuity_chat_user', { surface: 'chat' })).toBeNull();
  });

  it('binds short chat follow-ups to the failed task recovery point', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildWorkTakeoverContinuityContext, getWorkTakeoverContinuationQuickCommand } = await import('../server/work_takeover/continuity');
    await initDatabase();

    const task = createWorkTakeoverTask({
      userId: 'continuity_failed_resume_user',
      category: 'general_work',
      title: '打开 Codex 并输入预设消息',
      nextActions: ['恢复 Codex 窗口', '定位输入框', '输入消息'],
      source: 'manual',
      status: 'in_progress',
      metadata: {
        workTakeoverExecution: {
          lastTurn: { status: 'failed', capabilityLane: 'desktop_control' },
          lastFailure: { tool: 'desktop_ui_click', error: 'input box was not focused' },
          resumeHint: 'Resume task from the missed Codex input box focus.',
        },
      },
    });

    const context = buildWorkTakeoverContinuityContext('continuity_failed_resume_user', '继续', {
      surface: 'chat',
    });

    expect(context.shouldResumeTask).toBe(true);
    expect(context.strength).toBe('direct');
    expect(context.latestTask?.id).toBe(task.id);
    expect(context.promptOverlay).toContain('recovery pressure');
    expect(context.promptOverlay).toContain('failedTool=desktop_ui_click');

    const command = getWorkTakeoverContinuationQuickCommand('怎么样了', 'continuity_failed_resume_user', { surface: 'chat' });
    expect(command?.toolCall.name).toBe('work_takeover_task_continue');
    expect(command?.toolCall.arguments.id).toBe(task.id);
  });

  it('lets voice chat continue unless the wording is clearly work-directed', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { getWorkTakeoverContinuationQuickCommand } = await import('../server/work_takeover/continuity');
    await initDatabase();

    const task = createWorkTakeoverTask({
      userId: 'continuity_voice_user',
      category: 'general_work',
      title: '整理客户交付材料',
      nextActions: ['梳理需求'],
      source: 'manual',
      status: 'in_progress',
    });

    expect(getWorkTakeoverContinuationQuickCommand('继续', 'continuity_voice_user', { surface: 'voice' })).toBeNull();
    const command = getWorkTakeoverContinuationQuickCommand('继续推进这个任务', 'continuity_voice_user', { surface: 'voice' });
    expect(command?.toolCall.name).toBe('work_takeover_task_advance');
    expect(command?.toolCall.arguments.id).toBe(task.id);
  });

  it('does not confuse music continuation with work takeover continuation', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { getWorkTakeoverContinuationQuickCommand } = await import('../server/work_takeover/continuity');
    await initDatabase();

    createWorkTakeoverTask({
      userId: 'continuity_music_user',
      category: 'general_work',
      title: '一个未完成任务',
      nextActions: ['继续处理'],
      source: 'manual',
      status: 'in_progress',
    });

    expect(getWorkTakeoverContinuationQuickCommand('继续播放音乐', 'continuity_music_user')).toBeNull();
  });

  it('keeps ordinary acknowledgements when there is no active task', async () => {
    const { initDatabase } = await import('../db_layer');
    const { matchQuickCommand } = await import('../server/cognition/quick_commands');
    await initDatabase();

    const result = await matchQuickCommand('好的', 'continuity_no_task_user');
    expect(result?.matched).toBe(true);
    expect(result?.toolCall).toBeUndefined();
    expect(result?.responseText).toBe('👍');
  });
});
