import { describe, expect, it } from 'vitest';
import { hasClientActionOnlyIntent } from '../server/cognition/tool_intent';
import { shouldDelegateWorkInBackground } from '../server/agents/background_delegation';
import { guardCompletionClaims } from '../server/work_product/completion_guard';

describe('Lumi client action routing', () => {
  it('routes client-native surface commands to client action tools', () => {
    expect(hasClientActionOnlyIntent('你能打开中枢世界吗')).toBe(true);
    expect(hasClientActionOnlyIntent('打开技能大厅')).toBe(true);
    expect(hasClientActionOnlyIntent('检查自己的客户端')).toBe(true);
  });

  it('keeps information-only client questions conversational', () => {
    expect(hasClientActionOnlyIntent('中枢世界是什么')).toBe(false);
  });

  it('keeps client surface continuations in the foreground instead of background agents', () => {
    const decision = shouldDelegateWorkInBackground({
      text: '查',
      category: 'analysis',
      complexity: 'moderate',
      allowToolUse: true,
      clientActionOnly: false,
      clientSurfaceRequest: true,
      selfRepair: false,
      sanctuary: false,
      directDesktop: false,
      prefersSequentialWorkflow: false,
      availableAgentCount: 3,
    });

    expect(decision).toEqual({
      shouldDelegate: false,
      reason: 'client_surface_foreground',
    });
  });

  it('blocks claims that a client surface opened without tool evidence', () => {
    const result = guardCompletionClaims({
      task: '你能打开中枢世界吗',
      response: '我已经打开了。',
      toolCalls: [],
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('我还没有真正操作客户端');
    expect(result.text).toContain('client_get_state / client_action');
  });

  it('allows client completion claims when client_action produced evidence', () => {
    const result = guardCompletionClaims({
      task: '你能打开中枢世界吗',
      response: '我已经打开中枢世界了。',
      toolCalls: [{
        id: 'call_1',
        name: 'client_action',
        arguments: { action: 'open_nexus' },
        result: JSON.stringify({ ok: true, verification: { status: 'verified' } }),
      }],
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe('我已经打开中枢世界了。');
  });
});
