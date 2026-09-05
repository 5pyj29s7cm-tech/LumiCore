import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMAGE_EDIT_MODELS,
  DEFAULT_IMAGE_GENERATION_MODELS,
  DEFAULT_IMAGE_TO_VIDEO_MODELS,
  DEFAULT_VIDEO_GENERATION_MODELS,
  normalizeGenerationModelPrefs,
} from '../server/llm/generation_preferences';
import { normalizeRetrievalModelPreferences } from '../server/llm/retrieval_model_preferences';
import {
  DEFAULT_WORLD_MODELS,
  normalizeWorldModelPrefs,
} from '../server/llm/world_preferences';

describe('specialized model role preferences', () => {
  it('provides usable image and video defaults', () => {
    const prefs = normalizeGenerationModelPrefs(null);

    expect(prefs.image.provider).toBe('auto');
    expect(prefs.image.models).toMatchObject(DEFAULT_IMAGE_GENERATION_MODELS);
    expect(prefs.imageEdit).toMatchObject({
      provider: 'relay',
      model: DEFAULT_IMAGE_EDIT_MODELS.relay,
    });
    expect(prefs.video).toMatchObject({
      provider: 'qwen',
      model: DEFAULT_VIDEO_GENERATION_MODELS.qwen,
    });
    expect(prefs.imageToVideo).toMatchObject({
      provider: 'relay',
      model: DEFAULT_IMAGE_TO_VIDEO_MODELS.relay,
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

  it('supports independent real video providers without losing their saved models', () => {
    const prefs = normalizeGenerationModelPrefs({
      image: { provider: 'auto' },
      video: {
        provider: 'minimax',
        models: {
          minimax: 'MiniMax-Hailuo-02',
          openai: 'sora-2-pro',
          siliconflow: 'Wan-AI/Wan2.1-T2V-14B-720P',
        },
      },
    });

    expect(prefs.video.provider).toBe('minimax');
    expect(prefs.video.model).toBe('MiniMax-Hailuo-02');
    expect(prefs.video.models.openai).toBe('sora-2-pro');
    expect(prefs.video.models.siliconflow).toBe('Wan-AI/Wan2.1-T2V-14B-720P');
  });

  it('does not migrate a legacy text-to-video selection into the image-to-video lane', () => {
    const prefs = normalizeGenerationModelPrefs({
      image: { provider: 'auto' },
      video: {
        provider: 'relay',
        model: 'huawei_maas/Wan2.2-T2V-A14B',
        models: { relay: 'huawei_maas/Wan2.2-T2V-A14B' },
      },
    });

    expect(prefs.video.model).toBe('huawei_maas/Wan2.2-T2V-A14B');
    expect(prefs.imageToVideo).toMatchObject({
      provider: 'relay',
      model: 'aliyun/Wan2.2-I2V-A14B',
    });
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

describe('retrieval model preferences', () => {
  it('uses working defaults when no preferences exist', () => {
    expect(normalizeRetrievalModelPreferences(null)).toEqual({
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        fallbackProvider: 'ollama',
        fallbackModel: 'nomic-embed-text',
      },
      rerank: {
        enabled: false,
        provider: 'siliconflow',
        model: 'Qwen/Qwen3-Reranker-8B',
        topN: 5,
      },
    });
  });

  it('migrates the legacy flat retrieval value and rejects invalid providers', () => {
    const prefs = normalizeRetrievalModelPreferences({
      retrieval: {
        provider: 'not-a-provider',
        model: '',
        fallbackProvider: '',
        fallbackModel: '',
      },
    });

    expect(prefs).toEqual({
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-small',
        fallbackProvider: '',
        fallbackModel: '',
      },
      rerank: {
        enabled: false,
        provider: 'siliconflow',
        model: 'Qwen/Qwen3-Reranker-8B',
        topN: 5,
      },
    });
  });

  it('normalizes independent embedding and rerank selections', () => {
    const prefs = normalizeRetrievalModelPreferences({
      embedding: {
        provider: 'siliconflow',
        model: 'Qwen/Qwen3-Embedding-4B',
        fallbackProvider: '',
      },
      rerank: {
        enabled: true,
        provider: 'siliconflow',
        model: 'Qwen/Qwen3-Reranker-4B',
        topN: 200,
      },
    });

    expect(prefs.embedding).toMatchObject({
      provider: 'siliconflow',
      model: 'Qwen/Qwen3-Embedding-4B',
      fallbackProvider: '',
    });
    expect(prefs.rerank).toEqual({
      enabled: true,
      provider: 'siliconflow',
      model: 'Qwen/Qwen3-Reranker-4B',
      topN: 50,
    });
  });
});
