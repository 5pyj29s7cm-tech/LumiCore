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

  it('does not treat a negative no-mutation statement as an open claim', () => {
    const response = [
      '\u672c\u8f6e\u684c\u9762\u72b6\u6001\u8bfb\u53d6\u5df2\u5b8c\u6210\u3002',
      '\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\uff1aLumi OS\uff08lumi-os.exe\uff0cPID 3928\uff09\u3002',
      '\u672c\u8f6e\u6ca1\u6709\u6267\u884c\u70b9\u51fb\u3001\u8f93\u5165\u3001\u5207\u6362\u7a97\u53e3\u3001\u6253\u5f00\u5e94\u7528\u6216\u4fee\u6539\u5185\u5bb9\u3002',
    ].join('\n');

    const result = guardCompletionClaims({
      task: '\u53ea\u8bfb\u53d6\u5f53\u524d\u6d3b\u52a8\u7a97\u53e3\u548c\u684c\u9762\u8fd0\u884c\u72b6\u6001',
      response,
      toolCalls: [{
        name: 'desktop_active_window',
        arguments: {},
        result: '{"title":"Lumi OS","process_name":"lumi-os.exe","pid":3928}',
      }],
    });

    expect(result.blocked).toBe(false);
    expect(result.text).toBe(response);
  });
});
