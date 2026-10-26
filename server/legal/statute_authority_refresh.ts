import { normalizeStatuteReferenceTitle, statuteTextCopy, createStatuteTextSnapshot, parseOfficialStatuteText, extractReviewedStatuteHtml, extractStatuteReferences, statuteNumber, type StatuteTextSnapshot, type ReviewedStatuteHtmlSource } from '../regions/packs/cn/statute_provisions';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDataPath } from '../config/data_path';
import {
  listStatuteVerificationCatalog,
  parseArticleNumber,
  type StatuteVerificationCatalogEntry,
} from './kb';
import {
  loadStatuteAuthorityRefreshState,
  saveStatuteAuthorityRefreshState,
  type StatuteAuthorityCheck,
  type StatuteAuthorityObservedVersion,
  type StatuteAuthorityRefreshRun,
  type StatuteAuthorityRefreshState,
} from './statute_authority_store';

const OFFICIAL_BASE_URL = 'https://flk.npc.gov.cn';
const OFFICIAL_SEARCH_URL = `${OFFICIAL_BASE_URL}/law-search/search/list`;
const OFFICIAL_DETAIL_URL = `${OFFICIAL_BASE_URL}/law-search/search/flfgDetails`;
const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_REVIEW_DAYS = 90;

interface OfficialSearchRow {
  bbbs?: string;
  title?: string;
  gbrq?: string;
  sxrq?: string;
  sxx?: number;
  flxz?: string;
  zdjgName?: string;
}

interface OfficialLawDetails extends OfficialSearchRow {
  content?: unknown;
  ossFile?: {
    ossWordPath?: string;
    ossPdfPath?: string;
  };
  lsyg?: Array<{ bbbs?: string; title?: string; gbrq?: string }>;
}

export interface StatuteAuthorityRefreshOptions {
  fetchImpl?: typeof fetch;
  now?: Date;
  timeoutMs?: number;
  reviewDays?: number;
  requestDelayMs?: number;
  catalog?: StatuteVerificationCatalogEntry[];
  writeHistory?: boolean;
  persist?: boolean;
}

export interface StatuteAuthorityRefreshResult extends StatuteAuthorityRefreshRun {
  checks: StatuteAuthorityCheck[];
  pendingReview: StatuteAuthorityCheck[];
  archivePath?: string;
}

function normalizeTitle(value: unknown): string {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, '')
    .trim();
}

export function extractOfficialArticleMax(content: unknown): number | null {
  let maximum = 0;
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const match = String(node.title || '').trim().match(/^第([零〇一二两三四五六七八九十百千万\d]+)条(?:\s|$)/);
    if (match) {
      const parsed = parseArticleNumber(match[1]);
      if (parsed && parsed > maximum) maximum = parsed;
    }
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  visit(content);
  return maximum || null;
}

function collectOutlineTitles(content: unknown): string[] {
  const titles: string[] = [];
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    const title = String(node.title || '').replace(/\s+/g, ' ').trim();
    if (title) titles.push(title);
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  visit(content);
  return titles;
}

function stableFingerprint(details: OfficialLawDetails): string {
  const payload = {
    recordId: details.bbbs || '',
    title: normalizeTitle(details.title),
    versionDate: details.gbrq || '',
    effectiveDate: details.sxrq || '',
    effectivenessCode: Number.isFinite(details.sxx) ? details.sxx : null,
    category: details.flxz || '',
    issuingAuthority: details.zdjgName || '',
    wordPath: details.ossFile?.ossWordPath || '',
    pdfPath: details.ossFile?.ossPdfPath || '',
    history: (details.lsyg || []).map(item => [item.bbbs || '', item.gbrq || '', normalizeTitle(item.title)]),
    outline: collectOutlineTitles(details.content),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number): string {
  const next = new Date(value.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return isoDate(next);
}

interface OfficialFetchSession {
  cookie?: string;
}

function cookieFromResponse(response: Response): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie') || ''];
  const cookies = values
    .flatMap(value => value.split(/,(?=[^;,]+=)/))
    .map(value => value.split(';')[0].trim())
    .filter(Boolean);
  return cookies.length ? cookies.join('; ') : undefined;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  session: OfficialFetchSession,
  stage: string,
): Promise<any> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'flk.npc.gov.cn') {
    throw new Error(`Refused non-official authority source: ${url}`);
  }
  const controller = new AbortController();
  const timeoutError = new Error(`Official source ${stage} timed out after ${timeoutMs}ms (${url})`);
  timeoutError.name = 'OfficialSourceTimeoutError';
  const timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  try {
    const request = (cookie?: string) => fetchImpl(url, {
      ...init,
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Origin: OFFICIAL_BASE_URL,
        Referer: `${OFFICIAL_BASE_URL}/search`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36 LumiCore/3.0',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(init.headers || {}),
      },
    });
    let response = await request(session.cookie);
    if (isRedirectStatus(response.status)) {
      const challengeCookie = cookieFromResponse(response);
      if (!challengeCookie) throw new Error(`Official source redirected without a session cookie (HTTP ${response.status})`);
      session.cookie = challengeCookie;
      response = await request(session.cookie);
    }
    if (isRedirectStatus(response.status)) {
      throw new Error(`Official source WAF challenge did not settle (HTTP ${response.status})`);
    }
    if (!response.ok) throw new Error(`Official source returned HTTP ${response.status}`);
    const payload = await response.json();
    if (payload?.code !== 200) throw new Error(payload?.msg || `Official source returned code ${payload?.code}`);
    return payload;
  } catch (error) {
    if (controller.signal.reason === timeoutError) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function searchPayload(title: string): Record<string, any> {
  return {
    searchRange: 1,
    sxrq: [],
    gbrq: [],
    sxx: [],
    searchType: 1,
    xgzlSearch: false,
    searchContent: title,
    orderByParam: { order: '-1', sort: '' },
    flfgCodeId: [],
    zdjgCodeId: [],
    gbrqYear: [],
    pageNum: 1,
    pageSize: 30,
  };
}

async function searchOfficialRows(
  keyword: string, fetchImpl: typeof fetch, timeoutMs: number, session: OfficialFetchSession,
): Promise<OfficialSearchRow[]> {
  const payload = await fetchJson(fetchImpl, OFFICIAL_SEARCH_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json;charset=utf-8' },
    body: JSON.stringify(searchPayload(keyword)),
  }, timeoutMs, session, 'search/list');
  if (!Array.isArray(payload.rows) || payload.rows.some((row: OfficialSearchRow) => !row?.bbbs || !normalizeTitle(row.title))) {
    throw new Error('Official search returned invalid record identities');
  }
  return payload.rows;
}

async function fetchOfficialDetails(
  recordId: string, fetchImpl: typeof fetch, timeoutMs: number, session: OfficialFetchSession,
): Promise<OfficialLawDetails | undefined> {
  return (await fetchJson(fetchImpl, `${OFFICIAL_DETAIL_URL}?bbbs=${encodeURIComponent(recordId)}`,
    { method: 'GET' }, timeoutMs, session, 'record details')).data;
}

export function officialQueryLocator(keyword: string): { title: string; articleKeys: string[] } | undefined {
  const number = '[零〇一二两三四五六七八九十百千万\\d]+';
  if (/[\r\n。！？；;!?]/u.test(keyword)) return undefined;
  const namedTitle = /^[\p{Script=Han}A-Za-z0-9《》〈〉·（）()—-]{2,160}(?:法|法典|条例|规定|办法|解释|规则|细则|决定)$/u;
  const tokens = keyword.split(/[ \t　]+/u).map(token => token.split(new RegExp(`第${number}[编章节条]`, 'u'))[0]);
  const tokenTitles = tokens.filter(token => namedTitle.test(token));
  const quotedTitles = extractStatuteReferences(keyword).map(reference => reference.lawName || '').filter(name => name && !tokenTitles.some(title => title.includes('《' + name + '》')));
  const titles = [...quotedTitles, ...tokenTitles];
  const unique = [...new Map(titles.map(title => [normalizeStatuteReferenceTitle(title), title])).values()];
  if (unique.length !== 1) return undefined;
  const title = unique[0];
  const articleKeys = [...keyword.matchAll(new RegExp(`第(${number})条(?:之(${number}))?`, 'gu'))]
    .map(match => `${statuteNumber(match[1])}${match[2] ? '-' + statuteNumber(match[2]) : ''}`);
  return { title, articleKeys: [...new Set(articleKeys)] };
}

function requestedOfficialProvisions(provisions: StatuteTextSnapshot['provisions'], articleKeys: string[]): string {
  return articleKeys.map(key => {
    const [article, addition] = key.split('-');
    const label = `第${article}条${addition ? '之' + addition : ''}`;
    return provisions[key] ? `${label}\n${provisions[key].text}` : `${label}：本次未定位，未取得该条正文。`;
  }).join('\n\n');
}

/** Current read provenance, not a canonical snapshot or case-applicability decision.
 * Only explicitly selected, actually parsed articles provide provision coverage. */
export interface CurrentStatuteOriginalEvidence {
  sourceId: string;
  title: string;
  recordId: string;
  versionDate: string;
  effectiveDate: string;
  effectivenessCode: number | null;
  sourceUrl: string;
  queriedAt: string;
  originalSha256?: string;
  requestedArticleKeys: string[];
  provisions: StatuteTextSnapshot['provisions'];
}

/** Private search-cache provenance. Never returned in model-facing receipts. */
export interface CachedStatuteOriginal {
  title: string; recordId: string; versionDate: string; effectiveDate: string;
  sourceUrl: string; queriedAt: string; originalText: string; originalSha256: string;
  bodySha256: string; articleMax: number;
}
function cacheStatuteOriginal(observed: StatuteAuthorityObservedVersion, originalText: string,
  provisions: StatuteTextSnapshot['provisions'], articleMax: number, queriedAt: string): CachedStatuteOriginal {
  return { title: observed.title, recordId: observed.recordId, versionDate: observed.versionDate,
    effectiveDate: observed.effectiveDate, sourceUrl: observed.sourceUrl, queriedAt, originalText,
    originalSha256: crypto.createHash('sha256').update(originalText).digest('hex'),
    bodySha256: crypto.createHash('sha256').update(JSON.stringify(provisions)).digest('hex'), articleMax };
}

/** Reparse the bound original, never a displayed summary or its directory. */
export function projectCachedStatuteOriginal(keyword: string, source: CurrentStatuteOriginalEvidence,
  cached: CachedStatuteOriginal): { sourceText: string; statuteSource: CurrentStatuteOriginalEvidence } | undefined {
  const locator = officialQueryLocator(keyword.trim());
  if (!locator?.articleKeys.length || !source || !cached || source.sourceId !== 'national-law-regulations'
    || normalizeStatuteReferenceTitle(normalizeTitle(locator.title)) !== normalizeStatuteReferenceTitle(normalizeTitle(source.title))
    || ['title', 'recordId', 'versionDate', 'effectiveDate', 'sourceUrl', 'queriedAt'].some(key => (cached as any)[key] !== (source as any)[key])
    || typeof cached.originalText !== 'string' || !normalizeTitle(cached.originalText.slice(0, 2000)).includes(normalizeTitle(source.title))
    || !Number.isInteger(cached.articleMax) || cached.articleMax < 1
    || !/^[a-f0-9]{64}$/u.test(cached.originalSha256) || source.originalSha256 !== cached.originalSha256
    || crypto.createHash('sha256').update(cached.originalText).digest('hex') !== cached.originalSha256) return undefined;
  const observedAt = Date.parse(source.queriedAt);
  if (!Number.isFinite(observedAt) || observedAt > Date.now() || Date.now() - observedAt > 24 * 60 * 60 * 1000) return undefined;
  let parsed: StatuteTextSnapshot['provisions'];
  try { parsed = parseOfficialStatuteText(cached.originalText, cached.articleMax); } catch { return undefined; }
  if (crypto.createHash('sha256').update(JSON.stringify(parsed)).digest('hex') !== cached.bodySha256) return undefined;
  const provisions = Object.fromEntries(locator.articleKeys.filter(key => parsed[key]).map(key => [key, parsed[key]]));
  const statuteSource = { ...source, requestedArticleKeys: locator.articleKeys, provisions };
  const sourceText = [
    '来源名称：' + source.title, '官方记录：' + source.recordId, '原始检索词：' + keyword,
    '公布日期：' + source.versionDate + '；施行日期：' + source.effectiveDate,
    '效力代码：' + (source.effectivenessCode ?? '未返回'), '来源链接：' + source.sourceUrl,
    '原件读取时间：' + source.queriedAt,
    '读取范围：复用同一新鲜缓存中身份和哈希匹配的原件文字，重新解析后仅返回明确请求的条文；未发起新的联网查询。',
    '请求条文（来源原文摘录；未定位条文明确标注）：', requestedOfficialProvisions(provisions, locator.articleKeys),
  ].join('\n');
  return { sourceText, statuteSource };
}

export async function searchOfficialStatuteRecords(keyword: string, limit = 5): Promise<Array<{
  details: OfficialLawDetails; sourceUrl: string; sourceEndpoint: string; queriedAt: string; sourceText: string; statuteSource: CurrentStatuteOriginalEvidence; originalCache?: CachedStatuteOriginal;
}>> {
  if (!keyword.trim()) return [];
  const session: OfficialFetchSession = {};
  const locator = officialQueryLocator(keyword.trim());
  const titleQuery = locator?.title || keyword.trim();
  const rows = await searchOfficialRows(titleQuery, fetch, DEFAULT_TIMEOUT_MS, session);
  const sameTitle = (title: unknown) => normalizeStatuteReferenceTitle(normalizeTitle(title)) === normalizeStatuteReferenceTitle(normalizeTitle(titleQuery));
  const exactRows = rows.filter(row => sameTitle(row.title));
  // The national formal prefix may be omitted in a citation. Resolve it only
  // from actual returned full titles; arbitrary suffixes cannot identify a law.
  const nationalPrefix = '中华人民共和国';
  const normalizedQuery = normalizeStatuteReferenceTitle(normalizeTitle(titleQuery));
  const formalRows = locator && !exactRows.length ? rows.filter(row => {
    const title = normalizeStatuteReferenceTitle(normalizeTitle(row.title));
    return title.startsWith(nationalPrefix) && title.slice(nationalPrefix.length) === normalizedQuery;
  }) : [];
  const formalTitles = new Set(formalRows.map(row => normalizeStatuteReferenceTitle(normalizeTitle(row.title))));
  // Preserve every returned version of one actual title as a separate identity.
  const selectedRows = locator ? exactRows.length ? exactRows : formalTitles.size === 1 ? formalRows : []
    : exactRows.length ? exactRows : rows;
  return Promise.all(selectedRows.slice(0, Math.max(1, Math.min(limit, 20))).map(async row => {
    const details: OfficialLawDetails & { bbbs: string; title: string } = {
      ...row, bbbs: row.bbbs!, title: String(row.title || '').replace(/<[^>]+>/g, '').trim(),
    };
    const sourceUrl = `${OFFICIAL_BASE_URL}/detail?id=${encodeURIComponent(details.bbbs)}&title=${encodeURIComponent(normalizeTitle(details.title))}`;
    const queriedAt = new Date().toISOString();
    const observed: StatuteAuthorityObservedVersion = {
      recordId: details.bbbs, title: String(details.title), versionDate: String(details.gbrq || ''),
      effectiveDate: String(details.sxrq || ''), effectivenessCode: Number.isFinite(details.sxx) ? Number(details.sxx) : null,
      category: String(details.flxz || ''), issuingAuthority: String(details.zdjgName || ''),
      articleMax: extractOfficialArticleMax(details.content), sourceUrl,
      wordPath: details.ossFile?.ossWordPath, pdfPath: details.ossFile?.ossPdfPath,
    };
    const sourceEndpoint = OFFICIAL_SEARCH_URL;
    const requestedArticleKeys = locator?.articleKeys || [];
    const sourceMetadata = [
      `来源名称：${observed.title}`, `官方记录：${observed.recordId}`, `原始检索词：${keyword}`,
      `公布日期：${observed.versionDate || '未返回'}；施行日期：${observed.effectiveDate || '未返回'}`,
      `效力代码：${observed.effectivenessCode ?? '未返回'}；制定机关：${observed.issuingAuthority || '未返回'}；类别：${observed.category || '未返回'}`,
      ...(requestedArticleKeys.length ? [] : [
        `官方目录最后条号：${observed.articleMax ?? '未返回'}`,
        `原件路径：${[observed.wordPath, observed.pdfPath].filter(Boolean).join('；') || '未返回'}`,
      ]),
      `来源链接：${sourceUrl}`, ...(requestedArticleKeys.length ? [] : [`查询端点：${sourceEndpoint}`]), `查询时间：${queriedAt}`,
    ].join('\n');
    const statuteSource: CurrentStatuteOriginalEvidence = {
      sourceId: 'national-law-regulations', title: observed.title, recordId: observed.recordId,
      versionDate: observed.versionDate, effectiveDate: observed.effectiveDate,
      effectivenessCode: observed.effectivenessCode, sourceUrl, queriedAt, requestedArticleKeys, provisions: {},
    };
    const selectProvisions = (provisions: StatuteTextSnapshot['provisions']) => Object.fromEntries(
      requestedArticleKeys.filter(key => provisions[key]).map(key => [key, provisions[key]]),
    );
    let sourceText: string;
    let originalCache: CachedStatuteOriginal | undefined;
    try {
      if (observed.articleMax === null) {
        const original = await fetchOriginalDocumentText(observed, fetch, DEFAULT_TIMEOUT_MS, session);
        statuteSource.originalSha256 = crypto.createHash('sha256').update(original).digest('hex');
        const scope = '正文提取范围：已读取同一官方记录的原件文字；官方目录未提供条数，未作外部条数或完整性核验。';
        if (requestedArticleKeys.length) {
          const observedTextMax = extractOfficialArticleMax(original.split(/\r?\n/u).map(title => ({ title })));
          if (!observedTextMax) throw new Error('Requested article boundaries unavailable in official original');
          const parsed = parseOfficialStatuteText(original, observedTextMax);
          statuteSource.provisions = selectProvisions(parsed);
          originalCache = cacheStatuteOriginal(observed, original, parsed, observedTextMax, queriedAt);
          const requested = requestedOfficialProvisions(statuteSource.provisions, requestedArticleKeys);
          sourceText = `${sourceMetadata}\n\n${scope}本次仅返回明确请求的条文。\n\n请求条文（来源原文摘录；未定位条文明确标注）：\n${requested}`;
        } else {
          try {
            const originalMax = extractOfficialArticleMax(original.split(/\r?\n/u).map(title => ({ title })));
            if (originalMax) originalCache = cacheStatuteOriginal(observed, original, parseOfficialStatuteText(original, originalMax), originalMax, queriedAt);
          } catch { /* Unstructured originals remain readable, with no reusable provision binding. */ }
          sourceText = `${sourceMetadata}\n\n${scope}\n${original}`;
        }
      } else {
        const originalText = await fetchOriginalDocumentText(observed, fetch, DEFAULT_TIMEOUT_MS, session);
        const original = createStatuteTextSnapshot(originalText, observed.articleMax, {
          recordId: observed.recordId, versionDate: observed.versionDate, fetchedAt: queriedAt, sourceUrl,
        });
        originalCache = cacheStatuteOriginal(observed, originalText, original.provisions, observed.articleMax, queriedAt);
        statuteSource.originalSha256 = original.sha256;
        statuteSource.provisions = selectProvisions(original.provisions);
        if (requestedArticleKeys.length) {
          const requested = requestedOfficialProvisions(original.provisions, requestedArticleKeys);
          sourceText = `${sourceMetadata}\n\n原件内部核对：共 ${Object.keys(original.provisions).length} 条，条号与官方目录一致。本次仅返回明确请求的条文。\n\n请求条文（来源原文摘录；未定位条文明确标注）：\n${requested}`;
        } else {
          const provisions = Object.entries(original.provisions).map(([number, provision]) => {
            const [article, addition] = number.split('-');
            return `第${article}条${addition ? '之' + addition : ''}\n${provision.text}`;
          }).join('\n\n');
          sourceText = `${sourceMetadata}\n\n正文提取范围：已提取并核对全部 ${Object.keys(original.provisions).length} 条正文；条号与官方目录一致。\n${String(details.title)}${locator ? '\n原始检索词：' + keyword : ''}\n\n${provisions}`;
        }
      }
    } catch (error) {
      delete statuteSource.originalSha256;
      statuteSource.provisions = {};
      originalCache = undefined;
      sourceText = `${sourceMetadata}\n\n读取范围：已取得来源元数据，正文提取未完成：${error instanceof Error ? error.message : String(error)}`;
    }
    return { details, sourceUrl, sourceEndpoint, queriedAt, sourceText, statuteSource, originalCache };
  }));
}

async function fetchObservedVersion(
  entry: StatuteVerificationCatalogEntry,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  session: OfficialFetchSession,
): Promise<{ details: OfficialLawDetails; observed: StatuteAuthorityObservedVersion; fingerprint: string }> {
  let recordId = entry.recordId;
  if (!recordId) {
    const exactRows = (await searchOfficialRows(entry.sourceTitle, fetchImpl, timeoutMs, session))
      .filter((row: OfficialSearchRow) => normalizeTitle(row.title) === normalizeTitle(entry.sourceTitle))
      .sort((a: OfficialSearchRow, b: OfficialSearchRow) => String(b.gbrq || '').localeCompare(String(a.gbrq || '')));
    recordId = (exactRows.find((row: OfficialSearchRow) => row.sxx === 3) || exactRows[0])?.bbbs;
    if (!recordId) throw new Error(`Official database did not return an exact record for ${entry.sourceTitle}`);
  }

  const details = await fetchOfficialDetails(recordId, fetchImpl, timeoutMs, session);
  if (!details?.bbbs || normalizeTitle(details.title) !== normalizeTitle(entry.sourceTitle)) {
    throw new Error(`Official detail title mismatch for ${entry.sourceTitle}`);
  }
  const observed: StatuteAuthorityObservedVersion = {
    recordId: details.bbbs,
    title: String(details.title || ''),
    versionDate: String(details.gbrq || ''),
    effectiveDate: String(details.sxrq || ''),
    effectivenessCode: Number.isFinite(details.sxx) ? Number(details.sxx) : null,
    category: String(details.flxz || ''),
    issuingAuthority: String(details.zdjgName || ''),
    articleMax: extractOfficialArticleMax(details.content),
    sourceUrl: `${OFFICIAL_BASE_URL}/detail?id=${encodeURIComponent(details.bbbs)}&title=${encodeURIComponent(String(details.title || ''))}`,
    wordPath: details.ossFile?.ossWordPath,
    pdfPath: details.ossFile?.ossPdfPath,
  };
  return { details, observed, fingerprint: stableFingerprint(details) };
}

function changedReasons(
  entry: StatuteVerificationCatalogEntry,
  observed: StatuteAuthorityObservedVersion,
  fingerprint: string,
  previous?: StatuteAuthorityCheck,
): string[] {
  const reasons: string[] = [];
  if (observed.effectivenessCode !== 3) reasons.push(`官方效力状态不是“有效”（sxx=${observed.effectivenessCode ?? 'unknown'}）`);
  if (observed.versionDate !== entry.verification.versionDate) {
    reasons.push(`公布/版本日期由 ${entry.verification.versionDate} 变为 ${observed.versionDate || '空'}`);
  }
  if (observed.effectiveDate !== entry.verification.effectiveDate) {
    reasons.push(`施行日期由 ${entry.verification.effectiveDate} 变为 ${observed.effectiveDate || '空'}`);
  }
  if (entry.recordId && observed.recordId !== entry.recordId) {
    reasons.push(`官方记录由 ${entry.recordId} 变为 ${observed.recordId}`);
  }
  if (observed.articleMax !== null && entry.verification.articleMax !== undefined
    && observed.articleMax !== entry.verification.articleMax) {
    reasons.push(`最后条号由 ${entry.verification.articleMax} 变为 ${observed.articleMax}`);
  }
  if (previous?.fingerprint && previous.lastVerifiedAt
    && previous.observed?.recordId === observed.recordId
    && previous.fingerprint !== fingerprint) {
    reasons.push('同一官方记录的稳定内容指纹发生变化');
  }
  return reasons;
}

async function fetchReviewedHtmlText(
  observed: StatuteAuthorityObservedVersion, source: ReviewedStatuteHtmlSource,
  articleMax: number, fetchImpl: typeof fetch, timeoutMs: number, fetchedAt: string,
): Promise<StatuteTextSnapshot> {
  if (source.url !== statuteTextCopy.saleContractHtml.url || source.recordId !== observed.recordId
    || source.versionDate !== observed.versionDate || source.effectiveDate !== observed.effectiveDate
    || source.articleMax !== articleMax
    || normalizeTitle(source.sectionBoundary + source.sectionHeading) !== normalizeTitle(observed.title)) {
    throw new Error('Reviewed official HTML source identity mismatch');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(source.url, { redirect: 'error', signal: controller.signal,
      headers: { Accept: 'text/html' } });
    if (!response.ok || !response.body || !/text\/html/i.test(response.headers.get('content-type') || '')) {
      throw new Error('Reviewed official HTML download failed');
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read(); if (item.done) break;
        size += item.value.byteLength;
        if (size > 2 * 1024 * 1024) throw new Error('Reviewed official HTML exceeds download limit');
        chunks.push(item.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const html = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return createStatuteTextSnapshot(extractReviewedStatuteHtml(html, source), articleMax, {
      recordId: observed.recordId, versionDate: observed.versionDate, fetchedAt, sourceUrl: source.url,
    });
  } finally { clearTimeout(timer); }
}

async function fetchOriginalText(
  observed: StatuteAuthorityObservedVersion, fetchImpl: typeof fetch,
  timeoutMs: number, session: OfficialFetchSession, fetchedAt: string, expectedArticleMax?: number,
  reviewedHtml?: ReviewedStatuteHtmlSource,
): Promise<StatuteTextSnapshot> {
  // Some official records have no outline. The already-reviewed catalog bound
  // still requires every article and the final article to match the real text.
  const articleMax = observed.articleMax ?? expectedArticleMax;
  if (typeof articleMax !== 'number' || !Number.isInteger(articleMax) || articleMax < 1) throw new Error('Official article count unavailable');
  if (reviewedHtml) return fetchReviewedHtmlText(observed, reviewedHtml, articleMax, fetchImpl, timeoutMs, fetchedAt);
  if (!observed.wordPath) throw new Error('Official DOCX unavailable');
  const text = await fetchOriginalDocumentText(observed, fetchImpl, timeoutMs, session);
  return createStatuteTextSnapshot(text, articleMax, {
    recordId: observed.recordId, versionDate: observed.versionDate, fetchedAt,
    sourceUrl: observed.sourceUrl,
  });
}

async function fetchOriginalDocumentText(
  observed: StatuteAuthorityObservedVersion, fetchImpl: typeof fetch,
  timeoutMs: number, session: OfficialFetchSession,
): Promise<string> {
  const download = await fetchJson(fetchImpl,
    `${OFFICIAL_BASE_URL}/law-search/download/pc?format=docx&bbbs=${encodeURIComponent(observed.recordId)}&fileId=`,
    {}, timeoutMs, session, 'document download URL');
  const url = new URL(download.data?.url || download.data?.urlIn);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !['flk.npc.gov.cn', 'flkoss.obs-bj2.cucloud.cn'].includes(url.hostname)
    || (observed.wordPath && decodeURIComponent(url.pathname).replace(/^\//, '') !== observed.wordPath.replace(/^\//, ''))) {
    throw new Error('Official text download location mismatch');
  }
  const controller = new AbortController();
  const timeoutError = new Error(`Official source DOCX download timed out after ${timeoutMs}ms (${url.href})`);
  timeoutError.name = 'OfficialSourceTimeoutError';
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  try {
    const response = await fetchImpl(url.href, { redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Official text download failed (HTTP ${response.status}; response body ${response.body ? 'available' : 'unavailable'})`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 8 * 1024 * 1024) throw new Error('Official text exceeds download limit');
        chunks.push(item.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    const mammoth = (await import('mammoth')).default;
    const document = await mammoth.extractRawText({ buffer: Buffer.concat(chunks) });
    if (!normalizeTitle(document.value.slice(0, 2000)).includes(normalizeTitle(observed.title))) {
      throw new Error('Official document title mismatch');
    }
    return document.value;
  } catch (error) {
    if (controller.signal.reason === timeoutError) throw timeoutError;
    throw error;
  } finally { clearTimeout(timer); }
}

async function checkOne(
  entry: StatuteVerificationCatalogEntry,
  previous: StatuteAuthorityCheck | undefined,
  fetchImpl: typeof fetch,
  now: Date,
  timeoutMs: number,
  reviewDays: number,
  session: OfficialFetchSession,
): Promise<StatuteAuthorityCheck> {
  const checkedAt = now.toISOString();
  try {
    const { observed, fingerprint } = await fetchObservedVersion(entry, fetchImpl, timeoutMs, session);
    const reasons = changedReasons(entry, observed, fingerprint, previous);
    const invalid = normalizeTitle(observed.title) !== normalizeTitle(entry.sourceTitle) || observed.effectivenessCode === null;
    let verified = !invalid && reasons.length === 0;
    let originalText: StatuteTextSnapshot | undefined;
    let originalTextError: string | undefined;
    if (verified) {
      try {
        originalText = await fetchOriginalText(observed, fetchImpl, timeoutMs, session, checkedAt, entry.verification.articleMax, entry.verification.originalHtml);
        if (previous?.originalText && previous.originalText.recordId === originalText.recordId
          && previous.originalText.sha256 !== originalText.sha256) {
          reasons.push(statuteTextCopy.changed);
          verified = false;
          // Keep the last accepted text as the comparison baseline. A second
          // refresh must not silently approve the same unreviewed change.
          originalText = previous.originalText;
        }
      } catch { originalText = previous?.originalText; originalTextError = statuteTextCopy.unavailable; }
    } else originalText = previous?.originalText;
    return {
      title: entry.sourceTitle,
      status: invalid ? 'invalid' : verified ? 'verified' : 'changed',
      checkedAt,
      expectedVersionDate: entry.verification.versionDate,
      expectedEffectiveDate: entry.verification.effectiveDate,
      expectedArticleMax: entry.verification.articleMax ?? null,
      expectedRecordId: entry.recordId,
      observed,
      fingerprint,
      previousFingerprint: previous?.fingerprint,
      lastVerifiedAt: verified ? checkedAt : previous?.lastVerifiedAt,
      reviewAfter: verified ? addDays(now, reviewDays) : previous?.reviewAfter,
      reasons: invalid ? ['官方详情结构或效力字段无效', ...reasons] : reasons,
      consecutiveFailures: 0,
      originalText,
      originalTextError,
    };
  } catch (error: any) {
    return {
      title: entry.sourceTitle,
      status: 'unavailable',
      checkedAt,
      expectedVersionDate: entry.verification.versionDate,
      expectedEffectiveDate: entry.verification.effectiveDate,
      expectedArticleMax: entry.verification.articleMax ?? null,
      expectedRecordId: entry.recordId,
      observed: previous?.observed,
      originalText: previous?.originalText,
      originalTextError: previous?.originalTextError,
      fingerprint: previous?.fingerprint,
      previousFingerprint: previous?.previousFingerprint,
      lastVerifiedAt: previous?.lastVerifiedAt,
      reviewAfter: previous?.reviewAfter,
      reasons: [error?.name === 'AbortError' ? '访问权威来源超时' : (error?.message || String(error))],
      consecutiveFailures: (previous?.consecutiveFailures || 0) + 1,
    };
  }
}

function archiveRefreshRun(result: StatuteAuthorityRefreshResult): string {
  const stamp = result.completedAt.replace(/[:.]/g, '-');
  const target = getDataPath(path.join('legal_authority_refresh', 'history', `${stamp}.json`));
  const summaries = (checks: StatuteAuthorityCheck[]) => checks.map(({ originalText, ...check }) => ({
    ...check,
    ...(originalText ? { originalText: {
      recordId: originalText.recordId, versionDate: originalText.versionDate,
      fetchedAt: originalText.fetchedAt, sourceUrl: originalText.sourceUrl, sha256: originalText.sha256,
      articleCount: Object.keys(originalText.provisions).length,
    } } : {}),
  }));
  fs.writeFileSync(target, JSON.stringify({ ...result, checks: summaries(result.checks), pendingReview: summaries(result.pendingReview) }, null, 2), 'utf-8');
  return target;
}

async function performAuthoritativeStatuteRefresh(
  options: StatuteAuthorityRefreshOptions = {},
): Promise<StatuteAuthorityRefreshResult> {
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || new Date();
  const timeoutMs = Math.max(100, options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const reviewDays = Math.max(1, options.reviewDays || DEFAULT_REVIEW_DAYS);
  const requestDelayMs = Math.max(0, options.requestDelayMs ?? 200);
  const catalog = options.catalog || listStatuteVerificationCatalog();
  const previousState = loadStatuteAuthorityRefreshState();
  const checks: StatuteAuthorityCheck[] = [];
  const session: OfficialFetchSession = {};

  for (const [index, entry] of catalog.entries()) {
    if (index > 0 && requestDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, requestDelayMs));
    }
    checks.push(await checkOne(
      entry,
      previousState.checks[entry.sourceTitle],
      fetchImpl,
      now,
      timeoutMs,
      reviewDays,
      session,
    ));
  }

  const run: StatuteAuthorityRefreshRun = {
    runAt: now.toISOString(),
    completedAt: new Date().toISOString(),
    checked: checks.length,
    verified: checks.filter(check => check.status === 'verified').length,
    changed: checks.filter(check => check.status === 'changed').length,
    invalid: checks.filter(check => check.status === 'invalid').length,
    unavailable: checks.filter(check => check.status === 'unavailable').length,
    newPendingReview: checks.filter(check => (
      (check.status === 'changed' || check.status === 'invalid')
      && !['changed', 'invalid'].includes(previousState.checks[check.title]?.status || '')
    )).length,
  };
  const state: StatuteAuthorityRefreshState = {
    version: 1,
    lastRunAt: run.completedAt,
    lastSuccessfulRunAt: run.unavailable === 0 ? run.completedAt : previousState.lastSuccessfulRunAt,
    checks: Object.fromEntries(checks.map(check => [check.title, check])),
    runs: [...previousState.runs, run].slice(-30),
  };
  if (options.persist !== false) saveStatuteAuthorityRefreshState(state);

  const result: StatuteAuthorityRefreshResult = {
    ...run,
    checks,
    pendingReview: checks.filter(check => check.status === 'changed' || check.status === 'invalid'),
  };
  if (options.writeHistory !== false) result.archivePath = archiveRefreshRun(result);
  return result;
}

let refreshQueue: Promise<void> = Promise.resolve();

export function refreshAuthoritativeStatuteSources(
  options: StatuteAuthorityRefreshOptions = {},
): Promise<StatuteAuthorityRefreshResult> {
  const run = refreshQueue.then(
    () => performAuthoritativeStatuteRefresh(options),
    () => performAuthoritativeStatuteRefresh(options),
  );
  refreshQueue = run.then(() => undefined, () => undefined);
  return run;
}

export function formatStatuteAuthorityRefreshReport(
  stateOrResult: StatuteAuthorityRefreshState | StatuteAuthorityRefreshResult = loadStatuteAuthorityRefreshState(),
): string {
  const checks = Array.isArray((stateOrResult as StatuteAuthorityRefreshResult).checks)
    ? (stateOrResult as StatuteAuthorityRefreshResult).checks
    : Object.values((stateOrResult as StatuteAuthorityRefreshState).checks || {});
  const pending = checks.filter(check => check.status === 'changed' || check.status === 'invalid');
  const unavailable = checks.filter(check => check.status === 'unavailable');
  const verified = checks.filter(check => check.status === 'verified');
  const lastRunAt = 'completedAt' in stateOrResult
    ? stateOrResult.completedAt
    : stateOrResult.lastRunAt || '尚未运行';
  return [
    '# 权威法源自动巡检',
    '',
    `- 最近运行：${lastRunAt}`,
    `- 已检查：${checks.length}`,
    `- 权威版本一致：${verified.length}`,
    `- 待人工复核：${pending.length}`,
    `- 本次不可用：${checks.filter(check => check.status === 'unavailable' || check.originalTextError).length}`,
    '',
    '## 待人工复核',
    ...(pending.length
      ? pending.map(check => `- ${check.title}：${check.reasons.join('；')}`)
      : ['- 无']),
    '',
    '## 来源暂不可用',
    ...(unavailable.length || checks.some(check => check.originalTextError)
      ? [
        ...unavailable.map(check => `- ${check.title}：${check.reasons.join('；')}（连续失败 ${check.consecutiveFailures} 次）`),
        ...checks.filter(check => check.originalTextError && check.status !== 'unavailable').map(check => `- ${check.title}：${check.originalTextError}`),
      ]
      : ['- 无']),
    '',
    '## 规则',
    statuteTextCopy.domainRule,
    '- 官方版本、效力、日期、记录 ID、最后条号或稳定指纹变化时立即进入复核队列，不能自动放行正式文书。',
    '- 临时网络失败沿用最近一次仍在复核期限内的成功快照；期限届满后正式交付 gate 自动阻断。',
  ].join('\n');
}
