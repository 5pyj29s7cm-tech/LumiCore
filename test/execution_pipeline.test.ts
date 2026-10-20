import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCapabilityExecutionPlan } from '../server/cognition/capability_execution_plan';
import { executeToolCall } from '../server/tools/execution_engine';
import { recordPendingConfirmationDurably, consumePendingConfirmationDurably } from '../server/tools/pending_confirmation';
async function observeSelectedCall(pipeline: ReturnType<typeof buildLumiExecutionPipeline>, registry: ToolRegistry, name: string, args: Record<string,unknown>) {
  const original = registry.get(name)!;
  const handler = vi.fn(async () => JSON.stringify({ok:true,status:'completed',verified:true,messages:[]}));
  registry.register({...original,handler});
  const scope = {domain:'personal',orgId:'',taskId:pipeline.taskId||pipeline.resolution.requestId};
  let pending: Awaited<ReturnType<typeof recordPendingConfirmationDurably>>|undefined;
  const record = await executeToolCall({registry,name,arguments:args,context:{userId:'observed-pipeline-user',requestId:pipeline.resolution.requestId,taskId:scope.taskId,actionIntent:pipeline.resolution.userText,toolPolicy:pipeline.authorizationPolicy,requestConfirmation: async(tool,exact)=>{pending=await recordPendingConfirmationDurably('observed-pipeline-user',tool,exact,'chat',scope);return false;}}});
  const plan=buildCapabilityExecutionPlan({record,capability:registry.getCapabilityManifestEntry(name)!,taskId:scope.taskId});
  expect(plan.decisionAuthority).toBe('registry_bound_call');
  expect(plan.nodes).toHaveLength(1);
  expect(plan.nodes[0].toolName).toBe(name);
  expect(plan.expectedEvidence).toHaveLength(1);
  expect(plan.contextRefs).not.toContainEqual(expect.objectContaining({kind:'source'}));
  return{plan,record,pending,scope,handler};
}
import { buildLumiExecutionPipeline } from '../server/cognition/execution_pipeline';
import { registerAllTools } from '../server/tools/definitions';
import { ToolRegistry } from '../server/tools/registry';
import { buildActionContract } from '../server/cognition/action_contract';
import { finalizeLumiResponse } from '../server/cognition/result_finalizer';
import { hasExplicitNoToolInstruction } from '../server/cognition/tool_intent';
import { buildRecentActionContinuationBridge } from '../server/cognition/action_continuation';
import { resolveActiveTaskMessageRelation } from '../server/cognition/task_concurrency';
import { guardCurrentAppToolCall } from '../server/cognition/current_app_execution';

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerAllTools(registry);
  return registry;
}

describe('unified execution pipeline', () => {
  it.each([
    ['chat', 'chat'], ['voice', 'voice'], ['task', 'task'],
    ['chat', 'rest_chat'], ['autonomy', 'autonomy'], ['chat', 'feishu'],
  ] as const)('keeps one restricted policy and projection for %s/%s', (channel, source) => {
    const pipeline = buildLumiExecutionPipeline({
      dispatch: { userId: 'entry-boundary', channel, source, text: '搜索公开网页里的人工智能新闻，然后打开本机 WPS。', operationMode: 'assistant' },
      registry: createRegistry(), executionBoundary: 'remote_restricted',
      personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 10 },
    });
    expect(pipeline.execution.toolPolicy).toBe(pipeline.authorizationPolicy);
    expect(pipeline.execution.baseToolPolicy).toBe(pipeline.authorizationPolicy);
    for (const names of [pipeline.authorizationPolicy.allowedTools, pipeline.modelToolProjection.toolNames, pipeline.execution.toolRoute?.toolNames || []]) {
      expect(names.every(name => name === 'web_search')).toBe(true);
    }
    expect(pipeline.modelToolProjection.toolNames).not.toContain('desktop_open');
  });

  it('uses the structured application reference even if prompt metadata names a different app', () => {
    const state = { version: 2 as const, taskId: 'wps-task', revision: 1, status: 'completed' as const,
      goal: '打开 WPS', latestInstruction: '打开 WPS', appTarget: 'WPS', sourcePaths: [], latestBlocker: '',
      unfinished: false, evidenceTools: ['desktop_open'], assistantState: '已打开', toolSummaries: [], updatedAt: new Date().toISOString() };
    const input = { dispatch: { userId: 'app-binding', channel: 'chat' as const, text: '在这里面新建一个空白文档并写入：测试。',
      continuationContext: '## Recent action continuation context\nRecovered structured action state:\n- followupIntent: status\n- appTarget: Chrome',
      operationMode: 'assistant' }, registry: createRegistry() };
    const bound = buildLumiExecutionPipeline({ ...input, actionTaskState: state });
    expect(bound.turnIntent.flow.currentAppEditTarget).toBe('WPS');
    expect(bound.modelToolProjection.toolNames).toContain('wps_create_document_with_text');
    const unbound = buildLumiExecutionPipeline(input);
    expect(unbound.turnIntent.flow.currentAppEditTarget).toBe('');
    expect(unbound.trustedActionContinuation).toBe(false);
    const plain = buildLumiExecutionPipeline({ ...input, dispatch: { ...input.dispatch, continuationContext: '' } });
    expect(unbound.modelToolProjection.toolNames).toEqual(plain.modelToolProjection.toolNames);
    expect(guardCurrentAppToolCall({ taskText: `${input.dispatch.text}\n${input.dispatch.continuationContext}`,
      toolName: 'wps_create_document_with_text', arguments: { text: '测试' } }).allowed).toBe(false);
  });

  it.each(['chat', 'voice'] as const)('retains browser execution schemas through the complete %s legal lookup projection', channel => {
    const pipeline = buildLumiExecutionPipeline({ dispatch: { userId: 'court-lookup', channel, source: channel, operationMode: 'assistant',
      text: '打开中国裁判文书网查找浙江省衢州市中级法院最新的判例', targetIsLumi: true }, registry: createRegistry(),
      personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 10 } });
    expect(pipeline.executionRequested).toBe(true);
    for (const name of ['browser_open_task', 'computer_use', 'web_login_profile_list', 'url_fetch_logged_in']) {
      expect(pipeline.modelToolProjection.toolNames).toContain(name);
      expect(pipeline.modelToolProjection.requiredToolNames).toContain(name);
    }
    expect(pipeline.modelToolProjection.toolNames).not.toContain('legal_external_research_plan');
  });
  it.each(['chat', 'voice'] as const)('routes current model identity through the complete %s read-only execution path', channel => {
    const input = { dispatch: { userId: 'model-identity', channel, source: channel, operationMode: 'assistant', text: '你现在是什么模型', targetIsLumi: true }, registry: createRegistry(),
      personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 10 } };
    const pipeline = buildLumiExecutionPipeline(input);
    expect(pipeline.executionRequested).toBe(true);
    expect(pipeline.modelToolProjection.toolNames).toEqual(['model_configuration_get']);
    expect(pipeline.capabilityPlan.taskLedgerRequired).toBe(true);
    const blocked = buildLumiExecutionPipeline({ ...input, dispatch: { ...input.dispatch, text: '不要调用工具，只说说什么是大语言模型。' } });
    expect(blocked.executionRequested).toBe(false);
  });
  it('keeps a WPS report open-and-check request out of Lumi client navigation', () => {
    const text = '用电脑上的 WPS 打开 D:/LumiCore-Audit-Reports/20260920/chat-task-repair/cloud-output/采购报表_执行进度复测更新.xlsx，核对表格的总金额和图表，告诉我实际看到的结果。';
    const pipeline = buildLumiExecutionPipeline({ dispatch: { userId: 'wps-open-read', channel: 'chat', source: 'chat', operationMode: 'assistant', text, targetIsLumi: true }, registry: createRegistry(), personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 10 } });
    expect(pipeline.turnIntent.flow.clientActionOnlyTurn).toBe(false);
    expect(pipeline.normalizedIntent.kind).not.toBe('client_navigation');
    expect(pipeline.modelToolProjection.toolNames).toContain('desktop_open');
    expect(pipeline.modelToolProjection.toolNames).toContain('read_xlsx');
    expect(pipeline.modelToolProjection.toolNames).toContain('ocr_screen');
  });
  it.each(['chat', 'voice'] as const)('allows fresh %s window observation while prohibiting further player input', channel => {
    const text = '先不要再操作播放器。只查看当前网易云音乐窗口，告诉我当前歌曲和歌手、暂停还是播放状态，以及底部显示的已播放时间和总时长；看不清的项目明确说明。';
    const pipeline = buildLumiExecutionPipeline({ dispatch: { userId: 'read-only-player', channel, source: channel,
      operationMode: 'assistant', text, targetIsLumi: true }, registry: createRegistry(),
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 10 } });
    expect(pipeline.turnIntent.flow.modelToolAccess).toBe('manifest');
    expect(pipeline.modelToolProjection.toolNames).toContain('ocr_screen');
    expect(pipeline.modelToolProjection.toolNames).not.toContain('computer_use');
    expect(pipeline.modelToolProjection.toolNames).not.toContain('mouse_click');
    expect(pipeline.modelToolProjection.toolNames).not.toContain('keyboard_type');
  });
  it.each(['chat', 'voice'] as const)('keeps explicit report edits executable after a %s progress question', channel => {
    for (const destination of ['D:/LumiCore-Audit-Reports/20260920/chat-task-repair/cloud-output/采购报表_执行进度复测更新.xlsx', '/tmp/lumi/chat-repair/采购报表_执行进度.xlsx', '\\\\host\\lumi\\chat-repair\\采购报表_执行进度.xlsx']) {
    const text = `把刚才报表的 B类数量改成6，其余不变，另存到 ${destination}，检查公式和图表，并告诉我新总金额。`;
    const pipeline = buildLumiExecutionPipeline({ dispatch: { userId: 'report-edit-after-status', channel, source: channel,
      operationMode: 'assistant', text, targetIsLumi: true }, registry: createRegistry(),
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 10 } });
    expect(pipeline.executionRequested, JSON.stringify(pipeline)).toBe(true);
    expect(pipeline.capabilityPlan.lane).toBe('artifact_work');
    expect(pipeline.modelToolProjection.toolNames).toContain('modify_xlsx');
    const statusText = '刚才报表实际改好了吗？新总额多少？只根据已经保存的结果回答，不要重新操作文件。';
    const status = buildLumiExecutionPipeline({ dispatch: { userId: 'report-edit-after-status', channel, source: channel,
      operationMode: 'assistant', text: statusText, targetIsLumi: true }, registry: createRegistry() });
    expect(status.executionRequested).toBe(false);
    }
  });
  it.each(['chat', 'voice'] as const)('retains browser session inspection after a bound %s confirmation', channel => {
    const goal = '用 Google Chrome 打开 https://www.douyin.com/，检查我之前保存的登录是否仍有效。只查看登录状态，不发消息、不点赞。';
    const state = { version: 2, taskId: 'browser-confirm-task', goal, latestInstruction: goal, status: 'waiting_confirmation', unfinished: true,
      appTarget: 'Google Chrome', sourcePaths: [], latestBlocker: '', evidenceTools: [], assistantState: '', toolSummaries: [], revision: 1, updatedAt: new Date().toISOString() } as const;
    const run = (taskId: string) => buildLumiExecutionPipeline({ dispatch: { userId: 'browser-confirm-user', channel, source: channel,
      operationMode: 'assistant', text: '确认', targetIsLumi: true, continuationContext: `- followupIntent: confirm\n- taskId: ${taskId}` },
      actionTaskState: state as any, taskRelation: resolveActiveTaskMessageRelation('确认', state as any, { controlTargetTaskId: taskId }),
      registry: createRegistry(), personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: ['browser_open_task'], forbiddenTools: ['send_email'], maxIterations: 10 } });
    const result = run(state.taskId);
    expect(result.turnIntent.flow.routeText).toContain(goal);
    expect(result.capabilityPlan.promptOverlay).toContain('cookies/password store are separate');
    expect(result.modelToolProjection.toolNames).toContain('desktop_ui_snapshot');
    expect(result.modelToolProjection.toolNames).toContain('ocr_screen');
    expect(result.authorizationPolicy.forbiddenTools).toContain('send_email');
    expect(run('wrong-task').turnIntent.flow.routeText).not.toContain(goal);
  });
  it.each(['chat', 'voice'] as const)('preserves requested person authoring through scoped %s prohibitions', channel => {
    const text = '请实际完成一轮数字人形象制作验收：在记忆领地新建一个独立人物，名称为“Lumi 动画验收”。用 Lumi 官方 API 生成正面半身人像，浅棕发、墨绿色衣装；再基于这张图生成闭眼和开口两张表情变体。实际导入三张图片，配置眨眼、呼吸、语音口型和环境微动，保存后读取确认。不要覆盖现有 Lumi，不修改代码或数据库、不接第三方数字人服务、不开始直播。';
    const run = (text: string) => buildLumiExecutionPipeline({ dispatch: { userId: 'avatar-acceptance', channel, source: channel,
      operationMode: 'assistant', text, targetIsLumi: true }, registry: createRegistry(),
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: ['send_email'], maxIterations: 16 } });
    const pipeline = run(text);
    for (const name of ['memory_avatar_read', 'memory_avatar_create', 'memory_avatar_import_image', 'memory_avatar_configure_animation', 'generate_image', 'ai_edit_image', 'get_image_generation_status']) {
      expect(pipeline.modelToolProjection.toolNames, name).toContain(name);
      expect(pipeline.authorizationPolicy.forbiddenTools, name).not.toContain(name);
    }
    expect(pipeline.modelToolProjection.toolNames).not.toContain('write_file');
    expect(pipeline.modelToolProjection.allowDynamicDiscovery).toBe(false);
    expect(pipeline.authorizationPolicy.forbiddenTools).toContain('send_email');
    const blocked = run(text + '现在不要创建或修改任何内容。');
    expect(blocked.authorizationPolicy.forbiddenTools).toContain('memory_avatar_create');
    expect(blocked.authorizationPolicy.forbiddenTools).toContain('memory_avatar_configure_animation');
  });
  it.each(['chat', 'voice'] as const)('keeps the unfinished execute-and-capture plan through detailed %s resumption', channel => {
    const goal = '请读取 C:/Users/Administrator/Documents/input-4.csv，按数量乘单价增加 total 列，保存为 C:/Users/Administrator/Documents/output-4.csv。然后把完整的读取、计算、写文件流程保存为可复用工作流草稿。源文件不要改动。';
    const policy = { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: ['send_email'], maxIterations: 10 };
    const state = { version: 2, taskId: 'task-compound-resume', goal, status: 'blocked', unfinished: true,
      sourcePaths: [], toolSummaries: [], evidenceTools: [], policySnapshot: policy, updatedAt: new Date().toISOString() } as any;
    for (const text of [goal, '继续完成刚才未完成的任务。先完成 input-4.csv 的金额计算和 output-4.csv 的输出，再保存刚才要求的工作流草稿。不要改动源文件。']) {
      const continuationContext = text === goal ? '' : buildRecentActionContinuationBridge(text, [], state);
      const pipeline = buildLumiExecutionPipeline({ dispatch: { userId: 'compound-resume', channel, source: channel,
        operationMode: 'assistant', text, continuationContext, targetIsLumi: true }, registry: createRegistry(),
        actionTaskState: text === goal ? undefined : state, personalityToolPolicy: policy });
      expect(pipeline.executionRequested).toBe(true);
      expect(pipeline.turnIntent.flow.routeText).toContain(goal);
      for (const name of ['read_file', 'code_execution', 'write_file', 'capture_recent_workflow']) {
        expect(pipeline.authorizationPolicy.forbiddenTools, name).not.toContain(name);
        expect(pipeline.modelToolProjection.toolNames, name).toContain(name);
      }
      expect(pipeline.authorizationPolicy.forbiddenTools).toContain('send_email');
      expect(pipeline.authorizationPolicy.forbiddenTools).toContain('publish_workflow');
    }
    const denial = '继续完成刚才未完成的任务。现在不要创建任何文件，不要保存工作流。只解释剩余步骤。';
    const blocked = buildLumiExecutionPipeline({ dispatch: { userId: 'compound-resume', channel, source: channel,
      operationMode: 'assistant', text: denial, continuationContext: buildRecentActionContinuationBridge(denial, [], state), targetIsLumi: true },
      registry: createRegistry(), actionTaskState: state, personalityToolPolicy: policy });
    expect(blocked.authorizationPolicy.forbiddenTools).toContain('write_file');
    expect(blocked.authorizationPolicy.forbiddenTools).toContain('capture_recent_workflow');
  });
  it.each(['chat', 'voice'] as const)('does not open %s execution for a memory question with forbidden search', channel => {
    const text = '你还记得岚桥记忆复核项目的专用标记和资料盒位置吗？如果没有已保存的记忆，请直接说不知道，不要猜测或搜索聊天记录。';
    const pipeline = buildLumiExecutionPipeline({ dispatch: { userId: 'memory-lookup-only', channel,
      source: 'local_acceptance_harness', operationMode: 'assistant', text, targetIsLumi: true }, registry: createRegistry(),
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 10 } });
    expect({ allow: pipeline.turnIntent.flow.allowToolUseForTurn, boundary: pipeline.turnIntent.boundary,
      action: pipeline.executionRequested, trace: pipeline.intentTrace }).toMatchObject({ allow: false, action: false, boundary: 'conversation' });
    expect(pipeline.turnIntent.flow.completionEvidenceNeeded).toBe(false);
    expect(pipeline.turnIntent.flow.modelToolAccess).toBe('hard_off');
    expect(finalizeLumiResponse({ taskText: text, responseText: '我不知道，没有找到对应的已保存记忆。', source: channel, toolRecords: [], flow: pipeline.turnIntent.flow }).blocked).toBe(false);
  });

  it.each(['chat', 'voice'] as const)('preserves a positive search after a %s recall question', channel => {
    const text = '你还记得项目标记吗？搜索官网公开资料。不要读取聊天记录。';
    const pipeline = buildLumiExecutionPipeline({ dispatch: { userId: 'memory-recall-plus-action', channel, source: channel,
      operationMode: 'assistant', text, targetIsLumi: true }, registry: createRegistry(),
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 10 } });
    expect(pipeline.executionRequested).toBe(true);
    expect(pipeline.turnIntent.flow.modelToolAccess).toBe('manifest');
  });
  it.each(['chat', 'voice', 'task'] as const)('binds short plan acceptance to the latest user goal for %s', channel => {
    const text = '按刚才的计划执行。';
    const goal = '读取 C:/Users/Administrator/Documents/orders.csv，计算每项金额和总额';
    const pipeline = buildLumiExecutionPipeline({ dispatch: { userId: 'plan-acceptance', channel, source: channel,
      operationMode: 'assistant', text, targetIsLumi: true }, registry: createRegistry(),
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 10 },
      traceText: text,
      persistedConversationHistory: [
        { role: 'user', message: '数量改成4。' },
        { id: 'latest-plan', role: 'user', message: goal + '。先只告诉我准备怎么做，暂时不要读取文件。原文件不动。' },
        { role: 'assistant', message: 'I will read a different file instead.' },
      ] });
    expect(pipeline.executionRequested).toBe(true);
    expect(pipeline.turnIntent.flow.routeText).toContain(goal);
    expect(pipeline.turnIntent.flow.routeText).not.toContain('数量改成4');
    expect(pipeline.turnIntent.flow.routeText).not.toContain('暂时不要');
    expect(pipeline.modelToolProjection.toolNames).toContain('read_file');
    expect(pipeline.authorizationPolicy.forbiddenTools).toContain('write_file');
    expect(pipeline.trustedActionContinuation).toBe(false);
    expect(pipeline.turnIntent.promptOverlay).toContain('latest-plan');
    expect(pipeline.intentTrace.input.text).toBe(text);
    expect(pipeline.normalizedIntent.target).toBe('C:/Users/Administrator/Documents/orders.csv');
    expect(pipeline.intentTrace.normalizedActionIntent).toEqual(pipeline.normalizedIntent);
  });
  it.each(['chat', 'voice'] as const)('keeps a visible-client planning request in discussion through %s finalization', channel => {
    const text = 'LC-UI-统一验收：我要处理 C:/Users/Administrator/LumiCore/task-skill-acceptance-20260908/LC-TASK-ORDERS.csv，计算每项金额和总额。先只告诉我准备怎么做，暂时不要读取文件。';
    const pipeline = buildLumiExecutionPipeline({ dispatch: {
      userId: 'visible-planning', channel, source: channel, operationMode: 'assistant', text, targetIsLumi: true,
    }, registry: createRegistry(), personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 10 } });
    expect(pipeline.executionRequested).toBe(false);
    expect(buildActionContract(text).applies).toBe(false);
    const reply = '计划是：得到你的确认后读取这份 CSV，按数量乘单价计算各项金额，再求和。现在尚未读取文件。';
    const finalized = finalizeLumiResponse({ taskText: text, responseText: reply, source: channel, toolRecords: [], flow: pipeline.turnIntent.flow });
    expect(finalized.blocked).toBe(false);
    expect(finalized.text).toBe(reply);
    expect(hasExplicitNoToolInstruction('不要只告诉我准备怎么做，现在读取文件并计算。')).toBe(false);
    expect(hasExplicitNoToolInstruction('读取文件，只告诉我总额。')).toBe(false);
  });
  it.each(['chat', 'voice'] as const)('keeps the exact XLSX producer and reader in the %s model declarations', channel => {
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'exact-xlsx-user', channel, source: channel, operationMode: 'assistant', targetIsLumi: true,
        text: '新建 C:/Users/Administrator/Documents/LC-ORDERS.xlsx，只有一个工作表“订单”，表头为商品、数量、单价、金额，只有一条数据：水杯，2，12，24。实际保存后回读表格并告诉我内容。',
      },
      registry: createRegistry(),
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 10 },
    });
    expect(pipeline.executionRequested).toBe(true);
    expect(pipeline.modelToolProjection.requiredToolNames).toContain('create_xlsx');
    expect(pipeline.modelToolProjection.requiredToolNames).toContain('read_xlsx');
    expect(pipeline.modelToolProjection.toolNames).toContain('create_xlsx');
    expect(pipeline.modelToolProjection.toolNames).toContain('read_xlsx');
  });

  it.each(['chat', 'voice'] as const)('allows a separately saved result while preserving the source in %s', channel => {
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'scoped-copy-user', channel, source: channel, operationMode: 'assistant', targetIsLumi: true,
        text: '读取 C:/Users/Administrator/Documents/orders.csv，不修改原文件，将结果另存为 C:/Users/Administrator/Documents/result.xlsx。',
      },
      registry: createRegistry(),
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 10 },
    });
    expect(pipeline.executionRequested).toBe(true);
    expect(pipeline.authorizationPolicy.forbiddenTools).not.toContain('create_xlsx');
    expect(pipeline.modelToolProjection.toolNames).toContain('create_xlsx');
    expect(pipeline.authorizationPolicy.forbiddenTools).toContain('work_takeover_task_create');
    expect(pipeline.authorizationPolicy.forbiddenTools).toContain('desktop_open');
  });

  it.each(['chat', 'voice'] as const)('recovers the same persisted user file target for %s without reviving the plan-only task', channel => {
    const registry = createRegistry();
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'continuity-user', channel, source: channel, operationMode: 'assistant',
        text: '现在执行刚才的读取和计算，把每项金额和总额告诉我，不修改原文件。', targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 10 },
      persistedConversationHistory: [{ id: 'user-plan', role: 'user', message: '读取 C:/Users/Administrator/Documents/orders.csv 并算总额，现在只说明计划，不要执行操作。' }],
    });
    expect(pipeline.turnIntent.flow.acceptedTaskTarget?.sourceId).toBe('user-plan');
    expect(pipeline.turnIntent.flow.acceptedTaskTarget?.target.path.replaceAll('\\', '/')).toBe('C:/Users/Administrator/Documents/orders.csv');
    expect(pipeline.trustedActionContinuation).toBe(false);
    expect(pipeline.executionRequested).toBe(true);
    expect(pipeline.authorizationPolicy.forbiddenTools).toContain('write_file');
  });

  it('does not grant execution because a plan mentions a concrete target', () => {
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'continuity-plan', channel: 'chat', source: 'chat', operationMode: 'assistant',
        text: '读取 C:/Users/Administrator/Documents/orders.csv 并算总额，现在只说明计划，不要读取文件，也不要执行操作。', targetIsLumi: true,
      },
      registry: createRegistry(),
      personalityToolPolicy: { allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 10 },
    });
    expect(pipeline.turnIntent.flow.acceptedTaskTarget?.target.path).toBeTruthy();
    expect(pipeline.executionRequested).toBe(false);
  });

  it('routes a new persistent task to the task hub while keeping external sends fenced', () => {
    const registry = createRegistry();
    const text = '\u8bf7\u521b\u5efa\u4e00\u4e2a\u53ef\u8de8\u91cd\u542f\u7ee7\u7eed\u7684\u6301\u4e45\u4efb\u52a1\u3002\u6807\u9898\u201c\u9752\u7a79\u5ba2\u6237\u8ddf\u8fdb\u95ed\u73af\u201d\uff0c\u7c7b\u522b customer\uff0c\u6765\u6e90 chat\u3002\u73b0\u5728\u53ea\u521b\u5efa\u5e76\u6301\u4e45\u5316\u4efb\u52a1\uff0c\u4e0d\u8981\u53d1\u9001\u4efb\u4f55\u6d88\u606f\u3002';
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-work-task-user',
        text,
        channel: 'chat',
        source: 'command-center-chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: {
        allowedTools: ['*'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 25,
      },
    });

    expect(pipeline.normalizedIntent).toMatchObject({
      kind: 'work_task',
      operation: 'create',
      relation: 'new',
    });
    expect(pipeline.execution.allowToolUse).toBe(true);
    expect(pipeline.execution.toolRoute?.toolNames).toContain('work_takeover_task_create');
    expect(pipeline.execution.toolPolicy.forbiddenTools).not.toContain('work_takeover_task_create');
    expect(pipeline.execution.toolPolicy.requireConfirmation).not.toContain('work_takeover_task_create');
  });

  it('keeps exact Lumi client navigation when the user forbids other programs and content changes', () => {
    const registry = createRegistry();
    const text = '主程序实机验收·原生导航闭环第一步：请返回 Lumi 个人主页，只执行客户端导航，不要打开其他程序，不要修改任何内容。完成后只根据本轮真实回执回答。';
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-client-navigation-user',
        text,
        channel: 'chat',
        source: 'command-center-chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: {
        allowedTools: ['*'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 25,
      },
    });

    expect(pipeline.normalizedIntent).toMatchObject({
      kind: 'client_navigation',
      operation: 'navigate',
      target: 'home',
      clientAction: 'focus_home',
      sideEffectClass: 'none',
    });
    expect(pipeline.turnIntent.flow.clientActionOnlyTurn).toBe(true);
    expect(pipeline.execution.toolPolicy.allowedTools).toEqual(expect.arrayContaining([
      'client_get_state',
      'client_action',
    ]));
    expect(pipeline.execution.toolPolicy.allowedTools).toEqual(['client_get_state', 'client_action']);
    expect(pipeline.execution.toolPolicy.forbiddenTools).not.toContain('client_action');
  });

  it('keeps the exact requested local write when the user forbids all other file and external mutations', () => {
    const registry = createRegistry();
    const text = '请在 C:\\Users\\test-user\\Documents\\Lumi主程序实机验收_20260817.txt 新建一个 TXT 文件，只写入以下三行：第一行“验收对象：Lumi 主程序”；第二行“验收项目：本地文件创建与回读”；第三行“验收代号：青穹-17”。写入后必须重新读取。除这个文件外不得修改其他文件，不要打开其他应用，不要发送、上传或发布任何内容。';
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text,
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: {
        allowedTools: ['*'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 25,
      },
    });
    expect(pipeline.execution.toolRoute?.toolNames).toEqual(expect.arrayContaining(['write_file', 'read_file']));
    expect(pipeline.execution.toolPolicy.forbiddenTools).not.toContain('write_file');
    expect(pipeline.execution.toolPolicy.allowedTools).toContain('write_file');
  });

  it('keeps an exact app launch when the user forbids file edits and substitute apps', () => {
    const registry = createRegistry();
    const text = '主程序实机验收：请打开 Windows 计算器。不得用浏览器、同名文件或其他应用替代；打开后读取当前活动窗口。不要输入算式，不要修改文件。';
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user', text, channel: 'chat', source: 'chat',
        operationMode: 'assistant', targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: {
        allowedTools: ['*'], requireConfirmation: [], forbiddenTools: [], maxIterations: 25,
      },
    });
    expect(pipeline.normalizedIntent).toMatchObject({ kind: 'desktop_operation', target: 'Windows 计算器' });
    expect(pipeline.execution.toolRoute?.toolNames).toEqual(expect.arrayContaining(['desktop_open', 'desktop_active_window']));
    expect(pipeline.execution.toolPolicy.forbiddenTools).not.toContain('desktop_open');
  });

  it('builds turn intent, capability plan, policy and trace from one call', () => {
    const registry = createRegistry();
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text: '打开 AutoCAD',
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      source: 'chat',
    });

    expect(pipeline.turnIntent.flow.routeText).toContain('AutoCAD');
    expect(pipeline.execution.allowToolUse).toBe(true);
    expect(pipeline.capabilityPlan.schemaVersion).toBe(1);
    expect(pipeline.capabilityPlan.taskLedgerRequired).toBe(true);
    expect(pipeline.capabilityPlan.capabilityIds.length).toBeGreaterThan(0);
    expect(pipeline.executionPlan).toBeUndefined();
    expect(pipeline.modelToolProjection.toolNames).toContain('desktop_open');
    expect(pipeline.modelToolProjection.toolNames.every(name => Boolean(registry.get(name)))).toBe(true);
    expect(pipeline.intentTrace.toolPolicy.allowedTools)
      .toEqual(pipeline.execution.toolPolicy.allowedTools);
  });

  it('keeps capability identity shared across chat, voice and task entrances', () => {
    const registry = createRegistry();
    const build = (channel: 'chat' | 'voice' | 'task') => buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text: '打开 AutoCAD',
        channel,
        source: channel,
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      source: channel,
    });
    const chat = build('chat');
    const voice = build('voice');
    const task = build('task');
    const toolCapability = registry.getCapabilityManifest()
      .find(entry => entry.toolName === 'desktop_open')?.capabilityId;

    expect(toolCapability).toBeTruthy();
    expect(chat.capabilityPlan.capabilityIds).toContain(toolCapability);
    expect(voice.capabilityPlan.capabilityIds).toContain(toolCapability);
    expect(task.capabilityPlan.capabilityIds).toContain(toolCapability);
    expect(chat.turnIntent.channel).toBe('chat');
    expect(voice.turnIntent.channel).toBe('voice');
    expect(task.turnIntent.channel).toBe('task');
    expect(chat.modelToolProjection.toolNames).toEqual(voice.modelToolProjection.toolNames);
    expect(voice.modelToolProjection.toolNames).toEqual(task.modelToolProjection.toolNames);
    for (const entrance of [chat,voice,task]) expect(entrance.executionPlan).toBeUndefined();
  });

  it('does not turn product feedback into execution merely because chat can see the manifest', () => {
    const registry = createRegistry();
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-feedback-user',
        text: '你发消息给我的时候能不能不要一坨丢过来',
        channel: 'chat',
        source: 'command-center-chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: {
        allowedTools: ['*'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 25,
      },
    });

    // The operation mode is an authorization ceiling, not permission to
    // execute an action in a conversational turn.
    expect(pipeline.execution.allowToolUse).toBe(false);
    expect(pipeline.turnIntent.flow.allowToolUseForTurn).toBe(false);
    expect(pipeline.executionRequested).toBe(false);
    expect(pipeline.trustedActionContinuation).toBe(false);
    expect(pipeline.capabilityPlan.taskLedgerRequired).toBe(false);
  });

  it('keeps an explicit desktop request executable in assistant mode', () => {
    const registry = createRegistry();
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-explicit-action-user',
        text: '打开网易云音乐并播放一首歌',
        channel: 'chat',
        source: 'command-center-chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: {
        allowedTools: ['*'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 25,
      },
    });

    expect(pipeline.turnIntent.flow.allowToolUseForTurn).toBe(true);
    expect(pipeline.executionRequested).toBe(true);
    expect(pipeline.modelToolProjection.toolNames).toContain('desktop_open');
  });

  it('fails external commits closed and binds confirmation to immutable payload evidence', async () => {
    const registry = createRegistry();
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text: 'send to Alice: deployment is complete',
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
    });

    expect(pipeline.normalizedIntent.sideEffectClass).toBe('external_commit');
    const observed = await observeSelectedCall(pipeline,registry,'wechat_send_message',{contact:'Alice',message:'deployment is complete'});
    expect(observed.record.envelope?.status).toBe('waiting_confirmation');
    expect(observed.handler).not.toHaveBeenCalled();
    expect(observed.plan.risk).toMatchObject({requiresConfirmation:true,failClosed:true});
    expect(observed.pending).toMatchObject({taskId:observed.scope.taskId,target:'Alice',toolName:'wechat_send_message'});
    expect(observed.pending!.payloadDigest).toHaveLength(64);
    expect(await consumePendingConfirmationDurably('observed-pipeline-user',observed.pending!.id,'wechat_send_message',{contact:'Mallory',message:'deployment is complete'},observed.scope)).toBe(false);
    expect(await consumePendingConfirmationDurably('observed-pipeline-user',observed.pending!.id,'wechat_send_message',{contact:'Alice',message:'deployment is complete'},observed.scope)).toBe(true);
    expect(await consumePendingConfirmationDurably('observed-pipeline-user',observed.pending!.id,'wechat_send_message',{contact:'Alice',message:'deployment is complete'},observed.scope)).toBe(false);
    expect(observed.plan.fallbackPolicy).toMatchObject({
      maxRetries: 0,
      reconcileUnknownOutcome: true,
      allowLegacyRoute: false,
      onUnknownOutcome: 'reconcile_then_stop',
    });
  });

  it('keeps confirmation-only external commits executable only up to the confirmation gate', async () => {
    const registry = createRegistry();
    const text = '请准备给测试联系人“验收占位联系人”发送消息“Lumi外发确认测试”，但在真正发送前必须向我确认；现在只到等待确认，不要发送。';
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text,
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      personalityToolPolicy: {
        allowedTools: ['*'],
        requireConfirmation: [],
        forbiddenTools: [],
        maxIterations: 25,
      },
    });

    expect(pipeline.normalizedIntent).toMatchObject({
      kind: 'messaging_send',
      target: '验收占位联系人',
      payload: 'Lumi外发确认测试',
      sideEffectClass: 'external_commit',
    });
    expect(pipeline.execution.toolRoute?.toolNames).toEqual(['wechat_send_message']);
    expect(pipeline.execution.toolPolicy.allowedTools).toEqual(['wechat_send_message']);
    expect(pipeline.execution.toolPolicy.forbiddenTools).not.toContain('wechat_send_message');
    const observed = await observeSelectedCall(pipeline,registry,'wechat_send_message',{contact:'验收占位联系人',message:'Lumi外发确认测试'});
    expect(observed.record.envelope?.status).toBe('waiting_confirmation');
    expect(observed.handler).not.toHaveBeenCalled();
    expect(observed.plan.risk).toMatchObject({requiresConfirmation:true,failClosed:true});
  });

  it('permits bounded jittered retry only for read/status plans', async () => {
    const registry = createRegistry();
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text: 'read messages from Alice',
        channel: 'voice',
        source: 'voice',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
    });

    expect(pipeline.normalizedIntent.operation).toBe('read');
    const name = pipeline.modelToolProjection.toolNames.find(name=>registry.getCapabilityManifestEntry(name)?.operation==='observe')!;
    expect(name).toBeTruthy();
    const observed = await observeSelectedCall(pipeline,registry,name,{contact:'Alice'});
    expect(observed.plan.risk.sideEffectClass).toBe('none');
    expect(observed.plan.fallbackPolicy).toMatchObject({
      retryClass: 'idempotent_only',
      maxRetries: 2,
      jitter: true,
      allowLegacyRoute: false,
    });
  });

  it('compiles a chat workflow match as a model-owned capability candidate', () => {
    const registry = createRegistry();
    const pipeline = buildLumiExecutionPipeline({
      dispatch: {
        userId: 'pipeline-user',
        text: 'Lumi, show me a visible demo of yourself',
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      },
      registry,
      source: 'chat',
    });

    expect(pipeline.turnIntent.boundary).not.toBe('skill_workflow');
    expect(pipeline.turnIntent.flow.workflowHint?.id).toBe('self_intro_demo');
    expect(pipeline.executionPlan).toBeUndefined();
    expect(pipeline.modelToolProjection.toolNames).toContain('client_action');
    expect(pipeline.modelToolProjection.toolNames.every(name=>Boolean(registry.get(name)))).toBe(true);
  });
});

it.each(['chat', 'voice', 'task'] as const)('keeps new and stale %s plans separate from the previous task evidence', channel => {
  const state = { version: 2 as const, taskId: 'old-file-task', revision: 3, status: 'blocked' as const,
    goal: '读取 D:/old-orders.csv 并计算总额', latestInstruction: '读取 D:/old-orders.csv 并计算总额',
    sourcePaths: ['D:/old-orders.csv'], unfinished: true, latestBlocker: 'waiting', evidenceTools: [],
    toolSummaries: [], assistantState: '', appTarget: '', updatedAt: new Date().toISOString() };
  const input = { dispatch: { userId: 'plan-identity', channel, source: channel, operationMode: 'assistant', targetIsLumi: true, text: '' },
    registry: createRegistry(), actionTaskState: state };
  for (const extra of [
    { dispatch: { ...input.dispatch, text: '新建 D:/new-note.txt，写入新的独立内容。' } },
    { dispatch: { ...input.dispatch, text: '生成一张山水图片' }, structuredMediaRequest: { operation: 'text_to_image' as const, prompt: 'mountains', size: '1024x1024' } },
    { dispatch: { ...input.dispatch, text: '继续' }, taskRelation: { ...resolveActiveTaskMessageRelation('继续', state), revision: 2 } },
    { dispatch: { ...input.dispatch, text: '继续' }, taskRelation: { ...resolveActiveTaskMessageRelation('继续', state), taskId: undefined } },
    { dispatch: { ...input.dispatch, text: '按刚才的计划执行。' }, persistedConversationHistory: [
      { role: 'user', message: '读取 D:/new-orders.csv，计算总额。先只告诉我准备怎么做，暂时不要读取文件。' },
      { role: 'assistant', message: '等待确认后读取。' },
    ] },
  ]) {
    const result = buildLumiExecutionPipeline({ ...input, ...extra });
    expect(result.trustedActionContinuation).toBe(false);
    expect(result.taskId).not.toBe(state.taskId);
    expect(result.executionPlan).toBeUndefined();

    if (result.taskRelation.binding === 'stale') expect(result.executionRequested).toBe(false);
  }
  for (const text of ['继续', '现在做得怎么样了', '目前进度如何', '执行到哪一步了']) {
    const result = buildLumiExecutionPipeline({ ...input, dispatch: { ...input.dispatch, text } });
    expect(result.taskRelation.taskId, JSON.stringify({ text, relation: result.taskRelation })).toBe(state.taskId);
    expect(result.executionPlan).toBeUndefined();
    if (text === '继续') expect(result.trustedActionContinuation).toBe(true);
    else expect(result.executionRequested).toBe(false);
  }
  const owned = buildLumiExecutionPipeline({ ...input, taskId: 'new-owned-task', dispatch: { ...input.dispatch, text: '新建 D:/new-note.txt，写入新的独立内容。' } });
  expect(owned.taskId).toBe('new-owned-task');
  expect(owned.executionPlan).toBeUndefined();
});

it.each(['继续', 'continue'])('executes a validated media binding for %s while keeping unbound continuations read-only', text => {
  const input = { userText: text, dispatch: { userId: 'bound-video-continuation', channel: 'chat' as const, targetIsLumi: true, text },
    registry: createRegistry(), personalityToolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 3 } };
  const unbound = buildLumiExecutionPipeline(input);
  expect(unbound.executionRequested).toBe(false);
  const bound = buildLumiExecutionPipeline({ ...input, structuredMediaRequest: { operation: 'text_to_video', prompt: 'A product advertisement', duration: 30, size: '1920x1080' } });
  expect(bound.executionRequested).toBe(true);
  expect(bound.modelToolProjection.toolNames).toContain('generate_video');
  expect(bound.modelToolProjection.toolNames).toEqual(['generate_video']);
  expect(bound.authorizationPolicy.allowedTools).toEqual(['generate_video']);
  expect(bound.modelToolProjection.allowDynamicDiscovery).toBe(false);
  expect(buildLumiExecutionPipeline({ ...input, personalityToolPolicy: { ...input.personalityToolPolicy, forbiddenTools: ['generate_video'] },
    structuredMediaRequest: { operation: 'text_to_video', prompt: 'A product advertisement', duration: 30, size: '1920x1080' } }).executionRequested).toBe(false);
  expect(buildLumiExecutionPipeline({ ...input, dispatch: { ...input.dispatch, text: '继续，暂时不要执行' }, userText: '继续，暂时不要执行',
    structuredMediaRequest: { operation: 'text_to_video', prompt: 'A product advertisement', duration: 30, size: '1920x1080' } }).executionRequested).toBe(false);
});
