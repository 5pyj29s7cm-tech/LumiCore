import { describe, expect, it } from 'vitest';
import './helpers';
import { verifyCitation, verifyMultipleCitations } from '../server/legal/kb';

describe('Authoritative legal citation verification', () => {
  it('accepts a Civil Code article inside the sourced official snapshot range', () => {
    const check = verifyCitation('《民法典》第五百八十五条');
    expect(check.exists).toBe(true);
    expect(check.isEffective).toBe(true);
    expect(check.source).toContain('国家法律法规数据库');
    expect(check.source).toContain('2026-07-12');
  });

  it('rejects an impossible article instead of validating only the law title', () => {
    const check = verifyCitation('《民法典》第999999条');
    expect(check.exists).toBe(false);
    expect(check.isEffective).toBeNull();
    expect(check.detail).toContain('超出已核验条文范围');
  });

  it('does not mark an unsourced effective-law article as current and verified', () => {
    const check = verifyCitation('《公司法》第五十条');
    expect(check.exists).toBe(false);
    expect(check.isEffective).toBeNull();
    expect(check.source).not.toContain('国家法律法规数据库');
  });

  it('preserves the article reference during batch verification', () => {
    const checks = verifyMultipleCitations('依据《民法典》第五百八十五条处理。');
    expect(checks).toHaveLength(1);
    expect(checks[0].citation).toBe('《民法典》第五百八十五条');
    expect(checks[0].isEffective).toBe(true);
  });

  it('continues to block repealed statutes', () => {
    const check = verifyCitation('《合同法》第六十条');
    expect(check.exists).toBe(true);
    expect(check.isEffective).toBe(false);
  });
});
