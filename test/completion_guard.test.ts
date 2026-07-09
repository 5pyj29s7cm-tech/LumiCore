import { describe, expect, it } from 'vitest';
import { guardCompletionClaims } from '../server/work_product/completion_guard';

describe('completion guard desktop action handling', () => {
  it('does not replace an attempted desktop action with a file-reading guard', () => {
    const response = 'I will open WeChat from the desktop shortcut and check the process.';

    const result = guardCompletionClaims({
      task: 'open WeChat from the desktop shortcut',
      response,
      toolCalls: [
        {
          name: 'desktop_open',
          arguments: { target: 'WeChat' },
          result: '',
          error: 'Open command failed for: WeChat',
        },
      ],
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(response);
  });

  it('uses desktop wording when an open-completion claim is not verified', () => {
    const result = guardCompletionClaims({
      task: 'open WeChat from the desktop shortcut',
      response: 'Opened WeChat.',
      toolCalls: [
        {
          name: 'desktop_open',
          arguments: { target: 'WeChat' },
          result: '',
          error: 'Open command failed for: WeChat',
        },
      ],
    });

    expect(result.blocked).toBe(true);
    expect(result.text).toContain('desktop action');
    expect(result.text).not.toContain('file/location');
  });

  it('keeps Chinese desktop-action attempts out of the content-review fallback', () => {
    const response = '\u6211\u5148\u5c1d\u8bd5\u6253\u5f00\u5fae\u4fe1\uff0c\u5e76\u68c0\u67e5\u8fdb\u7a0b\u3002';

    const result = guardCompletionClaims({
      task: '\u684c\u9762\u4e0a\u5c31\u6709\u5fae\u4fe1\u7684\u5feb\u6377\u65b9\u5f0f',
      response,
      toolCalls: [
        {
          name: 'desktop_open',
          arguments: { target: '\u5fae\u4fe1' },
          result: '',
          error: 'Open command failed for: \u5fae\u4fe1',
        },
      ],
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(response);
  });
});
