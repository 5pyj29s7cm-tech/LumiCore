import { describe, expect, it } from 'vitest';
import { selectOfficialRoleModel, type LumiModelRole } from '../server/llm/model_configuration';
import { LUMI_OFFICIAL_DEFAULT_MODELS } from '../shared/model_provider_capabilities';
import { DEFAULT_VISION_MODELS } from '../server/llm/vision_preferences';
import { DEFAULT_WORLD_MODELS } from '../server/llm/world_preferences';
import { DEFAULT_IMAGE_EDIT_MODELS, DEFAULT_IMAGE_GENERATION_MODELS, DEFAULT_IMAGE_TO_VIDEO_MODELS, DEFAULT_VIDEO_GENERATION_MODELS } from '../server/llm/generation_preferences';
import { DEFAULT_EMBEDDING_MODELS, DEFAULT_RERANK_MODELS } from '../server/llm/retrieval_model_preferences';

const migrations: Array<[LumiModelRole, string]> = [
  ['vision', 'qwen2.5-vl-72b'], ['world', 'qwen2.5-vl-72b'],
  ['image_generation', 'qwen-image'], ['image_edit', 'qwen-image-edit-2509'],
  ['video_generation', 'Wan2.2-T2V-A14B'], ['image_to_video', 'Wan2.2-I2V-A14B'],
  ['embedding', 'bge-m3'], ['rerank', 'bge-reranker-v2-m3'],
];

describe('catalog-verified official model namespace migration', () => {
  it.each(migrations)('migrates %s only after its same-family replacement is catalogued', (role, family) => {
    const legacy = `huawei_maas/${family}`;
    const replacement = `aliyun/${family}`;
    expect(selectOfficialRoleModel(role, [replacement], legacy)).toEqual({
      model: replacement, selectionReason: 'catalog_namespace_migration',
    });
    expect(selectOfficialRoleModel(role, ['custom/different-family'], legacy)).toBeNull();
  });

  it.each(migrations)('preserves the still-live %s namespace', (role, family) => {
    const legacy = `huawei_maas/${family}`;
    expect(selectOfficialRoleModel(role, [legacy, `aliyun/${family}`], legacy)).toEqual({
      model: legacy, selectionReason: 'preserved_live_selection',
    });
  });

  it('preserves a live custom model and rejects a missing custom choice without rewriting it', () => {
    expect(selectOfficialRoleModel('world', ['custom/my-world-model', LUMI_OFFICIAL_DEFAULT_MODELS.world], 'custom/my-world-model'))
      .toEqual({ model: 'custom/my-world-model', selectionReason: 'preserved_live_selection' });
    expect(selectOfficialRoleModel('world', ['aliyun/private-world'], 'huawei_maas/private-world')).toBeNull();
  });

  it('does not migrate between text-to-video and image-to-video families', () => {
    expect(selectOfficialRoleModel('image_to_video', ['aliyun/Wan2.2-I2V-A14B'], 'huawei_maas/Wan2.2-T2V-A14B')).toBeNull();
  });

  it('distinguishes an explicitly saved default from an unselected default', () => {
    const defaultModel = LUMI_OFFICIAL_DEFAULT_MODELS.world;
    expect(selectOfficialRoleModel('world', ['custom/different-family'], defaultModel)).toBeNull();
    expect(selectOfficialRoleModel('world', ['custom/different-family'], defaultModel, { explicitSelection: false }))
      .toEqual({ model: 'custom/different-family', selectionReason: 'catalog_fallback' });
  });

  it('shares current catalog defaults across each backend role', () => {
    expect({
      vision: DEFAULT_VISION_MODELS.relay, world: DEFAULT_WORLD_MODELS.relay,
      image_generation: DEFAULT_IMAGE_GENERATION_MODELS.relay, image_edit: DEFAULT_IMAGE_EDIT_MODELS.relay,
      video_generation: DEFAULT_VIDEO_GENERATION_MODELS.relay, image_to_video: DEFAULT_IMAGE_TO_VIDEO_MODELS.relay,
      embedding: DEFAULT_EMBEDDING_MODELS.relay, rerank: DEFAULT_RERANK_MODELS.relay,
    }).toEqual(Object.fromEntries(['vision', 'world', 'image_generation', 'image_edit', 'video_generation', 'image_to_video', 'embedding', 'rerank']
      .map(role => [role, LUMI_OFFICIAL_DEFAULT_MODELS[role as LumiModelRole]])));
  });
});
