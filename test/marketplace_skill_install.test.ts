import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resolveMarketplaceSkillDirName } from '../server/routes/marketplace_routes';

describe('marketplace skill install helpers', () => {
  it('uses the stable marketplace skill id before a localized display name', () => {
    expect(resolveMarketplaceSkillDirName({
      skillId: 'skill-admin-assistant',
      skillName: '行政助理包',
      installPath: 'D:\\LumiCore\\server\\skills\\bundled\\admin-assistant',
    })).toBe('admin-assistant');
  });

  it('normalizes marketplace skill ids with spaces and casing', () => {
    expect(resolveMarketplaceSkillDirName({
      skillId: 'Skill-CAD Drafting',
      skillName: 'CAD Drafting Pack',
    })).toBe('cad-drafting');
  });

  it('falls back to install path when a skill id is missing', () => {
    expect(resolveMarketplaceSkillDirName({
      skillName: '行政助理包',
      installPath: '/opt/lumi/server/skills/bundled/admin-assistant',
    })).toBe('admin-assistant');
  });

  it('avoids dash-only directory names for fully localized labels', () => {
    expect(resolveMarketplaceSkillDirName({ skillName: '行政助理包' })).toBe('skill');
  });

  it('keeps key-required bundled skills clear about setup requirements', () => {
    const bundledRoot = path.join(process.cwd(), 'server', 'skills', 'bundled');
    for (const dirName of ['code-sandbox', 'minimax', 'nanobanana']) {
      const pkg = JSON.parse(fs.readFileSync(path.join(bundledRoot, dirName, 'package.json'), 'utf8'));
      expect(pkg.lumi.requiresApiKey).toBe(true);
      expect(pkg.lumi.apiKeyEnv).toMatch(/_API_KEY$/);
      expect(pkg.lumi.apiKeyUrl).toMatch(/^https:\/\//);
      expect(pkg.lumi.setupNote).toContain(pkg.lumi.apiKeyEnv);
    }
  });
});
