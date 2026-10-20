import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import './helpers';
import { Document, Packer, Paragraph } from 'docx';
import { initDatabase } from '../db_layer';
import { listStatuteVerificationCatalog, type StatuteVerificationCatalogEntry } from '../server/legal/kb';
import { refreshAuthoritativeStatuteSources } from '../server/legal/statute_authority_refresh';
import { loadStatuteAuthorityRefreshState, resetStatuteAuthorityRefreshStateForTest } from '../server/legal/statute_authority_store';
import { civilCodeText } from './fixtures/legal_authority_fixture';

// Isolated regression data: repack the existing official-text fixture. These
// mocked responses never install an authority record in production state.
const wordPath = 'official/civil-code.docx';
const downloadUrl = `https://flkoss.obs-bj2.cucloud.cn/${wordPath}?Signature=isolated-regression`;
let fullDocument: Buffer;
let missingTailDocument: Buffer;

function catalogEntry(): StatuteVerificationCatalogEntry {
  return listStatuteVerificationCatalog().find(entry => entry.key === '民法典')!;
}

function officialFetch(
  entry: StatuteVerificationCatalogEntry,
  document: Buffer,
  content: unknown = null,
  overrides: Record<string, unknown> = {},
) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/flfgDetails')) return Response.json({ code: 200, data: {
      bbbs: entry.recordId, title: entry.sourceTitle,
      gbrq: entry.verification.versionDate, sxrq: entry.verification.effectiveDate,
      sxx: 3, flxz: '法律', zdjgName: '全国人民代表大会',
      content, ossFile: { ossWordPath: wordPath }, lsyg: [], ...overrides,
    } });
    if (url.includes('/download/pc')) return Response.json({ code: 200, data: { url: downloadUrl } });
    if (url === downloadUrl) return new Response(new Uint8Array(document));
    throw new Error('Unexpected URL');
  });
}

async function probe(entry: StatuteVerificationCatalogEntry, fetchImpl: ReturnType<typeof officialFetch>) {
  return refreshAuthoritativeStatuteSources({
    catalog: [entry], fetchImpl: fetchImpl as typeof fetch,
    persist: false, writeHistory: false, requestDelayMs: 0,
  });
}

describe('Official original text with an absent outline', () => {
  beforeAll(async () => {
    await initDatabase();
    const pack = (text: string) => Packer.toBuffer(new Document({ sections: [{
      children: text.split(/\n\s*\n/).map(paragraph => new Paragraph(paragraph)),
    }] }));
    fullDocument = await pack(civilCodeText());
    missingTailDocument = await pack(civilCodeText().slice(0, civilCodeText().lastIndexOf('第一千二百六十条')));
  });

  afterEach(() => {
    resetStatuteAuthorityRefreshStateForTest();
    vi.restoreAllMocks();
  });

  it.each([null, { children: [{ title: '正文' }] }])(
    'uses the reviewed catalog bound when the outline has no article number (%j)', async content => {
      const entry = catalogEntry();
      const before = JSON.stringify(loadStatuteAuthorityRefreshState());
      const fetchImpl = officialFetch(entry, fullDocument, content);
      const result = await probe(entry, fetchImpl);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(result.checks[0]).toMatchObject({ status: 'verified', expectedArticleMax: 1260, observed: { articleMax: null } });
      expect(result.checks[0].originalTextError).toBeUndefined();
      expect(Object.keys(result.checks[0].originalText!.provisions)).toHaveLength(1260);
      expect(result.checks[0].originalText!.provisions['1260'].text).toContain('同时废止');
      expect(result.checks[0].originalText).toMatchObject({ recordId: entry.recordId, versionDate: entry.verification.versionDate });
      expect(JSON.stringify(result)).not.toContain('isolated-regression');
      expect(JSON.stringify(loadStatuteAuthorityRefreshState())).toBe(before);
    },
  );

  it('refuses an original missing the final article', async () => {
    const entry = catalogEntry();
    const result = await probe(entry, officialFetch(entry, missingTailDocument));
    expect(result.checks[0].originalText).toBeUndefined();
    expect(result.checks[0].originalTextError).toBeTruthy();
  });

  it('refuses a complete document whose final article differs from the reviewed bound', async () => {
    const entry = catalogEntry();
    entry.verification = { ...entry.verification, articleMax: 1261 };
    const result = await probe(entry, officialFetch(entry, fullDocument));
    expect(result.checks[0].originalText).toBeUndefined();
    expect(result.checks[0].originalTextError).toBeTruthy();
  });

  it('keeps the original unavailable when neither the outline nor catalog has a reviewed bound', async () => {
    const entry = catalogEntry();
    entry.verification = { ...entry.verification, articleMax: undefined };
    const fetchImpl = officialFetch(entry, fullDocument);
    const result = await probe(entry, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.checks[0].originalText).toBeUndefined();
    expect(result.checks[0].originalTextError).toBeTruthy();
  });

  it('still rejects an explicit official outline bound that disagrees with the catalog', async () => {
    const entry = catalogEntry();
    const fetchImpl = officialFetch(entry, fullDocument, { children: [{ title: '第一千二百六十一条' }] });
    const result = await probe(entry, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.checks[0].status).toBe('changed');
    expect(result.checks[0].originalText).toBeUndefined();
  });

  it.each([{ bbbs: 'unreviewed-record' }, { gbrq: '2026-10-13' }, { title: '非目录标题' }])(
    'keeps record, version and title checks before the fallback (%j)', async overrides => {
      const entry = catalogEntry();
      const fetchImpl = officialFetch(entry, fullDocument, null, overrides);
      const result = await probe(entry, fetchImpl);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.checks[0].status).not.toBe('verified');
      expect(result.checks[0].originalText).toBeUndefined();
    },
  );
});
