import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { buildRecentActionContinuationBridge, classifyConversationActionFollowupIntent, normalizeConversationActionState, prepareConversationActionTaskState } from '../server/cognition/action_continuation';
import { classifySkillAuthoringIntent } from '../server/skills/authoring_intent';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';

const policy = { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 16 };
const registry = new ToolRegistry();
beforeAll(async () => { await (await import('../db_layer')).initDatabase(); registerAllTools(registry); });
const report = normalizeConversationActionState({ version: 2, taskId: 'regression-report', status: 'blocked', unfinished: true,
  goal: '读取 D:/fixtures/input.csv，按数量乘单价生成总额，保存为 D:/fixtures/output.xlsx。A类数量2单价30，B类数量3单价20。',
  appTarget: 'WPS', sourcePaths: ['D:/fixtures/input.csv'], latestBlocker: '已读取输入，尚未写出结果',
  evidenceTools: ['read_file'], toolSummaries: ['read_file succeeded: A quantity=2 price=30; B quantity=3 price=20'], policySnapshot: policy, updatedAt: new Date().toISOString() })!;
const music = normalizeConversationActionState({ ...report, taskId: 'regression-music', goal: '用电脑上的网易云音乐播放周杰伦的晴天',
  latestInstruction: '用电脑上的网易云音乐播放周杰伦的晴天', appTarget: '网易云音乐', sourcePaths: [], taskCapsule: undefined,
  latestBlocker: '播放器已打开，尚未确认播放', evidenceTools: ['desktop_open'], toolSummaries: ['desktop_open succeeded: 网易云音乐'] })!;
function plan(text: string, channel: 'chat' | 'voice', state = report) {
  return buildLumiExecutionPipeline({ registry, personalityToolPolicy: policy, actionTaskState: state,
    dispatch: { userId: 'decision-regression', channel, source: channel, text, operationMode: 'assistant', targetIsLumi: true,
      continuationContext: buildRecentActionContinuationBridge(text, [], state) } });
}

describe('task relations and one interactive decision policy', () => {
  it.each(['数量改成4。', '把B类数量改成4，其他不变。', '改为四件，还是刚才那张表。', '不是换文件，是把表格里的数量改成4。', '单价调整为25。'])(
    'keeps the existing task, inputs and tools for %s', text => {
      expect(classifyConversationActionFollowupIntent(text, report)).toBe('execute');
      const next = prepareConversationActionTaskState(report, { userText: text, requestId: 'next-turn', toolPolicy: policy });
      expect(next.kind).toBe('resume');
      expect(next.state).toMatchObject({ taskId: report.taskId, goal: report.goal, sourcePaths: report.sourcePaths, latestInstruction: text });
      const chat = plan(text, 'chat'); const voice = plan(text, 'voice');
      for (const p of [chat, voice]) {
        expect(p.executionRequested).toBe(true);
        expect(p.trustedActionContinuation).toBe(true);
        expect(p.turnIntent.flow.rootTaskText).toBe(report.goal);
        expect(p.modelToolProjection.toolNames).toContain('create_xlsx');
        expect(p.modelToolProjection.toolNames).toContain('read_file');
      }
      expect(voice.modelToolProjection.toolNames).toEqual(chat.modelToolProjection.toolNames);
      expect(voice.authorizationPolicy).toEqual(chat.authorizationPolicy);
    });
  it.each(['做到哪一步了？不要重新执行。', '先别做了，告诉我已经完成了哪些步骤。', '刚才到底播放成功了吗？'])(
    'reports saved evidence without reacquiring execution: %s', text => {
      const state = text.includes('播放') ? music : report;
      expect(classifyConversationActionFollowupIntent(text, state)).toBe('status');
      for (const channel of ['chat', 'voice'] as const) {
        const p = plan(text, channel, state);
        expect(p.executionRequested).toBe(false);
        expect(p.trustedActionContinuation).toBe(false);
        expect(p.modelToolProjection.toolNames).toEqual([]);
      }
      expect(prepareConversationActionTaskState(state, { userText: text, requestId: 'query', toolPolicy: policy }).kind).toBe('status');
    });
  it('does not let a stale continuation marker override a new status-only message', () => {
    const p = buildLumiExecutionPipeline({ registry, actionTaskState: report, personalityToolPolicy: policy,
      dispatch: { userId: 'decision-regression', channel: 'chat', text: '做到哪一步了？不要重新执行。',
        continuationContext: buildRecentActionContinuationBridge('继续刚才的任务。', [], report) } });
    expect(p.executionRequested).toBe(false);
    expect(p.modelToolProjection.toolNames).toEqual([]);
  });
  it.each(['打开计算器。', '新建一个 D:/fixtures/new.txt，内容是你好。', '今天心情不太好，陪我聊聊。', '数量怎么修改？', '不要修改刚才的报表。'])(
    'does not treat unrelated, explanatory or negative text as a retry: %s', text => {
      expect(classifyConversationActionFollowupIntent(text, report)).not.toBe('execute');
    });
  it('continues failed playback with the same target on both modalities', () => {
    const text = '你只是打开了，还没播放，继续。';
    const a = plan(text, 'chat', music); const b = plan(text, 'voice', music);
    expect(a.trustedActionContinuation).toBe(true);
    expect(a.capabilityPlan.lane).toBe('desktop_control');
    expect(a.modelToolProjection.toolNames).toContain('computer_use');
    expect(b.modelToolProjection.toolNames).toEqual(a.modelToolProjection.toolNames);
  });
  it.each(['打开知识库。', '检查Lumi的桌面工具连接。', '打开网易云音乐并播放晴天。', '读取 D:/fixtures/input.csv 并计算总额。', '这套流程存下来，下次直接复用。'])(
    'uses the same interactive capability and permission envelope for %s', text => {
      const a = plan(text, 'chat'); const b = plan(text, 'voice');
      expect(b.capabilityPlan.lane).toBe(a.capabilityPlan.lane);
      expect(b.authorizationPolicy).toEqual(a.authorizationPolicy);
      expect(b.modelToolProjection.toolNames).toEqual(a.modelToolProjection.toolNames);
    });
  it('keeps editing and reporting its result an action at the recovery boundary', async () => {
    const { classifyExecutionGuardIntent } = await import('../server/cognition/execution_guard_recovery');
    const text = '水杯数量改成4，其余不变，更新刚才生成的 Excel，保存后回读告诉我结果。';
    expect(classifyExecutionGuardIntent(text)).toBe('action_execution');
    expect(classifyExecutionGuardIntent('刚才的 Excel 修改好了吗？告诉我结果。')).toBe('status_query');
    expect(classifyExecutionGuardIntent('刚才的 Excel 不要修改，只告诉我结果。')).toBe('status_query');
    expect(plan(text, 'chat').modelToolProjection.toolNames).toContain('modify_xlsx');
  });
  it('keeps file paths and posting verbs from selecting business analysis', async () => {
    const { buildActionContract } = await import('../server/cognition/action_contract');
    const { businessToolHints } = await import('../server/regions/packs/cn/business_routing');
    for (const directory of ['Audit-Reports', 'content', 'campaign']) {
      const text = `把刚才的 CSV 做成 Excel，工作表叫订单，列为商品、数量、单价、金额。原文件不动，另存为 D:/${directory}/output.xlsx。保存后回读。`;
      expect(buildActionContract(text).kind).toBe('artifact_work');
      expect(businessToolHints(text)).toEqual([]);
    }
    expect(businessToolHints('视频网站自动评论这个视频')).toEqual([]);
    expect(businessToolHints('分析店铺商品评论，整理好评和差评')).toContain('business_ecommerce_review_insight_analyzer');
    expect(buildActionContract('分析店铺订单的利润和售后风险').kind).toBe('ecommerce_operations');
  });
  it('distinguishes reusing a registered skill from publishing it', () => {
    const text = '换一份表，照刚才登记的技能再跑一遍。';
    expect(classifySkillAuthoringIntent(text)).toBe('use');
    for (const channel of ['chat', 'voice'] as const) {
      const p = plan(text, channel);
      expect(p.modelToolProjection.toolNames).toContain('run_workflow');
      expect(p.modelToolProjection.toolNames).not.toContain('publish_workflow');
      expect(p.modelToolProjection.toolNames).not.toContain('install_skill');
    }
    expect(classifySkillAuthoringIntent('这套流程存下来，下次直接复用。')).toBe('save');
    expect(classifySkillAuthoringIntent('不要把这个流程存下来。')).toBe('none');
    expect(classifySkillAuthoringIntent('只解释怎么复用已登记的技能，不要实际运行。')).toBe('none');
  });
});
