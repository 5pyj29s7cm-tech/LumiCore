import { describe, expect, it } from 'vitest';
import { isQuickCommand, matchQuickCommand } from '../server/cognition/quick_commands';

describe('voice/chat deterministic fast paths', () => {
  it('answers microphone audibility checks without an LLM or tool', async () => {
    expect(isQuickCommand('能不能听见我说话？')).toBe(true);
    const result = await matchQuickCommand('能不能听见我说话？', 'test-user', { surface: 'voice' });
    expect(result).toMatchObject({
      matched: true,
      responseText: '能听见。你说。',
    });
    expect(result?.toolCall).toBeUndefined();
  });

  it('opens exactly the requested app and does not invent a substitute', async () => {
    const result = await matchQuickCommand('打开AutoCAD。', 'test-user', { surface: 'voice' });
    expect(result?.toolCall).toEqual({
      name: 'desktop_open',
      arguments: { target: 'AutoCAD' },
    });
    expect(result?.formatToolResult?.('Opened app AutoCAD')).toBe('已打开AutoCAD。');
  });

  it('does not treat a latency complaint as a quick app launch', async () => {
    const result = await matchQuickCommand('你怎么运行了这么久才回我？', 'test-user', { surface: 'voice' });
    expect(result).toBeNull();
  });
});
