import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import './helpers';
import fs from 'node:fs';
import { initDatabase } from '../db_layer';
import { listStatuteVerificationCatalog, verifyCitation, type StatuteVerificationCatalogEntry } from '../server/legal/kb';
import { refreshAuthoritativeStatuteSources } from '../server/legal/statute_authority_refresh';
import { resetStatuteAuthorityRefreshStateForTest } from '../server/legal/statute_authority_store';
import { extractReviewedStatuteHtml } from '../server/regions/packs/cn/statute_provisions';

// Complete public Supreme Court page, retrieved on 2026-10-13. The tested
// annex is the 2020 revision with 33 articles; no legacy DOC bytes are mined.
const officialHtml = fs.readFileSync(new URL('./fixtures/sale-contract-interpretation-2020-official.html', import.meta.url), 'utf8');
const entry = () => listStatuteVerificationCatalog().find(item => item.key === '买卖合同司法解释')!;
function officialFetch(catalog: StatuteVerificationCatalogEntry, html = officialHtml, overrides: Record<string, unknown> = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/flfgDetails')) return Response.json({ code: 200, data: {
      bbbs: catalog.recordId, title: catalog.sourceTitle,
      gbrq: catalog.verification.versionDate, sxrq: catalog.verification.effectiveDate,
      sxx: 3, flxz: '司法解释', zdjgName: '最高人民法院', content: null,
      ossFile: { ossWordPath: 'official/sale-contract.doc' }, lsyg: [], ...overrides,
    } });
    if (url === catalog.verification.originalHtml?.url) return new Response(html, { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
    throw new Error('Unexpected URL: the legacy Word download must not be attempted');
  });
}
async function probe(catalog: StatuteVerificationCatalogEntry, html = officialHtml, overrides: Record<string, unknown> = {}, persist = false) {
  const fetchImpl = officialFetch(catalog, html, overrides);
  const result = await refreshAuthoritativeStatuteSources({ catalog: [catalog], fetchImpl: fetchImpl as typeof fetch,
    persist, writeHistory: false, requestDelayMs: 0 });
  return { result, fetchImpl };
}
function replaceInFixture(from: string, to: string) {
  if (!officialHtml.includes(from)) throw new Error('Expected public fixture text is missing');
  return officialHtml.replace(from, to);
}

describe('Pinned official 2020 sale-contract HTML original', () => {
  beforeAll(() => initDatabase());
  afterEach(() => { resetStatuteAuthorityRefreshStateForTest(); vi.restoreAllMocks(); });

  it('checks unchanged NPC metadata then the fixed independent official annex, without an invalid DOCX attempt', async () => {
    const catalog = entry();
    const { result, fetchImpl } = await probe(catalog, officialHtml, {}, true);
    const check = result.checks[0];
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe('https://www.court.gov.cn/zixun/xiangqing/282621.html');
    expect(check.status).toBe('verified');
    expect(check.originalTextError).toBeUndefined();
    expect(Object.keys(check.originalText!.provisions)).toHaveLength(33);
    expect(check.originalText).toMatchObject({ recordId: catalog.recordId, versionDate: '2020-12-29',
      sourceUrl: catalog.verification.originalHtml!.url, sha256: catalog.verification.originalHtml!.bodySha256 });
    expect(check.originalText!.provisions['33'].text).toContain('不适用本解释');
    const citation = verifyCitation('《买卖合同司法解释》第33条', undefined, { factDate: '2026-09-01' });
    expect(citation).toMatchObject({ provisionVerified: true, sourceUrl: catalog.verification.originalHtml!.url });
  });

  it('ignores unrelated page chrome while keeping the reviewed statutory body SHA fixed', async () => {
    const { result } = await probe(entry(), officialHtml + '<footer>New page chrome</footer>');
    expect(result.checks[0].originalText?.sha256).toBe(entry().verification.originalHtml!.bodySha256);
  });

  it.each(['missing_tail', 'wrong_section', 'old_revision', 'body_changed'] as const)('refuses an incomplete or unreviewed annex: %s', async failure => {
    let html = officialHtml;
    if (failure === 'missing_tail') {
      const start = html.indexOf('　　第三十三条本解释施行前');
      const end = html.indexOf('　　最高人民法院<br', start);
      if (start < 0 || end < 0) throw new Error('Expected official final article boundary is missing');
      html = html.slice(0, start) + html.slice(end);
    }
    if (failure === 'wrong_section') html = replaceInFixture('　　关于审理买卖合同纠纷案件适用法律问题的解释<br', '　　其他司法解释正文<br');
    if (failure === 'old_revision') html = officialHtml.replaceAll('根据2020年12月23日最高人民法院', '根据2012年3月31日最高人民法院');
    if (failure === 'body_changed') html = replaceInFixture('对账确认函、债权确认书等函件、凭证没有记载债权人名称', '对账确认函、债权确认书等函件、凭证已经记载债权人名称');
    expect(() => extractReviewedStatuteHtml(html, entry().verification.originalHtml!)).toThrow();
    const { result } = await probe(entry(), html);
    expect(result.checks[0].originalText).toBeUndefined();
    expect(result.checks[0].originalTextError).toBeTruthy();
  });

  it.each([{ bbbs: 'unreviewed-record' }, { gbrq: '2012-05-10' }, { sxrq: '2012-07-01' }])(
    'keeps old or changed NPC metadata blocked before any HTML read (%j)', async overrides => {
      const { result, fetchImpl } = await probe(entry(), officialHtml, overrides);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.checks[0].status).toBe('changed');
      expect(result.checks[0].originalText).toBeUndefined();
    },
  );

  it('refuses an arbitrary source URL even when the supplied catalog points there', async () => {
    const catalog = entry();
    catalog.verification = { ...catalog.verification, originalHtml: { ...catalog.verification.originalHtml!, url: 'https://example.invalid/statute' } };
    const { result, fetchImpl } = await probe(catalog);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.checks[0].originalText).toBeUndefined();
    expect(result.checks[0].originalTextError).toBeTruthy();
  });
});
