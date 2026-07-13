import { getLocale, type Locale } from '../../runtime';

export type ChinaLegalDataSourceId = 'qichacha' | 'tianyancha' | 'pkulaw' | 'farui';
export type ChinaLegalBrowserSourceId = 'fachan' | 'alpha' | 'wenshu' | 'courtCases' | 'enterpriseCredit';

export interface ChinaLegalDataSourceField {
  keyName: string;
  label: string;
  kind: 'secret' | 'url';
  placeholder: string;
  required?: boolean;
}

export interface ChinaLegalDataSourceDefinition {
  id: ChinaLegalDataSourceId;
  mode: 'api' | 'browser';
  fields: ChinaLegalDataSourceField[];
}

export const CHINA_LEGAL_DATA_SOURCES: ChinaLegalDataSourceDefinition[] = [
  {
    id: 'qichacha',
    mode: 'api',
    fields: [
      { keyName: 'QICHACHA_APP_KEY', label: 'App Key', kind: 'secret', placeholder: 'QICHACHA_APP_KEY', required: true },
      { keyName: 'QICHACHA_SECRET_KEY', label: 'Secret Key', kind: 'secret', placeholder: 'QICHACHA_SECRET_KEY', required: true },
      { keyName: 'QICHACHA_BASE_URL', label: 'Base URL', kind: 'url', placeholder: 'https://api.qichacha.com' },
    ],
  },
  {
    id: 'tianyancha',
    mode: 'api',
    fields: [
      { keyName: 'TIANYANCHA_API_KEY', label: 'API Key', kind: 'secret', placeholder: 'TIANYANCHA_API_KEY', required: true },
      { keyName: 'TIANYANCHA_BASE_URL', label: 'Base URL', kind: 'url', placeholder: 'https://open.api.tianyancha.com' },
    ],
  },
  {
    id: 'pkulaw',
    mode: 'api',
    fields: [
      { keyName: 'PKULAW_API_KEY', label: 'API Key', kind: 'secret', placeholder: 'PKULAW_API_KEY' },
      { keyName: 'PKULAW_TOKEN', label: 'Token', kind: 'secret', placeholder: 'PKULAW_TOKEN' },
      { keyName: 'PKULAW_BASE_URL', label: 'API Base URL', kind: 'url', placeholder: 'https://...' },
      { keyName: 'PKULAW_MCP_URL', label: 'MCP URL', kind: 'url', placeholder: 'https://mcp.pkulaw.com/...' },
    ],
  },
  {
    id: 'farui',
    mode: 'api',
    fields: [
      { keyName: 'FARUI_API_KEY', label: 'API Key', kind: 'secret', placeholder: 'FARUI_API_KEY', required: true },
      { keyName: 'FARUI_BASE_URL', label: 'Base URL', kind: 'url', placeholder: 'https://...', required: true },
    ],
  },
];

export const CHINA_LEGAL_BROWSER_SOURCE_IDS: ChinaLegalBrowserSourceId[] = [
  'fachan',
  'alpha',
  'wenshu',
  'courtCases',
  'enterpriseCredit',
];

const CHINA_LEGAL_COPY = {
  en: {
    material: 'Material',
    unnamedCase: 'Untitled case',
    assetTraceCaseType: 'Enforcement / asset preservation',
    bidCaseType: 'Tender / bid response',
    contractReviewCaseType: 'Contract review',
    dataSources: {
      qichacha: { label: 'Qichacha', boundary: 'Official API integration; falls back to authorized browser collaboration when unconfigured.' },
      tianyancha: { label: 'Tianyancha', boundary: 'Official API integration for company profiles, registry records, and risk lookup.' },
      pkulaw: { label: 'PKULaw', boundary: 'Authorized API or MCP gateway for statutes, cases, and legal authorities.' },
      farui: { label: 'Tongyi Farui', boundary: 'Explicit authorized gateway; requires FARUI_API_KEY and FARUI_BASE_URL for automatic lookup.' },
    },
    browserSources: {
      fachan: 'Fachan',
      alpha: 'Alpha',
      wenshu: 'China Judgments Online',
      courtCases: "People's Courts Case Database",
      enterpriseCredit: 'National Enterprise Credit Information Publicity System',
    },
    meeting: {
      title: 'Client meeting',
      case: 'Case',
      started: 'Started',
      ended: 'Ended',
      summary: 'Lumi meeting summary',
      noSummary: 'No summary is available.',
      transcript: 'Raw transcript',
      noTranscript: 'No transcript is available.',
      boundary: 'Professional boundary',
      boundaryText: 'This record assists legal analysis. A licensed lawyer must approve final legal advice and external documents.',
    },
  },
  zh: {
    material: '材料',
    unnamedCase: '未命名案件',
    assetTraceCaseType: '执行/财产保全',
    bidCaseType: '投标/招标文件响应',
    contractReviewCaseType: '合同审查',
    dataSources: {
      qichacha: { label: '企查查', boundary: '官方 API 接入；未配置时使用授权网页登录协作。' },
      tianyancha: { label: '天眼查', boundary: '官方 API 接入；用于企业主体、工商和风险信息查询。' },
      pkulaw: { label: '北大法宝', boundary: '授权 API/MCP 网关；用于法规、案例和法条依据检索。' },
      farui: { label: '通义法睿', boundary: '显式授权网关；必须配置 FARUI_API_KEY 和 FARUI_BASE_URL 才会自动查询。' },
    },
    browserSources: {
      fachan: '法蝉',
      alpha: 'Alpha',
      wenshu: '中国裁判文书网',
      courtCases: '人民法院案例库',
      enterpriseCredit: '国家企业信用信息公示系统',
    },
    meeting: {
      title: '当事人会谈',
      case: '案件',
      started: '开始',
      ended: '结束',
      summary: 'Lumi 会谈整理',
      noSummary: '暂无整理结果。',
      transcript: '原始转写',
      noTranscript: '暂无转写。',
      boundary: '安全边界',
      boundaryText: '本记录用于辅助律师分析，最终法律意见与对外文书由执业律师确认。',
    },
  },
} as const;

export function chinaLegalCopy(locale: Locale = getLocale()) {
  return CHINA_LEGAL_COPY[locale];
}

export const CHINA_LEGAL_TOOL_COPY = {
  noticeLinkMaterial: '短信/法院通知链接材料',
  clientOrParty: '委托人/当事人',
  party: '当事人',
  sparseEngagementFacts: '当前案件档案信息较少，请生成通用委托书/代理手续草稿。',
  engagementClaim: '生成律师委托/代理手续草稿，包含委托事项、授权范围、费用/风险提示占位、双方信息、签署栏和附件清单。',
  sparseReasoningFacts: '当前案件材料较少，请先形成可复核的三段论分析框架，并列出待补事实、证据和法源。',
} as const;

export function buildChinaLegalCaseProfile(caseFile: any, stageLabel: string): string {
  return [
    caseFile?.title && `案件名称：${caseFile.title}`,
    caseFile?.caseNumber && `案号：${caseFile.caseNumber}`,
    caseFile?.party && `当事人：${caseFile.party}`,
    caseFile?.cause && `案由：${caseFile.cause}`,
    caseFile?.court && `法院：${caseFile.court}`,
    caseFile?.judge && `承办法官：${caseFile.judge}`,
    caseFile?.stage && `阶段：${stageLabel || caseFile.stage}`,
    caseFile?.notes && `事实摘要/待补材料：\n${caseFile.notes}`,
    Array.isArray(caseFile?.materials) && caseFile.materials.length > 0
      && `已归档材料：\n${caseFile.materials.slice(0, 8).map((item: any) => `- ${item.title}（${item.type}）`).join('\n')}`,
  ].filter(Boolean).join('\n');
}

export function inferChinaLegalDocumentType(title: string, type?: string): string {
  if (/起诉状|complaint/i.test(title)) return '起诉状';
  if (/答辩状|answer|defen[cs]e/i.test(title)) return '答辩状';
  if (/质证|evidence\s+objection/i.test(title)) return '质证意见';
  if (/代理词|argument/i.test(title)) return '代理词';
  if (/法律意见|legal\s+(?:opinion|memo)/i.test(title)) return '法律意见书';
  if (/合同|contract/i.test(title) || type === 'contract') return '合同文本';
  if (/标书|投标|tender|bid/i.test(title)) return '投标书';
  if (/证据目录|evidence\s+(?:index|catalog)/i.test(title) || type === 'evidence') return '证据目录';
  return '法律工作底稿';
}

export interface ChinaContractRisk {
  level: 'high' | 'medium' | 'low';
  clause: string;
  reason: string;
  suggestion: string;
  statuteRef: string;
}

function inferContractRiskLevel(text: string): ChinaContractRisk['level'] {
  if (/高风险|重大|无效|违法|解除|赔偿|High/i.test(text)) return 'high';
  if (/低风险|轻微|提示|Low/i.test(text)) return 'low';
  return 'medium';
}

function extractContractField(block: string, labels: string[]): string {
  for (const label of labels) {
    const pattern = new RegExp(`(?:^|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*[:：]\\s*([^\\n]+)`, 'i');
    const match = block.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

export function parseChinaContractRisks(text: string): ChinaContractRisk[] {
  const risks: ChinaContractRisk[] = [];
  const blocks = text
    .split(/\n(?=\s*(?:[-*]\s*)?(?:\d+[.、)]\s*)?(?:\[?(?:高风险|中风险|低风险|High Risk|Medium Risk|Low Risk)|风险等级|风险条款|⚠️))/i)
    .map(item => item.trim())
    .filter(Boolean);

  for (const block of blocks) {
    const clause = extractContractField(block, ['条款', '问题', 'Clause'])
      || block.split('\n')[0].replace(/^\s*(?:[-*]\s*)?(?:\d+[.、)]\s*)?/, '').replace(/^⚠️\s*/, '').slice(0, 120);
    if (clause.length < 6) continue;
    risks.push({
      level: inferContractRiskLevel(block),
      clause,
      reason: extractContractField(block, ['理由', '原因', '法律依据', 'Reason']),
      suggestion: extractContractField(block, ['建议', '修改建议', 'Suggestion']),
      statuteRef: extractContractField(block, ['法条', '依据', 'Law']),
    });
  }

  if (risks.length === 0) {
    const lines = text.split('\n').map(line => line.trim())
      .filter(line => /风险|违约|无效|解除|赔偿|管辖|仲裁|责任|瑕疵|Risk/i.test(line))
      .slice(0, 20);
    for (const line of lines) {
      risks.push({
        level: inferContractRiskLevel(line),
        clause: line.replace(/^\s*(?:[-*]\s*)?(?:\d+[.、)]\s*)?/, '').replace(/^⚠️\s*/, '').slice(0, 120),
        reason: '',
        suggestion: '',
        statuteRef: '',
      });
    }
  }
  return risks.slice(0, 20);
}

export interface ChinaCaseSearchResult {
  articleId: string;
  title: string;
  caseNumber?: string;
  court?: string;
  chunk: string;
  score: number;
  date?: string;
}

export function parseChinaCaseSearchResults(text: string): ChinaCaseSearchResult[] {
  const parsed: ChinaCaseSearchResult[] = [];
  let current: Partial<ChinaCaseSearchResult> = {};
  for (const line of text.split('\n')) {
    const titleMatch = line.match(/^\d+\.\s*\*\*(.+?)\*\*\s*(?:\[(?:相似度|Similarity)[:：]\s*([\d.]+)\])?/i);
    if (titleMatch) {
      if (current.title) parsed.push(current as ChinaCaseSearchResult);
      current = { title: titleMatch[1].trim(), score: titleMatch[2] ? Number.parseFloat(titleMatch[2]) : 0, articleId: '', chunk: '' };
      continue;
    }
    const caseNumber = line.match(/(?:案号|Case\s*(?:number|no\.?))[:：]\s*([^|]+)/i);
    const court = line.match(/(?:法院|Court)[:：]\s*([^|]+)/i);
    const summary = line.match(/(?:摘要|Summary)[:：]\s*(.+)/i);
    if (caseNumber) current.caseNumber = caseNumber[1].trim();
    else if (court) current.court = court[1].trim();
    else if (summary) current.chunk = summary[1].trim();
    else if (current.title && line.trim()) current.chunk = [current.chunk, line.trim()].filter(Boolean).join('\n');
  }
  if (current.title) parsed.push(current as ChinaCaseSearchResult);
  return parsed;
}
