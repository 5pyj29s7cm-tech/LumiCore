import { LUMI_OFFICIAL_DEFAULT_MODELS } from "../../../shared/model_provider_capabilities";

export type GenerationPreference = {
  provider: string;
  model: string;
  models: Record<string, string>;
};

export type GenerationPreferences = {
  image: GenerationPreference;
  imageEdit: GenerationPreference;
  video: GenerationPreference;
  imageToVideo: GenerationPreference;
};

export const DEFAULT_GENERATION_PREFERENCES: GenerationPreferences = {
  image: {
    provider: 'auto',
    model: '',
    models: { openai: 'gpt-image-1', qwen: 'wan2.2-t2i-plus', siliconflow: 'Kwai-Kolors/Kolors', relay: LUMI_OFFICIAL_DEFAULT_MODELS.image_generation },
  },
  imageEdit: {
    provider: 'relay',
    model: LUMI_OFFICIAL_DEFAULT_MODELS.image_edit,
    models: { relay: LUMI_OFFICIAL_DEFAULT_MODELS.image_edit },
  },
  video: {
    provider: 'qwen',
    model: 'wanx2.1-t2v-turbo',
    models: {
      qwen: 'wanx2.1-t2v-turbo',
      minimax: 'MiniMax-Hailuo-2.3',
      siliconflow: 'Wan-AI/Wan2.2-T2V-A14B',
      openai: 'sora-2',
      relay: LUMI_OFFICIAL_DEFAULT_MODELS.video_generation,
    },
  },
  imageToVideo: {
    provider: 'relay',
    model: LUMI_OFFICIAL_DEFAULT_MODELS.image_to_video,
    models: { relay: LUMI_OFFICIAL_DEFAULT_MODELS.image_to_video },
  },
};

export const GENERATION_MODEL_OPTIONS: Record<string, string[]> = {
  openai: ['gpt-image-1', 'gpt-image-1-mini', 'dall-e-3'],
  qwenImage: ['wan2.2-t2i-plus'],
  siliconflowImage: ['Kwai-Kolors/Kolors', 'stabilityai/stable-diffusion-3-5-large'],
  qwenVideo: ['wanx2.1-t2v-turbo', 'wanx2.1-t2v-plus'],
  minimaxVideo: ['MiniMax-Hailuo-2.3', 'MiniMax-Hailuo-02'],
  siliconflowVideo: ['Wan-AI/Wan2.2-T2V-A14B', 'Wan-AI/Wan2.1-T2V-14B-720P', 'Wan-AI/Wan2.1-T2V-14B-720P-Turbo'],
  openaiVideo: ['sora-2', 'sora-2-pro'],
  relayImage: [],
  relayImageEdit: [],
  relayVideo: [],
  relayImageToVideo: [],
};

export const IMAGE_GENERATION_PROVIDERS: Record<string, { label: string; models: string[] }> = {
  openai: { label: 'OpenAI', models: GENERATION_MODEL_OPTIONS.openai },
  qwen: { label: 'Qwen / DashScope', models: GENERATION_MODEL_OPTIONS.qwenImage },
  siliconflow: { label: 'SiliconFlow', models: GENERATION_MODEL_OPTIONS.siliconflowImage },
  relay: { label: 'Lumi Official API', models: GENERATION_MODEL_OPTIONS.relayImage },
};

export const VIDEO_GENERATION_PROVIDERS: Record<string, { label: string; models: string[] }> = {
  qwen: { label: 'Qwen / DashScope', models: GENERATION_MODEL_OPTIONS.qwenVideo },
  minimax: { label: 'MiniMax', models: GENERATION_MODEL_OPTIONS.minimaxVideo },
  siliconflow: { label: 'SiliconFlow', models: GENERATION_MODEL_OPTIONS.siliconflowVideo },
  openai: { label: 'OpenAI', models: GENERATION_MODEL_OPTIONS.openaiVideo },
  relay: { label: 'Lumi Official API', models: GENERATION_MODEL_OPTIONS.relayVideo },
};

export type WorldPreference = {
  provider: string;
  model: string;
  models: Record<string, string>;
};

export const WORLD_MODEL_OPTIONS: Record<string, string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini'],
  gemini: ['gemini-2.0-flash', 'gemini-1.5-pro'],
  ark: ['doubao-1-5-vision-pro-32k'],
  qwen: ['qwen-vl-max'],
  ollama: ['qwen2.5vl:7b', 'minicpm-v:8b', 'llama3.2-vision:11b'],
  lmstudio: ['qwen2.5-vl-7b-instruct', 'minicpm-v-4_5', 'internvl3_5-8b'],
  relay: [LUMI_OFFICIAL_DEFAULT_MODELS.world, 'aliyun/qwen3-vl-flash', 'aliyun/qwen3-vl-plus'],
};

export type EmbeddingModelSelection = {
  provider: string;
  model: string;
  fallbackProvider: string;
  fallbackModel: string;
};

export type RerankModelSelection = {
  enabled: boolean;
  provider: string;
  model: string;
  topN: number;
};

export type RetrievalModelPreferences = {
  embedding: EmbeddingModelSelection;
  rerank: RerankModelSelection;
};

export const DEFAULT_RETRIEVAL_MODEL_PREFERENCES: RetrievalModelPreferences = {
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
};

export const EMBEDDING_MODEL_PROVIDERS = ['openai', 'qwen', 'siliconflow', 'ollama', 'lmstudio', 'relay'];

export const RERANK_MODEL_PROVIDERS = ['siliconflow', 'relay'];

export const EMBEDDING_MODELS: Record<string, string[]> = {
  openai: ['text-embedding-3-small', 'text-embedding-3-large'],
  qwen: ['text-embedding-v4', 'text-embedding-v3'],
  siliconflow: ['Qwen/Qwen3-Embedding-8B', 'Qwen/Qwen3-Embedding-4B', 'Qwen/Qwen3-Embedding-0.6B'],
  ollama: ['nomic-embed-text', 'mxbai-embed-large'],
  lmstudio: ['text-embedding-nomic-embed-text-v1.5'],
  relay: [LUMI_OFFICIAL_DEFAULT_MODELS.embedding],
};

export const RERANK_MODELS: Record<string, string[]> = {
  siliconflow: ['Qwen/Qwen3-Reranker-8B', 'Qwen/Qwen3-Reranker-4B', 'Qwen/Qwen3-Reranker-0.6B'],
  relay: [LUMI_OFFICIAL_DEFAULT_MODELS.rerank],
};

export const REASONING_MODEL_OPTIONS: Record<string, string[]> = {
  deepseek: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
  qwen: ['qwen-plus', 'qwen-max', 'qwen-turbo'],
  gemini: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  anthropic: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5'],
  ark: ['doubao-seed-2-0-lite-260215', 'doubao-1-5-pro-32k', 'doubao-1-5-lite-32k'],
  xiaomi: ['mimo-v2.5-pro', 'mimo-v2.5', 'mimo-v2-pro'],
  kimi: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  glm: ['glm-5.1', 'glm-5-turbo', 'glm-4.7', 'glm-4-plus'],
  relay: [LUMI_OFFICIAL_DEFAULT_MODELS.reasoning],
  ollama: [],
  lmstudio: [],
  auto: [],
};
