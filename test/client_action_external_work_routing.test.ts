import './helpers';
import { beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});

const MULTI_STEP_DESKTOP_TASK = '\u5206\u4e24\u6b65\u6267\u884c\uff1a\u5148\u67e5\u770b\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff0c\u518d\u5217\u51fa\u684c\u9762\u6587\u4ef6\uff0c\u6700\u540e\u6309\u771f\u5b9e\u7ed3\u679c\u6c47\u62a5\u3002';
const SINGLE_DESKTOP_TASK = '\u5217\u51fa\u684c\u9762\u6587\u4ef6';
const WPS_MULTI_STEP_TASK = '\u4e3b\u7a0b\u5e8f\u5b9e\u673a\u9a8c\u6536\uff1a\u8bf7\u6253\u5f00 WPS\uff0c\u7136\u540e\u65b0\u5efa\u4e00\u4e2a Word \u6587\u6863\uff0c\u5728\u6b63\u6587\u5199\u5165\uff1aLumi\u4e3b\u7a0b\u5e8fWPS\u534f\u540c\u9a8c\u6536\u901a\u8fc7\u3002\u4e0d\u8981\u4fdd\u5b58\u3001\u4e0d\u8981\u53d1\u9001\u3002';

describe('external work versus Lumi client actions', () => {
  it('does not treat desktop observation or multi-step work as a client surface action', async () => {
    const {
      hasClientActionIntent,
      hasClientActionOnlyIntent,
      traceToolIntentDecision,
    } = await import('../server/cognition/tool_intent');

    for (const request of [
      MULTI_STEP_DESKTOP_TASK,
      '\u67e5\u770b\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3',
      '\u5217\u51fa\u684c\u9762\u6587\u4ef6',
      WPS_MULTI_STEP_TASK,
    ]) {
      expect(hasClientActionIntent(request), request).toBe(false);
      expect(hasClientActionOnlyIntent(request), request).toBe(false);
    }

    const trace = traceToolIntentDecision(MULTI_STEP_DESKTOP_TASK, 'voice', 'assistant');
    expect(trace.signals.explicitToolIntent).toBe(true);
    expect(trace.signals.clientActionIntent).toBe(false);
    expect(trace.signals.clientActionOnlyIntent).toBe(false);
    expect(trace.matchedRules.some(rule => rule.layer === 'client_action_only')).toBe(false);

    const wpsTrace = traceToolIntentDecision(WPS_MULTI_STEP_TASK, 'command-center-chat', 'assistant');
    expect(wpsTrace.signals.clientActionIntent).toBe(false);
    expect(wpsTrace.signals.clientActionOnlyIntent).toBe(false);
    expect(wpsTrace.matchedRules.some(rule => (
      rule.layer === 'client_action' || rule.layer === 'client_action_only'
    ))).toBe(false);

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
        text: MULTI_STEP_DESKTOP_TASK,
        channel,
        source: channel,
        operationMode: 'assistant',
      });
      const decision = buildLumiExecutionDecision({
        flow: dispatch.flow,
        text: MULTI_STEP_DESKTOP_TASK,
        toolDeclarations: declarations,
      });

      expect(dispatch.boundary, channel).toBe('tool_action');
      expect(dispatch.flow.clientActionOnlyTurn, channel).toBe(false);
      expect(dispatch.flow.allowToolUseForTurn, channel).toBe(true);
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

  it('keeps legacy direct-tool hints read-only for both multi-step and single-step turns', async () => {
    const { processInput } = await import('../server/cognition');
    const { toolRegistry } = await import('../server/tools/registry');
    const execute = vi.spyOn(toolRegistry, 'execute').mockResolvedValue(
      JSON.stringify([{ name: 'example.txt', path: 'C:\\Users\\example\\Desktop\\example.txt' }]),
    );
    const context = {
      userId: 'single_core_cognition_user',
      personalityId: 'lumi',
      personalityName: 'Lumi',
      llmProvider: 'deepseek',
      llmModel: 'deepseek-v4-flash',
      isLLMAvailable: true,
    };

    try {
      const multiStepResult = await processInput(MULTI_STEP_DESKTOP_TASK, context);
      expect(multiStepResult.intent.directToolCall?.name).toBe('desktop_list_files');
      expect(multiStepResult.directToolExecuted).toBe(false);
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

});
