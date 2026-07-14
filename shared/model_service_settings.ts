export type ModelServiceCategory =
  | 'reasoning'
  | 'world'
  | 'generation'
  | 'document'
  | 'retrieval'
  | 'voice'
  | 'safety';

export interface ModelServiceSettingsTarget {
  provider: string;
  category: ModelServiceCategory;
  settingsSection: string;
}

const SKILL_MODEL_SERVICE_TARGETS: Readonly<Record<string, ModelServiceSettingsTarget>> = {
  MINIMAX_API_KEY: {
    provider: 'MiniMax',
    category: 'generation',
    settingsSection: 'generation-models',
  },
  SILICONFLOW_API_KEY: {
    provider: 'SiliconFlow',
    category: 'generation',
    settingsSection: 'generation-models',
  },
};

export function getSkillModelServiceSettingsTarget(apiKeyEnv?: string): ModelServiceSettingsTarget | null {
  return SKILL_MODEL_SERVICE_TARGETS[String(apiKeyEnv || '').trim()] || null;
}
