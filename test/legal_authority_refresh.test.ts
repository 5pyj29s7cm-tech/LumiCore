import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import './helpers';
import { initDatabase } from '../db_layer';
import {
  listStatuteVerificationCatalog,
  verifyCitation,
  type StatuteVerificationCatalogEntry,
} from '../server/legal/kb';
import {
  extractOfficialArticleMax,
  refreshAuthoritativeStatuteSources,
} from '../server/legal/statute_authority_refresh';
import {
  loadStatuteAuthorityRefreshState,
  resetStatuteAuthorityRefreshStateForTest,
} from '../server/legal/statute_authority_store';

function companyLawCatalogEntry(): StatuteVerificationCatalogEntry {
  const entry = listStatuteVerificationCatalog().find(item => item.key === '公司法');
  if (!entry) throw new Error('Company Law verification catalog entry is missing');
  return entry;
}

function officialDetail(entry: StatuteVerificationCatalogEntry, overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    code: 200,
    data: {
      bbbs: entry.recordId,
      title: entry.sourceTitle,
      gbrq: entry.verification.versionDate,
      sxrq: entry.verification.effectiveDate,
      sxx: 3,
      flxz: '法律',
      zdjgName: '全国人民代表大会常务委员会',
      content: { children: [{ title: '第二百六十六条' }] },
      ossFile: { ossWordPath: 'official/company-law.docx' },
      lsyg: [],
      ...overrides,
    },
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Authoritative statute source refresh', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  afterEach(() => {
    resetStatuteAuthorityRefreshStateForTest();
    vi.restoreAllMocks();
  });

  it('keeps every formal verification catalog entry pinned to an official record ID', () => {
    const catalog = listStatuteVerificationCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(20);
    expect(catalog.every(entry => Boolean(entry.recordId))).toBe(true);
  });

  it('verifies official metadata and extends the delivery review deadline', async () => {
    const entry = companyLawCatalogEntry();
    const fetchImpl = vi.fn(async () => officialDetail(entry)) as unknown as typeof fetch;
    const result = await refreshAuthoritativeStatuteSources({
      catalog: [entry],
      fetchImpl,
      now: new Date('2026-10-01T01:00:00.000Z'),
      requestDelayMs: 0,
      writeHistory: false,
    });

    expect(result.verified).toBe(1);
    expect(result.pendingReview).toHaveLength(0);
    expect(loadStatuteAuthorityRefreshState().checks[entry.sourceTitle].reviewAfter).toBe('2026-12-30');

    const citation = verifyCitation('《公司法》第五十条', undefined, { asOf: '2026-11-01' });
    expect(citation.isEffective).toBe(true);
    expect(citation.verificationStatus).toBe('verified');
    expect(citation.reviewAfter).toBe('2026-12-30');
  });

  it('puts changed official records into review and immediately blocks formal delivery', async () => {
    const entry = companyLawCatalogEntry();
    const fetchImpl = vi.fn(async () => officialDetail(entry, {
      bbbs: 'new-official-record',
      gbrq: '2026-09-01',
      sxrq: '2026-10-01',
      content: { children: [{ title: '第二百七十条' }] },
    })) as unknown as typeof fetch;
    const result = await refreshAuthoritativeStatuteSources({
      catalog: [entry],
      fetchImpl,
      now: new Date('2026-10-01T01:00:00.000Z'),
      requestDelayMs: 0,
      writeHistory: false,
    });

    expect(result.changed).toBe(1);
    expect(result.newPendingReview).toBe(1);
    expect(result.pendingReview[0].reasons.join('；')).toContain('官方记录');

    const citation = verifyCitation('《公司法》第五十条');
    expect(citation.isEffective).toBeNull();
    expect(citation.verificationStatus).toBe('changed');
    expect(citation.detail).toContain('人工复核队列');
  });

  it('preserves a still-current successful snapshot during an outage, then fails closed at expiry', async () => {
    const entry = companyLawCatalogEntry();
    await refreshAuthoritativeStatuteSources({
      catalog: [entry],
      fetchImpl: vi.fn(async () => officialDetail(entry)) as unknown as typeof fetch,
      now: new Date('2026-10-01T01:00:00.000Z'),
      requestDelayMs: 0,
      writeHistory: false,
    });
    const unavailable = await refreshAuthoritativeStatuteSources({
      catalog: [entry],
      fetchImpl: vi.fn(async () => { throw new Error('network unavailable'); }) as unknown as typeof fetch,
      now: new Date('2026-10-02T01:00:00.000Z'),
      requestDelayMs: 0,
      writeHistory: false,
    });

    expect(unavailable.unavailable).toBe(1);
    expect(unavailable.checks[0].reviewAfter).toBe('2026-12-30');

    const withinDeadline = verifyCitation('《公司法》第五十条', undefined, { asOf: '2026-11-01' });
    expect(withinDeadline.isEffective).toBe(true);
    expect(withinDeadline.authorityRefreshStatus).toBe('unavailable');

    const expired = verifyCitation('《公司法》第五十条', undefined, { asOf: '2026-12-31' });
    expect(expired.isEffective).toBeNull();
    expect(expired.verificationStatus).toBe('expired');
  });

  it('settles the official WAF session challenge once without following a redirect loop', async () => {
    const entry = companyLawCatalogEntry();
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return new Response('', {
          status: 307,
          headers: { 'set-cookie': 'wzws_cid=test-session; Path=/; HttpOnly' },
        });
      }
      return officialDetail(entry);
    });

    const result = await refreshAuthoritativeStatuteSources({
      catalog: [entry],
      fetchImpl: fetchMock as unknown as typeof fetch,
      requestDelayMs: 0,
      writeHistory: false,
    });

    expect(result.verified).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(retryHeaders.get('Cookie')).toBe('wzws_cid=test-session');
  });

  it('extracts the final article from both object and array outlines', () => {
    expect(extractOfficialArticleMax({ children: [{ title: '第一百条' }] })).toBe(100);
    expect(extractOfficialArticleMax([{ title: '第九十九条' }, { title: '第一百零一条' }])).toBe(101);
  });
});
