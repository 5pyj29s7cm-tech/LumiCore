import { describe, expect, it } from 'vitest';
import { buildClientDiagnosticPlan } from '../server/cognition/client_diagnostic_result';

describe('deterministic client diagnostic plan', () => {
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
