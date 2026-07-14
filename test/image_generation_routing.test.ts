import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { saveKeys } from '../server/config/keys';
import { upsertUserPreferredGenerationModels } from '../server/llm/generation_preferences';
import { registerImageTools } from '../server/tools/definitions/image_tools';
import { ToolRegistry } from '../server/tools/registry';

describe('image generation model routing', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    saveKeys({ SILICONFLOW_API_KEY: '' });
  });

  it('uses the explicitly selected SiliconFlow model without provider fallback', async () => {
    saveKeys({ SILICONFLOW_API_KEY: 'siliconflow-test-key' });
    upsertUserPreferredGenerationModels('image-routing-user', {
      image: {
        provider: 'siliconflow',
        models: { siliconflow: 'stabilityai/stable-diffusion-3-5-large' },
      },
      video: { provider: 'qwen' },
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ url: 'https://example.test/generated.png' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const registry = new ToolRegistry();
    registerImageTools(registry);
    const raw = await registry.execute(
      'generate_image',
      { prompt: 'A precise architectural massing study', size: '1024x1024' },
      { userId: 'image-routing-user' },
    );
    const result = JSON.parse(raw);

    expect(result).toMatchObject({
      success: true,
      provider: 'siliconflow',
      model: 'stabilityai/stable-diffusion-3-5-large',
      images: ['https://example.test/generated.png'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.siliconflow.cn/v1/images/generations');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: 'stabilityai/stable-diffusion-3-5-large',
      prompt: 'A precise architectural massing study',
      size: '1024x1024',
    });
  });
});
