import { describe, expect, it } from 'vitest';
import {
  getRegionalCapabilityPack,
  inferRegion,
  listRegionalCapabilityPacks,
} from '../server/regions/registry';

describe('regional capability packs', () => {
  it('keeps the global core independent from China-only platforms', () => {
    const pack = getRegionalCapabilityPack({ region: 'global' });
    expect(pack.id).toBe('global');
    expect(pack.legal).toBeUndefined();
  });

  it('selects the China pack from locale, platform, or Chinese input', () => {
    expect(inferRegion({ locale: 'zh-CN' })).toBe('cn');
    expect(inferRegion({ source: 'feishu_bot' })).toBe('cn');
    expect(inferRegion({ text: '\u8bf7\u8d77\u8349\u8d77\u8bc9\u72b6' })).toBe('cn');
    expect(inferRegion({ text: 'Draft a contract under New York law' })).toBe('global');
  });

 it('registers unique pack identifiers', () => {
    const ids = listRegionalCapabilityPacks().map(pack => pack.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['global', 'cn']));
  });
});
