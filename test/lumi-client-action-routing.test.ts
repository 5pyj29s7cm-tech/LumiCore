import { describe, expect, it } from 'vitest';
import {
  hasClientActionOnlyIntent,
  hasExplicitNoToolInstruction,
  traceToolIntentDecision,
} from '../server/cognition/tool_intent';
import { shouldDelegateWorkInBackground } from '../server/agents/background_delegation';
import { guardCompletionClaims } from '../server/work_product/completion_guard';

describe('Lumi client action routing', () => {
  it('routes client-native surface commands to client action tools', () => {
    expect(hasClientActionOnlyIntent('你能打开中枢世界吗')).toBe(true);
    expect(hasClientActionOnlyIntent('打开技能大厅')).toBe(true);
    expect(hasClientActionOnlyIntent('检查自己的客户端')).toBe(true);
    expect(hasClientActionOnlyIntent('进入桌面小组件模式')).toBe(true);
    expect(hasClientActionOnlyIntent('展开 Lumi 小组件')).toBe(true);
    expect(hasClientActionOnlyIntent('打开头像工作室')).toBe(true);
    expect(hasClientActionOnlyIntent('打开记忆头像')).toBe(true);
    expect(hasClientActionOnlyIntent('打开工作队列')).toBe(true);
    expect(hasClientActionOnlyIntent('打开电脑适配中心')).toBe(true);
    expect(hasClientActionOnlyIntent('打开主屏幕')).toBe(true);
    expect(hasClientActionOnlyIntent('回到主页')).toBe(true);
    expect(hasClientActionOnlyIntent('打开通知面板')).toBe(true);
    expect(hasClientActionOnlyIntent('打开提醒面板')).toBe(true);
    expect(hasClientActionOnlyIntent('关闭中枢世界')).toBe(true);
    expect(hasClientActionOnlyIntent('关掉知识库')).toBe(true);
    expect(hasClientActionOnlyIntent('关闭运行日志')).toBe(true);
    expect(hasClientActionOnlyIntent('关闭桌面小组件')).toBe(true);
    expect(hasClientActionOnlyIntent('打开订阅页面')).toBe(false);
    expect(hasClientActionOnlyIntent('打开激活页面')).toBe(false);
    expect(hasClientActionOnlyIntent('close subscription page')).toBe(false);
  });

  it('routes concrete organization workspace destinations as client navigation', () => {
    expect(hasClientActionOnlyIntent('\u6253\u5f00\u7ec4\u7ec7\u77e5\u8bc6\u5e93')).toBe(true);
    expect(hasClientActionOnlyIntent('\u8fdb\u5165\u5f8b\u6240\u5de5\u4f5c\u53f0')).toBe(true);
    expect(hasClientActionOnlyIntent('\u6253\u5f00\u7a7a\u95f4\u5efa\u7b51\u8bbe\u8ba1')).toBe(true);
    expect(hasClientActionOnlyIntent('\u6253\u5f00\u54c1\u724c\u521b\u610f\u8bbe\u8ba1')).toBe(true);
    expect(hasClientActionOnlyIntent('open company Lumi')).toBe(true);
    expect(hasClientActionOnlyIntent('open members and permissions')).toBe(true);
  });

  it('keeps information-only client questions conversational', () => {
    expect(hasClientActionOnlyIntent('中枢世界是什么')).toBe(false);
  });

  it('gives an explicit no-tool instruction precedence over surface keywords', () => {
    const text = '我们开始一个连续对话测试，只和我聊天，不要调用工具。';
    expect(hasExplicitNoToolInstruction(text)).toBe(true);
    expect(hasClientActionOnlyIntent(text)).toBe(false);
    expect(traceToolIntentDecision(text, 'chat', 'assistant')).toMatchObject({
      allowToolUse: false,
      decisionReason: 'explicit current-turn no-tool instruction',
      blockedBy: expect.arrayContaining(['explicit-no-tool-instruction']),
      signals: { explicitNoToolInstruction: true },
    });
    expect(hasExplicitNoToolInstruction('不用问我，直接调用工具完成')).toBe(false);
  });

  it('treats do-not-execute-new-actions as a hard current-turn tool veto', () => {
    expect(hasExplicitNoToolInstruction('\u53ea\u6839\u636e\u4e0a\u4e00\u8f6e\u56de\u6267\u56de\u7b54\uff0c\u4e0d\u8981\u6267\u884c\u65b0\u64cd\u4f5c\u3002')).toBe(true);
  });

  it('does not treat external app chat surfaces as Lumi client navigation', () => {
    expect(hasClientActionOnlyIntent('\u6253\u5f00\u5fae\u4fe1\u770b\u770b\u6211\u548c\u963f\u9646\u6700\u8fd1\u7684\u804a\u5929\u5185\u5bb9')).toBe(false);
    expect(hasClientActionOnlyIntent('open Chrome and log in')).toBe(false);
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
