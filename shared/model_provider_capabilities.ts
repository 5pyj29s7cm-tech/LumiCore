/**
 * The provider capability contract shared by the settings UI and the server.
 *
 * `relay` is the persisted id for Lumi's official API gateway. Keep the id
 * stable across preferences, while exposing the role contract in one place so
 * a selector cannot drift away from the runtime adapters.
 */

export const LUMI_OFFICIAL_PROVIDER_ID = 'relay' as const;

/**
 * The documented Lumi/ModelDepot endpoint.  Keep this as a UI default only:
 * credentials are still entered and stored on the server, never in the
 * browser bundle or local storage.
 */
export const LUMI_OFFICIAL_BASE_URL = 'https://zhuan.huaczy.com/v1' as const;

/** Public API documentation and account pages shown in Settings. */
export const LUMI_OFFICIAL_DOCS_URL = 'https://zhuan.huaczy.com/console/help' as const;
export const LUMI_OFFICIAL_RECHARGE_URL = 'https://zhuan.huaczy.com/console/recharge' as const;

export const LUMI_MODEL_ROLE_IDS = [
  'reasoning',
  'vision',
  'world',
  'image_generation',
  'image_edit',
  'video_generation',
  'image_to_video',
  'embedding',
  'rerank',
  'speech_recognition',
  'speech_synthesis',
] as const;

export type LumiModelRoleId = typeof LUMI_MODEL_ROLE_IDS[number];

/** Safe model-id defaults used when a user has not chosen a role-specific id. */
export const LUMI_OFFICIAL_DEFAULT_MODELS: Readonly<Record<LumiModelRoleId, string>> = {
  reasoning: 'aliyun/qwen-plus',
  vision: 'aliyun/qwen2.5-vl-72b',
  world: 'aliyun/qwen3-vl-flash',
  image_generation: 'aliyun/qwen-image',
  image_edit: 'aliyun/qwen-image-edit-2509',
  video_generation: 'aliyun/Wan2.2-T2V-A14B',
  image_to_video: 'aliyun/Wan2.2-I2V-A14B',
  embedding: 'aliyun/bge-m3',
  rerank: 'aliyun/bge-reranker-v2-m3',
  speech_recognition: 'aliyun/qwen-audio-3.0-asr-flash-streaming',
  speech_synthesis: 'aliyun/cosyvoice-v3-flash',
};

/**
 * Model ids emitted by older builds as generic provider placeholders. They
 * are not ModelDepot ids and would be rejected by the official gateway. Keep
 * the migration role-aware so a custom, documented upstream id is preserved.
 */
const LEGACY_OFFICIAL_MODEL_IDS: Readonly<Record<LumiModelRoleId, ReadonlySet<string>>> = {
  reasoning: new Set(['openai-compatible', 'openai_compatible', 'default', 'gpt-4o', 'gpt-4o-mini']),
  vision: new Set(['openai-compatible', 'openai_compatible', 'default', 'qwen2.5-vl-7b-instruct']),
  world: new Set(['openai-compatible', 'openai_compatible', 'default']),
  image_generation: new Set(['openai-compatible', 'openai_compatible', 'default', 'gpt-image-1']),
  image_edit: new Set(['openai-compatible', 'openai_compatible', 'default']),
  video_generation: new Set(['openai-compatible', 'openai_compatible', 'default', 'sora-2']),
  image_to_video: new Set(['openai-compatible', 'openai_compatible', 'default']),
  embedding: new Set(['openai-compatible', 'openai_compatible', 'default', 'text-embedding-3-small']),
  rerank: new Set(['openai-compatible', 'openai_compatible', 'default', 'rerank-v1']),
  speech_recognition: new Set(['openai-compatible', 'openai_compatible', 'default', 'whisper-1']),
  speech_synthesis: new Set(['openai-compatible', 'openai_compatible', 'default', 'tts-1']),
};

export function normalizeLumiOfficialModel(role: LumiModelRoleId, value: unknown): string {
  const candidate = typeof value === 'string' ? value.trim().slice(0, 200) : '';
  return candidate && !LEGACY_OFFICIAL_MODEL_IDS[role].has(candidate)
    ? candidate
    : LUMI_OFFICIAL_DEFAULT_MODELS[role];
}

/**
 * These flags describe adapters that are present in this build, not whether
 * the user's endpoint/key is configured or healthy. Configuration and health
 * are reported separately by `/api/llm/providers`.
 *
 * The Lumi official API is the product-owned capability source. It exposes a
 * role-neutral contract for every model lane used by Lumi; the concrete model
 * id is selected independently for each role. Keeping every role here avoids
 * the old failure mode where the UI claimed a provider was official while a
 * runtime branch silently rejected it.
 */
export const LUMI_OFFICIAL_ROLE_CAPABILITIES: Readonly<Record<LumiModelRoleId, boolean>> = {
  reasoning: true,
  vision: true,
  world: true,
  image_generation: true,
  image_edit: true,
  video_generation: true,
  image_to_video: true,
  embedding: true,
  rerank: true,
  speech_recognition: true,
  speech_synthesis: true,
};

export const LUMI_OFFICIAL_SUPPORTED_ROLES = LUMI_MODEL_ROLE_IDS.filter(
  role => LUMI_OFFICIAL_ROLE_CAPABILITIES[role],
);

export const LUMI_OFFICIAL_UNSUPPORTED_ROLES = LUMI_MODEL_ROLE_IDS.filter(
  role => !LUMI_OFFICIAL_ROLE_CAPABILITIES[role],
);

export function isLumiOfficialRoleSupported(role: string): boolean {
  return LUMI_OFFICIAL_ROLE_CAPABILITIES[role as LumiModelRoleId] === true;
}
