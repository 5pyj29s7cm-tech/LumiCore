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

  it('accepts a Company Law article inside its independently sourced current snapshot', () => {
    const check = verifyCitation('《公司法》第五十条');
    expect(check.exists).toBe(true);
    expect(check.isEffective).toBe(true);
    expect(check.source).toContain('国家法律法规数据库');
    expect(check.source).toContain('2023-12-29');
    expect(check.verificationStatus).toBe('verified');
  });

  it.each([
    ['《民事诉讼法》第三百零六条', 306],
    ['《刑事诉讼法》第三百零八条', 308],
    ['《行政诉讼法》第一百零三条', 103],
    ['《劳动合同法》第九十八条', 98],
    ['《劳动法》第一百零七条', 107],
    ['《商标法》第七十三条', 73],
    ['《专利法》第八十二条', 82],
    ['《反不正当竞争法》第四十一条', 41],
    ['《消费者权益保护法》第六十三条', 63],
    ['《企业破产法》第一百三十六条', 136],
  ])('verifies the final article in a sourced current-law snapshot: %s', (citation, articleMax) => {
    const check = verifyCitation(citation);
    expect(check.exists).toBe(true);
    expect(check.isEffective).toBe(true);
    expect(check.detail).toContain(`第${articleMax}条`);
    expect(check.sourceUrl).toMatch(/^https:\/\//);
    expect(check.reviewAfter).toBe('2026-10-10');
  });

  it('fails closed after an authoritative snapshot reaches its review deadline', () => {
    const check = verifyCitation('《公司法》第五十条', undefined, { asOf: '2026-10-11' });
    expect(check.exists).toBe(true);
    expect(check.isEffective).toBeNull();
    expect(check.verificationStatus).toBe('expired');
    expect(check.detail).toContain('必须重新访问权威来源');
  });

  it('applies book-specific Civil Code article ranges to common citation aliases', () => {
    const valid = verifyCitation('《民法典合同编》第五百八十五条');
    const outsideBook = verifyCitation('《民法典合同编》第一百八十八条');
    expect(valid.isEffective).toBe(true);
    expect(valid.verificationStatus).toBe('verified');
    expect(outsideBook.exists).toBe(false);
    expect(outsideBook.detail).toContain('463-988条');
  });

  it('still blocks effective laws whose article text has no authoritative snapshot', () => {
    const check = verifyCitation('《证券法》第五十条');
    expect(check.exists).toBe(false);
    expect(check.isEffective).toBeNull();
    expect(check.verificationStatus).toBe('missing');
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
