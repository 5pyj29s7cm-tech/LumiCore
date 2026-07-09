import './helpers';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const declarations = [
  'client_get_state',
  'client_action',
  'work_product_plan',
  'work_product_verify',
  'web_search',
  'url_fetch',
  'create_ppt',
  'write_file',
  'desktop_list_apps',
  'desktop_open',
  'desktop_active_window',
  'desktop_ui_snapshot',
  'desktop_mouse_click_at',
  'desktop_cursor_glow_show',
  'desktop_cursor_glow_update',
  'desktop_cursor_glow_click',
  'desktop_cursor_glow_hide',
  'desktop_keyboard_press',
  'desktop_capture_screen',
  'ocr_screen',
  'client_health_check',
  'list_skills',
  'install_skill',
  'adapter_registry_list',
  'web_login_run',
  'url_fetch_logged_in',
  'wechat_read_recent_chat',
  'wechat_send_message',
  'wechat_prepare_reply',
  'wechat_copy_reply_draft',
  'work_takeover_task_continue',
  'work_takeover_task_orchestrate',
  'mcp_stockbot_stock_quote',
  'mcp_stockbot_stock_trade_plan',
  'mcp_stockbot_paper_portfolio',
].map(name => ({
  type: 'function' as const,
  function: {
    name,
    description: name.replace(/_/g, ' '),
    parameters: { type: 'object', properties: {} },
  },
}));

describe('Lumi execution decision', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('keeps ordinary conversation tool-free', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');

    const dispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_chat_user',
      text: 'just talk with me for a minute',
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
      targetIsLumi: true,
    });
    const decision = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text: 'just talk with me for a minute',
      toolDeclarations: declarations,
    });

    expect(dispatch.boundary).toBe('conversation');
    expect(decision.allowToolUse).toBe(false);
    expect(decision.toolPolicy.forbiddenTools).toContain('*');
    expect(decision.toolRoute).toBeNull();
  });

  it('restricts client action turns to client state/action tools', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');

    const dispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_client_user',
      text: 'open settings',
      channel: 'voice',
      source: 'voice',
      operationMode: 'chat',
      targetIsLumi: true,
    });
    const decision = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text: 'open settings',
      toolDeclarations: declarations,
    });

    expect(dispatch.boundary).toBe('client_action');
    expect(decision.toolPolicy.allowedTools).toEqual(['client_get_state', 'client_action']);
    expect(decision.maxIterations).toBe(4);
  });

  it('treats task center as executable persistent work', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');

    const text = 'create a customer delivery report and export the package';
    const dispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_task_user',
      text,
      channel: 'task',
      source: 'task',
      operationMode: 'chat',
      targetIsLumi: true,
    });
    const decision = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text,
      toolDeclarations: declarations,
    });

    expect(dispatch.boundary).toBe('task_center');
    expect(decision.allowToolUse).toBe(true);
    expect(decision.toolRoute?.toolNames).toContain('work_product_plan');
    expect(decision.toolPolicy.allowedTools.length).toBeGreaterThan(0);
  });

  it('routes voice tool work through the same narrowed tool selection', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');

    const text = 'search the web and create a ppt report';
    const dispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_voice_user',
      text,
      channel: 'voice',
      source: 'voice',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const decision = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text,
      toolDeclarations: declarations,
    });

    expect(decision.allowToolUse).toBe(true);
    expect(decision.toolRoute?.categories.length).toBeGreaterThan(0);
    expect(decision.toolPolicy.allowedTools).toContain('web_search');
    expect(decision.promptOverlay).toContain('Lumi Execution Decision');
  });

  it('keeps chat, voice, and task sockets on the shared execution decision path', () => {
    const root = process.cwd();
    const sources = [
      readFileSync(path.join(root, 'server/socket/chat.ts'), 'utf8'),
      readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8'),
      readFileSync(path.join(root, 'server/socket/task.ts'), 'utf8'),
    ];

    for (const source of sources) {
      expect(source).toContain('buildLumiExecutionDecision');
      expect(source).toContain('buildLumiIntentTrace');
      expect(source).toContain('agent:intent_trace');
      expect(source).not.toContain('routeToolsForTurn');
      expect(source).not.toContain('mergeToolPolicyWithRoute');
    }
  });

  it('routes release-regression user wording without falling back to empty chat', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');

    const openSkillHall = '\u6253\u5f00\u6280\u80fd\u5927\u5385';
    const stockAssistant = '\u8fdb\u5165\u770b\u76d8\u8f85\u52a9\u6a21\u5f0f';
    const checkMcp = '\u5e2e\u6211\u68c0\u67e5 MCP \u72b6\u6001';
    const installThisSkill = '\u628a\u8fd9\u4e2a\u6280\u80fd\u88c5\u4e0a';

    const skillHallDispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_regression_user',
      text: openSkillHall,
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
      targetIsLumi: true,
    });
    const skillHallDecision = buildLumiExecutionDecision({
      flow: skillHallDispatch.flow,
      text: openSkillHall,
      toolDeclarations: declarations,
    });
    expect(skillHallDispatch.boundary).toBe('client_action');
    expect(skillHallDecision.toolPolicy.allowedTools).toEqual(['client_get_state', 'client_action']);
    expect(skillHallDecision.promptOverlay).toContain('verification.status');

    const stockDispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_regression_user',
      text: stockAssistant,
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
      targetIsLumi: true,
    });
    const stockDecision = buildLumiExecutionDecision({
      flow: stockDispatch.flow,
      text: stockAssistant,
      toolDeclarations: declarations,
    });
    expect(stockDecision.allowToolUse).toBe(true);
    expect(stockDecision.toolRoute?.categories).toContain('market_finance');
    expect(stockDecision.toolRoute?.toolNames).toEqual(expect.arrayContaining([
      'mcp_stockbot_stock_quote',
      'mcp_stockbot_stock_trade_plan',
    ]));

    const mcpDispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_regression_user',
      text: checkMcp,
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
      targetIsLumi: true,
    });
    const mcpDecision = buildLumiExecutionDecision({
      flow: mcpDispatch.flow,
      text: checkMcp,
      toolDeclarations: declarations,
    });
    expect(mcpDispatch.boundary).toBe('self_repair');
    expect(mcpDecision.allowToolUse).toBe(true);

    const installDispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_regression_user',
      text: installThisSkill,
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
      targetIsLumi: true,
    });
    const installDecision = buildLumiExecutionDecision({
      flow: installDispatch.flow,
      text: installThisSkill,
      toolDeclarations: declarations,
    });
    expect(installDecision.allowToolUse).toBe(true);
    expect(installDecision.toolRoute?.categories).toContain('skills_agents');
    expect(installDecision.toolRoute?.toolNames).toEqual(expect.arrayContaining([
      'list_skills',
      'install_skill',
    ]));

    const browseSkillHall = '\u53bb\u6280\u80fd\u5927\u5385\u770b\u770b';
    const browseDispatch = buildLumiTurnDispatch({
      userId: 'execution_decision_regression_user',
      text: browseSkillHall,
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
      targetIsLumi: true,
    });
    const browseDecision = buildLumiExecutionDecision({
      flow: browseDispatch.flow,
      text: browseSkillHall,
      toolDeclarations: declarations,
    });
    expect(browseDispatch.boundary).toBe('client_action');
    expect(browseDecision.toolPolicy.allowedTools).toEqual(['client_get_state', 'client_action']);
  });

  it('routes natural follow-up wording to action paths instead of empty chat', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');
    const decide = (text: string) => {
      const dispatch = buildLumiTurnDispatch({
        userId: 'execution_decision_natural_probe_user',
        text,
        channel: 'chat',
        source: 'chat',
        operationMode: 'chat',
        targetIsLumi: true,
      });
      const decision = buildLumiExecutionDecision({
        flow: dispatch.flow,
        text,
        toolDeclarations: declarations,
      });
      return { dispatch, decision };
    };

    const autonomousMode = decide('\u5f00\u59cb\u81ea\u4e3b\u6267\u884c\u6a21\u5f0f');
    expect(autonomousMode.dispatch.boundary).toBe('client_action');
    expect(autonomousMode.decision.toolPolicy.allowedTools).toEqual(['client_get_state', 'client_action']);
    expect(autonomousMode.decision.promptOverlay).toContain('verification.status');

    const deliveryReport = decide('\u7ed9\u6211\u505a\u4e00\u4e2a\u5ba2\u6237\u4ea4\u4ed8\u62a5\u544a\u5e76\u5bfc\u51fa');
    expect(deliveryReport.decision.allowToolUse).toBe(true);
    expect(deliveryReport.decision.toolRoute?.categories).toContain('documents');

    const readFile = decide('\u628a\u8fd9\u4e2a\u6587\u4ef6\u8bfb\u4e00\u4e0b');
    expect(readFile.decision.allowToolUse).toBe(true);
    expect(readFile.decision.toolRoute?.categories).toContain('documents');

    const stockNews = decide('\u67e5\u4e00\u4e0b\u4eca\u5929\u7f8e\u80a1\u65b0\u95fb');
    expect(stockNews.decision.allowToolUse).toBe(true);
    expect(stockNews.decision.toolRoute?.categories).toEqual(expect.arrayContaining(['market_finance', 'web_research']));

    const taobaoBackend = decide('\u5e2e\u6211\u7528\u6d4f\u89c8\u5668\u6253\u5f00\u6dd8\u5b9d\u540e\u53f0');
    expect(taobaoBackend.decision.allowToolUse).toBe(true);
    expect(taobaoBackend.decision.toolRoute?.categories).toContain('authenticated_web');
    expect(taobaoBackend.decision.toolRoute?.toolNames).toEqual(expect.arrayContaining([
      'web_login_run',
      'url_fetch_logged_in',
    ]));

    const legalFolder = decide('\u6839\u636e\u6848\u4ef6\u6587\u4ef6\u5939\u6574\u7406\u4ee3\u7406\u8bcd');
    expect(legalFolder.decision.allowToolUse).toBe(true);
    expect(legalFolder.decision.toolRoute?.categories).toContain('legal');

    const installLoose = decide('\u8fd9\u4e2a\u6280\u80fd\u88c5\u4e00\u4e0b');
    expect(installLoose.decision.allowToolUse).toBe(true);
    expect(installLoose.decision.toolRoute?.categories).toContain('skills_agents');

    const newsSearch = decide('\u641c\u4e00\u4e0b\u4eca\u5929 OpenAI \u65b0\u95fb');
    expect(newsSearch.decision.allowToolUse).toBe(true);
    expect(newsSearch.decision.toolRoute?.categories).toContain('web_research');

    const pptReport = decide('\u505a\u4e2a PPT \u6c47\u62a5\u5e76\u5bfc\u51fa');
    expect(pptReport.decision.allowToolUse).toBe(true);
    expect(pptReport.decision.toolRoute?.categories).toContain('documents');
    expect(pptReport.decision.toolRoute?.toolNames).toContain('create_ppt');

    const summarizeDoc = decide('\u628a\u8fd9\u4efd\u6587\u6863\u603b\u7ed3\u4e00\u4e0b');
    expect(summarizeDoc.decision.allowToolUse).toBe(true);
    expect(summarizeDoc.decision.toolRoute?.categories).toContain('documents');

    const readLoose = decide('\u8bfb\u53d6\u8fd9\u4e2a\u6587\u4ef6');
    expect(readLoose.decision.allowToolUse).toBe(true);
    expect(readLoose.decision.toolRoute?.categories).toContain('documents');

    const summarizePdf = decide('\u603b\u7ed3\u8fd9\u4efd PDF');
    expect(summarizePdf.decision.allowToolUse).toBe(true);
    expect(summarizePdf.decision.toolRoute?.categories).toContain('documents');

    const poster = decide('\u753b\u4e00\u5f20\u6d77\u62a5');
    expect(poster.decision.allowToolUse).toBe(true);
    expect(poster.decision.toolRoute?.categories).toContain('cad_design');

    const importKb = decide('\u628a\u8fd9\u4efd\u8d44\u6599\u5bfc\u5165\u77e5\u8bc6\u5e93');
    expect(importKb.decision.allowToolUse).toBe(true);
    expect(importKb.decision.toolRoute?.categories).toContain('documents');

    const wechatReply = decide('\u5e2e\u6211\u56de\u4e00\u4e0b\u5fae\u4fe1\u5ba2\u6237');
    expect(wechatReply.decision.allowToolUse).toBe(true);
    expect(wechatReply.decision.toolRoute?.categories).toContain('messaging');
    expect(wechatReply.decision.toolRoute?.toolNames).toEqual(expect.arrayContaining([
      'wechat_prepare_reply',
      'wechat_copy_reply_draft',
    ]));

    const wechatSend = decide('\u5fae\u4fe1\u76f4\u63a5\u53d1\u665a\u5b89\u7ed9\u963f\u9646');
    expect(wechatSend.decision.allowToolUse).toBe(true);
    expect(wechatSend.decision.toolRoute?.categories).toContain('messaging');
    expect(wechatSend.decision.toolRoute?.toolNames).toContain('wechat_send_message');

    const wechatRead = decide('\u6253\u5f00\u5fae\u4fe1\u770b\u770b\u6211\u548c\u963f\u9646\u6700\u8fd1\u7684\u804a\u5929\u5185\u5bb9');
    expect(wechatRead.decision.allowToolUse).toBe(true);
    expect(wechatRead.decision.toolRoute?.categories).toContain('messaging');
    expect(wechatRead.decision.toolRoute?.toolNames).toContain('wechat_read_recent_chat');
    expect(wechatRead.decision.toolRoute?.toolNames.slice(0, 4)).not.toContain('wechat_send_message');

    const continueCustomerTask = decide('\u7ee7\u7eed\u90a3\u4e2a\u5ba2\u6237\u4ea4\u4ed8\u4efb\u52a1');
    expect(continueCustomerTask.decision.allowToolUse).toBe(true);
    expect(continueCustomerTask.decision.toolRoute?.categories).toContain('work_takeover');
    expect(continueCustomerTask.decision.toolRoute?.toolNames).toEqual(expect.arrayContaining([
      'work_takeover_task_continue',
      'work_takeover_task_orchestrate',
    ]));

    const whyPush = decide('\u4e3a\u4ec0\u4e48\u8981\u63a8\u9001');
    expect(whyPush.dispatch.boundary).toBe('conversation');
    expect(whyPush.decision.allowToolUse).toBe(false);
    expect(whyPush.decision.toolRoute).toBeNull();

    const naturalnessQuestion = decide('lumi \u80fd\u4e0d\u80fd\u66f4\u81ea\u7136\u4e00\u70b9');
    expect(naturalnessQuestion.dispatch.boundary).toBe('conversation');
    expect(naturalnessQuestion.decision.allowToolUse).toBe(false);
    expect(naturalnessQuestion.decision.toolRoute).toBeNull();

    const stockModeQuestion = decide('\u770b\u76d8\u8f85\u52a9\u6a21\u5f0f\u662f\u4ec0\u4e48');
    expect(stockModeQuestion.dispatch.boundary).toBe('conversation');
    expect(stockModeQuestion.decision.allowToolUse).toBe(false);
    expect(stockModeQuestion.decision.toolRoute).toBeNull();

    const skillInstallQuestion = decide('\u6280\u80fd\u5927\u5385\u7684\u5b89\u88c5\u53ef\u4ee5\u7528\u5417');
    expect(skillInstallQuestion.dispatch.boundary).toBe('conversation');
    expect(skillInstallQuestion.decision.allowToolUse).toBe(false);
    expect(skillInstallQuestion.decision.toolRoute).toBeNull();

    const installerQuestion = decide('\u7f16\u8bd1\u6210\u5b89\u88c5\u5305\u4e5f\u80fd\u7528\u5417');
    expect(installerQuestion.dispatch.boundary).toBe('conversation');
    expect(installerQuestion.decision.allowToolUse).toBe(false);
    expect(installerQuestion.decision.toolRoute).toBeNull();

    const mcpWhyQuestion = decide('lumi \u4e3a\u4ec0\u4e48\u8981\u63a5\u5165\u5916\u90e8 MCP');
    expect(mcpWhyQuestion.dispatch.boundary).toBe('conversation');
    expect(mcpWhyQuestion.decision.allowToolUse).toBe(false);
    expect(mcpWhyQuestion.decision.toolRoute).toBeNull();

    const marketHowQuestion = decide('\u770b\u76d8\u8f85\u52a9\u6a21\u5f0f\u600e\u4e48\u7528');
    expect(marketHowQuestion.dispatch.boundary).toBe('conversation');
    expect(marketHowQuestion.decision.allowToolUse).toBe(false);
    expect(marketHowQuestion.decision.toolRoute).toBeNull();

    const installerCanQuestion = decide('\u5b89\u88c5\u5305\u80fd\u4e0d\u80fd\u7528');
    expect(installerCanQuestion.dispatch.boundary).toBe('conversation');
    expect(installerCanQuestion.decision.allowToolUse).toBe(false);
    expect(installerCanQuestion.decision.toolRoute).toBeNull();

    const marketRiskQuestion = decide('\u770b\u76d8\u8f85\u52a9\u4f1a\u4e0d\u4f1a\u6709\u98ce\u9669');
    expect(marketRiskQuestion.dispatch.boundary).toBe('conversation');
    expect(marketRiskQuestion.decision.allowToolUse).toBe(false);
    expect(marketRiskQuestion.decision.toolRoute).toBeNull();

    const whyFailed = decide('\u4e3a\u4ec0\u4e48\u6ca1\u505a\u5b8c');
    expect(whyFailed.dispatch.boundary).toBe('self_repair');
    expect(whyFailed.decision.allowToolUse).toBe(true);
  });

  it('builds intent traces for action versus consultation boundaries', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');
    const { buildLumiIntentTrace } = await import('../server/cognition/intent_trace');
    const decide = (text: string) => {
      const dispatch = buildLumiTurnDispatch({
        userId: 'execution_decision_trace_user',
        text,
        channel: 'chat',
        source: 'chat',
        operationMode: 'chat',
        targetIsLumi: true,
      });
      const decision = buildLumiExecutionDecision({
        flow: dispatch.flow,
        text,
        toolDeclarations: declarations,
      });
      const trace = buildLumiIntentTrace({
        dispatch,
        execution: decision,
        text,
        source: 'test',
      });
      return { dispatch, decision, trace };
    };

    const openSkillHall = decide('\u6253\u5f00\u6280\u80fd\u5927\u5385');
    expect(openSkillHall.trace.boundary).toBe('client_action');
    expect(openSkillHall.trace.allowed).toBe(true);
    expect(openSkillHall.trace.matched.clientActionOnlyTurn).toBe(true);
    expect(openSkillHall.trace.toolPolicy.allowedTools).toEqual(['client_get_state', 'client_action']);
    expect(openSkillHall.trace.matchedRules).toEqual(expect.arrayContaining([
      expect.objectContaining({ layer: 'structured_client', name: 'client-navigation' }),
      expect.objectContaining({ layer: 'turn_flow', name: 'client-action-only-turn' }),
    ]));

    const skillInstallQuestion = decide('\u6280\u80fd\u5927\u5385\u7684\u5b89\u88c5\u53ef\u4ee5\u7528\u5417');
    expect(skillInstallQuestion.trace.boundary).toBe('conversation');
    expect(skillInstallQuestion.trace.allowed).toBe(false);
    expect(skillInstallQuestion.trace.matched.informationOnlyQuestion).toBe(true);
    expect(skillInstallQuestion.trace.blockedBy).toContain('information-only-question');
    expect(skillInstallQuestion.trace.toolRoute).toBeNull();

    const checkMcp = decide('\u5e2e\u6211\u68c0\u67e5 MCP \u72b6\u6001');
    expect(checkMcp.trace.boundary).toBe('self_repair');
    expect(checkMcp.trace.allowed).toBe(true);
    expect(checkMcp.trace.matched.diagnosticOrRepair).toBe(true);
    expect(checkMcp.trace.matchedRules).toEqual(expect.arrayContaining([
      expect.objectContaining({ layer: 'turn_flow', name: 'self-repair-turn' }),
    ]));

    const installThisSkill = decide('\u628a\u8fd9\u4e2a\u6280\u80fd\u88c5\u4e0a');
    expect(installThisSkill.trace.boundary).toBe('tool_action');
    expect(installThisSkill.trace.allowed).toBe(true);
    expect(installThisSkill.trace.matched.explicitToolIntent).toBe(true);
    expect(installThisSkill.trace.matchedRules).toEqual(expect.arrayContaining([
      expect.objectContaining({ layer: 'structured_tool', name: 'skill-install' }),
    ]));
    expect(installThisSkill.trace.toolRoute?.categories).toContain('skills_agents');

    const mcpBrokenQuestion = decide('MCP \u4e3a\u4ec0\u4e48\u6253\u4e0d\u5f00');
    expect(mcpBrokenQuestion.trace.boundary).toBe('self_repair');
    expect(mcpBrokenQuestion.trace.allowed).toBe(true);
    expect(mcpBrokenQuestion.trace.matched.diagnosticOrRepair).toBe(true);

    const mcpConceptQuestion = decide('lumi \u4e3a\u4ec0\u4e48\u8981\u63a5\u5165\u5916\u90e8 MCP');
    expect(mcpConceptQuestion.trace.boundary).toBe('conversation');
    expect(mcpConceptQuestion.trace.allowed).toBe(false);
    expect(mcpConceptQuestion.trace.matched.informationOnlyQuestion).toBe(true);
    expect(mcpConceptQuestion.trace.blockedBy).toContain('information-only-question');
  });
});
