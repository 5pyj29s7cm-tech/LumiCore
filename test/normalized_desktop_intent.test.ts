import { describe, expect, it } from 'vitest';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';

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
    expect(normalizeActionIntent('打开聊天界面')).toMatchObject({
      kind: 'client_navigation',
      clientAction: 'open_chat',
    });
  });

  it('keeps inbound semantic roles ahead of action-shaped words', () => {
    expect(normalizeActionIntent('张勇给我发了什么')).toMatchObject({
      kind: 'messaging_read',
      sideEffectClass: 'none',
    });
  });
});
