import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  makeLLMCall: vi.fn(),
}));

vi.mock('../server/llm/providers', async () => {
  const actual = await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers');
  return {
    ...actual,
    makeLLMCall: mocks.makeLLMCall,
  };
});

import { runWithTools } from '../server/llm/adapter';
import { ToolRegistry } from '../server/tools/registry';

const getters = [
  () => null,
  () => null,
  () => null,
  () => null,
  () => null,
] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('desktop user-activity pause boundary', () => {
  it('stops the remaining batch and all replans after the first lease pause', async () => {
    const registry = new ToolRegistry();
    let pauseReason = '';
    const first = vi.fn(async () => {
      pauseReason = 'desktop_control_paused_for_user_activity';
      return JSON.stringify({ ok: false, status: 'paused' });
    });
    const second = vi.fn(async () => JSON.stringify({ ok: true, status: 'completed' }));
    for (const [name, handler] of [
      ['desktop_first_action', first],
      ['desktop_forbidden_after_pause', second],
    ] as const) {
      registry.register({
        name,
        description: `Desktop pause-boundary test tool ${name}`,
        parameters: { type: 'object', properties: {}, required: [] },
        permission: 'public',
        securityLevel: 'safe',
        handler,
      });
    }
    const desktopRelay = Object.assign(
      vi.fn(async () => ''),
      { getControlPauseReason: () => pauseReason || null },
    );
    mocks.makeLLMCall.mockResolvedValue({
      text: 'run both desktop actions',
      toolCalls: [
        { id: 'desktop-first', name: 'desktop_first_action', arguments: {} },
        { id: 'desktop-second', name: 'desktop_forbidden_after_pause', arguments: {} },
      ],
    });

    const result = await runWithTools(
      [{ role: 'user', content: '打开网站，然后继续操作桌面' }],
      registry,
      { provider: 'deepseek', model: 'test-model' },
      undefined,
      5,
      ...getters,
      undefined,
      { desktopRelay },
    );

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(mocks.makeLLMCall).toHaveBeenCalledTimes(1);
    expect(result.toolCalls.map(record => record.id)).toEqual(['desktop-first']);
    expect(result.text).toContain('先暂停了桌面操作');
    expect(result.text).toContain('说“继续”即可');
    expect(result.text).not.toMatch(/desktop_control_paused|tool loop|lease/i);
  });
});
