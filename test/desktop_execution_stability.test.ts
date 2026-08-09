import './helpers';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const declarations = [
  'desktop_active_window',
  'desktop_capture_screen',
  'desktop_ui_snapshot',
  'desktop_ui_focus',
  'desktop_ui_click',
  'desktop_ui_type',
  'desktop_ui_invoke',
  'desktop_open',
  'computer_use',
  'work_takeover_task_verify_result',
  'work_product_verify',
  'web_login_run',
  'browser_open_task',
  'mcp_playwright_browser_snapshot',
].map(name => ({
  type: 'function' as const,
  function: {
    name,
    description: name.replace(/_/g, ' '),
    parameters: { type: 'object', properties: {} },
  },
}));

async function buildPolicy(text: string, operationMode = 'assistant') {
  const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
  const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');
  const { buildLumiCapabilitySelection } = await import('../server/cognition/capability_selection');
  const { buildDesktopExecutionStabilityPolicy } = await import('../server/cognition/desktop_execution_stability');

  const dispatch = buildLumiTurnDispatch({
    userId: 'desktop_policy_user',
    channel: 'chat',
    source: 'chat',
    text,
    operationMode,
    targetIsLumi: true,
  });
  const execution = buildLumiExecutionDecision({
    flow: dispatch.flow,
    text,
    toolDeclarations: declarations,
  });
  const capabilitySelection = buildLumiCapabilitySelection({
    dispatch,
    execution,
    text,
  });

  return {
    dispatch,
    execution,
    capabilitySelection,
    policy: buildDesktopExecutionStabilityPolicy({
      channel: 'chat',
      text,
      flow: dispatch.flow,
      capabilitySelection,
    }),
  };
}

describe('desktop execution stability policy', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('requires screen evidence for visible desktop/software control', async () => {
    const { capabilitySelection, policy } = await buildPolicy('open WPS and operate the visible desktop with mouse to write a Lumi intro document');

    expect(capabilitySelection.lane).toBe('desktop_control');
    expect(policy.applies).toBe(true);
    expect(policy.evidenceTools).toContain('desktop_active_window');
    expect(policy.actuationTools).toContain('mouse_drag');
    expect(policy.actuationTools).toContain('keyboard_press');
    expect(policy.actuationTools).toContain('computer_use');
    expect(policy.verificationTools).toContain('desktop_capture_screen');
    expect(policy.promptOverlay).toContain('screen is the source of truth');
    expect(policy.promptOverlay).toContain('Actuation tools to prefer');
    expect(policy.promptOverlay).toContain('verify focus before typing');
    expect(policy.promptOverlay).toContain('If the target app is already running');
    for (const toolName of policy.actuationTools.filter(name => name !== 'write_clipboard')) {
      expect(
        policy.executionPlan?.steps.some(step => step.allowedTools.includes(toolName)),
        `${toolName} must be authorized by the compiled desktop plan`,
      ).toBe(true);
    }
  });

  it('also applies to browser/account work because login state is visible state', async () => {
    const { capabilitySelection, policy } = await buildPolicy('open the seller dashboard with the saved login account');

    expect(capabilitySelection.lane).toBe('web_or_account');
    expect(policy.applies).toBe(true);
    expect(policy.verificationTools).toContain('mcp_playwright_browser_snapshot');
    expect(policy.promptOverlay).toContain('browser/account work');
  });

  it('keeps recovered current-app editing on an auditable UIA state machine', async () => {
    const { buildLumiTurnDispatch } = await import('../server/cognition/turn_dispatch');
    const { buildLumiExecutionDecision } = await import('../server/cognition/execution_decision');
    const { buildLumiCapabilitySelection } = await import('../server/cognition/capability_selection');
    const { buildDesktopExecutionStabilityPolicy } = await import('../server/cognition/desktop_execution_stability');
    const text = '在这里面新建一个空白文档并写入：Lumi端到端回归测试。';
    const continuationContext = [
      '## Recent action continuation context',
      'Recovered structured action state:',
      '- followupIntent: execute',
      '- originalGoal: 打开WPS。',
      '- appTarget: WPS',
      '- unfinished: no',
      'Recent tool evidence:',
      '- desktop_open | status=opened',
    ].join('\n');
    const dispatch = buildLumiTurnDispatch({
      userId: 'desktop_policy_current_app_user',
      channel: 'chat',
      source: 'chat',
      text,
      continuationContext,
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const execution = buildLumiExecutionDecision({
      flow: dispatch.flow,
      text: dispatch.flow.routeText,
      toolDeclarations: declarations,
    });
    const capabilitySelection = buildLumiCapabilitySelection({
      dispatch,
      execution,
      text: dispatch.flow.routeText,
    });
    const policy = buildDesktopExecutionStabilityPolicy({
      channel: 'chat',
      text: dispatch.flow.routeText,
      flow: dispatch.flow,
      capabilitySelection,
    });

    expect(policy.actuationTools).toEqual(expect.arrayContaining([
      'desktop_ui_focus',
      'desktop_ui_invoke',
      'desktop_ui_type',
    ]));
    expect(policy.actuationTools).not.toContain('computer_use');
    expect(policy.actuationTools).not.toContain('mouse_click');
    expect(policy.actuationTools).not.toContain('keyboard_type');
    expect(policy.promptOverlay).toContain('Never type or paste until');
    expect(policy.promptOverlay).toContain('Do not repeat the same New/Blank selector');
    for (const toolName of policy.actuationTools.filter(name => name !== 'write_clipboard')) {
      expect(
        policy.executionPlan?.steps.some(step => step.allowedTools.includes(toolName)),
        `${toolName} must be authorized for the recovered current-app plan`,
      ).toBe(true);
    }
  });

  it('does not apply to ordinary conversation', async () => {
    const { capabilitySelection, policy } = await buildPolicy('just chat with me for a minute', 'chat');

    expect(capabilitySelection.lane).toBe('conversation');
    expect(policy.applies).toBe(false);
    expect(policy.promptOverlay).toBe('');
  });

  it('keeps chat, voice, and task sockets on the shared desktop stability path', () => {
    const root = process.cwd();
    const chatSource = readFileSync(path.join(root, 'server/socket/chat.ts'), 'utf8');
    const voiceSource = readFileSync(path.join(root, 'server/socket/voice.ts'), 'utf8');
    const taskSource = readFileSync(path.join(root, 'server/socket/task.ts'), 'utf8');
    const sources = [chatSource, voiceSource, taskSource];

    for (const source of sources) {
      expect(source).toContain('buildDesktopExecutionStabilityPolicy');
      expect(source).toContain('agent:desktop_execution_policy');
      expect(source).toContain('actuationTools: desktopExecutionPolicy.actuationTools');
    }
    expect(chatSource).toMatch(/source:\s*'chat',[\s\S]{0,160}taskId:\s*requestId/);
    expect(voiceSource).toMatch(/source:\s*'voice',[\s\S]{0,160}taskId:\s*requestId/);
    expect(taskSource).toMatch(/source:\s*'task',[\s\S]{0,160}taskId:\s*requestId/);
  });
});
