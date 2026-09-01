import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  getSkillModelServiceSettingsTarget,
  getSkillSettingsTarget,
} from '../shared/model_service_settings';

describe('skill model-service settings classification', () => {
  it('routes model services to their model settings category', () => {
    expect(getSkillModelServiceSettingsTarget('MINIMAX_API_KEY')).toMatchObject({
      provider: 'MiniMax',
      category: 'generation',
      settingsSection: 'ai-providers',
    });
    expect(getSkillModelServiceSettingsTarget('SILICONFLOW_API_KEY')).toMatchObject({
      provider: 'SiliconFlow',
      category: 'generation',
      settingsSection: 'ai-providers',
    });
  });

  it('does not classify data sources or tool runtimes as model services', () => {
    expect(getSkillModelServiceSettingsTarget('QICHACHA_API_KEY')).toBeNull();
    expect(getSkillModelServiceSettingsTarget('PKULAW_API_KEY')).toBeNull();
    expect(getSkillModelServiceSettingsTarget('E2B_API_KEY')).toBeNull();
  });

  it('routes every skill credential to one canonical settings owner', () => {
    expect(getSkillSettingsTarget('MINIMAX_API_KEY')).toMatchObject({
      category: 'model_provider',
      settingsSection: 'ai-providers',
    });
    expect(getSkillSettingsTarget('QICHACHA_API_KEY')).toMatchObject({
      category: 'data_source',
      settingsSection: 'data-sources',
    });
    expect(getSkillSettingsTarget('E2B_API_KEY')).toMatchObject({
      category: 'tool_runtime',
      settingsSection: 'tools',
    });
    expect(getSkillSettingsTarget('GITHUB_TOKEN')).toMatchObject({
      category: 'application_connection',
      settingsSection: 'applications',
    });
  });

  it('groups data-source fields by provider instead of rendering duplicate provider rows', () => {
    const settings = fs.readFileSync(path.join(process.cwd(), 'src/components/Settings.tsx'), 'utf8');
    expect(settings).toContain('CHINA_LEGAL_DATA_SOURCES.map(source =>');
    expect(settings).toContain('copy.dataSources[source.id]');
    expect(settings).not.toContain('label="Qichacha App Key"');
    expect(settings).not.toContain('label="Qichacha Secret Key"');
    expect(settings).not.toContain('label="PKULaw API Key"');
    expect(settings).not.toContain('label="PKULaw Token"');
  });

  it('keeps MCP lifecycle management in Skill Hall and diagnostics in Tool Runtimes', () => {
    const runtimeSettings = fs.readFileSync(path.join(process.cwd(), 'src/components/MCPSettings.tsx'), 'utf8');
    const skillHall = fs.readFileSync(path.join(process.cwd(), 'src/components/SkillCenter.tsx'), 'utf8');
    expect(runtimeSettings).toContain("detail: { action: 'open_skills' }");
    expect(runtimeSettings).toContain("apiFetch(`/api/mcp/restart/${name}`");
    expect(runtimeSettings).not.toContain("await fetch(`/api/mcp/restart/${name}`");
    expect(runtimeSettings).not.toContain('/api/mcp/github/search');
    expect(runtimeSettings).not.toContain('toggleServer');
    expect(skillHall).toContain('<GitHubMCPBrowser t={t} embedded />');
  });
});
