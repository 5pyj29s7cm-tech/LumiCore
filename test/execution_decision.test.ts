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
});
