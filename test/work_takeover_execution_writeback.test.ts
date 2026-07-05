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
  });
});
