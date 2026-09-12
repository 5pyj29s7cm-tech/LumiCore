import { describe, expect, it } from 'vitest';
import { buildClientDiagnosticPlan, hasCompleteClientDiagnosticReceipts } from '../server/cognition/client_diagnostic_result';
import { buildActionContract, hasCoreActionEvidence } from '../server/cognition/action_contract';
import { classifyRuntimeWorkIntent } from '../server/cognition/runtime_work_intent';

describe('deterministic client diagnostic plan', () => {
  it.each(['检查一下你当前的客户端和后台运行状态，把实际检查结果告诉我。', '查看客户端与后台的状态'])('does not let a ledger query consume coordinated client health inspection: %s', text => {
    expect(classifyRuntimeWorkIntent(text)).toBe('none');
    const plan = buildClientDiagnosticPlan(text);
    expect(plan.map(step => step.name)).toEqual(['runtime_work_status', 'client_health_check', 'client_get_state']);
    expect(buildActionContract(text).label).toBe('Current Lumi runtime diagnostic');
    const records = [{ name: 'runtime_work_status', arguments: {}, result: JSON.stringify({ok: true, activeCount: 0}) }];
    expect(hasCompleteClientDiagnosticReceipts(records, text)).toBe(false);
    expect(hasCoreActionEvidence(buildActionContract(text), records, text)).toBe(false);
    records.push({name: 'client_health_check', arguments: {}, result: '{"ok":true}'}, {name: 'client_get_state', arguments: {}, result: '{"ok":true}'});
    expect(hasCompleteClientDiagnosticReceipts(records, text)).toBe(true);
    records.push({name: 'client_get_state', arguments: {}, result: '{"ok":false,"status":"unavailable"}'});
    expect(hasCompleteClientDiagnosticReceipts(records, text)).toBe(false);
  });
  it.each([
    '做个自检',
    '你不能自检吗？',
    '检查一下客户端',
  ])('runs the two core read-only checks for a natural self-check request: %s', (text) => {
    expect(buildClientDiagnosticPlan(text)).toEqual([
      { name: 'client_health_check', arguments: {} },
      { name: 'client_get_state', arguments: {} },
    ]);
  });

  it('adds adapter evidence only when the user names an integration target', () => {
    expect(buildClientDiagnosticPlan('帮我检查 MCP 状态').map(call => call.name)).toEqual([
      'client_health_check',
      'client_get_state',
      'adapter_registry_list',
      'adapter_health_check',
    ]);
  });

  it.each([
    '你刚才是不是在做自检？',
    '修复并重启这个 MCP 技能',
    '检查一下这个文件',
  ])('does not turn explanation, repair, or artifact work into a fixed self-check: %s', (text) => {
    expect(buildClientDiagnosticPlan(text)).toEqual([]);
  });
});
