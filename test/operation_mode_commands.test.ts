import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(async () => {
  const { initDatabase } = await import('../db_layer');
  await initDatabase();
});

describe('shared Lumi operation mode commands', () => {
  it('recognizes natural mode requests without treating ordinary conversation as a switch', async () => {
    const {
      detectRequestedOperationMode,
      isPureOperationModeSwitchRequest,
    } = await import('../server/cognition/operation_modes');

    const pureChat = '\u7eaf\u804a\u5929';
    const autonomy = '\u5207\u6362\u5230\u81ea\u4e3b\u6a21\u5f0f';
    const assistant = '\u8bf7\u8fdb\u5165\u52a9\u624b\u6a21\u5f0f\u5427';
    const assistantAlias = '\u5207\u6362\u5230\u52a9\u7406\u6a21\u5f0f';

    expect(detectRequestedOperationMode(pureChat)).toBe('chat');
    expect(detectRequestedOperationMode(autonomy)).toBe('autonomous');
    expect(detectRequestedOperationMode(assistant)).toBe('assistant');
    expect(detectRequestedOperationMode(assistantAlias)).toBe('assistant');
    expect(detectRequestedOperationMode('\u5f00\u59cb\u81ea\u4e3b\u6267\u884c')).toBe('autonomous');
    expect(detectRequestedOperationMode('switch to meeting mode')).toBe('meeting');
    expect(detectRequestedOperationMode('\u6211\u60f3\u804a\u804a\u6700\u8fd1\u7684\u5de5\u4f5c')).toBeNull();
    expect(isPureOperationModeSwitchRequest(autonomy)).toBe(true);
    expect(isPureOperationModeSwitchRequest(assistant)).toBe(true);
    expect(isPureOperationModeSwitchRequest(assistantAlias)).toBe(true);
    expect(isPureOperationModeSwitchRequest('\u5f00\u59cb\u81ea\u4e3b\u6267\u884c')).toBe(true);
  });

  it('routes mode requests as deterministic Lumi client actions', async () => {
    const { hasClientActionIntent, hasClientActionOnlyIntent } = await import('../server/cognition/tool_intent');
    const request = '\u5207\u6362\u5230\u81ea\u4e3b\u6a21\u5f0f';

    expect(hasClientActionIntent(request)).toBe(true);
    expect(hasClientActionOnlyIntent(request)).toBe(true);
  });

  it('allows only safe client-state tools for an explicit page inspection request', async () => {
    const { traceToolIntentDecision } = await import('../server/cognition/tool_intent');
    const trace = traceToolIntentDecision('为我介绍一下客户端里的每一个页面是干什么用的。', 'voice', 'autonomous');

    expect(trace.allowToolUse).toBe(true);
    expect(trace.signals.clientActionIntent).toBe(true);
    expect(trace.signals.clientActionOnlyIntent).toBe(true);
    expect(trace.matchedRules.some(rule => rule.layer === 'client_action_only')).toBe(true);
  });

  it('keeps ordinary Chat pure and promotes explicit work to Assistant', async () => {
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    const ordinary = buildLumiTurnFlow({
      userId: 'operation_mode_chat_user',
      text: '\u6211\u4eca\u5929\u6709\u70b9\u7d2f\uff0c\u966a\u6211\u804a\u804a',
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
    });
    const messagingAction = buildLumiTurnFlow({
      userId: 'operation_mode_chat_user',
      text: '\u6253\u5f00\u5fae\u4fe1\u95ee\u95ee\u8054\u7cfb\u4eba\u5728\u5e72\u561b',
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
    });
    const desktopAction = buildLumiTurnFlow({
      userId: 'operation_mode_chat_user',
      text: '\u4f60\u7528\u7535\u8111\u64cd\u4f5c',
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
    });

    expect(ordinary.effectiveOperationMode).toBe('chat');
    expect(ordinary.allowToolUseForTurn).toBe(false);
    for (const action of [messagingAction, desktopAction]) {
      expect(action.autoPromoteToAssistant).toBe(true);
      expect(action.effectiveOperationMode).toBe('assistant');
      expect(action.allowToolUseForTurn).toBe(true);
      expect(action.clientActionOnlyTurn).toBe(false);
    }
  });

  it('makes a requested Autonomy switch executable without exposing unrelated work tools', async () => {
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    const flow = buildLumiTurnFlow({
      userId: 'operation_mode_switch_user',
      text: '\u5207\u6362\u5230\u81ea\u4e3b\u6a21\u5f0f',
      channel: 'chat',
      source: 'chat',
      operationMode: 'chat',
    });

    expect(flow.requestedMode).toBe('autonomous');
    expect(flow.effectiveOperationMode).toBe('autonomous');
    expect(flow.clientActionOnlyTurn).toBe(true);
    expect(flow.allowToolUseForTurn).toBe(true);
  });

  it('keeps a compound mode switch and external task in one executable turn', async () => {
    const { buildLumiTurnFlow } = await import('../server/cognition/turn_flow');
    const { hasClientActionOnlyIntent } = await import('../server/cognition/tool_intent');
    const { routeToolsForTurn } = await import('../server/cognition/tool_router');
    const text = '\u5148\u5207\u5230\u52a9\u624b\u6a21\u5f0f\uff0c\u7136\u540e\u6253\u5f00\u7f51\u6613\u4e91\u97f3\u4e50';
    const flow = buildLumiTurnFlow({
      userId: 'compound-mode-task-user',
      text,
      channel: 'voice',
      source: 'voice',
      operationMode: 'chat',
    });
    const declarations = ['client_get_state', 'client_action', 'desktop_list_apps', 'desktop_open', 'desktop_active_window']
      .map(name => ({ type: 'function' as const, function: { name, description: name, parameters: { type: 'object', properties: {} } } }));
    const route = routeToolsForTurn(text, declarations);

    expect(hasClientActionOnlyIntent(text)).toBe(false);
    expect(flow.clientActionOnlyTurn).toBe(false);
    expect(flow.allowToolUseForTurn).toBe(true);
    expect(route.toolNames).toEqual(expect.arrayContaining(['client_action', 'desktop_open']));
  });
});
