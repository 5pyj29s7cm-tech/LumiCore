/**
 * External legal data source integrations.
 *
 * Official/API integrations are used only when Lumi has a documented endpoint
 * and authorized credentials. Third-party legal databases and court websites
 * without a configured API are handled through authorized browser collaboration
 * plus user-confirmed material import into the knowledge base.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getKey } from '../config/keys';

// ── Cache ───────────────────────────────────────────────────────────────

const CACHE_DIR = path.join(process.cwd(), 'data', 'legal_cache');
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheKey(source: string, query: string): string {
  return `${source}_${Buffer.from(query).toString('base64').replace(/[/+=]/g, '_').slice(0, 80)}.json`;
}

function readCache(key: string, ttlMs = 24 * 60 * 60 * 1000): any | null {
  try {
    const file = path.join(CACHE_DIR, key);
    if (!fs.existsSync(file)) return null;
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > ttlMs) {
      fs.unlinkSync(file);
      return null;
    }
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch { return null; }
}

function writeCache(key: string, data: any) {
  ensureCacheDir();
  fs.writeFileSync(path.join(CACHE_DIR, key), JSON.stringify(data, null, 2));
}

// ── Source capability registry ─────────────────────────────────────────

export type LegalSourceAccessMode = 'api' | 'authorized_browser' | 'manual_import' | 'official_web';

export interface LegalSourceCapability {
  id: string;
  label: string;
  accessMode: LegalSourceAccessMode;
  configured: boolean;
  canAutoQuery: boolean;
  requiresAuthorization: boolean;
  boundary: string;
  nextAction: string;
}

function readSecret(name: keyof import('../config/keys').KeyStore): string {
  return (process.env[name] || getKey(name) || '').trim();
}

function qichachaConfig() {
  const appKey = readSecret('QICHACHA_APP_KEY') || readSecret('QICHACHA_API_KEY');
  const secretKey = readSecret('QICHACHA_SECRET_KEY');
  const baseUrl = (readSecret('QICHACHA_BASE_URL') || 'https://api.qichacha.com').replace(/\/+$/, '');
  return {
    appKey,
    secretKey,
    baseUrl,
    configured: Boolean(appKey && secretKey),
  };
}

function tianyanchaConfig() {
  const apiKey = readSecret('TIANYANCHA_API_KEY');
  const baseUrl = (readSecret('TIANYANCHA_BASE_URL') || 'https://open.api.tianyancha.com').replace(/\/+$/, '');
  return {
    apiKey,
    baseUrl,
    configured: Boolean(apiKey),
  };
}

function pkulawConfig() {
  const apiKey = readSecret('PKULAW_API_KEY') || readSecret('PKULAW_TOKEN');
  const baseUrl = readSecret('PKULAW_BASE_URL').replace(/\/+$/, '');
  const mcpUrl = readSecret('PKULAW_MCP_URL').replace(/\/+$/, '');
  return {
    apiKey,
    baseUrl,
    mcpUrl,
    configured: Boolean(apiKey && baseUrl),
    mcpConfigured: Boolean(mcpUrl),
  };
}

function faruiConfig() {
  const apiKey = readSecret('FARUI_API_KEY');
  const baseUrl = readSecret('FARUI_BASE_URL').replace(/\/+$/, '');
  const aliyunAk = readSecret('ALIYUN_AK_ID');
  const aliyunSecret = readSecret('ALIYUN_AK_SECRET');
  const hasAliyunCredential = Boolean(aliyunAk && aliyunSecret);
  return {
    apiKey,
    baseUrl,
    hasAliyunCredential,
    configured: Boolean(baseUrl && apiKey),
  };
}

export function listLegalSourceCapabilities(): LegalSourceCapability[] {
  const qcc = qichachaConfig();
  const tyc = tianyanchaConfig();
  const pkulaw = pkulawConfig();
  const farui = faruiConfig();
  return [
    {
      id: 'qichacha',
      label: '企查查',
      accessMode: 'api',
      configured: qcc.configured,
      canAutoQuery: qcc.configured,
      requiresAuthorization: true,
      boundary: qcc.configured
        ? '已配置官方 API 凭证时，可按授权额度查询企业信息；不得超出合同、套餐和用途限制。'
        : '尚未配置官方 API 凭证，只能使用授权网页登录协作。不能承诺自动抓取或批量同步。',
      nextAction: qcc.configured
        ? '可直接调用 legal_trace_assets / legal_equity_penetration 进行 API 查询，并保存来源时间。'
        : '配置 QICHACHA_APP_KEY 与 QICHACHA_SECRET_KEY，或使用 web_login_run 打开 qichacha 登录页。',
    },
    {
      id: 'tianyancha',
      label: '天眼查',
      accessMode: 'api',
      configured: tyc.configured,
      canAutoQuery: tyc.configured,
      requiresAuthorization: true,
      boundary: tyc.configured
        ? '已配置天眼查官方 API 凭证时，可按套餐和授权用途查询企业主体信息；不得超出合同、频控和用途限制。'
        : '尚未配置天眼查 API 凭证；当前只能通过授权网页登录或材料导入协作，不承诺自动抓取或批量同步。',
      nextAction: tyc.configured
        ? '可通过 legal_company_database_lookup / legal_trace_assets 查询企业信息，并将律师确认结果入库。'
        : '配置 TIANYANCHA_API_KEY；如供应商提供专属网关，可同时配置 TIANYANCHA_BASE_URL。',
    },
    {
      id: 'pkulaw',
      label: '北大法宝',
      accessMode: 'api',
      configured: pkulaw.configured || pkulaw.mcpConfigured,
      canAutoQuery: pkulaw.configured,
      requiresAuthorization: true,
      boundary: pkulaw.configured
        ? '已配置北大法宝授权 API 网关，可按合同范围检索法规、案例和法条依据；MCP 仅作为授权工具通道，不复制平台数据库。'
        : '尚未配置可调用的北大法宝 API 网关；可配置 PKULAW_API_KEY + PKULAW_BASE_URL，或使用 MCP/网页登录协作。',
      nextAction: pkulaw.configured
        ? '可调用 legal_search_external_authorities 检索权威法律依据，并把结果写入来源登记。'
        : '联系供应商开通 API/MCP 权限后配置 PKULAW_API_KEY、PKULAW_BASE_URL；仅有网页账号时继续用授权浏览器。',
    },
    {
      id: 'farui',
      label: '通义法睿',
      accessMode: 'api',
      configured: farui.configured,
      canAutoQuery: farui.configured,
      requiresAuthorization: true,
      boundary: farui.configured
        ? '已配置法睿授权网关或代理端点时，可按阿里云/供应商权限检索法规、案例和法律问答；输出仍需律师复核。'
        : farui.hasAliyunCredential
          ? '已发现阿里云 AK，但尚未配置 FARUI_BASE_URL；当前不直接构造签名请求，避免误调未授权接口。'
          : '尚未配置法睿 API 凭证或网关；当前不能承诺自动查询。',
      nextAction: farui.configured
        ? '可调用 legal_search_external_authorities 检索法规/案例；结果进入来源登记和引用核验。'
        : '配置 FARUI_BASE_URL + FARUI_API_KEY，或配置受控代理网关；没有接口授权时继续网页登录/人工检索。',
    },
    {
      id: 'alpha-lawyer',
      label: 'Alpha',
      accessMode: 'authorized_browser',
      configured: false,
      canAutoQuery: false,
      requiresAuthorization: true,
      boundary: '未发现稳定公开 API 配置；当前按律所账号授权网页登录协作，不复制平台数据库。',
      nextAction: '使用 web_login_profile_save_from_preset / web_login_run 打开 Alpha，律师确认结果后导入 Lumi 知识库。',
    },
    {
      id: 'fachan',
      label: '法蝉',
      accessMode: 'authorized_browser',
      configured: false,
      canAutoQuery: false,
      requiresAuthorization: true,
      boundary: '当前按第三方法律平台授权网页登录协作处理，不绕过账号权限、验证码、付费墙或下载限制。',
      nextAction: '使用授权浏览器检索，律师确认摘录后由 Lumi 导入知识库。',
    },
    {
      id: 'china-judgments-online',
      label: '中国裁判文书网',
      accessMode: 'authorized_browser',
      configured: false,
      canAutoQuery: false,
      requiresAuthorization: true,
      boundary: '当前不作为平台数据 API 接入；只做官方网页授权会话、检索辅助和人工确认后的材料导入。',
      nextAction: '使用授权浏览器检索、下载或复制材料，再调用 legal_import_materials_to_kb 入库。',
    },
    {
      id: 'people-court-case-library',
      label: '人民法院案例库',
      accessMode: 'official_web',
      configured: true,
      canAutoQuery: false,
      requiresAuthorization: false,
      boundary: '按官方网页检索与人工确认处理；引用方式和适用性需由律师复核。',
      nextAction: '生成检索词并打开官网，确认后导入案例摘录或全文。',
    },
    {
      id: 'national-enterprise-credit',
      label: '国家企业信用信息公示系统',
      accessMode: 'official_web',
      configured: true,
      canAutoQuery: false,
      requiresAuthorization: false,
      boundary: '按官方网站查询处理；遇验证码、地区跳转或频控时由人工完成。',
      nextAction: '打开官方网页核验主体信息，保存查询时间、主体名称和统一社会信用代码。',
    },
  ];
}

// ── Fetch helper ────────────────────────────────────────────────────────

async function fetchWithUA(url: string, timeoutMs = 10000): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

async function fetchJsonWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 10000): Promise<any | null> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function appendQuery(baseUrl: string, params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined && String(value).trim().length > 0)
    .map(([key, value]) => [key, String(value)] as const);
  if (entries.length === 0) return baseUrl;
  try {
    const url = new URL(baseUrl);
    for (const [key, value] of entries) url.searchParams.set(key, value);
    return url.toString();
  } catch {
    const query = entries
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join('&');
    return `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}${query}`;
  }
}

function firstString(raw: any, keys: string[]): string {
  if (!raw || typeof raw !== 'object') return '';
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function normalizeApiRows(data: any): any[] {
  const candidates = [
    data?.results,
    data?.items,
    data?.records,
    data?.list,
    data?.data?.results,
    data?.data?.items,
    data?.data?.records,
    data?.data?.list,
    data?.result?.results,
    data?.result?.items,
    data?.result?.records,
    data?.result?.list,
    data?.Result?.Results,
    data?.Result?.Items,
    data?.Result?.Records,
    data?.Data?.Results,
    data?.Data?.Items,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  const singleton = data?.result ?? data?.Result ?? data?.data ?? data?.Data;
  if (Array.isArray(singleton)) return singleton;
  if (singleton && typeof singleton === 'object') return [singleton];
  if (data && typeof data === 'object') return [data];
  return [];
}

function isSelectedSource(sourceIds: string[] | undefined, id: string, aliases: string[] = []): boolean {
  if (!sourceIds || sourceIds.length === 0) return true;
  const selected = new Set(sourceIds.map(item => item.toLowerCase()));
  return selected.has(id.toLowerCase()) || aliases.some(alias => selected.has(alias.toLowerCase()));
}

export type ExternalLegalSearchKind = 'law' | 'case' | 'mixed';

export interface ExternalLegalSearchResult {
  sourceId: string;
  sourceName: string;
  title: string;
  summary: string;
  url: string;
  effectiveStatus?: string;
  publishDate?: string;
  court?: string;
  caseNumber?: string;
  raw?: any;
}

function mapExternalLegalResult(raw: any, sourceId: string, sourceName: string): ExternalLegalSearchResult {
  const title = firstString(raw, [
    'title', 'Title', 'name', 'Name', 'docTitle', 'lawTitle', 'caseTitle',
    'fullName', 'caption', 'subject',
  ]) || `${sourceName} result`;
  const summary = firstString(raw, [
    'summary', 'Summary', 'digest', 'Digest', 'abstract', 'content', 'Content',
    'text', 'Text', 'reason', 'judgementResult', '裁判要旨',
  ]);
  return {
    sourceId,
    sourceName,
    title,
    summary: summary.slice(0, 1000),
    url: firstString(raw, ['url', 'Url', 'link', 'Link', 'sourceUrl', 'detailUrl', 'viewUrl']),
    effectiveStatus: firstString(raw, ['status', 'Status', 'effectiveness', 'validity', 'isEffective']),
    publishDate: firstString(raw, ['publishDate', 'pubDate', 'date', 'judgmentDate', 'trialDate']),
    court: firstString(raw, ['court', 'courtName', 'Court', '法院']),
    caseNumber: firstString(raw, ['caseNumber', 'caseNo', '案号', 'no']),
    raw,
  };
}

async function callConfiguredLegalSearch(
  sourceId: string,
  sourceName: string,
  baseUrl: string,
  apiKey: string,
  params: {
    query: string;
    type?: ExternalLegalSearchKind;
    limit?: number;
  },
): Promise<ExternalLegalSearchResult[]> {
  if (!baseUrl || !apiKey) return [];
  const limit = Math.max(1, Math.min(Number(params.limit) || 5, 20));
  const ck = cacheKey(sourceId, JSON.stringify({ q: params.query, type: params.type || 'mixed', limit, baseUrl }));
  const cached = readCache(ck, 30 * 60 * 1000);
  if (cached) return cached;

  const endpoint = appendQuery(baseUrl, {
    q: params.query,
    query: params.query,
    keyword: params.query,
    type: params.type || 'mixed',
    limit,
  });
  const authValue = /^bearer\s+/i.test(apiKey) ? apiKey : `Bearer ${apiKey}`;
  const data = await fetchJsonWithTimeout(endpoint, {
    headers: {
      Accept: 'application/json',
      Authorization: authValue,
      'X-API-Key': apiKey,
      Token: apiKey,
    },
  }, 10000);
  if (!data) return [];

  const rows = normalizeApiRows(data)
    .map(row => mapExternalLegalResult(row, sourceId, sourceName))
    .filter(row => row.title || row.summary)
    .slice(0, limit);
  writeCache(ck, rows);
  return rows;
}

export async function searchLegalAuthorityDatabase(params: {
  query: string;
  type?: ExternalLegalSearchKind;
  sourceIds?: string[];
  limit?: number;
  includeOfficialWeb?: boolean;
}): Promise<ExternalLegalSearchResult[]> {
  const query = params.query.trim();
  if (!query) return [];
  const limit = Math.max(1, Math.min(Number(params.limit) || 5, 20));
  const results: ExternalLegalSearchResult[] = [];

  const pkulaw = pkulawConfig();
  if (pkulaw.configured && isSelectedSource(params.sourceIds, 'pkulaw', ['beidafabao', 'pku-law', '北大法宝'])) {
    results.push(...await callConfiguredLegalSearch('pkulaw', '北大法宝', pkulaw.baseUrl, pkulaw.apiKey, {
      query,
      type: params.type,
      limit,
    }));
  }

  const farui = faruiConfig();
  if (farui.configured && isSelectedSource(params.sourceIds, 'farui', ['tongyi-farui', 'aliyun-farui', '法睿'])) {
    results.push(...await callConfiguredLegalSearch('farui', '通义法睿', farui.baseUrl, farui.apiKey, {
      query,
      type: params.type,
      limit,
    }));
  }

  if (
    params.includeOfficialWeb
    && (params.type === 'law' || params.type === 'mixed' || !params.type)
    && isSelectedSource(params.sourceIds, 'national-law-regulations', ['flk', 'npc-law'])
  ) {
    const statutes = await searchFLK(query);
    results.push(...statutes.slice(0, limit).map(item => ({
      sourceId: 'national-law-regulations',
      sourceName: '国家法律法规数据库',
      title: item.title,
      summary: [item.issuingBody, item.status].filter(Boolean).join(' | '),
      url: item.url,
      effectiveStatus: item.status,
      publishDate: item.publishDate,
      raw: item,
    })));
  }

  return results.slice(0, limit);
}

// ── 中国裁判文书网 (wenshu.court.gov.cn) ───────────────────────────────

export interface JudgmentSearchParams {
  keyword?: string;
  caseNumber?: string;
  court?: string;
  causeOfAction?: string;
  party?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface JudgmentResult {
  title: string;
  caseNumber: string;
  court: string;
  date: string;
  causeOfAction: string;
  parties: string;
  url: string;
}

export async function searchWenshu(params: JudgmentSearchParams): Promise<JudgmentResult[]> {
  const ck = cacheKey('wenshu', JSON.stringify(params));
  const cached = readCache(ck, 6 * 60 * 60 * 1000); // 6-hour TTL
  if (cached) return cached;

  const results: JudgmentResult[] = [];
  // 中国裁判文书网当前按授权网页登录协作处理，不作为平台数据 API 接入。
  // 律师确认后的下载文件或摘录由 legal_import_materials_to_kb 入库。
  writeCache(ck, results);
  return results;
}

// ── 国家法律法规数据库 (flk.npc.gov.cn) ───────────────────────────────

export interface StatuteSearchResult {
  title: string;
  docId: string;
  status: string;       // 现行有效 / 已修改 / 已废止
  publishDate: string;
  effectiveDate: string;
  issuingBody: string;
  url: string;
}

export async function searchFLK(keyword: string): Promise<StatuteSearchResult[]> {
  const ck = cacheKey('flk', keyword);
  const cached = readCache(ck, 24 * 60 * 60 * 1000);
  if (cached) return cached;

  const results: StatuteSearchResult[] = [];

  const html = await fetchWithUA(
    `https://flk.npc.gov.cn/search.html?keyword=${encodeURIComponent(keyword)}`,
    12000,
  );

  if (html) {
    try {
      // Try to find embedded JSON data
      const dataRe = /(?:var|let|const)\s+\w+\s*=\s*(\[[\s\S]*?\]);/;
      const match = html.match(dataRe);
      if (match) {
        const list = JSON.parse(match[1]);
        for (const item of list) {
          results.push({
            title: item.title || item.name || '',
            docId: item.id || '',
            status: item.status || item.effectiveness || '未知',
            publishDate: item.publishDate || '',
            effectiveDate: item.effectiveDate || '',
            issuingBody: item.issuingBody || '全国人民代表大会',
            url: `https://flk.npc.gov.cn/detail.html?${item.id || ''}`,
          });
        }
      }
    } catch { /* HTML parse fallback */ }
  }

  writeCache(ck, results);
  return results;
}

// ── 住建部合同模板 (mohurd.gov.cn) ─────────────────────────────────────

export interface ContractTemplate {
  title: string;
  category: string;
  url: string;
  publishDate: string;
}

const MOHURD_TEMPLATES: ContractTemplate[] = [
  { title: '建设工程施工合同（示范文本）', category: '工程建设', url: 'https://www.mohurd.gov.cn/gongkai/zhengce/zhengcefilelib/', publishDate: '2017' },
  { title: '商品房买卖合同（预售）示范文本', category: '房地产', url: 'https://www.mohurd.gov.cn/gongkai/zhengce/zhengcefilelib/', publishDate: '2014' },
  { title: '商品房买卖合同（现售）示范文本', category: '房地产', url: 'https://www.mohurd.gov.cn/gongkai/zhengce/zhengcefilelib/', publishDate: '2014' },
  { title: '工程总承包合同（示范文本）', category: '工程建设', url: 'https://www.mohurd.gov.cn/gongkai/zhengce/zhengcefilelib/', publishDate: '2020' },
  { title: '建筑工人简易劳动合同（示范文本）', category: '劳动合同', url: 'https://www.mohurd.gov.cn/gongkai/zhengce/zhengcefilelib/', publishDate: '2024' },
  { title: '物业临时管理规约（示范文本）', category: '物业管理', url: 'https://www.mohurd.gov.cn/gongkai/zhengce/zhengcefilelib/', publishDate: '2023' },
];

export async function searchMOHURDTemplates(keyword?: string): Promise<ContractTemplate[]> {
  if (!keyword) return MOHURD_TEMPLATES;
  const kw = keyword.toLowerCase();
  return MOHURD_TEMPLATES.filter(
    t => t.title.includes(kw) || t.category.includes(kw),
  );
}

// ── 企查查 (qcc.com) — 企业信息查询 ───────────────────────────────────

export interface CompanyInfo {
  name: string;
  legalPerson: string;
  registeredCapital: string;
  status: string;
  establishDate: string;
  unifiedCode: string;
  address: string;
  businessScope: string;
  shareholders: { name: string; ratio: number; type: string }[];
  branches: string[];
  riskInfo: {
    enforcementCount: number;
    dishonestyCount: number;
    restrictionsCount: number;
  };
  url: string;
  sourceMode?: 'api' | 'authorized_browser' | 'manual';
  sourceName?: string;
  queriedAt?: string;
}

function qichachaHeaders(config: ReturnType<typeof qichachaConfig>): Record<string, string> {
  const timespan = String(Date.now());
  const token = crypto
    .createHash('md5')
    .update(`${config.appKey}${timespan}${config.secretKey}`)
    .digest('hex');
  return {
    Token: token,
    Timespan: timespan,
    Accept: 'application/json',
  };
}

function pickQichachaResult(data: any): any {
  const result = data?.Result ?? data?.result ?? data?.Data ?? data?.data;
  if (Array.isArray(result)) return result[0];
  if (Array.isArray(result?.Result)) return result.Result[0];
  if (Array.isArray(result?.Items)) return result.Items[0];
  if (Array.isArray(result?.items)) return result.items[0];
  return result || data;
}

function mapQichachaCompany(raw: any, keyword: string): CompanyInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const name = raw.Name || raw.name || raw.CompanyName || raw.companyName || raw.KeyNo || keyword;
  const keyNo = raw.KeyNo || raw.keyNo || raw.No || raw.id || encodeURIComponent(keyword);
  return {
    name,
    legalPerson: raw.OperName || raw.legalPersonName || raw.LegalPerson || raw.operName || '',
    registeredCapital: raw.RegistCapi || raw.registeredCapital || raw.RegisteredCapital || '',
    status: raw.Status || raw.regStatus || raw.StatusCode || raw.status || '',
    establishDate: raw.StartDate || raw.establishDate || raw.EstablishDate || '',
    unifiedCode: raw.CreditCode || raw.unifiedCode || raw.CreditNo || raw.No || '',
    address: raw.Address || raw.address || '',
    businessScope: raw.Scope || raw.businessScope || raw.BusinessScope || '',
    shareholders: (raw.Shareholders || raw.shareholders || raw.Partners || []).map((s: any) => ({
      name: s.Name || s.name || s.StockName || '',
      ratio: Number.parseFloat(String(s.Ratio || s.ratio || s.StockPercent || 0)) || 0,
      type: s.Type || s.type || s.StockType || '',
    })),
    branches: raw.Branches || raw.branches || [],
    riskInfo: {
      enforcementCount: Number(raw.EnforcementCount || raw.enforcementCount || raw.ZhiXingCount || 0),
      dishonestyCount: Number(raw.DishonestyCount || raw.dishonestyCount || raw.ShiXinCount || 0),
      restrictionsCount: Number(raw.RestrictionsCount || raw.restrictionsCount || raw.XianGaoCount || 0),
    },
    url: `https://www.qcc.com/firm/${keyNo}.html`,
    sourceMode: 'api',
    sourceName: '企查查开放平台 API',
    queriedAt: new Date().toISOString(),
  };
}

async function searchQichachaCompany(keyword: string): Promise<CompanyInfo | null> {
  const ck = cacheKey('qcc', keyword);
  const cached = readCache(ck, 6 * 60 * 60 * 1000);
  if (cached) return cached;

  const config = qichachaConfig();
  if (config.configured) {
    try {
      const endpoint = `${config.baseUrl}/ECIV4/GetBasicDetailsByName?key=${encodeURIComponent(keyword)}`;
      const res = await fetch(endpoint, {
        headers: qichachaHeaders(config),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = await res.json();
        const status = String(data?.Status || data?.status || data?.Code || data?.code || '');
        if (!status || /^200$|^0$/i.test(status)) {
          const info = mapQichachaCompany(pickQichachaResult(data), keyword);
          if (info) {
            writeCache(ck, info);
            return info;
          }
        }
      }
    } catch { /* API failed; use authorized browser workflow outside this connector */ }
  }

  return null;
}

function formatMaybeDate(value: any): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 10_000_000_000) {
      return new Date(n).toISOString().slice(0, 10);
    }
  }
  return String(value);
}

function tianyanchaEndpoint(baseUrl: string): string {
  if (/\/services\/|\/api\//i.test(baseUrl)) return baseUrl;
  return `${baseUrl}/services/open/ic/baseinfoV2/2.0`;
}

function mapTianyanchaCompany(raw: any, keyword: string): CompanyInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const name = raw.name || raw.companyName || raw.Name || keyword;
  const id = raw.id || raw.companyId || raw.cid || encodeURIComponent(keyword);
  return {
    name,
    legalPerson: raw.legalPersonName || raw.legalPerson || raw.operName || raw.OperName || '',
    registeredCapital: raw.regCapital || raw.registeredCapital || raw.regCapitalAmount || '',
    status: raw.regStatus || raw.status || raw.Status || '',
    establishDate: formatMaybeDate(raw.estiblishTime || raw.establishDate || raw.fromTime),
    unifiedCode: raw.creditCode || raw.socialStaffNum || raw.unifiedCode || '',
    address: raw.regLocation || raw.address || '',
    businessScope: raw.businessScope || raw.scope || '',
    shareholders: (raw.shareholders || raw.holderList || raw.investorList || []).map((s: any) => ({
      name: s.name || s.shareholderName || s.investorName || '',
      ratio: Number.parseFloat(String(s.percent || s.ratio || s.capitalRatio || 0)) || 0,
      type: s.type || s.shareholderType || '',
    })),
    branches: raw.branches || raw.branchList || [],
    riskInfo: {
      enforcementCount: Number(raw.zhixingCount || raw.enforcementCount || raw.executeCount || 0),
      dishonestyCount: Number(raw.shixinCount || raw.dishonestyCount || 0),
      restrictionsCount: Number(raw.xiangaoCount || raw.restrictionsCount || 0),
    },
    url: raw.url || `https://www.tianyancha.com/company/${id}`,
    sourceMode: 'api',
    sourceName: '天眼查开放平台 API',
    queriedAt: new Date().toISOString(),
  };
}

async function searchTianyanchaCompany(keyword: string): Promise<CompanyInfo | null> {
  const config = tianyanchaConfig();
  if (!config.configured) return null;
  const ck = cacheKey('tianyancha', keyword);
  const cached = readCache(ck, 6 * 60 * 60 * 1000);
  if (cached) return cached;

  const endpoint = appendQuery(tianyanchaEndpoint(config.baseUrl), { keyword });
  const data = await fetchJsonWithTimeout(endpoint, {
    headers: {
      Accept: 'application/json',
      Authorization: config.apiKey,
    },
  }, 8000);
  if (!data) return null;

  const code = String(data?.error_code ?? data?.errorCode ?? data?.code ?? data?.Code ?? '');
  if (code && !/^0$|^200$/i.test(code)) return null;
  const raw = data?.result ?? data?.data ?? data?.Result ?? data;
  const info = mapTianyanchaCompany(raw, keyword);
  if (info) writeCache(ck, info);
  return info;
}

export async function searchCompanySources(keyword: string, sourceIds?: string[]): Promise<CompanyInfo[]> {
  const results: CompanyInfo[] = [];
  if (isSelectedSource(sourceIds, 'qichacha', ['qcc', '企查查'])) {
    const qcc = await searchQichachaCompany(keyword);
    if (qcc) results.push(qcc);
  }
  if (isSelectedSource(sourceIds, 'tianyancha', ['tyc', '天眼查'])) {
    const tyc = await searchTianyanchaCompany(keyword);
    if (tyc) results.push(tyc);
  }

  const seen = new Set<string>();
  return results.filter(item => {
    const key = `${item.sourceName}:${item.unifiedCode || item.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function searchCompany(keyword: string): Promise<CompanyInfo | null> {
  const results = await searchCompanySources(keyword);
  return results[0] || null;
}

// ── 全国法院被执行人信息 (zhixing.court.gov.cn) ───────────────────────

export interface EnforcementRecord {
  caseNumber: string;
  court: string;
  filingDate: string;
  subjectName: string;
  subjectType: string;
  executionTarget: string;
  status: string;
  url: string;
}

export async function searchEnforcementRecords(subjectName: string): Promise<EnforcementRecord[]> {
  const ck = cacheKey('zhixing', subjectName);
  const cached = readCache(ck, 6 * 60 * 60 * 1000);
  if (cached) return cached;

  const results: EnforcementRecord[] = [];
  const html = await fetchWithUA(
    `https://zhixing.court.gov.cn/search/?searchType=1&name=${encodeURIComponent(subjectName)}`,
    12000,
  );

  if (html) {
    try {
      const dataRe = /(?:var|const|let)\s+\w+\s*=\s*(\[[\s\S]*?\]);/;
      const match = html.match(dataRe);
      if (match) {
        const list = JSON.parse(match[1]);
        for (const item of list) {
          results.push({
            caseNumber: item.caseCode || item.caseNumber || '',
            court: item.courtName || '',
            filingDate: item.filingDate || item.executionDate || '',
            subjectName: item.name || item.partyName || subjectName,
            subjectType: item.type || item.partyType || '',
            executionTarget: item.executionTarget || item.enforceAmount || '',
            status: item.status || '',
            url: `https://zhixing.court.gov.cn/detail?id=${item.id || ''}`,
          });
        }
      }
    } catch { /* parse failed */ }
  }

  writeCache(ck, results);
  return results;
}
