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
  'desktop_ui_snapshot',
  'client_health_check',
  'list_skills',
  'install_skill',
  'adapter_registry_list',
  'web_login_run',
  'url_fetch_logged_in',
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
  });
});
