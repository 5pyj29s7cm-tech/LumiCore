import './helpers';
import { describe, expect, it } from 'vitest';

describe('Lumi turn flow', () => {
  it('treats the exact prior-turn receipt question as status-only, not saved-artifact work', async () => {
    const text = '你上一轮是否真的调用过工具？不要再次调用工具，只根据已保存的回执告诉我：工具名、成功还是失败。';
    const { initDatabase } = await import('../db_layer');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    const { normalizeActionIntent } = await import('../server/cognition/normalized_action_intent');
    const { buildActionContract } = await import('../server/cognition/action_contract');
    await initDatabase();

    expect(normalizeActionIntent(text)).toMatchObject({
      kind: 'status_query',
      target: 'previous_action',
      sideEffectClass: 'none',
    });
    expect(buildActionContract(text)).toMatchObject({ applies: false, kind: 'none' });

    const flow = buildLumiTurnFlow({
      userId: 'turn_flow_exact_prior_receipt',
      text,
      channel: 'chat',
      source: 'command-center-chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    expect(flow.allowToolUseForTurn).toBe(false);
    expect(flow.modelToolAccess).toBe('hard_off');
    expect(flow.selfRepairTurn).toBe(false);
    expect(flow.completionEvidenceNeeded).toBe(false);
    expect(flow.executionGovernance.verificationIntent).toBe('none');
  });

  it.each(['chat', 'voice'] as const)('keeps explicit no-tool continuity tests conversational in %s', async (channel) => {
    const { initDatabase } = await import('../db_layer');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    await initDatabase();
    const flow = buildLumiTurnFlow({
      userId: `turn_flow_no_tools_${channel}`,
      text: '我们开始一个连续对话测试。请记住代号“青穹-17”，自然确认，不要调用工具。',
      channel,
      source: channel,
      operationMode: 'assistant',
    });

    expect(flow.clientActionOnlyTurn).toBe(false);
    expect(flow.selfRepairTurn).toBe(false);
    expect(flow.allowToolUseForTurn).toBe(false);
    expect(flow.completionEvidenceNeeded).toBe(false);
    expect(flow.executionGovernance.verificationIntent).toBe('none');
  });

  it.each([
    '你好 Lumi，我正在和你进行现场验收。请用两句话说明你是谁、能做什么，并明确今天只按我的指令行动。不要调用工具。',
    '接着刚才的验收，请记住验收代号是晨星716，只回复已记住，不执行工具。',
    '最终同步验收：只回复“修复复测已完成”，不调用工具。',
    '这是虚构的上下文验收，不需要任何工具。请记住杯子代号 cup-123，只简短确认已经记住。',
    '继续保持不调用工具。刚才杯子的代号是什么？只回复代号。',
  ])('keeps the field no-tool dialogue outside completion evidence: %s', async (text) => {
    const { initDatabase } = await import('../db_layer');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    await initDatabase();
    const flow = buildLumiTurnFlow({
      userId: 'turn_flow_field_dialogue',
      text,
      channel: 'chat',
      source: 'command-center-chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(flow.allowToolUseForTurn).toBe(false);
    expect(flow.selfRepairTurn).toBe(false);
    expect(flow.completionEvidenceNeeded).toBe(false);
    expect(flow.executionGovernance.verificationIntent).toBe('none');
    expect(flow.executionGovernance.delegationIntent).toBe('none');
  });

  it('keeps a quoted old action inside an explicit no-tool correction off the client-action lane', async () => {
    const { initDatabase } = await import('../db_layer');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    await initDatabase();
    const flow = buildLumiTurnFlow({
      userId: 'turn_flow_task_identity_correction',
      text: '不对，我刚才给的是一个新的 TXT 文件创建任务，你却回答了旧的“打开指挥中心”回执。只解释，不要执行新工具。',
      channel: 'chat',
      source: 'command-center-chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(flow.allowToolUseForTurn).toBe(false);
    expect(flow.clientActionOnlyTurn).toBe(false);
    expect(flow.selfRepairTurn).toBe(false);
    expect(flow.completionEvidenceNeeded).toBe(false);
  });

  it('does not join navigation verbs and client-surface nouns across separate clauses', async () => {
    const { initDatabase } = await import('../db_layer');
    const { buildLumiTurnFlow, buildInteractionModeOverlay } = await import('../server/cognition/turn_flow');
    await initDatabase();
    const flow = buildLumiTurnFlow({
      userId: 'turn_flow_factual_restatement',
      text: '先别做计划。我真正的要求是：明天去看硬件社区合作，重点问交付方式和售后责任。你复述一下，只复述事实。',
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
    });

    expect(flow.clientActionOnlyTurn).toBe(false);
    expect(flow.allowToolUseForTurn).toBe(false);
    expect(buildInteractionModeOverlay(flow)).toContain('Factual Restatement Fidelity');
  });

  it.each(['chat', 'voice'] as const)('keeps capability access questions conversational in %s', async (channel) => {
    const { initDatabase } = await import('../db_layer');
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    await initDatabase();

    const dispatch = buildLumiTurnDispatch({
      userId: `turn_flow_capability_meta_${channel}`,
      text: '\u90a3\u8981\u600e\u4e48\u624d\u80fd\u8ba9\u4f60\u4f7f\u7528\u5176\u5b83\u5de5\u5177',
      continuationContext: 'active task: search memory and continue execution',
      channel,
      source: channel === 'chat' ? 'command-center-chat' : 'voice',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(dispatch.boundary).toBe('conversation');
    expect(dispatch.flow.conceptualCapabilityQuestion).toBe(true);
    expect(dispatch.flow.allowToolUseForTurn).toBe(false);
    expect(dispatch.flow.clientActionOnlyTurn).toBe(false);
    expect(dispatch.flow.selfRepairTurn).toBe(false);
    expect(dispatch.flow.specialWorkflow).toBeNull();
    expect(dispatch.flow.executionGovernance.delegationIntent).toBe('none');
    expect(dispatch.flow.routeText).not.toContain('active task');
    if (channel === 'chat') {
      expect(dispatch.promptOverlay).toContain('only text entry');
      expect(dispatch.flow.promptOverlay).toContain('already there');
    }
  });

  it.each([
    '你能不能使用桌面工具打开记事本？现在打开它。',
    'Can you use desktop tools to open Notepad? Open it now.',
  ])('keeps a capability question with an immediate action on an execution boundary: %s', async (text) => {
    const { initDatabase } = await import('../db_layer');
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    await initDatabase();

    const dispatch = buildLumiTurnDispatch({
      userId: 'turn_flow_capability_action_user',
      text,
      channel: 'chat',
      source: 'command-center-chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(dispatch.flow.conceptualCapabilityQuestion).toBe(false);
    expect(dispatch.flow.allowToolUseForTurn).toBe(true);
    expect(dispatch.flow.clientActionOnlyTurn).toBe(false);
    expect(dispatch.boundary).toBe('tool_action');
  });

  it.each([
    '这个任务完成了吗？没完成就继续执行。',
    'Check the task status; if unfinished, retry it.',
    '上一轮是否调用工具？现在请调用另一个工具核实。',
  ])('keeps a mixed status and resume turn executable with continuation context: %s', async (text) => {
    const { initDatabase } = await import('../db_layer');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    await initDatabase();

    const flow = buildLumiTurnFlow({
      userId: 'turn_flow_mixed_status_execution_user',
      text,
      continuationContext: '## Recent action continuation context\n- followupIntent: status\n- unfinished: true\n- goal: finish the active task',
      channel: 'chat',
      source: 'command-center-chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(flow.conceptualCapabilityQuestion).toBe(false);
    expect(flow.allowToolUseForTurn).toBe(true);
    expect(flow.routeText).toContain('finish the active task');
  });

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

  it('keeps a concrete desktop action primary when repair wording only describes the fallback', async () => {
    const { initDatabase } = await import('../db_layer');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    await initDatabase();

    const text = '\u4e3b\u7a0b\u5e8f\u81ea\u6062\u590d\u9a8c\u6536\uff1a\u8bf7\u6253\u5f00 Windows \u8bb0\u4e8b\u672c\uff0c\u53ea\u6253\u5f00\u8fd9\u4e2a\u7cbe\u786e\u76ee\u6807\uff0c\u4e0d\u8981\u6253\u5f00\u66ff\u4ee3\u8f6f\u4ef6\u3002\u5982\u679c\u89c6\u89c9\u670d\u52a1\u4e0d\u53ef\u7528\uff0c\u8bf7\u4f7f\u7528\u5b89\u5168\u7684\u672c\u5730\u7a97\u53e3\u56de\u6267\u5b8c\u6210\u6838\u9a8c\u3002\u5b8c\u6210\u540e\u8bf4\u660e\u5b9e\u9645\u8fdb\u7a0b\u3001\u7a97\u53e3\u548c\u9a8c\u8bc1\u72b6\u6001\u3002';
    const flow = buildLumiTurnFlow({
      userId: 'turn_flow_primary_work_with_repair_fallback',
      text,
      channel: 'chat',
      source: 'command-center-chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(flow.selfRepairTurn).toBe(false);
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
    expect(flow.effectiveOperationMode).toBe('chat');
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

  it.each([
    '请分三句简短回答：你今天会如何陪我完成工作？每句不超过十五个字。',
    'Please answer in three short sentences: how will you help me complete my work today?',
  ])('keeps a work-support conversation off the active-task tool lane: %s', async (text) => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    await initDatabase();

    createWorkTakeoverTask({
      userId: 'turn_flow_work_support_question_user',
      category: 'general_work',
      title: '旧的未完成工作',
      nextActions: ['继续旧任务'],
      source: 'manual',
      status: 'in_progress',
    });

    const dispatch = buildLumiTurnDispatch({
      userId: 'turn_flow_work_support_question_user',
      text,
      channel: 'chat',
      source: 'command-center-chat',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(dispatch.boundary).toBe('conversation');
    expect(dispatch.flow.workTakeover.shouldResumeTask).toBe(false);
    expect(dispatch.flow.allowToolUseForTurn).toBe(false);
    expect(dispatch.flow.routeText).toBe(text);
  });

  it('keeps an adjacent-reply restatement ahead of an older active work task', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildRecentActionContinuationBridge } = await import('../server/cognition/action_continuation');
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    await initDatabase();

    const userId = 'turn_flow_adjacent_reply_restatement_user';
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
    const continuationContext = buildRecentActionContinuationBridge(text, [
      { role: 'user', message: '继续青穹客户跟进。' },
      { role: 'assistant', message: '旧任务仍然受阻。' },
      { role: 'user', message: '你是谁？' },
      { role: 'assistant', message: '我是 Lumi，是你的常驻智能伙伴。' },
    ]);
    const dispatch = buildLumiTurnDispatch({
      userId,
      text,
      continuationContext,
      channel: 'voice',
      source: 'voice',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(dispatch.boundary).toBe('conversation');
    expect(dispatch.flow.workTakeover.shouldResumeTask).toBe(false);
    expect(dispatch.flow.selfRepairTurn).toBe(false);
    expect(dispatch.flow.allowToolUseForTurn).toBe(false);
    expect(dispatch.flow.modelToolAccess).toBe('hard_off');
    expect(dispatch.flow.routeText).toContain('followupIntent: repeat');
    expect(dispatch.flow.routeText).toContain('我是 Lumi，是你的常驻智能伙伴。');
    expect(dispatch.flow.routeText).not.toContain('工作接管');
  });

  it('keeps the wallpaper-state speech alias on the client route despite an old task', async () => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    await initDatabase();

    const userId = 'turn_flow_wallpaper_state_alias_user';
    createWorkTakeoverTask({
      userId,
      category: 'general_work',
      title: '旧的自主任务',
      nextActions: ['继续旧任务'],
      source: 'manual',
      status: 'in_progress',
    });

    const dispatch = buildLumiTurnDispatch({
      userId,
      text: '打开壁纸状态。',
      channel: 'voice',
      source: 'voice',
      operationMode: 'assistant',
      targetIsLumi: true,
    });

    expect(dispatch.boundary).toBe('client_action');
    expect(dispatch.flow.clientActionOnlyTurn).toBe(true);
    expect(dispatch.flow.workTakeover.shouldResumeTask).toBe(false);
    expect(dispatch.flow.routeText).toBe('打开壁纸状态。');
  });

  it.each([
    '现在帮我完成这项工作。',
    'Help me complete this work now.',
  ])('keeps an explicit work imperative on the active-task execution lane: %s', async (text) => {
    const { initDatabase } = await import('../db_layer');
    const { createWorkTakeoverTask } = await import('../server/work_takeover/tasks');
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    await initDatabase();

    createWorkTakeoverTask({
      userId: 'turn_flow_work_support_imperative_user',
      category: 'general_work',
      title: '需要继续的工作',
      nextActions: ['执行下一步'],
      source: 'manual',
      status: 'in_progress',
    });

    const dispatch = buildLumiTurnDispatch({
      userId: 'turn_flow_work_support_imperative_user',
      text,
      channel: 'chat',
      source: 'command-center-chat',
      operationMode: 'chat',
      targetIsLumi: true,
    });

    expect(dispatch.boundary).toBe('work_takeover');
    expect(dispatch.flow.workTakeover.intent).toBe('advance');
    expect(dispatch.flow.workTakeover.shouldResumeTask).toBe(true);
    expect(dispatch.flow.autoPromoteToAssistant).toBe(true);
    expect(dispatch.flow.effectiveOperationMode).toBe('chat');
    expect(dispatch.flow.allowToolUseForTurn).toBe(true);
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

  it('routes knowledge inventory as read-only knowledge work, not client navigation', async () => {
    const { initDatabase } = await import('../db_layer');
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    await initDatabase();
    const flow = buildLumiTurnFlow({
      userId: 'turn_flow_knowledge_inventory',
      text: '请检查当前个人知识库是否可用，报告文档数量、已索引数量和最近错误。只读取真实状态，不导入、不修改任何内容。',
      channel: 'chat',
      source: 'chat',
      operationMode: 'assistant',
    });
    expect(flow.clientActionOnlyTurn).toBe(false);
    expect(flow.allowToolUseForTurn).toBe(true);
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
    expect(flow.promptOverlay).toContain('skill workflows as capability candidates');
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
