import { describe, expect, it } from 'vitest';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';
import {
  buildDeterministicClientNavigationCommand,
  buildDeterministicLocalDesktopNavigationCommand,
} from '../server/cognition/quick_commands';

describe('normalized desktop intent priority', () => {
  it('recognizes a concrete local application target', () => {
    expect(normalizeActionIntent('帮我打开记事本')).toMatchObject({
      kind: 'desktop_operation',
      operation: 'navigate',
      target: '记事本',
      sideEffectClass: 'none',
    });
  });

  it('keeps Lumi client navigation ahead of generic desktop control', () => {
    const intent = normalizeActionIntent('打开聊天界面');
    expect(intent).toMatchObject({
      kind: 'client_navigation',
      clientAction: 'open_chat',
    });
    const deterministic = buildDeterministicClientNavigationCommand(intent);
    expect(deterministic?.formatToolResult?.(JSON.stringify({
      ok: true,
      verification: { status: 'verified' },
    }))).toBe('已打开聊天界面。');
  });

  it('derives native navigation from the registered client surface map', () => {
    expect(normalizeActionIntent('open personalization')).toMatchObject({
      kind: 'client_navigation',
      target: 'personalization',
      clientAction: 'open_personalization',
    });
    expect(normalizeActionIntent('personalization 状态怎么样')).toMatchObject({
      kind: 'status_query',
      target: 'personalization',
    });
  });

  it('keeps inbound semantic roles ahead of action-shaped words', () => {
    expect(normalizeActionIntent('张勇给我发了什么')).toMatchObject({
      kind: 'messaging_read',
      sideEffectClass: 'none',
    });
  });

  it('keeps external AI history in its own read-only lane', () => {
    expect(normalizeActionIntent('读取 ChatGPT 里的聊天历史并同步新增消息')).toMatchObject({
      kind: 'external_ai_history',
      operation: 'read',
      target: 'ChatGPT',
      sideEffectClass: 'none',
      rule: 'external-ai-history-read',
    });
    expect(normalizeActionIntent('Lumi 可以读取外部 AI 里的聊天内容吗？')).toMatchObject({
      kind: 'external_ai_history',
      operation: 'read',
      target: 'external_ai',
      sideEffectClass: 'none',
    });
  });

  it('does not turn a fresh external AI prompt into history access', () => {
    expect(normalizeActionIntent('问问 ChatGPT 并让它回答聊天历史应该怎么迁移')).not.toMatchObject({
      kind: 'external_ai_history',
    });
  });

  it('executes only normalized local navigation through the exact desktop-open tool', () => {
    expect(buildDeterministicLocalDesktopNavigationCommand({
      kind: 'desktop_operation',
      operation: 'navigate',
      subject: 'user',
      target: 'Notepad',
      payload: '',
      sideEffectClass: 'none',
      relation: 'new',
      confidence: 0.9,
      rule: 'test',
    })?.toolCall).toEqual({ name: 'desktop_open', arguments: { target: 'Notepad' } });

    expect(buildDeterministicLocalDesktopNavigationCommand({
      kind: 'desktop_operation',
      operation: 'mutate',
      subject: 'user',
      target: 'Notepad',
      payload: '',
      sideEffectClass: 'none',
      relation: 'new',
      confidence: 0.9,
      rule: 'test',
    })).toBeNull();
  });

  it('keeps retrospective open questions in the zero-tool status lane', () => {
    expect(normalizeActionIntent('\u521a\u624d\u6253\u5f00\u4e86\u4ec0\u4e48\uff1f\u53ea\u6839\u636e\u4e0a\u4e00\u8f6e\u56de\u6267\u56de\u7b54\uff0c\u4e0d\u8981\u6267\u884c\u65b0\u64cd\u4f5c\u3002')).toMatchObject({
      kind: 'status_query',
      operation: 'status',
      target: 'previous_action',
      sideEffectClass: 'none',
      relation: 'status',
    });
  });
});
