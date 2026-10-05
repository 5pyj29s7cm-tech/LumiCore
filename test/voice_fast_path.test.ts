import { describe, expect, it } from 'vitest';
import { foregroundPipeline } from './foreground_pipeline_fixture';
import { hasMixedStatusExecutionIntent } from '../server/cognition/normalized_action_intent';
import { isNamedPersistentWorkTaskStatusQuery } from '../server/cognition/action_contract';
import { extractRequestedCurrentAppText } from '../server/cognition/action_contract';

describe('shared foreground planning after shortcut retirement', () => {
  it.each(['chat', 'voice'] as const)('retains the actual tools for each %s request', channel => {
    for (const [text, tools] of [
      ['打开AutoCAD。', ['desktop_open']],
      ['打开正在运行的微信，不要启动新的微信。', ['desktop_open']],
      ['打开聊天界面', ['client_action']],
      ['打开中国裁判文书网。', ['browser_open_task']],
      ['看一下现在知识库里有多少的文件内容。', ['knowledge_file_stats']],
      ['打开 WPS，然后新建文档，在正文写入：第一行。\n第二行。', ['wps_create_document_with_text']],
      ['打开爱奇艺并播放蜡笔小新第一集', ['desktop_open', 'computer_use']],
      ['打开网易云并播放秋天不回来', ['desktop_open', 'computer_use']],
    ] as const) {
      const plan = foregroundPipeline(text, channel);
      expect(plan.executionRequested, text).toBe(true);
      expect(plan.modelToolProjection.toolNames, text).toEqual(expect.arrayContaining([...tools]));
      expect(plan.executionPlan.nodes.some(node => node.type === 'skill' && !node.toolName), text).toBe(false);
    }
  });

  it.each(['你怎么运行了这么久才回我？', '能不能听见我说话？', '打开了。', '你能不能不要动不动就进入介绍客户端的界面啊'])(
    'keeps conversation and correction out of execution: %s', text => {
      expect(foregroundPipeline(text).executionRequested).toBe(false);
    },
  );
  it.each(['持久任务 wt_task_acceptance：完成第一步了吗？返回状态。', '任务进度怎么样；完成第一步了吗？'])(
    'keeps progress questions read-only: %s', text => {
      const plan = foregroundPipeline(text);
      expect(hasMixedStatusExecutionIntent(text)).toBe(false);
      expect(plan.normalizedIntent?.kind).toBe('status_query');
      expect(plan.modelToolProjection.toolNames.every(name => ['runtime_work_status', 'work_takeover_task_get'].includes(name))).toBe(true);
    },
  );
  it.each(['chat', 'voice', 'task', 'scheduler', 'autonomy'] as const)(
    'keeps matched workflows advisory and honors a hard deny on %s', channel => {
      const plan = foregroundPipeline('Lumi, show me a visible demo of yourself', channel,
        { allowedTools: [], forbiddenTools: ['*'], requireConfirmation: [], maxIterations: 1 });
      expect(plan.turnIntent.flow.workflowHint?.id).toBe('self_intro_demo');
      expect(plan.executionRequested).toBe(false);
      expect(plan.authorizationPolicy.allowedTools).toEqual([]);
      expect(plan.executionPlan.nodes).toEqual([]);
    },
  );
  it.each(['打开计算器。不要修改文件，读取 D:/fixtures/orders.csv 并总结内容。',
    'Open Calculator. Do not edit files, read D:/fixtures/orders.csv and summarize it.',
    '打开记事本，然后打开技能大厅。'])(
    'keeps the complete compound goal after a negative clause: %s', text => {
      const plan = foregroundPipeline(text);
      expect(plan.executionRequested).toBe(true);
      expect(plan.turnIntent.flow.routeText).toContain(text);
      expect(plan.modelToolProjection.toolNames).toContain('desktop_open');
      expect(plan.turnIntent.flow.routeText).not.toMatch(/^Calculator$|^计算器$|^记事本$/u);
    },
  );
  it('retains WPS multiline payload parsing independently of dispatch', () => {
    expect(extractRequestedCurrentAppText('打开 WPS，新建文档，写入内容：\n第一行。\n第二行。\n完成后只根据真实工具回执回答。')).toBe('第一行。\n第二行。');
  });
  it('pins window observation in the shared execution projection', () => {
    const plan = foregroundPipeline('请打开 Windows 计算器。打开后读取当前活动窗口，只有窗口标题和进程能证明是计算器时才报告完成。');
    expect(plan.modelToolProjection.toolNames).toContain('desktop_active_window');
    expect(plan.modelToolProjection.requiredToolNames).toContain('desktop_active_window');
  });
  it.each(['请查询持久任务 wt_task_acceptance 是否完成和当前状态，只读任务账本，不要执行新动作。',
    '请查询任务“青穹客户跟进闭环”的持久状态，只根据任务账本回答。'])(
    'keeps exact persistent task queries distinct from foreground status: %s', text => {
      expect(isNamedPersistentWorkTaskStatusQuery(text)).toBe(true);
    },
  );
  it.each(['持久任务 wt_task_acceptance：不要执行外发动作；现在完成第一步“整理客户需求”，然后返回状态。',
    '创建一个持久任务“新任务”，返回任务状态。', '现在这个任务的进度怎么样？'])(
    'does not classify execution, creation or an unnamed task as an exact ledger read: %s', text => {
      expect(isNamedPersistentWorkTaskStatusQuery(text)).toBe(false);
    },
  );
});
