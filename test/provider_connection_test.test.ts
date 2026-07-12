import { describe, expect, it, vi } from 'vitest';
import { testLLMProviderConnection, testVisionProviderConnection } from '../server/routes/system_routes';

describe('provider live connection test', () => {
  it('performs a real minimal chat-completions call through the configured client', async () => {
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: 'OK' } }] });
    const result = await testLLMProviderConnection('lmstudio', 'local-chat-model', {
      getLmStudio: () => ({ chat: { completions: { create } } }),
    });

    expect(result.ok).toBe(true);
    expect(result.provider).toBe('lmstudio');
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toMatchObject({ model: 'local-chat-model', max_tokens: 8 });
  });

  it('rejects configured-looking providers that have no runtime client', async () => {
    await expect(testLLMProviderConnection('openai', 'gpt-4o-mini', {}))
      .rejects.toThrow('not configured');
  });

  it('performs a real multimodal request for vision validation', async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: 'OK' } }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    });
    const result = await testVisionProviderConnection('openai', 'gpt-4o-mini', {
      getOpenAI: () => ({ chat: { completions: { create } } }),
    });

    expect(result.ok).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    const request = create.mock.calls[0][0];
    expect(request.model).toBe('gpt-4o-mini');
    expect(request.messages[1].content[1].type).toBe('image_url');
  });
});
