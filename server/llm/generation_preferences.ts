import { readDB, writeDB } from '../../db_layer';
import { LUMI_OFFICIAL_DEFAULT_MODELS } from '../../shared/model_provider_capabilities';

export type ImageGenerationProvider = 'auto' | 'openai' | 'qwen' | 'siliconflow' | 'relay';
export type ImageEditProvider = 'relay';
export type VideoGenerationProvider = 'qwen' | 'minimax' | 'siliconflow' | 'openai' | 'relay';
export type ImageToVideoProvider = VideoGenerationProvider;

export interface GenerationModelSelection<TProvider extends string> {
  provider: TProvider;
  model: string;
  models: Record<string, string>;
}

export interface GenerationModelPrefs {
  image: GenerationModelSelection<ImageGenerationProvider>;
  imageEdit: GenerationModelSelection<ImageEditProvider>;
  video: GenerationModelSelection<VideoGenerationProvider>;
  imageToVideo: GenerationModelSelection<ImageToVideoProvider>;
}

export const DEFAULT_IMAGE_GENERATION_MODELS: Record<Exclude<ImageGenerationProvider, 'auto'>, string> = {
  openai: 'gpt-image-1',
  qwen: 'wan2.2-t2i-plus',
  siliconflow: 'Kwai-Kolors/Kolors',
  relay: LUMI_OFFICIAL_DEFAULT_MODELS.image_generation,
};

export const DEFAULT_IMAGE_EDIT_MODELS: Record<ImageEditProvider, string> = {
  relay: LUMI_OFFICIAL_DEFAULT_MODELS.image_edit,
};

export const DEFAULT_VIDEO_GENERATION_MODELS: Record<VideoGenerationProvider, string> = {
  qwen: 'wanx2.1-t2v-turbo',
  minimax: 'MiniMax-Hailuo-2.3',
  siliconflow: 'Wan-AI/Wan2.2-T2V-A14B',
  openai: 'sora-2',
  relay: LUMI_OFFICIAL_DEFAULT_MODELS.video_generation,
};

export const DEFAULT_IMAGE_TO_VIDEO_MODELS: Record<ImageToVideoProvider, string> = {
  // Existing direct providers keep their current video model unless the user
  // explicitly selects a provider-specific I2V model. The Lumi official route
  // has a dedicated, catalog-verifiable I2V default.
  qwen: DEFAULT_VIDEO_GENERATION_MODELS.qwen,
  minimax: DEFAULT_VIDEO_GENERATION_MODELS.minimax,
  siliconflow: 'Wan-AI/Wan2.2-I2V-A14B',
  openai: DEFAULT_VIDEO_GENERATION_MODELS.openai,
  relay: LUMI_OFFICIAL_DEFAULT_MODELS.image_to_video,
};

const IMAGE_PROVIDERS = new Set<ImageGenerationProvider>(['auto', 'openai', 'qwen', 'siliconflow', 'relay']);
const IMAGE_EDIT_PROVIDERS = new Set<ImageEditProvider>(['relay']);
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

  const imageEditModels = normalizeModels(raw?.imageEdit?.models);
  const imageEditProvider = IMAGE_EDIT_PROVIDERS.has(raw?.imageEdit?.provider)
    ? raw.imageEdit.provider as ImageEditProvider
    : 'relay';
  const imageEditModel = imageEditModels[imageEditProvider]
    || String(raw?.imageEdit?.model || '').trim()
    || DEFAULT_IMAGE_EDIT_MODELS[imageEditProvider];

  const videoModels = normalizeModels(raw?.video?.models);
  const videoProvider = VIDEO_PROVIDERS.has(raw?.video?.provider)
    ? raw.video.provider as VideoGenerationProvider
    : 'qwen';
  const videoModel = videoModels[videoProvider]
    || String(raw?.video?.model || '').trim()
    || DEFAULT_VIDEO_GENERATION_MODELS[videoProvider];

  const imageToVideoModels = normalizeModels(raw?.imageToVideo?.models);
  const imageToVideoProvider = VIDEO_PROVIDERS.has(raw?.imageToVideo?.provider)
    ? raw.imageToVideo.provider as ImageToVideoProvider
    : 'relay';
  const imageToVideoModel = imageToVideoModels[imageToVideoProvider]
    || String(raw?.imageToVideo?.model || '').trim()
    || DEFAULT_IMAGE_TO_VIDEO_MODELS[imageToVideoProvider];

  return {
    image: {
      provider: imageProvider,
      model: imageModel,
      models: {
        ...DEFAULT_IMAGE_GENERATION_MODELS,
        ...imageModels,
      },
    },
    imageEdit: {
      provider: imageEditProvider,
      model: imageEditModel,
      models: {
        ...DEFAULT_IMAGE_EDIT_MODELS,
        ...imageEditModels,
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
    imageToVideo: {
      provider: imageToVideoProvider,
      model: imageToVideoModel,
      models: {
        ...DEFAULT_IMAGE_TO_VIDEO_MODELS,
        ...imageToVideoModels,
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

export function isImageEditProvider(value: unknown): value is ImageEditProvider {
  return IMAGE_EDIT_PROVIDERS.has(value as ImageEditProvider);
}

export function isVideoGenerationProvider(value: unknown): value is VideoGenerationProvider {
  return VIDEO_PROVIDERS.has(value as VideoGenerationProvider);
}

export function isImageToVideoProvider(value: unknown): value is ImageToVideoProvider {
  return VIDEO_PROVIDERS.has(value as ImageToVideoProvider);
}
