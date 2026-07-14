export type ModelServiceCategory =
  | 'reasoning'
  | 'world'
  | 'generation'
  | 'retrieval'
  | 'voice';

export interface ModelServiceSettingsTarget {
  provider: string;
  category: ModelServiceCategory;
  settingsSection: string;
}

export type SkillSettingsCategory = 'model_provider' | 'data_source' | 'application_connection' | 'tool_runtime';

export interface SkillSettingsTarget {
  label: string;
  category: SkillSettingsCategory;
  settingsSection: 'ai-providers' | 'data-sources' | 'applications' | 'tools';
}

const SKILL_MODEL_SERVICE_TARGETS: Readonly<Record<string, ModelServiceSettingsTarget>> = {
  MINIMAX_API_KEY: {
    provider: 'MiniMax',
    category: 'generation',
    settingsSection: 'ai-providers',
  },
  SILICONFLOW_API_KEY: {
    provider: 'SiliconFlow',
    category: 'generation',
    settingsSection: 'ai-providers',
  },
};

const DATA_SOURCE_KEY_PREFIXES = ['QICHACHA_', 'TIANYANCHA_', 'PKULAW_', 'FARUI_'];

const SKILL_CONNECTION_LABELS: Readonly<Record<string, string>> = {
  E2B_API_KEY: 'E2B Code Sandbox',
  GITHUB_TOKEN: 'GitHub',
  NOTION_API_KEY: 'Notion',
  FIGMA_ACCESS_TOKEN: 'Figma',
};

const APPLICATION_CONNECTION_KEYS = new Set(['GITHUB_TOKEN', 'NOTION_API_KEY', 'FIGMA_ACCESS_TOKEN']);

function humanizeKeyName(apiKeyEnv: string): string {
  return apiKeyEnv
    .replace(/_(?:API_KEY|ACCESS_KEY|TOKEN|SECRET|CLIENT_ID|CLIENT_SECRET|BASE_URL|WEBHOOK_URL)$/i, '')
    .split('_')
    .filter(Boolean)
    .map(part => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ');
}

export function getSkillModelServiceSettingsTarget(apiKeyEnv?: string): ModelServiceSettingsTarget | null {
  return SKILL_MODEL_SERVICE_TARGETS[String(apiKeyEnv || '').trim()] || null;
}

export function getSkillSettingsTarget(apiKeyEnv?: string): SkillSettingsTarget | null {
  const keyName = String(apiKeyEnv || '').trim();
  if (!keyName) return null;

  const modelTarget = getSkillModelServiceSettingsTarget(keyName);
  if (modelTarget) {
    return {
      label: modelTarget.provider,
      category: 'model_provider',
      settingsSection: 'ai-providers',
    };
  }

  if (DATA_SOURCE_KEY_PREFIXES.some(prefix => keyName.startsWith(prefix))) {
    return {
      label: humanizeKeyName(keyName),
      category: 'data_source',
      settingsSection: 'data-sources',
    };
  }

  if (APPLICATION_CONNECTION_KEYS.has(keyName)) {
    return {
      label: SKILL_CONNECTION_LABELS[keyName] || humanizeKeyName(keyName),
      category: 'application_connection',
      settingsSection: 'applications',
    };
  }

  return {
    label: SKILL_CONNECTION_LABELS[keyName] || humanizeKeyName(keyName),
    category: 'tool_runtime',
    settingsSection: 'tools',
  };
}
