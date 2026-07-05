import { describe, expect, it } from 'vitest';
import { resolveMarketplaceSkillDirName } from '../server/routes/marketplace_routes';

describe('marketplace skill install helpers', () => {
  it('uses the stable marketplace skill id before a localized display name', () => {
    expect(resolveMarketplaceSkillDirName({
      skillId: 'skill-admin-assistant',
      skillName: '行政助理包',
      installPath: 'D:\\lumiOS\\server\\skills\\bundled\\admin-assistant',
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
});
