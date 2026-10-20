import { evaluateCurrentLawGate } from '../server/regions/packs/cn/legal_tools/citations';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import './helpers';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Document, Packer, Paragraph } from 'docx';
import { initDatabase } from '../db_layer';
import { listStatuteVerificationCatalog, verifyCitation, type StatuteVerificationCatalogEntry } from '../server/legal/kb';
import { refreshAuthoritativeStatuteSources } from '../server/legal/statute_authority_refresh';
import { resetStatuteAuthorityRefreshStateForTest } from '../server/legal/statute_authority_store';

// Public NPC original downloaded on 2026-10-13. The test never installs this
// fixture in production or confirms a changed statutory version.
const original = fs.readFileSync(new URL('./fixtures/civil-procedure-interpretation-2022-official.docx', import.meta.url));
const wordPath = 'official/civil-procedure-2022.docx';
const downloadUrl = `https://flkoss.obs-bj2.cucloud.cn/${wordPath}?Signature=isolated-regression`;
const entry = () => listStatuteVerificationCatalog().find(item => item.key === '民事诉讼法解释')!;
function officialFetch(catalog: StatuteVerificationCatalogEntry, bytes = original) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/flfgDetails')) return Response.json({ code: 200, data: {
      bbbs: catalog.recordId, title: catalog.sourceTitle,
      gbrq: catalog.verification.versionDate, sxrq: catalog.verification.effectiveDate,
      sxx: 3, flxz: '司法解释', zdjgName: '最高人民法院', content: null,
      ossFile: { ossWordPath: wordPath }, lsyg: [],
    } });
    if (url.includes('/download/pc')) return Response.json({ code: 200, data: { url: downloadUrl } });
    if (url === downloadUrl) return new Response(new Uint8Array(bytes));
    throw new Error('Unexpected URL');
  }) as typeof fetch;
}
const probe = (catalog: StatuteVerificationCatalogEntry, bytes = original) => refreshAuthoritativeStatuteSources({
  catalog: [catalog], fetchImpl: officialFetch(catalog, bytes), persist: false, writeHistory: false, requestDelayMs: 0,
});

describe('Reviewed 2022 civil procedure interpretation metadata', () => {
  beforeAll(() => initDatabase());
  afterEach(() => { resetStatuteAuthorityRefreshStateForTest(); vi.restoreAllMocks(); });

  it('pins the same 2022 official record and dates while correcting its final article to 550', () => {
    const catalog = entry();
    expect(catalog.recordId).toBe('ff80818181cdceb30181d801c31c4070');
    expect(catalog.verification).toMatchObject({ versionDate: '2022-04-01', effectiveDate: '2022-04-10', articleMax: 550 });
    expect(crypto.createHash('sha256').update(original).digest('hex')).toBe('a8dcb7894aa019b5acd3c5f8341cde6118548cd61e6149025831265fb9917698');
  });

  it('rejects the actual complete 2022 original under the incorrect earlier-version bound of 552', async () => {
    const catalog = entry(); catalog.verification = { ...catalog.verification, articleMax: 552 };
    const result = await probe(catalog);
    expect(result.checks[0].originalText).toBeUndefined();
    expect(result.checks[0].originalTextError).toBeTruthy();
  });

  it('accepts all 550 articles from the actual public original under its correct bound', async () => {
    const result = await probe(entry());
    const check = result.checks[0];
    expect(check.status).toBe('verified');
    expect(check.originalTextError).toBeUndefined();
    expect(Object.keys(check.originalText!.provisions)).toHaveLength(550);
    expect(check.originalText!.provisions['550'].text).toContain('不再适用');
    expect(check.originalText!.provisions['551']).toBeUndefined();
    expect(check.originalText).toMatchObject({ recordId: 'ff80818181cdceb30181d801c31c4070', versionDate: '2022-04-01' });
  });

  it('still rejects a 2022 original missing its final article after correcting the bound', async () => {
    const mammoth = (await import('mammoth')).default;
    const parsed = await mammoth.extractRawText({ buffer: original });
    const text = parsed.value.slice(0, parsed.value.lastIndexOf('第五百五十条'));
    const missingTail = await Packer.toBuffer(new Document({ sections: [{
      children: text.split(/\n\s*\n/).map(paragraph => new Paragraph(paragraph)),
    }] }));
    const result = await probe(entry(), missingTail);
    expect(result.checks[0].originalText).toBeUndefined();
    expect(result.checks[0].originalTextError).toBeTruthy();
  });
  it('keeps an exact procedural original blocked without a sourced temporal review even when a procedure date is known', async () => {
    const catalog = entry();
    await refreshAuthoritativeStatuteSources({ catalog: [catalog], fetchImpl: officialFetch(catalog),
      persist: true, writeHistory: false, requestDelayMs: 0 });
    const citation = '《民诉法解释》第五百五十条';
    const procedureDate = '2026-10-19';
    const exact = verifyCitation(citation, undefined, { procedureDate });
    expect(exact.provisionVerified).toBe(true);
    expect(exact.temporalApplicabilityVerified).toBe(false);
    expect(exact.applicabilityStatus).toBe('procedural_review_required');
    expect(evaluateCurrentLawGate(citation).missingProcedureDate).toBe(true);
    const gate = evaluateCurrentLawGate(citation, undefined, [], undefined, { procedureDate });
    expect(gate.missingProcedureDate).toBe(false);
    expect(gate.passed).toBe(false);
  });

});
