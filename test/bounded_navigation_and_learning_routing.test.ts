import './helpers';
import { beforeAll, expect, it } from 'vitest';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import { buildLumiTurnDispatch } from '../server/cognition/turn_dispatch';
import { buildLumiExecutionDecision } from '../server/cognition/execution_decision';
import { buildOperationModeMetaResponse } from '../server/cognition/capability_meta';

const names = ['client_get_state', 'client_action', 'client_health_check', 'client_self_repair',
  'client_repair_skill', 'adapter_registry_list', 'adapter_health_check', 'web_search',
  'run_command', 'write_file', 'desktop_open', 'skill_marketplace_search', 'list_skills',
  'capability_research', 'external_control_candidates', 'external_control_configure_candidate',
  'generate_skill', 'skill_marketplace_install', 'install_skill', 'capability_gap_autofix',
  'client_capability_manifest'];
const declarations = names.map(name => ({ type: 'function' as const,
  function: { name, description: name, parameters: { type: 'object', properties: {} } } }));
const decide = (text: string) => {
  const dispatch = buildLumiTurnDispatch({ userId: 'bounded-routing-test', text,
    channel: 'chat', source: 'chat', operationMode: 'chat', targetIsLumi: true });
  return { dispatch, decision: buildLumiExecutionDecision({ flow: dispatch.flow, text, toolDeclarations: declarations }) };
};
beforeAll(async () => { const { initDatabase } = await import('../db_layer'); await initDatabase(); });

it.each([
  ['去技能大厅看看', 'skills'],
  ['请去 Lumi 技能大厅看一下，不要安装技能。', 'skills'],
  ['主程序实机验收·原生导航闭环第一步：请返回 Lumi 个人主页，只执行客户端导航，不要打开其他程序，不要修改任何内容。完成后只根据本轮真实回执回答。', 'home'],
  ['本次导航第二步：请打开技能大厅。', 'skills'],
])('keeps bounded navigation and only the two client tools: %s', (text, target) => {
  expect(normalizeActionIntent(text)).toMatchObject({ kind: 'client_navigation', target, sideEffectClass: 'none' });
  const { dispatch, decision } = decide(text);
  expect(dispatch.flow.clientActionOnlyTurn).toBe(true);
  expect(decision.toolPolicy.allowedTools).toEqual(['client_get_state', 'client_action']);
});

it.each([
  '不要去技能大厅看看。', '别去技能大厅看一下。', '能去技能大厅看看吗？',
  '去技能大厅看看？', '解释“去技能大厅看看”这句话。',
  '如果去技能大厅看看会怎样？', '去 C:\\notes\\技能大厅.txt 看看。',
  '去技能大厅.example.com看看。', '去仓库看看。',
  '不要执行本次导航第二步：请打开技能大厅。',
  '解释“本次导航第二步：请打开技能大厅。”',
  '本次导航第二步：请打开技能大厅吗？',
  '文档原文是：请返回 Lumi 个人主页。',
])('does not promote a prohibition, question, quotation or external operand: %s', text => {
  expect(normalizeActionIntent(text).kind).not.toBe('client_navigation');
});

it('routes an already classified learning request through reuse-first capability discovery', () => {
  const text = "Fix Lumi's missing tool capability. Search the Skill Hall and approved external MCP candidates first, and generate a skill only if the capability is genuinely missing.";
  const { dispatch, decision } = decide(text);
  expect(dispatch.flow.executionGovernance.capabilityLearningIntent).toBe('learn_missing');
  expect(decision.selfRepairToolPolicy).toBeNull();
  expect(decision.toolRoute?.categories).toContain('capability_learning');
  expect(decision.toolRoute?.toolNames).toEqual(expect.arrayContaining([
    'skill_marketplace_search', 'list_skills', 'capability_research', 'external_control_candidates', 'generate_skill',
  ]));
});

it('keeps an ordinary diagnostic request on its minimum diagnostic policy', () => {
  const { dispatch, decision } = decide('Lumi is broken. Diagnose the client.');
  expect(dispatch.flow.selfRepairTurn).toBe(true);
  expect(decision.toolPolicy.allowedTools).not.toEqual(expect.arrayContaining(['generate_skill', 'install_skill']));
  expect(decision.toolRoute?.categories || []).not.toContain('capability_learning');
});

it('does not use a quoted learning request as learning authorization', () => {
  const { dispatch, decision } = decide('Explain "Fix Lumi\'s missing tool capability"; do not use tools.');
  expect(dispatch.flow.allowToolUseForTurn).toBe(false);
  expect(decision.toolPolicy.allowedTools).toEqual([]);
});

it.each(['开始自主执行模式', '切换到自主执行模式', '进入自动执行模式'])('explains a retired selector without changing permissions: %s', text => {
  const { dispatch, decision } = decide(text);
  expect(dispatch.flow.effectiveOperationMode).toBe('assistant');
  expect(dispatch.flow.requestedMode).toBeNull();
  expect(decision.allowToolUse).toBe(false);
  expect(decision.toolPolicy.allowedTools).toEqual([]);
  expect(buildOperationModeMetaResponse({ text, operationMode: 'chat' })).toBeTruthy();
});
