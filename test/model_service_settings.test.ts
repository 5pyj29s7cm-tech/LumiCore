import { describe, expect, it } from 'vitest';
import { getSkillModelServiceSettingsTarget } from '../shared/model_service_settings';

describe('skill model-service settings classification', () => {
  it('routes model services to their model settings category', () => {
    expect(getSkillModelServiceSettingsTarget('MINIMAX_API_KEY')).toMatchObject({
      provider: 'MiniMax',
      category: 'generation',
      settingsSection: 'generation-models',
    });
    expect(getSkillModelServiceSettingsTarget('SILICONFLOW_API_KEY')).toMatchObject({
      provider: 'SiliconFlow',
      category: 'generation',
      settingsSection: 'generation-models',
    });
  });

  it('does not classify data sources or tool runtimes as model services', () => {
    expect(getSkillModelServiceSettingsTarget('QICHACHA_API_KEY')).toBeNull();
    expect(getSkillModelServiceSettingsTarget('PKULAW_API_KEY')).toBeNull();
    expect(getSkillModelServiceSettingsTarget('E2B_API_KEY')).toBeNull();
  });
});
