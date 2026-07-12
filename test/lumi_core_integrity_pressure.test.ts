import './helpers';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildLumiCapabilitySelection } from '../server/cognition/capability_selection';
import { buildLumiRuntimeCapabilityContext } from '../server/cognition/capability_context';
import { buildLumiExecutionDecision } from '../server/cognition/execution_decision';
import { buildLumiOperatingKernelPrompt } from '../server/cognition/operating_kernel';
import { buildLumiTurnDispatch } from '../server/cognition/turn_dispatch';
import { generateSystemPrompt } from '../server/personality/engine';
import type { PersonalityConfig } from '../server/personality/types';
import { ToolRegistry } from '../server/tools/registry';
import { registerAllTools } from '../server/tools/definitions';

const MCP_DECLARATION_NAMES = [
  'mcp_playwright_browser_snapshot',
  'mcp_playwright_browser_navigate',
  'mcp_playwright_browser_click',
  'mcp_playwright_browser_fill_form',
  'mcp_stockbot_stock_quote',
  'mcp_stockbot_stock_kline',
  'mcp_stockbot_market_index',
  'mcp_stockbot_stock_trade_plan',
  'mcp_stockbot_paper_portfolio',
  'mcp_cad-drafting_cad_space_program',
  'mcp_cad-drafting_cad_renovation_folder_workflow',
];

function mcpDeclaration(name: string) {
  return {
    type: 'function' as const,
    function: {
      name,
      description: name.replace(/_/g, ' '),
      parameters: { type: 'object', properties: {} },
    },
  };
}

function buildRegistry() {
  const registry = new ToolRegistry();
  registerAllTools(registry);
  return registry;
}

function buildDeclarations(registry: ToolRegistry) {
  const existing = new Set(registry.getToolDeclarations().map(item => item.function.name));
  return [
    ...registry.getToolDeclarations(),
    ...MCP_DECLARATION_NAMES.filter(name => !existing.has(name)).map(mcpDeclaration),
  ];
}

function evaluateTurn(input: {
  userId: string;
  text: string;
  channel?: 'chat' | 'voice' | 'task';
  operationMode?: string;
}) {
  const registry = buildRegistry();
  const channel = input.channel || 'chat';
  const dispatch = buildLumiTurnDispatch({
    userId: input.userId,
    text: input.text,
    channel,
    source: channel,
    operationMode: input.operationMode || 'assistant',
    targetIsLumi: true,
  });
  const execution = buildLumiExecutionDecision({
    flow: dispatch.flow,
    text: input.text,
    toolDeclarations: buildDeclarations(registry),
  });
  const selection = buildLumiCapabilitySelection({
    dispatch,
    execution,
    text: input.text,
  });
  return { registry, dispatch, execution, selection };
}

function expectCleanCorePrompt(value: string) {
  expect(value).not.toContain('鈥');
  expect(value).not.toContain('鍔');
  expect(value).not.toContain('鏈');
  expect(value).not.toContain('�');
}

describe('Lumi core integrity pressure', () => {
  beforeEach(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });

  it('keeps the personality core clean and model-independent across chat and voice', () => {
    const config = JSON.parse(
      readFileSync(path.join(process.cwd(), 'server/personality/personalities.json'), 'utf8'),
    )[0] as PersonalityConfig;

    const prompt = generateSystemPrompt({
      ...config,
      growthState: {
        version: 1,
        lastUpdatedAt: new Date().toISOString(),
        ownerInterests: ['legal casework', 'desktop automation'],
        ownerExpressions: ['完整闭环'],
        communicationPatterns: ['prefers direct code-level status'],
        adaptationNotes: ['Use growth context for personalization, not identity replacement.'],
      },
    }, {
      mode: 'chat',
      uiContext: 'voice',
      sensory: {
        audio: true,
        visual: true,
        spatial: false,
        haptic: false,
        holographic: false,
        activeDeviceTypes: ['desktop'],
        deviceCount: 1,
      },
    }, {
      userId: 'core_integrity_personality_user',
      userText: 'Lumi 现在人格核心和语音链路稳定吗？',
    });

    expect(prompt).toContain('Stable Lumi Identity Anchor');
    expect(prompt).toContain('one local desktop AI subject');
    expect(prompt).toContain('Chat, voice, task center, tools, skills, memory');
    expect(prompt).toContain('same Lumi, not separate personas');
    expect(prompt).toContain('Personal Growth State');
    expect(prompt).toContain('do not treat it as core identity');
    expect(prompt).toContain('完整闭环');
    expect(prompt).toContain('Active senses: can hear, can see.');
    expectCleanCorePrompt(prompt);

    const voiceDispatch = buildLumiTurnDispatch({
      userId: 'core_integrity_kernel_user',
      text: '继续推进这个任务',
      channel: 'voice',
      source: 'voice',
      operationMode: 'assistant',
      targetIsLumi: true,
    });
    const kernel = buildLumiOperatingKernelPrompt({ channel: 'voice', flow: voiceDispatch.flow });

    expect(kernel).toContain('one local desktop AI subject');
    expect(kernel).toContain('same Lumi body/capability graph');
    expect(kernel).toContain('For voice, keep spoken output short while work continues');
    expect(kernel).toContain('Use tools and agents as Lumi\'s hands');
    expectCleanCorePrompt(kernel);
  });

  it('keeps text, voice, and task entry points on the same internal capability graph', () => {
    const wechatText = '\u5fae\u4fe1\u7ed9\u963f\u9646\u53d1\u665a\u5b89';
    const chat = evaluateTurn({
      userId: 'core_integrity_chat_wechat',
      text: wechatText,
      channel: 'chat',
      operationMode: 'assistant',
    });
    const voice = evaluateTurn({
      userId: 'core_integrity_voice_wechat',
      text: wechatText,
      channel: 'voice',
      operationMode: 'assistant',
    });

    for (const result of [chat, voice]) {
      expect(result.dispatch.boundary).toBe('tool_action');
      expect(result.execution.allowToolUse).toBe(true);
      expect(result.selection.lane).toBe('messaging');
      expect(result.selection.preferredTools).toEqual(expect.arrayContaining([
        'wechat_send_message',
        'desktop_mouse_click_at',
        'desktop_cursor_glow_show',
      ]));
      expect(result.execution.toolPolicy.requireConfirmation || []).not.toContain('wechat_send_message');
    }

    const externalAi = evaluateTurn({
      userId: 'core_integrity_external_ai',
      text: 'Ask WorkBuddy, Codex, ChatGPT, and Claude this question, collect their answers, and summarize the differences.',
      channel: 'chat',
      operationMode: 'assistant',
    });
    expect(externalAi.selection.lane).toBe('desktop_control');
    expect(externalAi.selection.preferredTools.slice(0, 8)).toEqual(expect.arrayContaining([
      'desktop_ai_list_targets',
      'desktop_ai_discovery_plan',
      'desktop_ai_ask',
      'desktop_ai_collect_answer',
    ]));
    expect(externalAi.execution.toolRoute?.toolNames.indexOf('desktop_ai_ask')).toBeLessThan(
      externalAi.execution.toolRoute?.toolNames.indexOf('computer_use') ?? Number.POSITIVE_INFINITY,
    );

    const legalVoice = evaluateTurn({
      userId: 'core_integrity_voice_legal',
      text: '\u8bed\u97f3\u4f1a\u8bae\u8bb0\u5f55\uff1a\u6839\u636e\u8fd9\u4e2a\u6848\u5b50\u751f\u6210\u7b54\u8fa9\u72b6\u548c\u8d28\u8bc1\u610f\u89c1',
      channel: 'voice',
      operationMode: 'assistant',
    });
    expect(legalVoice.selection.lane).toBe('legal_casework');
    expect(legalVoice.selection.preferredTools).toEqual(expect.arrayContaining([
      'legal_meeting_minutes_to_case',
      'legal_case_reasoning_matrix',
      'legal_generate_litigation_packet',
    ]));
    expect(legalVoice.execution.promptOverlay).toContain('Current-law gate');

    const task = evaluateTurn({
      userId: 'core_integrity_task_center',
      text: 'Create a project report package, verify the result, and export it.',
      channel: 'task',
      operationMode: 'assistant',
    });
    expect(task.dispatch.boundary).toBe('task_center');
    expect(task.selection.lane).toBe('task_center');
    expect(task.selection.preferredTools).toEqual(expect.arrayContaining([
      'work_takeover_task_advance',
      'work_takeover_task_verify_result',
      'work_takeover_task_export_packet',
    ]));

    const dream = evaluateTurn({
      userId: 'core_integrity_sleep_dream',
      text: '让 Lumi 做梦休息一下，整理最近的记忆，降低混乱，但不要改核心人格',
      channel: 'chat',
      operationMode: 'assistant',
    });
    expect(dream.dispatch.boundary).toBe('tool_action');
    expect(dream.execution.allowToolUse).toBe(true);
    expect(dream.execution.toolRoute?.categories).toContain('sleep_dream');
    expect(dream.selection.lane).toBe('internal_memory');
    expect(dream.selection.preferredTools).toEqual(expect.arrayContaining([
      'lumi_sleep_status',
      'lumi_sleep_cycle',
    ]));
    expect(dream.selection.promptOverlay).toContain('internal memory consolidation');
  });

  it('keeps runtime capability context wired to tools, adapters, skills, MCP health, and task state', () => {
    const { registry, dispatch } = evaluateTurn({
      userId: 'core_integrity_context_user',
      text: 'Ask other desktop AI tools this question and bring the answers back.',
      channel: 'chat',
      operationMode: 'assistant',
    });

    const context = buildLumiRuntimeCapabilityContext({
      userId: 'core_integrity_context_user',
      text: 'Ask other desktop AI tools this question and bring the answers back.',
      flow: dispatch.flow,
      toolRegistry: registry,
    });

    expect(context).toContain('Lumi Runtime Capability Context');
    expect(context).toContain('Lumi is the subject');
    expect(context).toContain('tools=available');
    expect(context).toContain('Tool groups available:');
    expect(context).toContain('desktop=');
    expect(context).toContain('web/account=');
    expect(context).toContain('MCP health gate:');
    expect(context).toContain('Skill workflows known:');
    expect(context).toContain('Relevant adapters/external systems:');
    expect(context).toContain('understand the turn -> decide chat/work');
    expectCleanCorePrompt(context);
  });

  it('keeps desktop AI catalog, discovery, registration, and ask path complete', async () => {
    const registry = buildRegistry();
    const declarations = registry.getToolDeclarations().map(item => item.function.name);

    expect(declarations).toEqual(expect.arrayContaining([
      'desktop_ai_list_targets',
      'desktop_ai_discovery_plan',
      'desktop_ai_register_target',
      'desktop_ai_ask',
      'desktop_ai_collect_answer',
    ]));

    const listRaw = await registry.execute('desktop_ai_list_targets', { includeStored: false }, {
      userId: 'core_integrity_desktop_ai_user',
    });
    const list = JSON.parse(listRaw);
    const ids = list.targets.map((target: any) => target.id);
    expect(ids).toEqual(expect.arrayContaining([
      'workbuddy',
      'codex',
      'chatgpt',
      'claude',
      'gemini',
      'deepseek',
      'kimi',
      'doubao',
      'tongyi',
      'wenxin',
      'perplexity',
      'cursor',
      'copilot',
      'lmstudio',
      'ollama',
      'cherry-studio',
      'anythingllm',
    ]));
    expect(list.boundary).toContain('Desktop-only targets are controlled through visible windows');

    const planRaw = await registry.execute('desktop_ai_discovery_plan', {
      focus: 'desktop AI and coding agents',
    }, {
      userId: 'core_integrity_desktop_ai_user',
    });
    const plan = JSON.parse(planRaw);
    expect(plan.evaluationChecklist.join('\n')).toContain('official product pages');
    expect(plan.boundary).toContain('does not install software');

    const userId = 'core_integrity_registered_ai_user';
    await registry.execute('desktop_ai_register_target', {
      id: 'test-ai',
      label: 'Test AI',
      aliases: ['TestAI'],
      openTargets: ['Test AI'],
      surface: 'desktop_app',
      sourceUrls: ['https://example.com/test-ai'],
      notes: 'Synthetic pressure target.',
    }, {
      userId,
      userConfirmed: true,
    });

    const calls: Array<{ name: string; args: Record<string, any> }> = [];
    const askRaw = await registry.execute('desktop_ai_ask', {
      question: 'Summarize the risk in one sentence.',
      targets: ['test-ai'],
      send: false,
    }, {
      userId,
      desktopRelay: async (name, args) => {
        calls.push({ name, args });
        if (name === 'desktop_active_window') return JSON.stringify({ title: 'Test AI', processName: 'TestAI.exe' });
        if (name === 'desktop_clipboard_write') return JSON.stringify({ ok: true });
        if (name === 'desktop_keyboard_press') return JSON.stringify({ ok: true });
        return JSON.stringify({ ok: true });
      },
    });
    const ask = JSON.parse(askRaw);

    expect(ask.ok).toBe(true);
    expect(ask.preparedCount).toBe(1);
    expect(ask.results[0].target).toBe('test-ai');
    expect(ask.results[0].actions).toEqual(expect.arrayContaining([
      'desktop_clipboard_write',
      'desktop_keyboard_press:ctrl+v',
    ]));
    expect(calls.map(call => call.name)).toEqual(expect.arrayContaining([
      'desktop_active_window',
      'desktop_clipboard_write',
      'desktop_keyboard_press',
    ]));
    expect(calls.some(call => call.name === 'desktop_open')).toBe(false);
  });
});
