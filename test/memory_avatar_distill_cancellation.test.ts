import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/llm/providers', () => ({ makeLLMCall: vi.fn() }));
vi.mock('../server/llm/user_preferences', () => ({ getScopedPreferredLLM: () => ({ provider: 'relay', model: 'synthetic' }) }));
import { makeLLMCall } from '../server/llm/providers';
import { distillPersona, parseChatLog } from '../server/memory_avatar/distiller';
const options = {
  chatLog: Array.from({ length: 12 }, (_, index) => `Target: synthetic message ${index}`).join('\n'),
  format: 'plain' as const, targetName: 'Target', userId: 'synthetic-owner',
};
afterEach(() => vi.clearAllMocks());
describe('avatar distillation request lifetime', () => {
  it('cancels all four parallel calls and never starts the later extraction stages', async () => {
    vi.mocked(makeLLMCall).mockImplementation((_messages, _tools, config) => new Promise((_resolve, reject) => {
      config.signal!.addEventListener('abort', () => reject(config.signal!.reason), { once: true });
    }));
    const controller = new AbortController();
    const pending = distillPersona({ ...options, signal: controller.signal }, { getDeepSeek: vi.fn(), getGemini: vi.fn() });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(makeLLMCall).toHaveBeenCalledTimes(4);
    expect(vi.mocked(makeLLMCall).mock.calls.every(call => call[2].signal === controller.signal)).toBe(true);
    controller.abort(); await rejected;
    expect(makeLLMCall).toHaveBeenCalledTimes(4);
  });
  it('rejects a cancelled request before reading model selection or starting any call', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(distillPersona({ ...options, signal: controller.signal }, { getDeepSeek: vi.fn(), getGemini: vi.fn() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(makeLLMCall).not.toHaveBeenCalled();
  });
});

describe('chat log import formats', () => {
  const header = '2026-10-01 09:02:03 Alice';
  const message = { speaker: 'Alice', content: 'Hello\nsecond line', timestamp: '2026-10-01 09:02:03' };
  it.each(['wechat', 'qq'] as const)('preserves multiline %s messages and skips empty headers', format => {
    expect(parseChatLog('ignored preamble\n' + header + '\nHello\n\nsecond line\n2026-10-01 10:00:00 Bob\n', format)).toEqual([message]);
    expect(parseChatLog(header.replace('09:', '9:') + '\nHello', format)).toEqual(format === 'qq' ? [{ ...message, content: 'Hello', timestamp: '2026-10-01 9:02:03' }] : []);
  });
  it.each(['[图片]', '[语音]'])('keeps the QQ %s marker inside the current message', marker => {
    const raw = header + '\nHello\n2026-10-01 10:00:00 Bob ' + marker + '\nsecond line';
    expect(parseChatLog(raw, 'qq')).toEqual([{ ...message, content: 'Hello\n2026-10-01 10:00:00 Bob ' + marker + '\nsecond line' }]);
    expect(parseChatLog(raw, 'wechat')).toEqual([{ ...message, content: 'Hello' }, { speaker: 'Bob ' + marker, content: 'second line', timestamp: '2026-10-01 10:00:00' }]);
  });
});
