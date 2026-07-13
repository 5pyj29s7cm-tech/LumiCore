import { describe, expect, it } from 'vitest';
import {
  formatRegionalLegalPrompt,
  getRegionalCapabilityPack,
  inferRegion,
  listRegionalCapabilityPacks,
} from '../server/regions/registry';
import { buildUnifiedLegalEntryPrompt } from '../server/cognition/legal_entry';

describe('regional capability packs', () => {
  it('keeps the global core independent from China-only platforms', () => {
    const pack = getRegionalCapabilityPack({ region: 'global' });
    expect(pack.id).toBe('global');
    expect(pack.legal).toBeUndefined();
    expect(formatRegionalLegalPrompt(pack)).toBe('');
  });

  it('selects the China pack from locale, platform, or Chinese input', () => {
    expect(inferRegion({ locale: 'zh-CN' })).toBe('cn');
    expect(inferRegion({ source: 'feishu_bot' })).toBe('cn');
    expect(inferRegion({ text: '\u8bf7\u8d77\u8349\u8d77\u8bc9\u72b6' })).toBe('cn');
    expect(inferRegion({ text: 'Draft a contract under New York law' })).toBe('global');
  });

  it('injects China legal platform boundaries only for the China pack', () => {
    const chinaPrompt = buildUnifiedLegalEntryPrompt({
      text: '\u8bf7\u67e5\u627e\u7c7b\u6848',
      region: 'cn',
    });
    const globalPrompt = buildUnifiedLegalEntryPrompt({
      text: 'Please draft a legal complaint',
      region: 'global',
    });
    expect(chinaPrompt).toContain('China Judgments Online');
    expect(chinaPrompt).toContain("Supreme People's Court");
    expect(globalPrompt).not.toContain('China Judgments Online');
    expect(globalPrompt).not.toContain('Qichacha');
  });

  it('registers unique pack identifiers', () => {
    const ids = listRegionalCapabilityPacks().map(pack => pack.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['global', 'cn']));
  });
});
