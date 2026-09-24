import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { buildRecentActionContinuationBridge, prepareConversationActionTaskState, type ConversationActionContinuationState } from '../server/cognition/action_continuation';
import { resolveActiveTaskMessageRelation } from '../server/cognition/task_concurrency';
import { buildActionContract } from '../server/cognition/action_contract';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';

const policy = { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 10 };
const registry = new ToolRegistry();
beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
  registerAllTools(registry);
});

function task(): ConversationActionContinuationState {
  return { version: 2, taskId: 'playback-continuation', revision: 3, status: 'blocked',
    goal: '使用电脑上的网易云音乐播放选定歌曲。', latestInstruction: '使用电脑上的网易云音乐播放选定歌曲。',
    appTarget: '网易云音乐', sourcePaths: [], latestBlocker: 'Opened, playback not verified.', unfinished: true,
    evidenceTools: ['desktop_open', 'desktop_ui_snapshot'], assistantState: '软件已打开，还未播放。',
    toolSummaries: [], receipts: [], updatedAt: new Date().toISOString() };
}

describe.each(['chat', 'voice'] as const)('one %s task continuation decision', channel => {
  it.each(['刚才缺的源文件已经补好了，继续完成原任务，保存到之前指定的位置。',
    '继续上个任务', 'The file is ready. Resume the original task.'])('retains the blocked task after its prerequisite is supplied: %s', text => {
    const state = { ...task(), goal: '把 D:/orders.xlsx 的水杯数量改成4，另存为 D:/result.xlsx，保留公式。',
      sourcePaths: ['D:/orders.xlsx'], appTarget: '', latestBlocker: 'XLSX file not found: D:/orders.xlsx' };
    const taskRelation = resolveActiveTaskMessageRelation(text, state);
    const pipeline = buildLumiExecutionPipeline({ dispatch: { text, userId: 'authority', channel,
      continuationContext: buildRecentActionContinuationBridge(text, [], state) },
      taskRelation, actionTaskState: state, registry, personalityToolPolicy: policy });
    expect(pipeline.actionFollowupIntent).toBe('execute');
    expect(pipeline.trustedActionContinuation).toBe(true);
    expect(buildActionContract(pipeline.turnIntent.flow.routeText).kind).toBe('artifact_work');
    expect(pipeline.turnIntent.flow.routeText).not.toContain('latestBlocker');
    const prepared = prepareConversationActionTaskState(state, { userText: text, requestId: 'supplied-input',
      toolPolicy: pipeline.authorizationPolicy, followupIntent: pipeline.actionFollowupIntent });
    expect(prepared.kind).toBe('resume');
    expect(prepared.state).toMatchObject({ taskId: state.taskId, goal: state.goal });
  });

  it('does not let a future continuation override the current status request or reacquire a task lease', () => {
    const state = task();
    const text = '继续之前，先告诉我做到哪一步了';
    const taskRelation = resolveActiveTaskMessageRelation(text, state);
    expect(taskRelation).toMatchObject({ feedback: 'status', taskRelation: 'status', operation: 'inspect' });
    const pipeline = buildLumiExecutionPipeline({ dispatch: { text, userId: 'authority', channel,
      continuationContext: buildRecentActionContinuationBridge(text, [], state) },
      taskRelation, actionTaskState: state, registry, personalityToolPolicy: policy });
    expect(pipeline.actionFollowupIntent).toBe('status');
    expect(pipeline.executionRequested).toBe(false);
    expect(pipeline.trustedActionContinuation).toBe(false);
    expect(pipeline.turnIntent.flow.allowToolUseForTurn).toBe(false);
    expect(pipeline.modelToolProjection.toolNames).toEqual([]);
    const prepared = prepareConversationActionTaskState(state, { userText: text, requestId: 'status-turn',
      toolPolicy: pipeline.authorizationPolicy, followupIntent: pipeline.actionFollowupIntent });
    expect(prepared.kind).toBe('status');
    expect(prepared.state).toMatchObject({ taskId: state.taskId, revision: 3, status: 'blocked' });
    expect(prepared.state?.activeRequestId).toBeUndefined();
  });

  it.each(['数量改成4，但暂时不要执行', '我只是在复述“继续播放”，不要执行', 'Do not execute yet.'])('keeps a current veto out of the tool loop: %s', text => {
    const state = task();
    const pipeline = buildLumiExecutionPipeline({ dispatch: { text, userId: 'authority', channel,
      continuationContext: `- followupIntent: execute\n- taskId: ${state.taskId}\n- originalGoal: ${state.goal}` },
      actionTaskState: state, registry, personalityToolPolicy: policy });
    expect(pipeline.executionRequested).toBe(false);
    expect(pipeline.trustedActionContinuation).toBe(false);
    expect(pipeline.capabilityPlan.taskLedgerRequired).toBe(false);
  });

  it.each(['', '- followupIntent: status\n- taskId: obsolete-prompt-id'])('binds a real task correction from structured state, independent of prompt formatting: %s', continuationContext => {
    const state = task();
    const text = '只是打开了，还没播放，继续';
    const taskRelation = resolveActiveTaskMessageRelation(text, state);
    const pipeline = buildLumiExecutionPipeline({ dispatch: { text, userId: 'authority', channel, continuationContext },
      taskRelation, actionTaskState: state, registry, personalityToolPolicy: policy });
    expect(pipeline.trustedActionContinuation).toBe(true);
    expect(pipeline.executionRequested).toBe(true);
    expect(pipeline.turnIntent.flow.rootTaskText).toBe(state.goal);
    const prepared = prepareConversationActionTaskState(state, { userText: text, requestId: 'resume-turn',
      toolPolicy: pipeline.authorizationPolicy, followupIntent: pipeline.actionFollowupIntent });
    expect(prepared.kind).toBe('resume');
    expect(prepared.state).toMatchObject({ taskId: state.taskId, goal: state.goal, revision: 4 });
  });

  it('rejects a task revision changed after admission rather than silently resuming another snapshot', () => {
    const state = task();
    const text = '继续';
    const taskRelation = resolveActiveTaskMessageRelation(text, state);
    const pipeline = buildLumiExecutionPipeline({ dispatch: { text, userId: 'authority', channel },
      taskRelation, actionTaskState: { ...state, revision: 4 }, registry, personalityToolPolicy: policy });
    expect(pipeline.taskRelation.binding).toBe('stale');
    expect(pipeline.trustedActionContinuation).toBe(false);
    expect(pipeline.executionRequested).toBe(false);
    expect(pipeline.modelToolProjection.toolNames).toEqual([]);
  });

  it('does not turn a casual acknowledgement into task authority from prompt text', () => {
    const state = task();
    const pipeline = buildLumiExecutionPipeline({ dispatch: { text: '好的', userId: 'authority', channel,
      continuationContext: `- followupIntent: execute\n- taskId: ${state.taskId}\n- originalGoal: ${state.goal}` },
      actionTaskState: state, registry, personalityToolPolicy: policy });
    expect(pipeline.trustedActionContinuation).toBe(false);
    expect(pipeline.executionRequested).toBe(false);
  });
});
