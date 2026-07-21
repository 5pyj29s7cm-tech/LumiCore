import './helpers';
import { describe, expect, it } from 'vitest';

describe('Lumi turn flow', () => {
  it('keeps a missing-reply complaint conversational in assistant mode', async () => {
    const { initDatabase } = await import('../db_layer');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    await initDatabase();

    const flow = buildLumiTurnFlow({
      userId: 'turn_flow_missing_reply_user',
      text: '为什么不回我',
      channel: 'chat',
      source: 'chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(flow.selfRepairTurn).toBe(false);
    expect(flow.allowToolUseForTurn).toBe(false);
    expect(flow.completionEvidenceNeeded).toBe(false);
    expect(flow.routeText).toBe('为什么不回我');
  });

  it('keeps artifact inspection and repair on ordinary work routes', async () => {
    const { initDatabase } = await import('../db_layer');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    await initDatabase();

    const tasks = [
      '检查一下这个文件',
      '检查合同',
      '检查桌面图片',
      '你自己检查一下这份合同',
      '检查微信新消息',
      '检查股票',
      '检查日程',
      '这段代码报错了，帮我修复',
      '合同有问题，帮我改一下',
    ];

    for (const [index, text] of tasks.entries()) {
      const flow = buildLumiTurnFlow({
        userId: `turn_flow_artifact_work_${index}`,
        text,
        channel: 'chat',
        source: 'chat',
        operationMode: 'assistant',
        targetIsLumi: true,
      });

      expect(flow.selfRepairTurn, text).toBe(false);
      expect(flow.allowToolUseForTurn, text).toBe(true);
    }
  });

  it.each([
    '检查一下你自己有没有问题',
    '检查一下客户端',
    '你自己检查一下',
  ])('keeps explicit current client checks on self-repair: %s', async (text) => {
    const { initDatabase } = await import('../db_layer');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    await initDatabase();

    const flow = buildLumiTurnFlow({
      userId: 'turn_flow_explicit_self_check',
      text,
      channel: 'chat',
      source: 'chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(flow.selfRepairTurn).toBe(true);
    expect(flow.allowToolUseForTurn).toBe(true);
  });

  it('promotes a question-shaped self-check from chat mode and executes it in the foreground', async () => {
    const { initDatabase } = await import('../db_layer');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    await initDatabase();

    const flow = buildLumiTurnFlow({
      userId: 'turn_flow_question_self_check',
      text: '你不能自检吗？',
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
      targetIsLumi: true,
    });

    expect(flow.autoPromoteToAssistant).toBe(true);
    expect(flow.effectiveOperationMode).toBe('assistant');
    expect(flow.selfRepairTurn).toBe(true);
    expect(flow.allowToolUseForTurn).toBe(true);
    expect(flow.executionGovernance.delegationIntent).toBe('none');
  });

  it('keeps guard-polluted conversational follow-ups chat-only in text and voice', async () => {
    const { initDatabase } = await import('../db_layer');
    const { buildRecentActionContinuationBridge } = await import('../server/cognition/action_continuation');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    await initDatabase();

    const history = [
      { role: 'user', message: '你对目前自己的能力是否满意' },
      {
        role: 'assistant',
        message: '我还没有真正开始读取或审查：这一轮没有记录到成功的工具执行。',
        cognitiveIntent: 'work_product_guard',
      },
    ];

    for (const [channel, text] of [['chat', '继续'], ['voice', '回答我']] as const) {
      const continuationContext = buildRecentActionContinuationBridge(text, history);
      const flow = buildLumiTurnFlow({
        userId: `turn-flow-guard-${channel}`,
        text,
        continuationContext,
        channel,
        source: channel,
        operationMode: 'assistant',
        targetIsLumi: true,
      });

      expect(continuationContext).toBe('');
      expect(flow.allowToolUseForTurn).toBe(false);
      expect(flow.routeText).toBe(text);
    }
  });

  it('keeps ordinary chat soft even when an active task exists', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    await initDatabase();

    createWorkTakeoverTask({
      userId: 'turn_flow_chat_user',
      category: 'general_work',
      title: '整理客户资料',
      nextActions: ['整理需求'],
      source: 'manual',
      status: 'in_progress',
    });

    const flow = buildLumiTurnFlow({
      userId: 'turn_flow_chat_user',
      text: '下一步呢',
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
    });

    expect(flow.surface).toBe('chat');
    expect(flow.workTakeover.strength).toBe('hint');
    expect(flow.workTakeover.shouldResumeTask).toBe(false);
    expect(flow.allowToolUseForTurn).toBe(false);
    expect(flow.promptOverlay).toContain('Do not force a task/tool path');
  });

  it('binds assistant work-surface follow-ups to the task center', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    await initDatabase();

    const task = createWorkTakeoverTask({
      userId: 'turn_flow_work_user',
      category: 'store',
      title: '接管店铺账号',
      nextActions: ['整理商品卖点'],
      source: 'wechat',
      status: 'in_progress',
    });

    const flow = buildLumiTurnFlow({
      userId: 'turn_flow_work_user',
      text: '下一步呢',
      channel: 'chat',
      source: 'org-chat',
      category: 'organization',
      operationMode: 'assistant',
      domain: 'work',
      orgId: 'org-a',
    });

    expect(flow.surface).toBe('work');
    expect(flow.workTakeover.latestTask?.id).toBe(task.id);
    expect(flow.workTakeover.shouldResumeTask).toBe(true);
    expect(flow.effectiveOperationMode).toBe('assistant');
    expect(flow.allowToolUseForTurn).toBe(true);
    expect(flow.routeText).toContain('工作接管');
  });

  it('keeps chat mode conversational and lets assistant voice continue work', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    await initDatabase();

    createWorkTakeoverTask({
      userId: 'turn_flow_voice_user',
      category: 'customer',
      title: '客户跟进',
      nextActions: ['准备回复'],
      source: 'wechat',
      status: 'in_progress',
    });

    const chatty = buildLumiTurnFlow({
      userId: 'turn_flow_voice_user',
      text: '继续',
      channel: 'voice',
      source: 'voice',
      operationMode: 'chat',
    });
    expect(chatty.workTakeover.strength).toBe('hint');
    expect(chatty.allowToolUseForTurn).toBe(false);

    const working = buildLumiTurnFlow({
      userId: 'turn_flow_voice_user',
      text: '继续推进这个任务',
      channel: 'voice',
      source: 'voice',
      operationMode: 'assistant',
    });
    expect(working.workTakeover.shouldResumeTask).toBe(true);
    expect(working.effectiveOperationMode).toBe('assistant');
    expect(working.allowToolUseForTurn).toBe(true);
  });

  it('routes a foreground WeChat inquiry as messaging work, not Lumi client navigation', async () => {
    const { initDatabase } = await import('../db_layer');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    await initDatabase();

    const inquiry = buildLumiTurnFlow({
      userId: 'turn_flow_voice_wechat_inquiry',
      text: '你打开微信问一下阿露在干嘛。',
      channel: 'voice',
      source: 'voice',
      operationMode: 'autonomous',
    });
    expect(inquiry.clientActionOnlyTurn).toBe(false);
    expect(inquiry.allowToolUseForTurn).toBe(true);

    const channelCorrection = buildLumiTurnFlow({
      userId: 'turn_flow_voice_channel_correction',
      text: '不是，我现在就在桌面客户端上，哪来的微信客户端啊？',
      channel: 'voice',
      source: 'voice',
      operationMode: 'autonomous',
    });
    expect(channelCorrection.clientActionOnlyTurn).toBe(false);
    expect(channelCorrection.allowToolUseForTurn).toBe(false);
  });

  it('describes Lumi as the orchestrator over skills, tasks, and external systems', async () => {
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    const flow = buildLumiTurnFlow({
      userId: 'turn_flow_prompt_user',
      text: '帮我打开浏览器查一下资料',
      channel: 'chat',
      source: 'chat',
      operationMode: 'assistant',
    });

    expect(flow.promptOverlay).toContain('Stay as Lumi first');
    expect(flow.promptOverlay).toContain('Use skill workflows');
    expect(flow.promptOverlay).toContain('external software');
  });

  it('requires evidence and verification guidance for deliverable work', async () => {
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    const flow = buildLumiTurnFlow({
      userId: 'turn_flow_verify_user',
      text: '帮我生成一份装修方案PPT和CAD图纸',
      channel: 'chat',
      source: 'chat',
      operationMode: 'assistant',
    });

    expect(flow.completionEvidenceNeeded).toBe(true);
    expect(flow.executionGovernance.verificationIntent).toBe('completion_evidence');
    expect(flow.promptOverlay).toContain('work_product_verify');
  });

  it('treats capability sedimentation as reuse-first learning instead of hard-coded scripts', async () => {
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    const flow = buildLumiTurnFlow({
      userId: 'turn_flow_capability_user',
      text: '把这个能力沉淀下来，不要写死成脚本',
      channel: 'chat',
      source: 'chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(flow.executionGovernance.capabilityLearningIntent).toBe('inspect_reuse');
    expect(flow.executionGovernance.shouldInspectCapabilitiesFirst).toBe(true);
    expect(flow.promptOverlay).toContain('capability_learning_list/self_extension_plan');
    expect(flow.promptOverlay).toContain('capability_gap_autofix');
  });

  it('marks explicit background work as delegation while keeping Lumi as owner', async () => {
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    const flow = buildLumiTurnFlow({
      userId: 'turn_flow_delegate_user',
      text: '这个客户资料整理很复杂，交给后台子agent并行处理',
      channel: 'chat',
      source: 'chat',
      operationMode: 'assistant',
    });

    expect(flow.executionGovernance.delegationIntent).toBe('explicit_background');
    expect(flow.promptOverlay).toContain('Lumi remains the owner');
  });

  it('uses continuation context for parameters without letting it replace the current intent', async () => {
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    const resultDemand = buildLumiTurnFlow({
      userId: 'turn_flow_desktop_result_demand_user',
      text: '\u6211\u8ba9\u4f60\u5e2e\u6211\u770b\u4e0b\u684c\u9762\u4e0a\u591a\u5c11\u8f6f\u4ef6\u4f60\u5012\u662f\u8ddf\u6211\u8bf4\u5440',
      continuationContext: [
        '## Recent action continuation context',
        'Recovered structured action state:',
        '- followupIntent: status',
        '- originalGoal: \u5e2e\u6211\u770b\u4e0b\u684c\u9762\u4e0a\u6709\u591a\u5c11\u8f6f\u4ef6',
        '- unfinished: no',
        'Recent tool evidence:',
        '- desktop_list_apps | items=2 | sample=AutoCAD | WPS Office',
      ].join('\n'),
      channel: 'voice',
      source: 'voice',
      operationMode: 'assistant',
    });

    expect(resultDemand.allowToolUseForTurn).toBe(false);
    expect(resultDemand.routeText).toContain('desktop_list_apps | items=2');
    expect(resultDemand.routeText).not.toContain('work_takeover');

    const statusQuestion = buildLumiTurnFlow({
      userId: 'turn_flow_current_intent_user',
      text: '你在干嘛',
      continuationContext: [
        '## Recent action continuation context',
        '- 打开微信问阿陆在干嘛',
        '- client_get_state status=failed',
      ].join('\n'),
      channel: 'voice',
      source: 'voice',
      operationMode: 'assistant',
    });

    expect(statusQuestion.selfRepairTurn).toBe(false);
    expect(statusQuestion.clientActionOnlyTurn).toBe(false);
    expect(statusQuestion.allowToolUseForTurn).toBe(false);
    expect(statusQuestion.routeText).toContain('打开微信问阿陆在干嘛');

    const whyUnfinished = buildLumiTurnFlow({
      userId: 'turn_flow_status_cad_user',
      text: '\u6211\u95ee\u4f60\u4e3a\u4ec0\u4e48\u6ca1\u6709\u5b8c\u6210\uff1f\u4f60\u4e3a\u4ec0\u4e48\u4e0d\u53bb\u6267\u884c\uff1f',
      continuationContext: [
        '## Recent action continuation context',
        'Recovered structured action state:',
        '- followupIntent: status',
        '- originalGoal: 把桌面的设计草稿.jpg画到 AutoCAD 里',
        '- latestBlocker: image read failed',
        '- unfinished: yes',
      ].join('\n'),
      channel: 'voice',
      source: 'voice',
      operationMode: 'assistant',
    });

    expect(whyUnfinished.allowToolUseForTurn).toBe(false);
    expect(whyUnfinished.routeText).toContain('设计草稿.jpg');
    expect(whyUnfinished.routeText).toContain('followupIntent: status');

    const executionPressure = buildLumiTurnFlow({
      userId: 'turn_flow_execution_pressure_user',
      text: '\u6162\u4e2a\u5c41',
      continuationContext: [
        '## Recent action continuation context',
        'Recovered structured action state:',
        '- followupIntent: execute',
        '- originalGoal: \u628a\u684c\u9762\u7684\u8bbe\u8ba1\u8349\u7a3f.jpg\u753b\u5230 AutoCAD \u91cc',
        '- latestBlocker: image decoder failed',
        '- unfinished: yes',
      ].join('\n'),
      channel: 'voice',
      source: 'voice',
      operationMode: 'assistant',
    });

    expect(executionPressure.allowToolUseForTurn).toBe(true);
    expect(executionPressure.routeText).toContain('\u8bbe\u8ba1\u8349\u7a3f.jpg');
    expect(executionPressure.routeText).toContain('followupIntent: execute');

    const cadContinuation = buildLumiTurnFlow({
      userId: 'turn_flow_contextual_cad_user',
      text: '继续',
      continuationContext: [
        '## Recent action continuation context',
        '- 读取桌面设计草稿并在 AutoCAD 里画出来',
        '- cad_prepare_autocad_operations status=prepared',
      ].join('\n'),
      channel: 'voice',
      source: 'voice',
      operationMode: 'assistant',
    });

    expect(cadContinuation.allowToolUseForTurn).toBe(true);
    expect(cadContinuation.clientActionOnlyTurn).toBe(false);
    expect(cadContinuation.routeText).toContain('AutoCAD');
  });
});
