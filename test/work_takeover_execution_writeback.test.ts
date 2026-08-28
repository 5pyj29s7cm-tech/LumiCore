import './helpers';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolExecutionRecord } from '../server/tools/types';

const declarations = [
  'work_takeover_task_advance',
  'work_takeover_task_continue',
  'work_takeover_task_verify_result',
  'desktop_ui_snapshot',
  'desktop_ui_click',
].map(name => ({
  type: 'function' as const,
  function: {
    name,
    description: name.replace(/_/g, ' '),
    parameters: { type: 'object', properties: {} },
  },
}));

async function buildTurn(userId: string, text: string) {
  const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
  const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');
  const { buildLumiCapabilitySelection } = await import('../server/cognition/capability_selection');

  const dispatch = buildLumiTurnDispatch({
    userId,
    text,
    channel: 'chat',
    source: 'chat',
    domain: 'work',
    orgId: 'org-writeback',
    operationMode: 'chat',
    targetIsLumi: true,
  });
  const execution = buildLumiExecutionDecision({
    flow: dispatch.flow,
    text,
    toolDeclarations: declarations,
  });
  const capabilitySelection = buildLumiCapabilitySelection({
    dispatch,
    execution,
    text,
  });
  return { dispatch, execution, capabilitySelection };
}

describe('work takeover execution writeback', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('records the last capability lane, failed tool, and resume hint on the active task', async () => {
    const { createWorkTakeoverTask, getWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { persistWorkTakeoverTurnExecution } = await import('../server/work_takeover/execution_writeback');

    const task = createWorkTakeoverTask({
      userId: 'writeback_user',
      domain: 'work',
      orgId: 'org-writeback',
      category: 'general_work',
      title: 'Prepare customer delivery',
      nextActions: ['Open the file', 'Verify the result'],
      source: 'wechat',
      status: 'in_progress',
    });
    const { dispatch, capabilitySelection } = await buildTurn('writeback_user', 'continue the customer task');
    const toolRecords: ToolExecutionRecord[] = [
      {
        name: 'desktop_ui_click',
        arguments: { x: 100, y: 200 },
        result: '',
        error: 'Button not found',
      },
    ];

    const result = persistWorkTakeoverTurnExecution({
      userId: 'writeback_user',
      userText: 'continue the customer task',
      assistantText: 'I hit a blocker and need to inspect the window again.',
      source: 'chat',
      interactionId: 'turn-writeback-1',
      domain: 'work',
      orgId: 'org-writeback',
      flow: dispatch.flow,
      capabilitySelection,
      toolRecords,
    });

    const updated = getWorkTakeoverTask('writeback_user', task.id)!;
    expect(result.recorded).toBe(true);
    expect(result.taskId).toBe(task.id);
    expect(updated.metadata.workTakeoverExecution.lastTurn.capabilityLane).toBe('work_takeover');
    expect(updated.metadata.workTakeoverExecution.lastTurn.failedTool.name).toBe('desktop_ui_click');
    expect(updated.metadata.workTakeoverExecution.lastFailure.tool).toBe('desktop_ui_click');
    expect(updated.metadata.workTakeoverExecution.resumeHint).toContain('Resume task');
    expect(updated.blockedBy.join(' ')).toContain('desktop_ui_click');
  });

  it('does not let an unrelated current tool action hijack an ordinary active task', async () => {
    const { createWorkTakeoverTask, getWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { persistWorkTakeoverTurnExecution } = await import('../server/work_takeover/execution_writeback');

    const userId = `writeback_unrelated_${Date.now()}_${Math.random()}`;
    const task = createWorkTakeoverTask({
      userId,
      domain: 'work',
      orgId: 'org-writeback',
      category: 'general_work',
      title: 'Unfinished customer delivery',
      status: 'in_progress',
    });
    const { dispatch, capabilitySelection } = await buildTurn(userId, 'analyze my music profile');
    expect(dispatch.flow.workTakeover.latestTask?.id).toBe(task.id);
    expect(dispatch.flow.workTakeover.shouldResumeTask).toBe(false);

    const writeback = persistWorkTakeoverTurnExecution({
      userId,
      userText: 'analyze my music profile',
      assistantText: 'Music profile analyzed.',
      source: 'chat_music_profile',
      domain: 'work',
      orgId: 'org-writeback',
      flow: dispatch.flow,
      capabilitySelection,
      toolRecords: [{
        name: 'music_profile_analysis',
        arguments: {},
        result: JSON.stringify({ ok: true }),
      }],
    });

    expect(writeback).toMatchObject({ recorded: false, status: 'no_task' });
    expect(getWorkTakeoverTask(userId, task.id)?.metadata.workTakeoverExecution).toBeUndefined();
  });

  it.each([
    {
      name: 'work_takeover_task_list',
      expectedStatus: 'no_execution',
      arguments: (taskId: string) => ({ id: taskId }),
      result: (taskId: string) => JSON.stringify({
        tasks: [{ id: taskId, title: 'Unfinished customer delivery' }],
        count: 1,
      }),
    },
    {
      name: 'work_takeover_task_get',
      expectedStatus: 'no_execution',
      arguments: (taskId: string) => ({ id: taskId }),
      result: (taskId: string) => JSON.stringify({
        task: { id: taskId, title: 'Unfinished customer delivery' },
      }),
    },
    {
      name: 'read_file',
      expectedStatus: 'no_task',
      arguments: () => ({ path: 'task-export.json' }),
      result: (taskId: string) => `Document text mentions ${taskId} but is not a task operation.`,
    },
    {
      name: 'work_takeover_task_continue',
      expectedStatus: 'no_task',
      arguments: () => ({}),
      result: (taskId: string) => JSON.stringify({
        tasks: [{ id: taskId, title: 'Nested list must not bind' }],
      }),
    },
    {
      name: 'work_takeover_task_continue',
      expectedStatus: 'no_task',
      arguments: () => ({}),
      result: (taskId: string) => `Unstructured receipt mentions ${taskId}`,
    },
  ])('does not bind task state from $name list or arbitrary result content', async ({
    name,
    expectedStatus,
    arguments: buildArguments,
    result: buildResult,
  }) => {
    const { createWorkTakeoverTask, getWorkTakeoverTask, updateWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { persistWorkTakeoverTurnExecution } = await import('../server/work_takeover/execution_writeback');

    const userId = `writeback_result_hijack_${Date.now()}_${Math.random()}`;
    const task = createWorkTakeoverTask({
      userId,
      domain: 'work',
      orgId: 'org-writeback',
      category: 'general_work',
      title: 'Unfinished customer delivery',
      status: 'queued',
    });
    updateWorkTakeoverTask(userId, task.id, { result: 'previous verified result' });
    const { dispatch, capabilitySelection } = await buildTurn(userId, 'analyze my music profile');
    expect(dispatch.flow.workTakeover.shouldResumeTask).toBe(false);

    const writeback = persistWorkTakeoverTurnExecution({
      userId,
      userText: 'analyze my music profile',
      assistantText: 'Here is the requested information.',
      source: 'chat',
      domain: 'work',
      orgId: 'org-writeback',
      flow: dispatch.flow,
      capabilitySelection,
      toolRecords: [{
        name,
        arguments: typeof buildArguments === 'function'
          ? buildArguments(task.id)
          : buildArguments,
        result: buildResult(task.id),
      }],
    });

    expect(writeback).toMatchObject({ recorded: false, status: expectedStatus });
    const unchanged = getWorkTakeoverTask(userId, task.id)!;
    expect(unchanged.status).toBe('queued');
    expect(unchanged.result).toBe('previous verified result');
    expect(unchanged.metadata.workTakeoverExecution).toBeUndefined();
  });

  it.each([
    'work_takeover_task_update',
    'work_takeover_task_continue',
    'work_takeover_task_orchestrate',
    'work_takeover_task_verify_result',
  ])('still binds an explicit structured task argument for %s', async (toolName) => {
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { persistWorkTakeoverTurnExecution } = await import('../server/work_takeover/execution_writeback');

    const userId = `writeback_explicit_binding_${Date.now()}_${Math.random()}`;
    const task = createWorkTakeoverTask({
      userId,
      domain: 'work',
      orgId: 'org-writeback',
      category: 'general_work',
      title: 'Explicitly addressed task',
      status: 'in_progress',
    });
    const { dispatch, capabilitySelection } = await buildTurn(userId, 'analyze my music profile');

    const writeback = persistWorkTakeoverTurnExecution({
      userId,
      userText: 'analyze my music profile',
      assistantText: 'The addressed task operation ran.',
      source: 'chat',
      domain: 'work',
      orgId: 'org-writeback',
      flow: dispatch.flow,
      capabilitySelection,
      toolRecords: [{
        name: toolName,
        arguments: { id: task.id },
        result: JSON.stringify({ task: { id: task.id }, ok: true }),
      }],
    });

    expect(writeback).toMatchObject({ recorded: true, taskId: task.id, status: 'ran' });
  });

  it('does not turn a pure task-status lookup into execution writeback', async () => {
    const { createWorkTakeoverTask, getWorkTakeoverTask, updateWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { persistWorkTakeoverTurnExecution } = await import('../server/work_takeover/execution_writeback');

    const userId = `writeback_status_lookup_${Date.now()}_${Math.random()}`;
    const task = createWorkTakeoverTask({
      userId,
      domain: 'work',
      orgId: 'org-writeback',
      category: 'general_work',
      title: 'Status-only task',
      status: 'queued',
    });
    updateWorkTakeoverTask(userId, task.id, { result: 'previous verified result' });
    const { dispatch, capabilitySelection } = await buildTurn(userId, 'what is the current task status?');
    expect(dispatch.flow.workTakeover.intent).toBe('status');

    const writeback = persistWorkTakeoverTurnExecution({
      userId,
      userText: 'what is the current task status?',
      assistantText: 'The task is still queued.',
      source: 'chat',
      domain: 'work',
      orgId: 'org-writeback',
      flow: dispatch.flow,
      capabilitySelection,
      toolRecords: [{
        name: 'work_takeover_task_continue',
        arguments: { id: task.id },
        result: JSON.stringify({ task: { id: task.id, status: 'queued' } }),
      }],
    });

    expect(writeback.recorded).toBe(false);
    const unchanged = getWorkTakeoverTask(userId, task.id)!;
    expect(unchanged.status).toBe('queued');
    expect(unchanged.result).toBe('previous verified result');
    expect(unchanged.metadata.workTakeoverExecution).toBeUndefined();
  });

  it('binds an implicit continue only from its structured single-task receipt', async () => {
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { persistWorkTakeoverTurnExecution } = await import('../server/work_takeover/execution_writeback');

    const userId = `writeback_receipt_binding_${Date.now()}_${Math.random()}`;
    const task = createWorkTakeoverTask({
      userId,
      domain: 'work',
      orgId: 'org-writeback',
      category: 'general_work',
      title: 'Receipt-addressed task',
      status: 'in_progress',
    });
    const { dispatch, capabilitySelection } = await buildTurn(userId, 'analyze my music profile');

    const writeback = persistWorkTakeoverTurnExecution({
      userId,
      userText: 'analyze my music profile',
      assistantText: 'The continued task was inspected.',
      source: 'voice',
      domain: 'work',
      orgId: 'org-writeback',
      flow: dispatch.flow,
      capabilitySelection,
      toolRecords: [{
        name: 'work_takeover_task_continue',
        arguments: {},
        result: JSON.stringify({ task: { id: task.id }, currentAction: 'Inspect the file' }),
      }],
    });

    expect(writeback).toMatchObject({ recorded: true, taskId: task.id, status: 'ran' });
  });

  it('binds a newly created task from the create tool structured receipt', async () => {
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { persistWorkTakeoverTurnExecution } = await import('../server/work_takeover/execution_writeback');

    const userId = `writeback_create_binding_${Date.now()}_${Math.random()}`;
    const task = createWorkTakeoverTask({
      userId,
      domain: 'work',
      orgId: 'org-writeback',
      category: 'general_work',
      title: 'Newly created task',
      status: 'queued',
    });
    const { dispatch, capabilitySelection } = await buildTurn(userId, 'analyze my music profile');

    const writeback = persistWorkTakeoverTurnExecution({
      userId,
      userText: 'create a task for the customer follow-up',
      assistantText: 'The task was created.',
      source: 'chat',
      domain: 'work',
      orgId: 'org-writeback',
      flow: dispatch.flow,
      capabilitySelection,
      toolRecords: [{
        name: 'work_takeover_task_create',
        arguments: { category: 'general_work' },
        result: JSON.stringify({ task: { id: task.id }, note: 'created' }),
      }],
    });

    expect(writeback).toMatchObject({ recorded: true, taskId: task.id, status: 'ran' });
  });

  it('surfaces last failure and resume hint in continuity context', async () => {
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { persistWorkTakeoverTurnExecution } = await import('../server/work_takeover/execution_writeback');
    const { buildWorkTakeoverContinuityContext } = await import('../server/work_takeover/continuity');

    const task = createWorkTakeoverTask({
      userId: 'writeback_context_user',
      domain: 'work',
      orgId: 'org-writeback',
      category: 'general_work',
      title: 'Customer delivery stuck point',
      nextActions: ['Inspect app state'],
      source: 'manual',
      status: 'in_progress',
    });
    const { dispatch, capabilitySelection } = await buildTurn('writeback_context_user', 'continue the customer task');
    persistWorkTakeoverTurnExecution({
      userId: 'writeback_context_user',
      userText: 'continue the customer task',
      assistantText: 'The click failed.',
      source: 'chat',
      interactionId: 'turn-writeback-2',
      domain: 'work',
      orgId: 'org-writeback',
      flow: dispatch.flow,
      capabilitySelection,
      toolRecords: [{
        name: 'desktop_ui_click',
        arguments: {},
        result: '',
        error: 'Button not found',
      }],
    });

    const context = buildWorkTakeoverContinuityContext('writeback_context_user', 'what happened with this task', {
      domain: 'work',
      orgId: 'org-writeback',
      surface: 'work',
    });

    expect(context.latestTask?.id).toBe(task.id);
    expect(context.promptOverlay).toContain('Last execution:');
    expect(context.promptOverlay).toContain('failedTool=desktop_ui_click');
    expect(context.promptOverlay).toContain('Resume task');
  });

  it('does not write a guard-only turn back to an active task when no tool ran', async () => {
    const {
      createWorkTakeoverTask,
      getWorkTakeoverTask,
      updateWorkTakeoverTask,
    } = await import('../server/work_takeover/tasks');
    const { persistWorkTakeoverTurnExecution } = await import('../server/work_takeover/execution_writeback');

    const userId = `writeback_guard_no_tools_${Date.now()}_${Math.random()}`;
    const task = createWorkTakeoverTask({
      userId,
      domain: 'work',
      orgId: 'org-writeback',
      category: 'general_work',
      title: 'Keep the last verified result',
      status: 'in_progress',
    });
    updateWorkTakeoverTask(userId, task.id, { result: 'previous verified result' });
    const { dispatch, capabilitySelection } = await buildTurn(userId, 'continue the task');

    const writeback = persistWorkTakeoverTurnExecution({
      userId,
      userText: 'continue the task',
      assistantText: '我还不能说这件事已经完成。',
      source: 'chat',
      domain: 'work',
      orgId: 'org-writeback',
      flow: dispatch.flow,
      capabilitySelection,
      toolRecords: [],
      finalizationBlocked: true,
      assistantTextTrusted: false,
      finalizationReason: 'No successful tool execution was recorded.',
    });

    const unchanged = getWorkTakeoverTask(userId, task.id)!;
    expect(writeback.recorded).toBe(false);
    expect(writeback.reason).toContain('without tool execution evidence');
    expect(unchanged.result).toBe('previous verified result');
    expect(unchanged.metadata.workTakeoverExecution).toBeUndefined();
  });

  it('keeps real tool status but never persists blocked assistant text as a task result', async () => {
    const {
      createWorkTakeoverTask,
      getWorkTakeoverTask,
      updateWorkTakeoverTask,
    } = await import('../server/work_takeover/tasks');
    const { persistWorkTakeoverTurnExecution } = await import('../server/work_takeover/execution_writeback');

    const userId = `writeback_guard_with_tool_${Date.now()}_${Math.random()}`;
    const task = createWorkTakeoverTask({
      userId,
      domain: 'work',
      orgId: 'org-writeback',
      category: 'general_work',
      title: 'Preserve verified tool state',
      status: 'in_progress',
    });
    updateWorkTakeoverTask(userId, task.id, { result: 'previous verified result' });
    const { dispatch, capabilitySelection } = await buildTurn(userId, 'continue the task');

    const writeback = persistWorkTakeoverTurnExecution({
      userId,
      userText: 'continue the task',
      assistantText: '我还不能说这件事已经完成。',
      source: 'voice',
      domain: 'work',
      orgId: 'org-writeback',
      flow: dispatch.flow,
      capabilitySelection,
      toolRecords: [{
        name: 'desktop_ui_snapshot',
        arguments: {},
        result: '{"window":"WPS"}',
      }],
      finalizationBlocked: true,
      assistantTextTrusted: false,
      finalizationReason: 'Missing verified completion evidence.',
    });

    const updated = getWorkTakeoverTask(userId, task.id)!;
    const lastTurn = updated.metadata.workTakeoverExecution.lastTurn;
    expect(writeback.recorded).toBe(true);
    expect(writeback.status).toBe('ran');
    expect(updated.result).toBe('previous verified result');
    expect(lastTurn.toolCount).toBe(1);
    expect(lastTurn.tools[0]).toMatchObject({ name: 'desktop_ui_snapshot', status: 'ok' });
    expect(lastTurn.assistantTextPreview).toBe('');
    expect(lastTurn.assistantTextTrusted).toBe(false);
    expect(lastTurn.finalizationBlocked).toBe(true);
    expect(lastTurn.finalizationReason).toContain('Missing verified completion evidence');
  });

  it('records a confirmation denial from tool result as waiting instead of a successful run', async () => {
    const {
      createWorkTakeoverTask,
      getWorkTakeoverTask,
      updateWorkTakeoverTask,
    } = await import('../server/work_takeover/tasks');
    const { persistWorkTakeoverTurnExecution } = await import('../server/work_takeover/execution_writeback');

    const userId = `writeback_guard_confirmation_${Date.now()}_${Math.random()}`;
    const task = createWorkTakeoverTask({
      userId,
      domain: 'work',
      orgId: 'org-writeback',
      category: 'general_work',
      title: 'Wait for confirmation',
      status: 'in_progress',
    });
    updateWorkTakeoverTask(userId, task.id, { result: 'previous verified result' });
    const { dispatch, capabilitySelection } = await buildTurn(userId, 'continue the task');

    const writeback = persistWorkTakeoverTurnExecution({
      userId,
      userText: 'continue the task',
      assistantText: '我还不能说这件事已经完成。',
      source: 'voice',
      domain: 'work',
      orgId: 'org-writeback',
      flow: dispatch.flow,
      capabilitySelection,
      toolRecords: [{
        name: 'desktop_ui_click',
        arguments: { x: 100, y: 200 },
        result: 'Tool "desktop_ui_click" requires user confirmation and was not approved.',
      }],
      finalizationBlocked: true,
      assistantTextTrusted: false,
      finalizationReason: 'The action is waiting for confirmation.',
    });

    const updated = getWorkTakeoverTask(userId, task.id)!;
    const lastTurn = updated.metadata.workTakeoverExecution.lastTurn;
    expect(writeback.recorded).toBe(true);
    expect(writeback.status).toBe('waiting_confirmation');
    expect(updated.status).toBe('waiting_confirmation');
    expect(updated.result).toBe('previous verified result');
    expect(lastTurn.status).toBe('waiting_confirmation');
    expect(lastTurn.tools[0]).toMatchObject({
      name: 'desktop_ui_click',
      status: 'error',
    });
    expect(lastTurn.tools[0].error).toContain('requires user confirmation');
    expect(lastTurn.assistantTextPreview).toBe('');
  });

  it('treats a structured ok:false receipt as blocked instead of a successful run', async () => {
    const { createWorkTakeoverTask, getWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { persistWorkTakeoverTurnExecution } = await import('../server/work_takeover/execution_writeback');

    const userId = `writeback_semantic_ok_false_${Date.now()}_${Math.random()}`;
    const task = createWorkTakeoverTask({
      userId,
      domain: 'work',
      orgId: 'org-writeback',
      category: 'general_work',
      title: 'Detect semantic tool failure',
      status: 'in_progress',
    });
    const { dispatch, capabilitySelection } = await buildTurn(userId, 'continue the task');

    const writeback = persistWorkTakeoverTurnExecution({
      userId,
      userText: 'continue the task',
      assistantText: 'The step did not complete.',
      source: 'chat',
      domain: 'work',
      orgId: 'org-writeback',
      flow: dispatch.flow,
      capabilitySelection,
      toolRecords: [{
        name: 'desktop_ui_click',
        arguments: {},
        result: JSON.stringify({ ok: false, reason: 'Button not found' }),
      }],
    });

    const updated = getWorkTakeoverTask(userId, task.id)!;
    expect(writeback.status).toBe('blocked');
    expect(updated.status).toBe('blocked');
    expect(updated.metadata.workTakeoverExecution.lastTurn.tools[0]).toMatchObject({
      name: 'desktop_ui_click',
      status: 'error',
      error: 'Button not found',
    });
    expect(updated.metadata.workTakeoverExecution.resumeHint).toContain('failed tool desktop_ui_click');
  });

  it('treats a semantic failure after a successful receipt as failed', async () => {
    const { createWorkTakeoverTask, getWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { persistWorkTakeoverTurnExecution } = await import('../server/work_takeover/execution_writeback');

    const userId = `writeback_semantic_mixed_${Date.now()}_${Math.random()}`;
    const task = createWorkTakeoverTask({
      userId,
      domain: 'work',
      orgId: 'org-writeback',
      category: 'general_work',
      title: 'Preserve partial execution state',
      status: 'queued',
    });
    const { dispatch, capabilitySelection } = await buildTurn(userId, 'continue the task');

    const writeback = persistWorkTakeoverTurnExecution({
      userId,
      userText: 'continue the task',
      assistantText: 'The first step ran, but verification failed.',
      source: 'voice',
      domain: 'work',
      orgId: 'org-writeback',
      flow: dispatch.flow,
      capabilitySelection,
      toolRecords: [
        { name: 'desktop_ui_click', arguments: {}, result: JSON.stringify({ ok: true }) },
        {
          name: 'desktop_ui_snapshot',
          arguments: {},
          result: JSON.stringify({ success: false, status: 'failed', message: 'Target was not visible' }),
        },
      ],
    });

    const updated = getWorkTakeoverTask(userId, task.id)!;
    expect(writeback.status).toBe('failed');
    expect(updated.status).toBe('in_progress');
    expect(updated.metadata.workTakeoverExecution.lastTurn.tools).toMatchObject([
      { name: 'desktop_ui_click', status: 'ok' },
      { name: 'desktop_ui_snapshot', status: 'error', error: 'Target was not visible' },
    ]);
  });

  it('prioritizes a structured confirmation boundary and its resume instruction', async () => {
    const { createWorkTakeoverTask, getWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { persistWorkTakeoverTurnExecution } = await import('../server/work_takeover/execution_writeback');

    const userId = `writeback_semantic_confirmation_${Date.now()}_${Math.random()}`;
    const task = createWorkTakeoverTask({
      userId,
      domain: 'work',
      orgId: 'org-writeback',
      category: 'general_work',
      title: 'Wait at the confirmation boundary',
      status: 'in_progress',
    });
    const { dispatch, capabilitySelection } = await buildTurn(userId, 'continue the task');

    const writeback = persistWorkTakeoverTurnExecution({
      userId,
      userText: 'continue the task',
      assistantText: 'This action needs confirmation.',
      source: 'chat',
      domain: 'work',
      orgId: 'org-writeback',
      flow: dispatch.flow,
      capabilitySelection,
      toolRecords: [{
        name: 'desktop_ui_click',
        arguments: {},
        result: JSON.stringify({ verified: false, status: 'requires_confirmation', reason: 'Approve the click' }),
      }],
    });

    const updated = getWorkTakeoverTask(userId, task.id)!;
    expect(writeback.status).toBe('waiting_confirmation');
    expect(updated.status).toBe('waiting_confirmation');
    expect(updated.metadata.workTakeoverExecution.lastTurn.tools[0]).toMatchObject({
      name: 'desktop_ui_click',
      status: 'error',
      confirmationBlocked: true,
    });
    expect(writeback.resumeHint).toContain('at the confirmation boundary');
    expect(writeback.resumeHint).not.toContain('from failed tool');
  });

  it('treats an unfinished structured status as blocked', async () => {
    const { createWorkTakeoverTask, getWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { persistWorkTakeoverTurnExecution } = await import('../server/work_takeover/execution_writeback');

    const userId = `writeback_semantic_pending_${Date.now()}_${Math.random()}`;
    const task = createWorkTakeoverTask({
      userId,
      domain: 'work',
      orgId: 'org-writeback',
      category: 'general_work',
      title: 'Do not accept pending as success',
      status: 'in_progress',
    });
    const { dispatch, capabilitySelection } = await buildTurn(userId, 'continue the task');

    const writeback = persistWorkTakeoverTurnExecution({
      userId,
      userText: 'continue the task',
      assistantText: 'The operation is still pending.',
      source: 'chat',
      domain: 'work',
      orgId: 'org-writeback',
      flow: dispatch.flow,
      capabilitySelection,
      toolRecords: [{
        name: 'desktop_ui_snapshot',
        arguments: {},
        result: JSON.stringify({ status: 'pending', message: 'Window has not settled' }),
      }],
    });

    const updated = getWorkTakeoverTask(userId, task.id)!;
    expect(writeback.status).toBe('blocked');
    expect(updated.status).toBe('blocked');
    expect(updated.metadata.workTakeoverExecution.lastTurn.tools[0]).toMatchObject({
      status: 'error',
      error: 'Window has not settled',
    });
  });

  it('keeps chat, voice, and task sockets on the shared execution writeback path', () => {
    const root = process.cwd();
    const sources = [
      readFileSync(path.join(root, 'server/socket/chat.ts'), 'utf8'),
      readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8'),
      readFileSync(path.join(root, 'server/socket/task.ts'), 'utf8'),
    ];

    for (const source of sources) {
      expect(source).toContain('persistWorkTakeoverTurnExecution');
      expect(source).toContain('agent:task_execution_writeback');
    }

    for (const source of sources.slice(0, 2)) {
      expect(source).toContain('finalizationBlocked: finalResponse.blocked');
      expect(source).toContain('assistantTextTrusted: !finalResponse.blocked');
      expect(source).toContain('finalizationReason: finalResponse.reason');
    }
  });
});
