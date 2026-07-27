import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});

const TEAM_DESKTOP_TASK = '\u7ec4\u5efa\u56e2\u961f\uff0c\u5206\u4e24\u6b65\u6267\u884c\uff1a\u5148\u67e5\u770b\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff0c\u518d\u5217\u51fa\u684c\u9762\u6587\u4ef6\uff0c\u6700\u540e\u6309\u771f\u5b9e\u7ed3\u679c\u6c47\u62a5\u3002';
const SINGLE_DESKTOP_TASK = '\u5217\u51fa\u684c\u9762\u6587\u4ef6';

describe('external work versus Lumi client actions', () => {
  it('does not treat desktop observation or team execution wording as a client surface action', async () => {
    const {
      hasClientActionIntent,
      hasClientActionOnlyIntent,
      hasExplicitTeamExecutionRequest,
      traceToolIntentDecision,
    } = await import('../server/cognition/tool_intent');

    for (const request of [
      TEAM_DESKTOP_TASK,
      '\u67e5\u770b\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3',
      '\u5217\u51fa\u684c\u9762\u6587\u4ef6',
      '\u7ec4\u5efa\u56e2\u961f\u6267\u884c\u8fd9\u9879\u4efb\u52a1',
    ]) {
      expect(hasClientActionIntent(request), request).toBe(false);
      expect(hasClientActionOnlyIntent(request), request).toBe(false);
    }

    const trace = traceToolIntentDecision(TEAM_DESKTOP_TASK, 'voice', 'assistant');
    expect(trace.signals.explicitToolIntent).toBe(true);
    expect(trace.signals.clientActionIntent).toBe(false);
    expect(trace.signals.clientActionOnlyIntent).toBe(false);
    expect(trace.matchedRules.some(rule => rule.layer === 'client_action_only')).toBe(false);

    for (const request of [
      TEAM_DESKTOP_TASK,
      '\u7ec4\u961f\u5904\u7406\u8fd9\u4e2a\u4efb\u52a1',
      '\u8ba9\u56e2\u961f\u5206\u5de5\u5b8c\u6210\u8fd9\u4ef6\u4e8b',
      '\u8bf7\u591a\u4e2a\u667a\u80fd\u4f53\u534f\u4f5c\u5206\u6790\u3002',
    ]) {
      expect(hasExplicitTeamExecutionRequest(request), request).toBe(true);
    }
    expect(hasExplicitTeamExecutionRequest(SINGLE_DESKTOP_TASK)).toBe(false);
    expect(hasExplicitTeamExecutionRequest('\u6253\u5f00\u56e2\u961f\u9762\u677f')).toBe(false);
    expect(hasExplicitTeamExecutionRequest('\u600e\u4e48\u7ec4\u961f\uff1f')).toBe(false);
    expect(hasExplicitTeamExecutionRequest('\u80fd\u4e0d\u80fd\u7ec4\u5efa\u56e2\u961f\u6267\u884c\uff1f')).toBe(false);
  });

  it('keeps explicit Lumi settings and mode commands on the client-action path', async () => {
    const {
      hasClientActionIntent,
      hasClientActionOnlyIntent,
    } = await import('../server/cognition/tool_intent');

    for (const command of [
      '\u6253\u5f00 Lumi \u8bbe\u7f6e',
      '\u5207\u6362\u5230\u52a9\u624b\u6a21\u5f0f',
    ]) {
      expect(hasClientActionIntent(command), command).toBe(true);
      expect(hasClientActionOnlyIntent(command), command).toBe(true);
    }
  });

  it('routes the same external task through normal tool work in both voice and chat', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');
    const declarations = [
      'client_get_state',
      'client_action',
      'desktop_active_window',
      'get_active_window_info',
      'desktop_list_files',
      'desktop_path_info',
      'list_directory',
      'search_files',
      'grep_files',
      'read_file',
      'write_file',
      'list_skills',
      'work_product_plan',
      'work_product_verify',
    ].map(name => ({
      type: 'function' as const,
      function: {
        name,
        description: name.replace(/_/g, ' '),
        parameters: { type: 'object', properties: {} },
      },
    }));

    for (const channel of ['voice', 'chat'] as const) {
      const dispatch = buildLumiTurnDispatch({
        userId: `external_work_${channel}`,
        text: TEAM_DESKTOP_TASK,
        channel,
        source: channel,
        operationMode: 'assistant',
      });
      const decision = buildLumiExecutionDecision({
        flow: dispatch.flow,
        text: TEAM_DESKTOP_TASK,
        toolDeclarations: declarations,
      });

      expect(dispatch.boundary, channel).toBe('tool_action');
      expect(dispatch.flow.clientActionOnlyTurn, channel).toBe(false);
      expect(dispatch.flow.allowToolUseForTurn, channel).toBe(true);
      expect(dispatch.flow.exposeAgentWork, channel).toBe(true);
      expect(dispatch.flow.executionGovernance.delegationIntent, channel).toBe('explicit_team');
      expect(decision.clientActionToolPolicy, channel).toBeNull();
      expect(decision.toolRoute?.hardAllowlist, channel).toBe(true);
      expect(decision.toolPolicy.allowedTools, channel).toEqual([
        'desktop_active_window',
        'desktop_list_files',
      ]);
      expect(decision.toolPolicy.forbiddenTools, channel).toEqual(expect.arrayContaining([
        'get_active_window_info',
        'desktop_path_info',
        'list_directory',
        'search_files',
        'grep_files',
        'read_file',
        'write_file',
        'work_product_plan',
        'work_product_verify',
      ]));
      expect(decision.toolPolicy.maxIterations, channel).toBe(3);
      expect(decision.maxIterations, channel).toBe(3);
    }
  });

  it('keeps legacy direct-tool hints read-only for both team and single-agent turns', async () => {
    const { processInput } = await import('../server/cognition');
    const { toolRegistry } = await import('../server/tools/registry');
    const execute = vi.spyOn(toolRegistry, 'execute').mockResolvedValue(
      JSON.stringify([{ name: 'example.txt', path: 'C:\\Users\\example\\Desktop\\example.txt' }]),
    );
    const context = {
      userId: 'team_cognition_user',
      personalityId: 'lumi',
      personalityName: 'Lumi',
      llmProvider: 'deepseek',
      llmModel: 'deepseek-v4-flash',
      isLLMAvailable: true,
    };

    try {
      const teamResult = await processInput(TEAM_DESKTOP_TASK, context);
      expect(teamResult.intent.directToolCall?.name).toBe('desktop_list_files');
      expect(teamResult.directToolExecuted).toBe(false);
      expect(execute).not.toHaveBeenCalled();

      const singleResult = await processInput(SINGLE_DESKTOP_TASK, context);
      expect(singleResult.intent.directToolCall?.name).toBe('desktop_list_files');
      expect(singleResult.directToolExecuted).toBe(false);
      expect(singleResult.toolRecord).toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
    } finally {
      execute.mockRestore();
    }
  });

  it('forces explicit team turns through the shared voice/chat orchestration gate only', async () => {
    const {
      classifyComplexity,
      shouldAttemptOrchestration,
    } = await import('../server/agents/orchestrator');

    const teamComplexity = classifyComplexity(TEAM_DESKTOP_TASK, { userId: 'team_gate' });
    expect(teamComplexity).toBe('complex');
    expect(shouldAttemptOrchestration({
      channel: 'voice',
      text: TEAM_DESKTOP_TASK,
      complexity: teamComplexity,
      allowToolUse: true,
      clientActionOnly: false,
      selfRepair: false,
      artifactFirst: true,
      directDesktop: false,
    })).toBe(true);
    expect(shouldAttemptOrchestration({
      channel: 'chat',
      text: TEAM_DESKTOP_TASK,
      complexity: teamComplexity,
      allowToolUse: true,
      clientActionOnly: false,
      selfRepair: false,
      capabilityLane: 'desktop_control',
      cognitionCategory: 'command',
    })).toBe(true);

    const singleComplexity = classifyComplexity(SINGLE_DESKTOP_TASK, { userId: 'single_gate' });
    expect(singleComplexity).toBe('simple');
    expect(shouldAttemptOrchestration({
      channel: 'voice',
      text: SINGLE_DESKTOP_TASK,
      complexity: singleComplexity,
      allowToolUse: true,
      clientActionOnly: false,
      selfRepair: false,
      directDesktop: true,
    })).toBe(false);
    expect(shouldAttemptOrchestration({
      channel: 'chat',
      text: SINGLE_DESKTOP_TASK,
      complexity: singleComplexity,
      allowToolUse: true,
      clientActionOnly: false,
      selfRepair: false,
      capabilityLane: 'desktop_control',
      cognitionCategory: 'command',
    })).toBe(false);
  });
});
