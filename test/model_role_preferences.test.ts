import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGE_GENERATION_MODELS,
  DEFAULT_VIDEO_GENERATION_MODELS,
  normalizeGenerationModelPrefs,
} from '../server/llm/generation_preferences';
import {
  DEFAULT_WORLD_MODELS,
  normalizeWorldModelPrefs,
} from '../server/llm/world_preferences';

describe('specialized model role preferences', () => {
  it('provides usable image and video defaults', () => {
    const prefs = normalizeGenerationModelPrefs(null);

    expect(prefs.image.provider).toBe('auto');
    expect(prefs.image.models).toMatchObject(DEFAULT_IMAGE_GENERATION_MODELS);
    expect(prefs.video).toMatchObject({
      provider: 'qwen',
      model: DEFAULT_VIDEO_GENERATION_MODELS.qwen,
    });
  });

  it('keeps each provider model while selecting the active generation model', () => {
    const prefs = normalizeGenerationModelPrefs({
      image: {
        provider: 'openai',
        model: 'unused-direct-model',
        models: {
          openai: '  gpt-image-custom  ',
          qwen: 'wan-image-custom',
        },
      },
      video: {
        provider: 'qwen',
        models: { qwen: '  wan-video-custom  ' },
      },
    });

    expect(prefs.image.model).toBe('gpt-image-custom');
    expect(prefs.image.models.qwen).toBe('wan-image-custom');
    expect(prefs.video.model).toBe('wan-video-custom');
  });

  it('supports SiliconFlow as a real image generation role', () => {
    const prefs = normalizeGenerationModelPrefs({
      image: {
        provider: 'siliconflow',
        models: { siliconflow: 'stabilityai/stable-diffusion-3-5-large' },
      },
      video: { provider: 'qwen' },
    });

    expect(prefs.image.provider).toBe('siliconflow');
    expect(prefs.image.model).toBe('stabilityai/stable-diffusion-3-5-large');
  });

  it('defaults the World Model to Vision inheritance', () => {
    const prefs = normalizeWorldModelPrefs(null);

    expect(prefs.provider).toBe('inherit_vision');
    expect(prefs.model).toBe('');
    expect(prefs.models).toMatchObject(DEFAULT_WORLD_MODELS);
  });

  it('selects an independent World Model without discarding other provider models', () => {
    const prefs = normalizeWorldModelPrefs({
      provider: 'qwen',
      model: 'unused-direct-model',
      models: {
        qwen: '  qwen-vl-world-custom  ',
        openai: 'gpt-world-custom',
      },
    });

    expect(prefs.provider).toBe('qwen');
    expect(prefs.model).toBe('qwen-vl-world-custom');
    expect(prefs.models.openai).toBe('gpt-world-custom');
  });
});
