import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/llm/providers', () => ({ makeLLMCall: vi.fn() }));
vi.mock('../server/llm/user_preferences', () => ({ getScopedPreferredLLM: () => ({ provider: 'relay', model: 'synthetic' }) }));
import { makeLLMCall } from '../server/llm/providers';
import { distillPersona } from '../server/memory_avatar/distiller';
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
