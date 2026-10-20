import type { OfficialApiModelCatalog } from './official_api';
import { readSettingJson } from '../persistence/settings_repository';
import { writeModelPreference } from './model_preference_revision';
import { LUMI_OFFICIAL_DEFAULT_MODELS } from '../../shared/model_provider_capabilities';
import { cleanModelName, isSelectionProvider, normalizeModelSelection } from './model_selection';

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

export const GENERATION_MODEL_ROLES = {
  image_generation: { field: 'image', label: 'image', defaults: DEFAULT_IMAGE_GENERATION_MODELS, defaultProvider: 'auto', specialProvider: 'auto', specialModel: 'optional' },
  image_edit: { field: 'imageEdit', label: 'image edit', defaults: DEFAULT_IMAGE_EDIT_MODELS, defaultProvider: 'relay' },
  video_generation: { field: 'video', label: 'video', defaults: DEFAULT_VIDEO_GENERATION_MODELS, defaultProvider: 'qwen' },
  image_to_video: { field: 'imageToVideo', label: 'image-to-video', defaults: DEFAULT_IMAGE_TO_VIDEO_MODELS, defaultProvider: 'relay' },
} as const;
export type GenerationModelRole = keyof typeof GENERATION_MODEL_ROLES;

export function isGenerationModelRole(role: string): role is GenerationModelRole {
  return Object.hasOwn(GENERATION_MODEL_ROLES, role);
}

export function normalizeGenerationModelPrefs(raw: unknown): GenerationModelPrefs {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return Object.fromEntries(Object.values(GENERATION_MODEL_ROLES).map(definition => [
    definition.field,
    normalizeModelSelection(value[definition.field], { ...definition, includeDefaults: true }),
  ])) as unknown as GenerationModelPrefs;
}

export function updateUserGenerationModel(
  userId: string,
  role: GenerationModelRole,
  input: { provider?: string; model?: string },
): GenerationModelPrefs {
  const definition = GENERATION_MODEL_ROLES[role];
  const current = getUserPreferredGenerationModels(userId);
  const selection = current[definition.field];
  const provider = input.provider || selection.provider;
  if (!isSelectionProvider(provider, definition)) throw new Error(`Unsupported ${definition.label} provider: ${provider}`);
  const model = provider === 'auto' ? cleanModelName(input.model, 200)
    : cleanModelName(input.model, 200) || selection.models[provider] || definition.defaults[provider];
  return upsertUserPreferredGenerationModels(userId, {
    ...current,
    [definition.field]: {
      provider, model,
      models: provider === 'auto' ? selection.models : { ...selection.models, [provider]: model },
    },
  }, [definition.field]);
}

export function getUserPreferredGenerationModels(userId: string): GenerationModelPrefs {
  return normalizeGenerationModelPrefs(readSettingJson(`generation_prefs_${userId || 'anonymous'}`));
}

export function upsertUserPreferredGenerationModels(
  userId: string,
  input: unknown,
  savedRoles: readonly (keyof GenerationModelPrefs)[] = ['image', 'imageEdit', 'video', 'imageToVideo'],
): GenerationModelPrefs {
  const previous = getUserPreferredGenerationModels(userId);
  const prefs = normalizeGenerationModelPrefs(input);
  const key = `generation_prefs_${userId || 'anonymous'}`;
  const payload = { ...prefs, updatedAt: new Date().toISOString() };
  const changedRoles = (Object.keys(prefs) as (keyof GenerationModelPrefs)[])
    .filter(role => JSON.stringify(prefs[role]) !== JSON.stringify(previous[role]));
  writeModelPreference(key, payload, [...new Set([...savedRoles, ...changedRoles])]);
  return prefs;
}

export function isImageGenerationProvider(value: unknown): value is ImageGenerationProvider {
  return isSelectionProvider(value, GENERATION_MODEL_ROLES.image_generation);
}

export function isImageEditProvider(value: unknown): value is ImageEditProvider {
  return isSelectionProvider(value, GENERATION_MODEL_ROLES.image_edit);
}

export function isVideoGenerationProvider(value: unknown): value is VideoGenerationProvider {
  return isSelectionProvider(value, GENERATION_MODEL_ROLES.video_generation);
}

export function isImageToVideoProvider(value: unknown): value is ImageToVideoProvider {
  return isSelectionProvider(value, GENERATION_MODEL_ROLES.image_to_video);
}

/** A selected official model must be advertised for this exact generation role. */
export function assertOfficialGenerationModel(catalog: OfficialApiModelCatalog, role: GenerationModelRole, model: string): void {
  const available = catalog.byRole[role] || [];
  if (!available.includes(model)) {
    throw new Error(`The selected official model ${model} is unavailable for ${role}. Available models: ${available.join(', ') || 'none'}. No generation was submitted or model preference changed.`);
  }
}

export function validateOfficialGenerationPreferences(input: unknown, catalog: OfficialApiModelCatalog): GenerationModelPrefs {
  const prefs = normalizeGenerationModelPrefs(input);
  const provided = input && typeof input === 'object' ? input : {};
  for (const [role, definition] of Object.entries(GENERATION_MODEL_ROLES)) {
    if (!Object.hasOwn(provided, definition.field)) continue;
    const selection = prefs[definition.field];
    if (selection.provider === 'relay') assertOfficialGenerationModel(catalog, role as GenerationModelRole, selection.model);
  }
  return prefs;
}
