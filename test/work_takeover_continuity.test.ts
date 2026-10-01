import './helpers';
import { describe, expect, it } from 'vitest';

describe('work takeover continuity', () => {
  it('binds a bare continue turn to the latest active task on a work surface', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildWorkTakeoverContinuityContext } = await import('../server/work_takeover/continuity');
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

    const command = buildWorkTakeoverContinuityContext('continuity_continue_user', '下一步呢', { surface: 'work' });
    expect(command.intent).toBe('advance');
    expect(command.latestTask?.id).toBe(task.id);
  });

  it('keeps ambiguous chat turns soft on a normal chat surface', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildWorkTakeoverContinuityContext } = await import('../server/work_takeover/continuity');
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
    expect(buildWorkTakeoverContinuityContext('continuity_chat_user', '下一步呢', { surface: 'chat' }).shouldResumeTask).toBe(false);
  });

  it('does not inherit an older takeover task when the user declares a new isolated task', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildWorkTakeoverContinuityContext } = await import('../server/work_takeover/continuity');
    await initDatabase();

    const userId = 'continuity_new_task_boundary_user';
    createWorkTakeoverTask({
      userId,
      category: 'general_work',
      title: '旧的后台接管任务',
      nextActions: ['继续旧任务'],
      source: 'manual',
      status: 'in_progress',
    });

    const text = '这是可取消的隔离长任务，等待后给出一句结果，不调用任何工具。';
    const context = buildWorkTakeoverContinuityContext(userId, text, { surface: 'chat' });
    expect(context.intent).toBeNull();
    expect(context.strength).toBe('none');
    expect(context.shouldResumeTask).toBe(false);
    expect(context.routeText).toBe(text);
    expect(buildWorkTakeoverContinuityContext(userId, text, { surface: 'chat' }).shouldResumeTask).toBe(false);
  });

  it('never lets a delivery restatement request resume an older work task', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildWorkTakeoverContinuityContext } = await import('../server/work_takeover/continuity');
    await initDatabase();

    const userId = 'continuity_adjacent_reply_restatement_user';
    createWorkTakeoverTask({
      userId,
      category: 'general_work',
      title: '青穹客户跟进闭环',
      nextActions: ['整理客户资料'],
      source: 'manual',
      status: 'in_progress',
      metadata: {
        workTakeoverExecution: {
          lastTurn: { status: 'failed' },
          lastFailure: { tool: 'desktop_ui_click', error: 'stale failure' },
        },
      },
    });

    const text = 'sorry, 你刚刚又卡住了，重新说。';
    for (const surface of ['chat', 'voice', 'work'] as const) {
      const context = buildWorkTakeoverContinuityContext(userId, text, { surface });
      expect(context.intent, surface).toBeNull();
      expect(context.strength, surface).toBe('none');
      expect(context.shouldResumeTask, surface).toBe(false);
      expect(context.routeText, surface).toBe(text);
      expect(buildWorkTakeoverContinuityContext(userId, text, { surface }).shouldResumeTask, surface).toBe(false);
    }
  });

  it('does not turn work-support questions into persisted-task continuation', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildWorkTakeoverContinuityContext } = await import('../server/work_takeover/continuity');
    await initDatabase();

    createWorkTakeoverTask({
      userId: 'continuity_work_support_question_user',
      category: 'general_work',
      title: '旧的未完成工作',
      nextActions: ['继续旧任务'],
      source: 'manual',
      status: 'in_progress',
    });

    const questions = [
      '请分三句简短回答：你今天会如何陪我完成工作？每句不超过十五个字。',
      '请分三句简短回答：你今天会如何陪我完成任务？每句不超过十五个字。',
      '你会怎么帮助我完成任务？',
      '请简短回答你会如何帮我完成工作，只回答，不执行任何任务。',
      'Please answer in three short sentences: how will you help me complete my work today? Keep each under fifteen words.',
      '你喜欢这个游戏吗？现在开始。',
    ];
    for (const text of questions) {
      const context = buildWorkTakeoverContinuityContext('continuity_work_support_question_user', text, { surface: 'chat' });
      expect(context.intent, text).toBeNull();
      expect(context.strength, text).toBe('none');
      expect(context.shouldResumeTask, text).toBe(false);
      expect(context.routeText, text).toBe(text);
      expect(buildWorkTakeoverContinuityContext('continuity_work_support_question_user', text, { surface: 'chat' }).shouldResumeTask, text).toBe(false);
    }
  });

  it.each([
    '现在帮我完成这项工作。',
    '现在继续完成这项工作。',
    'Help me complete this work now.',
    'Continue this work now.',
    '你会如何帮我完成工作？现在就开始。',
    'How would you help me complete this work? Start now.',
  ])('treats an explicit work imperative as advance, not status: %s', async (text) => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildWorkTakeoverContinuityContext } = await import('../server/work_takeover/continuity');
    await initDatabase();

    const userId = `continuity_work_imperative_${Buffer.from(text).toString('hex')}`;
    const task = createWorkTakeoverTask({
      userId,
      category: 'general_work',
      title: '需要继续的工作',
      nextActions: ['执行下一步'],
      source: 'manual',
      status: 'in_progress',
    });

    const context = buildWorkTakeoverContinuityContext(userId, text, { surface: 'chat' });
    expect(context.intent).toBe('advance');
    expect(context.strength).toBe('direct');
    expect(context.shouldResumeTask).toBe(true);
    const command = buildWorkTakeoverContinuityContext(userId, text, { surface: 'chat' });
    expect(command.intent).toBe('advance');
    expect(command.latestTask?.id).toBe(task.id);
  });

  it('keeps an explicit completion question on the status path', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildWorkTakeoverContinuityContext } = await import('../server/work_takeover/continuity');
    await initDatabase();

    createWorkTakeoverTask({
      userId: 'continuity_completion_question_user',
      category: 'general_work',
      title: '需要查询的工作',
      nextActions: ['等待查询'],
      source: 'manual',
      status: 'in_progress',
    });

    const context = buildWorkTakeoverContinuityContext(
      'continuity_completion_question_user',
      '完成这个工作了吗？',
      { surface: 'chat' },
    );
    expect(context.intent).toBe('status');
  });

  it('binds short chat follow-ups to the failed task recovery point', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildWorkTakeoverContinuityContext } = await import('../server/work_takeover/continuity');
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

    const command = buildWorkTakeoverContinuityContext('continuity_failed_resume_user', '怎么样了', { surface: 'chat' });
    expect(command.intent).toBe('status');
    expect(command.latestTask?.id).toBe(task.id);
  });

  it('lets voice chat continue unless the wording is clearly work-directed', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildWorkTakeoverContinuityContext } = await import('../server/work_takeover/continuity');
    await initDatabase();

    const task = createWorkTakeoverTask({
      userId: 'continuity_voice_user',
      category: 'general_work',
      title: '整理客户交付材料',
      nextActions: ['梳理需求'],
      source: 'manual',
      status: 'in_progress',
    });

    expect(buildWorkTakeoverContinuityContext('continuity_voice_user', '继续', { surface: 'voice' }).shouldResumeTask).toBe(false);
    const command = buildWorkTakeoverContinuityContext('continuity_voice_user', '继续推进这个任务', { surface: 'voice' });
    expect(command.intent).toBe('advance');
    expect(command.latestTask?.id).toBe(task.id);
  });

  it('does not confuse music continuation with work takeover continuation', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildWorkTakeoverContinuityContext } = await import('../server/work_takeover/continuity');
    await initDatabase();

    createWorkTakeoverTask({
      userId: 'continuity_music_user',
      category: 'general_work',
      title: '一个未完成任务',
      nextActions: ['继续处理'],
      source: 'manual',
      status: 'in_progress',
    });

    expect(buildWorkTakeoverContinuityContext('continuity_music_user', '继续播放音乐').shouldResumeTask).toBe(false);
  });

  it('does not invent work from an acknowledgement without an active task', async () => {
    const { initDatabase } = await import('../db_layer');
    const { buildWorkTakeoverContinuityContext } = await import('../server/work_takeover/continuity');
    await initDatabase();
    expect(buildWorkTakeoverContinuityContext('continuity_no_task_user', '好的').shouldResumeTask).toBe(false);
  });
});
