import { describe, expect, it } from 'vitest';
import { buildDeterministicLocalDesktopNavigationCommand } from '../server/cognition/quick_commands';
import { normalizeActionIntent } from '../server/cognition/normalized_action_intent';

describe('bounded desktop navigation builders', () => {
  it('opens exactly the requested app and does not invent a substitute', () => {
    const text = '打开AutoCAD。';
    const result = buildDeterministicLocalDesktopNavigationCommand(normalizeActionIntent(text), text);
    expect(result?.toolCall).toEqual({ name: 'desktop_open', arguments: { target: 'AutoCAD' } });
    expect(result?.formatToolResult?.('Opened app AutoCAD')).toBe('已打开AutoCAD。');
  });
  it.each(['你怎么运行了这么久才回我？', '能不能听见我说话？'])('does not turn a question into an app launch: %s', text => {
    expect(buildDeterministicLocalDesktopNavigationCommand(normalizeActionIntent(text), text)).toBeNull();
  });
});
