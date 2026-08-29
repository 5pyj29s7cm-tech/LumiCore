import { readDB, writeDB } from '../../db_layer';

export type ImageGenerationProvider = 'auto' | 'openai' | 'qwen' | 'siliconflow' | 'relay';
export type VideoGenerationProvider = 'qwen' | 'minimax' | 'siliconflow' | 'openai' | 'relay';

export interface GenerationModelSelection<TProvider extends string> {
  provider: TProvider;
  model: string;
  models: Record<string, string>;
}

export interface GenerationModelPrefs {
  image: GenerationModelSelection<ImageGenerationProvider>;
  video: GenerationModelSelection<VideoGenerationProvider>;
}

export const DEFAULT_IMAGE_GENERATION_MODELS: Record<Exclude<ImageGenerationProvider, 'auto'>, string> = {
  openai: 'gpt-image-1',
  qwen: 'wan2.2-t2i-plus',
  siliconflow: 'Kwai-Kolors/Kolors',
  relay: 'huawei_maas/qwen-image',
};

export const DEFAULT_VIDEO_GENERATION_MODELS: Record<VideoGenerationProvider, string> = {
  qwen: 'wanx2.1-t2v-turbo',
  minimax: 'MiniMax-Hailuo-2.3',
  siliconflow: 'Wan-AI/Wan2.2-T2V-A14B',
  openai: 'sora-2',
  relay: 'huawei_maas/Wan2.2-T2V-A14B',
};

const IMAGE_PROVIDERS = new Set<ImageGenerationProvider>(['auto', 'openai', 'qwen', 'siliconflow', 'relay']);
const VIDEO_PROVIDERS = new Set<VideoGenerationProvider>(['qwen', 'minimax', 'siliconflow', 'openai', 'relay']);

function parseSetting(userId: string): any {
  try {
    const db = readDB();
    const row = (db.settings || []).find((item: any) => item.key === `generation_prefs_${userId}`);
    return row?.value ? JSON.parse(row.value) : null;
  } catch {
    return null;
  }
}

function normalizeModels(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, model]) => typeof model === 'string' && model.trim())
    .map(([provider, model]) => [provider, String(model).trim()]));
}

export function normalizeGenerationModelPrefs(raw: any): GenerationModelPrefs {
  const imageModels = normalizeModels(raw?.image?.models);
  const imageProvider = IMAGE_PROVIDERS.has(raw?.image?.provider)
    ? raw.image.provider as ImageGenerationProvider
    : 'auto';
  const imageModel = imageProvider === 'auto'
    ? String(raw?.image?.model || '').trim()
    : imageModels[imageProvider] || String(raw?.image?.model || '').trim() || DEFAULT_IMAGE_GENERATION_MODELS[imageProvider];

  const videoModels = normalizeModels(raw?.video?.models);
  const videoProvider = VIDEO_PROVIDERS.has(raw?.video?.provider)
    ? raw.video.provider as VideoGenerationProvider
    : 'qwen';
  const videoModel = videoModels[videoProvider]
    || String(raw?.video?.model || '').trim()
    || DEFAULT_VIDEO_GENERATION_MODELS[videoProvider];

  return {
    image: {
      provider: imageProvider,
      model: imageModel,
      models: {
        ...DEFAULT_IMAGE_GENERATION_MODELS,
        ...imageModels,
      },
    },
    video: {
      provider: videoProvider,
      model: videoModel,
      models: {
        ...DEFAULT_VIDEO_GENERATION_MODELS,
        ...videoModels,
      },
    },
  };
}

export function getUserPreferredGenerationModels(userId: string): GenerationModelPrefs {
  return normalizeGenerationModelPrefs(parseSetting(userId || 'anonymous'));
}

export function upsertUserPreferredGenerationModels(userId: string, input: unknown): GenerationModelPrefs {
  const prefs = normalizeGenerationModelPrefs(input);
  const db = readDB();
  const key = `generation_prefs_${userId || 'anonymous'}`;
  const payload = { ...prefs, updatedAt: new Date().toISOString() };
  if (!db.settings) (db as any).settings = [];
  const index = (db.settings || []).findIndex((item: any) => item.key === key);
  if (index >= 0) {
    (db.settings as any[])[index].value = JSON.stringify(payload);
  } else {
    db.settings.push({ key, value: JSON.stringify(payload) });
  }
  writeDB(db);
  return prefs;
}

export function isImageGenerationProvider(value: unknown): value is ImageGenerationProvider {
  return IMAGE_PROVIDERS.has(value as ImageGenerationProvider);
}

export function isVideoGenerationProvider(value: unknown): value is VideoGenerationProvider {
  return VIDEO_PROVIDERS.has(value as VideoGenerationProvider);
}
