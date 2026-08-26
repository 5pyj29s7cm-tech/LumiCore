import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { getDataPath } from '../config/data_path';
import {
  listStatuteVerificationCatalog,
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

const CHINESE_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

function normalizeTitle(value: unknown): string {
  return String(value || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function parseChineseNumber(value: string): number | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  let total = 0;
  let section = 0;
  let number = 0;
  let sawNumber = false;
  for (const char of raw) {
    if (char in CHINESE_DIGITS) {
      number = number * 10 + CHINESE_DIGITS[char];
      sawNumber = true;
      continue;
    }
    const unit = units[char];
    if (!unit) return null;
    sawNumber = true;
    if (unit === 10000) {
      total += (section + number) * unit;
      section = 0;
    } else {
      section += (number || 1) * unit;
    }
    number = 0;
  }
  return sawNumber ? total + section + number : null;
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
      const parsed = parseChineseNumber(match[1]);
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
): Promise<any> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'flk.npc.gov.cn') {
    throw new Error(`Refused non-official authority source: ${url}`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

async function fetchObservedVersion(
  entry: StatuteVerificationCatalogEntry,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  session: OfficialFetchSession,
): Promise<{ details: OfficialLawDetails; observed: StatuteAuthorityObservedVersion; fingerprint: string }> {
  let recordId = entry.recordId;
  if (!recordId) {
    const search = await fetchJson(fetchImpl, OFFICIAL_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
      body: JSON.stringify(searchPayload(entry.sourceTitle)),
    }, timeoutMs, session);
    const exactRows = (Array.isArray(search.rows) ? search.rows : [])
      .filter((row: OfficialSearchRow) => normalizeTitle(row.title) === normalizeTitle(entry.sourceTitle))
      .sort((a: OfficialSearchRow, b: OfficialSearchRow) => String(b.gbrq || '').localeCompare(String(a.gbrq || '')));
    recordId = (exactRows.find((row: OfficialSearchRow) => row.sxx === 3) || exactRows[0])?.bbbs;
    if (!recordId) throw new Error(`Official database did not return an exact record for ${entry.sourceTitle}`);
  }

  const detailUrl = `${OFFICIAL_DETAIL_URL}?bbbs=${encodeURIComponent(recordId)}`;
  const detailPayload = await fetchJson(fetchImpl, detailUrl, { method: 'GET' }, timeoutMs, session);
  const details = detailPayload.data as OfficialLawDetails | undefined;
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
    const verified = !invalid && reasons.length === 0;
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
  fs.writeFileSync(target, JSON.stringify(result, null, 2), 'utf-8');
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
    `- 本次不可用：${unavailable.length}`,
    '',
    '## 待人工复核',
    ...(pending.length
      ? pending.map(check => `- ${check.title}：${check.reasons.join('；')}`)
      : ['- 无']),
    '',
    '## 来源暂不可用',
    ...(unavailable.length
      ? unavailable.map(check => `- ${check.title}：${check.reasons.join('；')}（连续失败 ${check.consecutiveFailures} 次）`)
      : ['- 无']),
    '',
    '## 规则',
    '- 只访问国家法律法规数据库官方 HTTPS 域名。',
    '- 官方版本、效力、日期、记录 ID、最后条号或稳定指纹变化时立即进入复核队列，不能自动放行正式文书。',
    '- 临时网络失败沿用最近一次仍在复核期限内的成功快照；期限届满后正式交付 gate 自动阻断。',
  ].join('\n');
}
