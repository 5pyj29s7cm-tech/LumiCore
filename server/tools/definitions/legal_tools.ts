import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { ToolRegistry } from '../registry';
import { parseDocument, extractLegalMetadata } from '../../legal/parser';
import {
  createLegalArticle, indexLegalArticle,
  searchSimilarCases, searchStatutes, verifyCitation, verifyMultipleCitations,
  type CitationCheck,
  type LegalArticleType,
} from '../../legal/kb';
import {
  searchWenshu, searchFLK, searchMOHURDTemplates,
  searchCompany, searchCompanySources, searchEnforcementRecords, listLegalSourceCapabilities,
  searchLegalAuthorityDatabase, type ExternalLegalSearchKind,
} from '../../legal/sources';
import { generateEmbedding } from '../../memory/store';
import { makeLLMCall, type NormalizedMessage } from '../../llm/providers';
import { getUserPreferredLLMConfig } from '../../llm/user_preferences';
import * as LegalCases from '../../org/legal_cases';

async function runLegalLLM(prompt: string, context?: any, maxTokens = 2048): Promise<string | null> {
  const getters = context?.llmGetters;
  if (!getters) return null;
  const userId = context?.userId || 'anonymous';
  const messages: NormalizedMessage[] = [{ role: 'user', content: prompt }];
  const response = await makeLLMCall(
    messages,
    [],
    getUserPreferredLLMConfig(userId, { maxTokens, domain: context?.domain, orgId: context?.orgId }),
    getters.getDeepSeek,
    getters.getGemini,
    getters.getOpenAI,
    getters.getAnthropic,
    getters.getQwen,
    getters.getOllama,
    getters.getLmStudio,
    getters.getArk,
    getters.getXiaomi,
    getters.getKimi,
    getters.getGlm,
    getters.getRelay,
  );
  return response.text || null;
}

const EXTERNAL_LEGAL_SOURCES = [
  {
    label: '国家法律法规数据库',
    presetId: '',
    url: 'https://flk.npc.gov.cn/',
    use: '核验现行有效法律、行政法规、司法解释引用状态',
  },
  {
    label: '人民法院案例库',
    presetId: 'people-court-case-library',
    url: 'https://rmfyalk.court.gov.cn/',
    use: '优先检索权威案例、参考案例和裁判规则',
  },
  {
    label: '中国裁判文书网',
    presetId: 'china-judgments-online',
    url: 'https://wenshu.court.gov.cn/',
    use: '检索同案由、同争议焦点、同法院层级的公开裁判文书',
  },
  {
    label: '法蝉',
    presetId: 'fachan',
    url: 'https://www.fachans.com/',
    use: '在律所授权账号内补充商业库案例、裁判规则和办案资料',
  },
  {
    label: 'Alpha',
    presetId: 'alpha-lawyer',
    url: 'https://alphalawyer.cn/',
    use: '在律所授权账号内补充案例检索、诉讼策略和办案协同资料',
  },
  {
    label: '企查查',
    presetId: 'qichacha',
    url: 'https://www.qcc.com/',
    use: '查询企业基本信息、股东结构、风险信息和财产线索',
  },
  {
    label: '国家企业信用信息公示系统',
    presetId: 'national-enterprise-credit',
    url: 'https://www.gsxt.gov.cn/',
    use: '核验企业登记、公示、经营异常等官方信息',
  },
  {
    label: '人民法院在线服务',
    presetId: 'court-online-service',
    url: 'https://zxfw.court.gov.cn/',
    use: '半自动立案材料组卷后，由律师人工登录、核对、提交',
  },
];

const LEGAL_REASONING_BASELINE = [
  '三段论是 Lumi 法律工作的核心基础：所有法律任务都必须先形成内部“大前提/小前提/涵摄结论”，再生成用户要求的工作产物。',
  '大前提：先核验现行有效法律、司法解释和可比类案；小前提：将事实、证据、举证责任和质证风险对应到具体法律要件；结论：完成涵摄、风险提示和文书表达。',
  '普通文书和聊天结果不要把“大前提/小前提/结论”“三段论”等方法论标题作为交付内容输出，除非用户明确要求法律分析底稿。',
  '所有未核验法条、未确认类案、未绑定证据的事实必须标注“待检索/待核验/待补证”。',
].join('\n');

function sanitizeLegalWorkProductOutput(text: string): string {
  return text
    .replace(/底层三段论|三段论检索框架|三段论/g, '法律分析框架')
    .replace(/大前提/g, '法律依据与裁判规则')
    .replace(/小前提/g, '事实与证据')
    .replace(/涵摄/g, '事实适用分析');
}

function textArg(args: Record<string, any>, key: string): string {
  return String(args[key] || '').trim();
}

function listArg(args: Record<string, any>, key: string): string[] {
  const value = args[key];
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '').split(/\n|,|;|，|；/).map(s => s.trim()).filter(Boolean);
}

function roleLabel(role: string): '原告' | '被告' | '通用' {
  if (/被告|被申请人|被上诉人|respondent|defendant/i.test(role)) return '被告';
  if (/原告|申请人|上诉人|plaintiff|claimant/i.test(role)) return '原告';
  return '通用';
}

function buildCaseContext(args: Record<string, any>): string {
  const fields = [
    ['案件名称', textArg(args, 'caseName')],
    ['我方身份', textArg(args, 'role')],
    ['案由/类型', textArg(args, 'caseType')],
    ['管辖/法院', textArg(args, 'court')],
    ['当事人', textArg(args, 'parties')],
    ['诉请/抗辩目标', textArg(args, 'claims') || textArg(args, 'objective')],
    ['事实摘要', textArg(args, 'facts')],
    ['证据材料', textArg(args, 'evidence')],
    ['对方材料', textArg(args, 'opponentMaterials')],
  ];
  return fields
    .filter(([, value]) => value)
    .map(([label, value]) => `- ${label}: ${value}`)
    .join('\n') || '- 待补充案件基础信息';
}

function buildSearchQueries(args: Record<string, any>): string[] {
  const caseType = textArg(args, 'caseType') || '民事纠纷';
  const issues = listArg(args, 'issues');
  const facts = textArg(args, 'facts');
  const seeds = [
    ...issues.map(issue => `${caseType} ${issue}`),
    `${caseType} 争议焦点 裁判规则`,
    `${caseType} 举证责任`,
    `${caseType} 诉讼时效`,
    `${caseType} 证据目录 证明目的`,
  ];
  if (/违约|合同|货款|交付|质量/.test(facts + caseType)) seeds.push(`${caseType} 违约责任 损失 违约金`);
  if (/劳动|工资|解除|加班/.test(facts + caseType)) seeds.push('劳动争议 违法解除 举证责任');
  if (/借款|利息|本金|转账/.test(facts + caseType)) seeds.push('民间借贷 转账凭证 借贷合意');
  return Array.from(new Set(seeds.map(s => s.trim()).filter(Boolean))).slice(0, 10);
}

function inferDisputeFocuses(args: Record<string, any>): string[] {
  const explicit = listArg(args, 'issues');
  if (explicit.length > 0) return explicit.slice(0, 8);

  const source = [
    textArg(args, 'caseType'),
    textArg(args, 'facts'),
    textArg(args, 'materials'),
    textArg(args, 'complaint'),
    textArg(args, 'evidence'),
    textArg(args, 'transcript'),
    textArg(args, 'trialNotes'),
  ].join(' ');

  if (/劳动|工资|解除|加班|社保|竞业/.test(source)) {
    return ['劳动关系及主体资格', '解除或处分行为是否合法', '工资报酬及补偿金额', '考勤、通知、规章制度和送达证据'];
  }
  if (/借款|本金|利息|转账|还款|担保/.test(source)) {
    return ['借贷合意是否成立', '款项交付与还款情况', '利息、违约金和担保责任', '诉讼时效与催收证据'];
  }
  if (/合同|货款|交付|质量|违约|发票|订单|签收/.test(source)) {
    return ['合同关系及履行事实', '付款条件是否成就及欠款金额', '质量异议或拒付抗辩是否成立', '违约责任、损失和违约金调整'];
  }
  if (/侵权|损害|过错|责任|赔偿|事故/.test(source)) {
    return ['侵权行为及过错认定', '损害事实与因果关系', '赔偿范围和金额依据', '责任比例和减免责事由'];
  }
  return ['法律关系与主体资格', '核心事实是否成立', '证据链完整性与举证责任', '责任承担方式和请求范围'];
}

function materialSummary(args: Record<string, any>): string {
  const entries = [
    ['起诉状/申请书', textArg(args, 'complaint')],
    ['证据材料', textArg(args, 'evidence')],
    ['庭审笔录/会议记录', textArg(args, 'transcript') || textArg(args, 'trialNotes')],
    ['案件材料', textArg(args, 'materials')],
    ['对方意见', textArg(args, 'opponentArguments') || textArg(args, 'opponentMaterials')],
  ].filter(([, value]) => value);

  if (entries.length === 0) return '- 待补充起诉状、证据、庭审笔录或其他案件材料';
  return entries
    .map(([label, value]) => `- ${label}: ${value.slice(0, 500)}`)
    .join('\n');
}

const LEGAL_MATERIAL_EXTENSIONS = new Set([
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.csv', '.txt', '.md', '.rtf',
]);
const LEGAL_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);
const NOTICE_LINK_MAX_BYTES = 25 * 1024 * 1024;

function extractFirstUrl(input: string): string {
  const match = input.match(/https?:\/\/[^\s<>"'，。；、）)\]]+/i);
  return match ? match[0].replace(/[。。，，；;、]+$/u, '') : '';
}

function safeFileSegment(input: string, fallback = 'material'): string {
  const cleaned = String(input || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 90);
  return cleaned || fallback;
}

function ensureLegalIntakeDir(orgId: string): string {
  const dir = path.join(process.cwd(), 'data', 'legal_intake', safeFileSegment(orgId || 'default', 'default'));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureLegalDeliveryRoot(orgId: string): string {
  const dir = path.join(process.cwd(), 'data', 'legal_delivery', safeFileSegment(orgId || 'default', 'default'));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureLegalExternalWorkspaceRoot(orgId: string): string {
  const dir = path.join(process.cwd(), 'data', 'legal_external_workspaces', safeFileSegment(orgId || 'default', 'default'));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function uniqueLegalFolder(baseDir: string, caseName: string, suffix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = safeFileSegment(`${stamp}_${caseName || 'legal'}_${suffix}`, `${stamp}_legal_${suffix}`);
  let candidate = path.join(baseDir, base);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(baseDir, `${base}_${counter}`);
    counter += 1;
  }
  fs.mkdirSync(candidate, { recursive: true });
  return candidate;
}

function resolveWritableOutputDir(input: string, fallbackRoot: string, caseName: string, suffix: string): string {
  if (input) {
    const resolved = path.resolve(expandLocalPath(input));
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }
  return uniqueLegalFolder(fallbackRoot, caseName, suffix);
}

function psEscape(value: string): string {
  return String(value).replace(/'/g, "''");
}

function markdownTitle(markdown: string, fallback: string): string {
  const line = markdown.split(/\r?\n/).find(item => /^#\s+/.test(item));
  return line ? line.replace(/^#\s+/, '').trim() : fallback;
}

function stripMarkdownTableDivider(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function normalizeFormalDocumentType(input: string): string {
  const raw = String(input || '').trim();
  if (/起诉|complaint/i.test(raw)) return '起诉状';
  if (/要素式/i.test(raw)) return '要素式诉状';
  if (/答辩|defense|answer/i.test(raw)) return '答辩状';
  if (/质证/i.test(raw)) return '质证意见';
  if (/证据目录/i.test(raw)) return '证据目录';
  if (/代理词|argument/i.test(raw)) return '代理词';
  if (/法律意见|opinion/i.test(raw)) return '法律意见书';
  if (/合同/i.test(raw)) return '合同文本';
  if (/标书|投标/i.test(raw)) return '投标书';
  return raw || '法律文书';
}

function normalizeMarkdownBody(content: string, title: string): string {
  const lines = String(content || '').replace(/\r/g, '').split('\n');
  if (lines[0]?.trim() === `# ${title}`) return lines.slice(1).join('\n').trim();
  return lines.join('\n').trim();
}

function buildFormalLegalMarkdown(args: Record<string, any>, content: string): string {
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const documentType = normalizeFormalDocumentType(textArg(args, 'documentType') || textArg(args, 'type'));
  const lawFirmName = textArg(args, 'lawFirmName') || '［律所名称］';
  const lawyerName = textArg(args, 'lawyerName') || '［承办律师］';
  const title = textArg(args, 'title') || `${caseName}${documentType}`;
  const body = normalizeMarkdownBody(sanitizeLegalWorkProductOutput(content), title);
  const reviewStatus = args.markDraft === false ? '律师确认稿' : '律师复核稿';

  return [
    `# ${title}`,
    '',
    `- 文书类型：${documentType}`,
    `- 案件名称：${caseName}`,
    `- 案由/类型：${textArg(args, 'caseType') || '待确认'}`,
    `- 我方身份：${textArg(args, 'role') || '待确认'}`,
    `- 拟提交/使用法院：${textArg(args, 'court') || '待确认'}`,
    `- 律所：${lawFirmName}`,
    `- 承办律师：${lawyerName}`,
    `- 生成时间：${new Date().toISOString()}`,
    `- 状态：${reviewStatus}，不得未经律师确认直接提交、签发或发送。`,
    '',
    '## 正文',
    '',
    body || '［正文待补充］',
    '',
    '## 律师复核清单',
    '',
    '- 核对当事人身份信息、送达地址、统一社会信用代码、联系方式。',
    '- 核对诉讼请求、抗辩目标、金额、利息、违约金、保全和管辖。',
    '- 核对所有事实是否有证据对应；不能对应的事实标注“待补证”。',
    '- 核对所有法条、司法解释和案例引用是否真实、现行有效、可用于本案。',
    '- 核对附件、页码、份数、签字盖章、授权范围、法院平台填写项。',
    '',
    '## 使用边界',
    '',
    '本文件由 Lumi 生成，仅作为律师工作底稿或复核稿。正式对外提交、签署、盖章、缴费、确认送达、撤回或承诺性操作，必须由律师或当事人亲自确认。',
    '',
  ].join('\n');
}

function formatCitationReportMarkdown(args: Record<string, any>, text: string, sourceLabel: string): string {
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const orgId = textArg(args, 'orgId') || undefined;
  const checks = verifyMultipleCitations(text, orgId);
  const statuteChecks = checks.filter(item => item.type === 'statute');
  const caseChecks = checks.filter(item => item.type === 'case');
  const missing = checks.filter(item => !item.exists);
  const repealed = checks.filter(item => item.isEffective === false);
  const statuteGateRisks = statuteChecks.filter(item => !item.exists || item.isEffective !== true);
  const valid = checks.filter(item => item.exists && item.isEffective !== false);

  const rows = checks.length
    ? checks.map((item, index) =>
      `| ${index + 1} | ${item.type === 'statute' ? '法条' : '案例'} | ${item.citation.replace(/\|/g, ' ')} | ${item.exists ? '存在' : '未确认'} | ${item.isEffective === null ? '不适用/待人工核验' : item.isEffective ? '现行有效' : '已废止'} | ${(item.source || 'N/A').replace(/\|/g, ' ')} | ${item.detail.replace(/\|/g, ' ')} |`,
    ).join('\n')
    : '| 1 | 无 | 未检测到《XX法》或案号格式引用 | 待补充 | 待核验 | N/A | 建议在正式文书中补充引用来源 |';

  return [
    `# ${caseName} 引用核验报告`,
    '',
    `- 来源材料：${sourceLabel}`,
    `- 生成时间：${new Date().toISOString()}`,
    `- 核验范围：法条引用、案号引用、是否存在、是否已废止、本地知识库是否收录。`,
    `- 核验边界：本报告不能替代律师最终检索；未在本地库命中的案例需到人民法院案例库/裁判文书网/法蝉/Alpha 等授权来源人工复核。`,
    '',
    '## 统计',
    '',
    `- 引用总数：${checks.length}`,
    `- 法条引用：${statuteChecks.length}`,
    `- 案例引用：${caseChecks.length}`,
    `- 已确认或可继续使用：${valid.length}`,
    `- 未确认存在：${missing.length}`,
    `- 已废止/失效风险：${repealed.length}`,
    `- 现行有效法律硬门槛：${statuteGateRisks.length === 0 ? '通过' : '未通过'}`,
    '',
    '## 明细',
    '',
    '| 序号 | 类型 | 引用 | 存在性 | 有效性 | 来源 | 说明 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    rows,
    '',
    '## 处理建议',
    '',
    '- 已废止法条不得直接作为现行法律依据，应替换为现行有效法律或司法解释。',
    '- 未确认案例不得写成“已有裁判支持”，应先完成来源登记和律师复核。',
    '- 最终文书应保留来源名称、发布日期/裁判日期、案号、法院层级、链接或下载文件路径。',
    '',
  ].join('\n');
}

interface CurrentLawGateResult {
  passed: boolean;
  checks: CitationCheck[];
  statuteChecks: CitationCheck[];
  blockingStatutes: CitationCheck[];
  missingCaseChecks: CitationCheck[];
}

interface LegalReasoningGateResult {
  passed: boolean;
  hasMajorPremise: boolean;
  hasMinorPremise: boolean;
  hasConclusion: boolean;
  missing: string[];
}

function evaluateCurrentLawGate(text: string, orgId?: string): CurrentLawGateResult {
  const checks = verifyMultipleCitations(text, orgId);
  const statuteChecks = checks.filter(item => item.type === 'statute');
  const blockingStatutes = statuteChecks.filter(item => !item.exists || item.isEffective !== true);
  const missingCaseChecks = checks.filter(item => item.type === 'case' && !item.exists);
  return {
    passed: blockingStatutes.length === 0,
    checks,
    statuteChecks,
    blockingStatutes,
    missingCaseChecks,
  };
}

function collectLegalReasoningGateText(args: Record<string, any>, sourceText: string): string {
  const keys = [
    'reasoningMatrix',
    'reasoningSummary',
    'legalReasoning',
    'archivedReasoning',
    'analysis',
    'legalAuthorities',
    'similarCases',
    'facts',
    'evidence',
    'materials',
    'claims',
    'issues',
    'content',
    'packetText',
    'documentText',
  ];
  const parts = [sourceText];
  for (const key of keys) {
    const value = args[key];
    if (Array.isArray(value)) parts.push(value.map(String).join('\n'));
    else if (value !== undefined && value !== null) parts.push(String(value));
  }
  return parts.join('\n\n');
}

function evaluateLegalReasoningGate(args: Record<string, any>, sourceText: string): LegalReasoningGateResult {
  const text = collectLegalReasoningGateText(args, sourceText);
  const explicitMatrix = /法律分析三段论底稿|三段论|大前提|小前提|涵摄|major\s+premise|minor\s+premise|subsumption|reasoning\s+matrix/i.test(text);
  const hasMajorPremise = explicitMatrix || /法律依据|现行有效法律|法条|司法解释|裁判规则|类案|法律适用|《[^》]{1,80}》|statute|legal\s+(?:authority|basis)|case\s+law/i.test(text);
  const hasMinorPremise = explicitMatrix || /事实|证据|待证|举证|质证|原告|被告|当事人|合同关系|履行|付款|交付|欠款|聊天记录|转账|发票|材料|facts?|evidence|proof/i.test(text);
  const hasConclusion = explicitMatrix || /结论|涵摄|适用|应当|请求|支持|承担|构成|成立|不成立|风险|代理意见|法律意见|据此|故|therefore|conclusion|application|liable/i.test(text);
  const missing = [
    hasMajorPremise ? '' : '大前提：现行有效法律、司法解释或类案裁判规则',
    hasMinorPremise ? '' : '小前提：待证事实、证据材料、举证质证',
    hasConclusion ? '' : '结论：涵摄适用、文书表达和风险',
  ].filter(Boolean);
  return {
    passed: hasMajorPremise && hasMinorPremise && hasConclusion,
    hasMajorPremise,
    hasMinorPremise,
    hasConclusion,
    missing,
  };
}

function findArchivedLegalReasoningGateText(args: Record<string, any>, orgId: string): string {
  const caseId = textArg(args, 'caseId');
  if (!caseId) return '';
  const caseFile = LegalCases.getCase(orgId, caseId);
  if (!caseFile) return '';
  const material = (caseFile.materials || []).find(item => {
    const haystack = `${item.title}\n${item.content || ''}`;
    return /法律分析三段论底稿|三段论|大前提|小前提|涵摄|reasoning\s+matrix|major\s+premise|minor\s+premise|subsumption/i.test(haystack);
  });
  if (!material) return '';
  return [
    `Archived reasoning material: ${material.title}`,
    material.localPath ? `Local path: ${material.localPath}` : '',
    material.content || '',
  ].filter(Boolean).join('\n');
}

function formatCitationList(items: CitationCheck[]): string[] {
  if (items.length === 0) return ['- 无'];
  return items.map(item => `- ${item.citation} | exists=${item.exists ? 'yes' : 'no'} | effective=${item.isEffective === null ? 'n/a' : item.isEffective ? 'yes' : 'no'} | source=${item.source || 'N/A'} | ${item.detail}`);
}

function formatCurrentLawGateBlock(args: {
  caseName: string;
  documentType: string;
  outputDir: string;
  reportPath: string;
  sourcePath: string;
  gate: CurrentLawGateResult;
}): string {
  return [
    `# ${args.caseName} current-law gate blocked`,
    '',
    `- Document type: ${args.documentType}`,
    `- Checked at: ${new Date().toISOString()}`,
    `- Output directory: ${args.outputDir}`,
    `- Citation report: ${args.reportPath}`,
    `- Source register: ${args.sourcePath}`,
    `- Statute citations checked: ${args.gate.statuteChecks.length}`,
    `- Blocking statute citations: ${args.gate.blockingStatutes.length}`,
    `- Missing case citations for lawyer review: ${args.gate.missingCaseChecks.length}`,
    '',
    '## Blocking Statutes',
    '',
    ...formatCitationList(args.gate.blockingStatutes),
    '',
    '## Missing Case Citations',
    '',
    ...formatCitationList(args.gate.missingCaseChecks),
    '',
    '## Required Fix',
    '',
    '- Replace repealed statutes with current effective law or judicial interpretations.',
    '- Verify unknown statutes against an authoritative source before generating the formal delivery package.',
    '- Re-run legal_finalize_delivery_package after the legal authority text is corrected.',
    '',
  ].join('\n');
}

const LEGAL_WORK_PRODUCT_GATE_FIELDS = [
  'legalAuthorities',
  'statutes',
  'authorities',
  'laws',
  'content',
  'text',
  'requirements',
  'contract',
  'details',
  'facts',
  'evidence',
  'materials',
  'complaint',
  'opponentMaterials',
  'opponentArguments',
  'transcript',
  'trialNotes',
  'claims',
  'objective',
];

function collectLegalWorkProductGateText(report: string, args: Record<string, any>): string {
  const parts = [report];
  for (const key of LEGAL_WORK_PRODUCT_GATE_FIELDS) {
    const value = args[key];
    if (Array.isArray(value)) parts.push(value.map(String).join('\n'));
    else if (value !== undefined && value !== null) parts.push(String(value));
  }
  return parts.join('\n\n');
}

function compactCitationListForPreflight(items: CitationCheck[], max = 6): string {
  if (items.length === 0) return '无';
  return items
    .slice(0, max)
    .map(item => item.citation)
    .join('；') + (items.length > max ? `；另 ${items.length - max} 项` : '');
}

function buildLegalWorkProductPreflightSection(
  report: string,
  args: Record<string, any>,
  orgId?: string,
): string {
  const gate = evaluateCurrentLawGate(collectLegalWorkProductGateText(report, args), orgId);
  const statuteStatus = legalReasoningGateStatus(gate);
  const blocking = compactCitationListForPreflight(gate.blockingStatutes);
  const missingCases = compactCitationListForPreflight(gate.missingCaseChecks);
  const deliveryRule = gate.passed
    ? '草稿可继续进入律师复核；正式对外文件仍必须运行 legal_finalize_delivery_package 生成来源登记和交付包。'
    : '存在已废止、失效或未确认的法条引用，不得标记为正式成果；需先替换或核验后再运行 legal_finalize_delivery_package。';

  return [
    '## 法律成果预检',
    `- 内部分析链路：已按“法律依据 / 事实证据 / 适用结论”组织工作稿；普通文书不展开方法论标题。`,
    `- 现行有效法律预检：${statuteStatus}（识别法条 ${gate.statuteChecks.length} 项，阻断 ${gate.blockingStatutes.length} 项）。`,
    `- 法条阻断项：${blocking}。`,
    `- 类案待复核项：${missingCases}。`,
    `- 正式交付规则：${deliveryRule}`,
  ].join('\n');
}

const LEGAL_CASE_SEARCH_ORDER = ['最高人民法院', '高级人民法院', '中级人民法院', '基层人民法院'];

function normalizeLegalCaseStage(input: string): LegalCases.LegalCaseStage {
  if (/立案|filing/i.test(input)) return 'filing';
  if (/开庭|庭审|trial/i.test(input)) return 'trial';
  if (/判决|judgment/i.test(input)) return 'judgment';
  if (/执行|enforcement/i.test(input)) return 'enforcement';
  if (/结案|closed/i.test(input)) return 'closed';
  return 'consultation';
}

function legalWorkflowStateLabel(state: LegalCases.LegalCaseWorkflowStepState): string {
  if (state === 'done') return '已完成';
  if (state === 'ready') return '可推进';
  if (state === 'blocked') return '阻断';
  if (state === 'manual') return '待人工确认';
  return '待补充';
}

function formatLegalWorkflowRows(steps: LegalCases.LegalCaseWorkflowStep[]): string {
  return steps.map(step => [
    step.label,
    legalWorkflowStateLabel(step.state),
    step.summary,
    step.nextStep,
    step.tool,
  ].map(value => String(value || '').replace(/\|/g, ' ')).join(' | ')).map(row => `| ${row} |`).join('\n');
}

function formatLegalWorkflowActionQueue(workflow: LegalCases.LegalCaseWorkflowEvaluation): string {
  const actionableStates = new Set<LegalCases.LegalCaseWorkflowStepState>(['blocked', 'ready', 'manual', 'missing']);
  const queue: LegalCases.LegalCaseWorkflowStep[] = [];
  const seen = new Set<string>();
  for (const step of [workflow.nextStep, ...workflow.steps]) {
    if (!step || seen.has(step.key) || !actionableStates.has(step.state)) continue;
    seen.add(step.key);
    queue.push(step);
    if (queue.length >= 5) break;
  }
  if (queue.length === 0) {
    return [
      '## 优先行动队列',
      '- 闭环已完成；继续做律师复核、来源留痕、归档和期限管理。',
    ].join('\n');
  }
  const clean = (value: unknown) => String(value || '').replace(/\|/g, ' ');
  return [
    '## 优先行动队列',
    '| 顺位 | 模块 | 状态 | 下一步 | 推荐工具 |',
    '| --- | --- | --- | --- | --- |',
    ...queue.map((step, index) => `| ${index + 1} | ${clean(step.label)} | ${clean(legalWorkflowStateLabel(step.state))} | ${clean(step.nextStep)} | ${clean(step.tool)} |`),
  ].join('\n');
}

function formatStandardLegalCaseworkSequence(): string {
  const rows = [
    ['01', 'Intake / case space', 'Archive messages, meetings, identity material, evidence, notice links, and local files into one case before drafting.', 'legal_message_intake_to_case -> legal_case_workspace -> legal_import_materials_to_kb'],
    ['02', 'Identity / facts', 'Confirm party identity, authority, service address, claims, jurisdiction, and a facts timeline.', 'legal_case_workspace -> legal_meeting_minutes_to_case'],
    ['03', 'Major premise', 'Retrieve current effective law, explain the rule, and reinforce it with ranked similar cases.', 'legal_search_statute -> legal_external_research_plan -> legal_search_external_authorities'],
    ['04', 'Minor premise', 'Map facts, evidence, proof purpose, burden of proof, authenticity, legality, relevance, and cross-examination risks.', 'legal_extract_dispute_focus -> legal_generate_litigation_packet'],
    ['05', 'Conclusion / subsumption', 'Apply the rule to the facts and turn it into complaint, defense, cross-exam notes, argument, or legal opinion drafts.', 'legal_case_reasoning_matrix -> legal_generate_argument_or_opinion'],
    ['06', 'Current-law gate', 'Before any formal document, verify citations and block repealed, invalid, or unverified statutes.', 'legal_generate_citation_verification_report -> legal_finalize_delivery_package'],
    ['07', 'Filing handoff', 'Prepare court-platform fields and upload lists; do not submit, sign, pay, confirm service, or commit settlement automatically.', 'legal_prepare_filing_handoff'],
    ['08', 'Delivery / archive', 'Generate the formal delivery package, source register, citation report, and organization knowledge archive.', 'legal_finalize_delivery_package -> legal_import_materials_to_kb'],
  ];
  return [
    '## Standard Legal Casework Sequence',
    '| Step | Stage | Required judgment | Tool chain |',
    '| --- | --- | --- | --- |',
    ...rows.map(row => `| ${row.map(value => value.replace(/\|/g, ' ')).join(' | ')} |`),
  ].join('\n');
}

function makeWorkspaceWorkflowCase(args: Record<string, any>, params: {
  orgId: string;
  caseName: string;
  role: string;
  caseType: string;
  court: string;
  parties: string;
  claims: string;
  facts: string;
  evidence: string;
  stage: LegalCases.LegalCaseStage;
}): Partial<LegalCases.OrgLegalCaseFile> {
  const materials = workspaceMaterialInputs(args).map((material, index) => ({
    id: `input-${index + 1}`,
    type: material.type,
    title: material.title,
    content: material.content,
    source: 'tool' as const,
    createdBy: 'system',
    createdAt: new Date().toISOString(),
  }));
  return {
    orgId: params.orgId,
    title: params.caseName,
    party: params.parties || params.role,
    cause: params.caseType,
    court: params.court,
    stage: params.stage,
    notes: [
      params.claims ? `办理目标：${params.claims}` : '',
      params.facts ? `事实摘要：${params.facts.slice(0, 2000)}` : '',
      params.evidence ? `证据摘要：${params.evidence.slice(0, 1200)}` : '',
    ].filter(Boolean).join('\n'),
    materials,
  };
}

function splitWorkspaceItems(value: string): string[] {
  return String(value || '')
    .split(/\r?\n|[;；]/)
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 30);
}

interface EvidenceReviewRow {
  index: number;
  name: string;
  fact: string;
  proofPurpose: string;
  authenticity: string;
  legality: string;
  relevance: string;
  gap: string;
}

function inferEvidenceFact(name: string, args: Record<string, any>): string {
  const caseType = textArg(args, 'caseType') || textArg(args, 'cause');
  const facts = textArg(args, 'facts') || textArg(args, 'materials');
  const text = `${name} ${caseType} ${facts}`;
  if (/合同|协议|订单|要约|确认书|contract|agreement|order/i.test(text)) return '合同关系、交易基础、权利义务内容';
  if (/发货|送货|签收|物流|收货|交付|delivery|receipt/i.test(text)) return '履行交付、收货确认、付款条件是否成就';
  if (/发票|银行|流水|转账|付款|收款|对账|invoice|bank|payment/i.test(text)) return '付款事实、欠款金额、资金往来和损失计算';
  if (/微信|聊天|短信|邮件|通知|催告|沟通|wechat|message|email/i.test(text)) return '通知催告、协商过程、质量异议或对方确认';
  if (/质量|验收|检测|异议|退货|维修|鉴定|inspection|quality/i.test(text)) return '质量异议、验收状态、拒付或减损抗辩基础';
  if (/起诉状|答辩状|证据目录|庭审|笔录|complaint|answer|transcript/i.test(text)) return '对方主张、争议焦点、程序事实和质证对象';
  return facts ? facts.slice(0, 80) : '待匹配待证事实';
}

function buildEvidenceReviewRows(args: Record<string, any>): EvidenceReviewRow[] {
  const evidence = textArg(args, 'evidence');
  const items = splitWorkspaceItems(evidence);
  const sourceItems = items.length > 0 ? items : ['待整理证据材料'];
  return sourceItems.map((rawName, index) => {
    const name = rawName.replace(/\|/g, ' ');
    const fact = inferEvidenceFact(name, args);
    return {
      index: index + 1,
      name,
      fact,
      proofPurpose: fact === '待匹配待证事实' ? '待填写证明目的' : `证明${fact}`,
      authenticity: '核对原件/形成时间/签章或电子数据原始载体',
      legality: '核对取得方式、授权来源、隐私与平台规则',
      relevance: '对应争议焦点和待证事实，排除无关材料',
      gap: name === '待整理证据材料' ? '需补充证据名称、来源、页码和原件状态' : '待补页码、原件状态、来源登记和反证风险',
    };
  });
}

function formatEvidenceReviewRows(rows: EvidenceReviewRow[]): string {
  return rows.map(row =>
    `| ${row.index} | ${row.name} | ${row.fact} | ${row.proofPurpose} | ${row.authenticity} | ${row.legality} | ${row.relevance} | ${row.gap} |`,
  ).join('\n');
}

function formatEvidenceGapList(rows: EvidenceReviewRow[]): string {
  return rows.map(row => `- ${row.index}. ${row.name}：${row.gap}`).join('\n');
}

function workspaceMaterialIndexRows(materials: LegalCases.OrgLegalCaseMaterial[]): string {
  if (!materials.length) return '| 1 | 待归集 | 待归集 | 待归集 | 待归集 |';
  return materials.slice(0, 20).map((material, index) =>
    `| ${index + 1} | ${material.type} | ${material.title.replace(/\|/g, ' ')} | ${material.source} | ${material.createdAt} |`,
  ).join('\n');
}

function workspaceMaterialInputs(args: Record<string, any>): Array<{ type: LegalCases.LegalCaseMaterialType; title: string; content: string }> {
  const entries: Array<{ type: LegalCases.LegalCaseMaterialType; title: string; content: string }> = [
    { type: 'note', title: '案件事实与时间线', content: textArg(args, 'facts') },
    { type: 'evidence', title: '证据材料与证明目的', content: textArg(args, 'evidence') },
    { type: 'pleading', title: '起诉状/答辩状/对方材料', content: textArg(args, 'complaint') || textArg(args, 'opponentMaterials') },
    { type: 'consultation', title: '庭审/会议/沟通记录', content: textArg(args, 'transcript') || textArg(args, 'trialNotes') },
    { type: 'note', title: '法条、类案与外部检索记录', content: textArg(args, 'legalAuthorities') || textArg(args, 'similarCases') },
  ];
  return entries.filter(item => item.content.trim());
}

function courtLevelRank(value: string): number {
  const text = String(value || '');
  if (/最高人民法院|最高法/.test(text)) return 0;
  if (/高级人民法院|高院/.test(text)) return 1;
  if (/中级人民法院|中院/.test(text)) return 2;
  if (/基层人民法院|基层法院|区人民法院|县人民法院|旗人民法院|市人民法院|人民法庭/.test(text)) return 3;
  return 4;
}

function appendLegalCaseMaterial(args: {
  orgId: string;
  userId: string;
  caseId: string;
  type: LegalCases.LegalCaseMaterialType;
  title: string;
  content: string;
  localPath?: string;
}): LegalCases.OrgLegalCaseMaterial | null {
  if (!args.caseId) return null;
  const caseFile = LegalCases.getCase(args.orgId, args.caseId);
  if (!caseFile) return null;
  return LegalCases.addMaterial(args.orgId, args.userId, args.caseId, {
    type: args.type,
    title: args.title,
    content: args.content,
    localPath: args.localPath,
    source: 'tool',
  });
}

function archiveLegalReportToCase(args: Record<string, any>, params: {
  orgId: string;
  userId: string;
  caseName: string;
  title: string;
  content: string;
  type?: LegalCases.LegalCaseMaterialType;
  cause?: string;
  court?: string;
  localPath?: string;
}): string {
  if (args.persistCase === false) return '- 案件空间：未归档（persistCase=false）';

  const explicitCaseId = textArg(args, 'caseId');
  const explicitCaseName = textArg(args, 'caseName') || textArg(args, 'title');
  const shouldArchive = args.persistCase === true || !!explicitCaseId || !!explicitCaseName;
  if (!shouldArchive) return '- 案件空间：未归档（未提供 caseId/caseName；设置 persistCase=true 可创建案件）';

  let caseFile = explicitCaseId ? LegalCases.getCase(params.orgId, explicitCaseId) : null;
  if (!caseFile && explicitCaseName) {
    caseFile = LegalCases.listCases(params.orgId, explicitCaseName, 1)[0] || null;
  }
  if (!caseFile && explicitCaseId && !explicitCaseName && args.persistCase !== true) {
    return '- 案件空间：未归档（caseId 不存在或无权限）';
  }
  if (!caseFile) {
    caseFile = LegalCases.createCase(params.orgId, params.userId, {
      title: explicitCaseName || params.caseName,
      party: textArg(args, 'parties') || roleLabel(textArg(args, 'role')),
      cause: params.cause || textArg(args, 'caseType') || textArg(args, 'cause'),
      court: params.court || textArg(args, 'court'),
      stage: normalizeLegalCaseStage(textArg(args, 'stage')),
      notes: params.content.slice(0, 3000),
    });
  }

  const material = LegalCases.addMaterial(params.orgId, params.userId, caseFile.id, {
    type: params.type || 'note',
    title: params.title,
    content: params.content,
    localPath: params.localPath,
    source: 'tool',
  });
  return material
    ? `- 案件空间：已归档 caseId=${caseFile.id} materialId=${material.id}`
    : `- 案件空间：未归档 caseId=${caseFile.id}`;
}

type LegalRemoteMessagePlatform = 'feishu' | 'wechat' | 'wecom' | 'sms' | 'other';

function normalizeLegalRemoteMessagePlatform(value: string): LegalRemoteMessagePlatform {
  if (/飞书|feishu|lark/i.test(value)) return 'feishu';
  if (/企微|企业微信|wecom|wxwork/i.test(value)) return 'wecom';
  if (/微信|wechat|weixin/i.test(value)) return 'wechat';
  if (/短信|sms/i.test(value)) return 'sms';
  return 'other';
}

function legalRemoteMessagePlatformLabel(platform: LegalRemoteMessagePlatform): string {
  if (platform === 'feishu') return '飞书';
  if (platform === 'wechat') return '微信';
  if (platform === 'wecom') return '企微';
  if (platform === 'sms') return '短信';
  return '远程消息';
}

function legalRemoteMessageMaterialSource(platform: LegalRemoteMessagePlatform): LegalCases.OrgLegalCaseMaterial['source'] {
  return platform === 'feishu' ? 'feishu' : 'import';
}

function extractAllUrls(input: string): string[] {
  const urls = Array.from(String(input || '').matchAll(/https?:\/\/[^\s<>"'，。；、）)\]]+/gi))
    .map(match => match[0].replace(/[。。，，；;、]+$/u, '').trim())
    .filter(Boolean);
  return Array.from(new Set(urls));
}

function listAttachmentNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(item => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      const record = item as Record<string, any>;
      return String(record.fileName || record.name || record.title || record.localPath || '').trim();
    }).filter(Boolean);
  }
  return String(value || '').split(/\n|,|;|；/).map(item => item.trim()).filter(Boolean);
}

function attachmentContentBlocks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (!item || typeof item !== 'object') return '';
    const record = item as Record<string, any>;
    const name = String(record.fileName || record.name || record.title || '未命名附件').trim();
    const text = String(record.extractedText || record.text || record.content || '').trim();
    const localPath = String(record.localPath || '').trim();
    const meta = [
      `## 附件：${name}`,
      localPath ? `- 本地缓存：${localPath}` : '',
      text ? '' : '- 正文：未抽取到可读文本',
      text,
    ].filter(Boolean);
    return meta.join('\n');
  }).filter(Boolean);
}

function extractCaseNameFromLegalMessage(message: string): string {
  const patterns = [
    /(?:归档|保存|入案|放入|放到|加入|新建|创建).{0,16}(?:案件|案号|卷宗)?[：:\s「《"]*([^，。；;\n」》"]{2,80})/,
    /(?:案件|案号|卷宗)[：:\s「《"]+([^，。；;\n」》"]{2,80})/,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) {
      return match[1]
        .replace(/^(里|中|内|为|是|材料|链接|短信|通知)/, '')
        .trim()
        .slice(0, 80);
    }
  }
  return '';
}

function extractSpecificCourtFromLegalMessage(message: string): string {
  const courts = Array.from(String(message || '').matchAll(/[\u4e00-\u9fa5]{2,40}(?:人民法院|法院)/g))
    .map(match => match[0])
    .filter(candidate => !['人民法院', '法院'].includes(candidate))
    .sort((a, b) => b.length - a.length);
  return courts[0] || '';
}

function appendLegalWorkProductArchiveSection(
  report: string,
  args: Record<string, any>,
  context: any,
  params: {
    caseName: string;
    title: string;
    type?: LegalCases.LegalCaseMaterialType;
    cause?: string;
    court?: string;
    localPath?: string;
  },
): string {
  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const preflightSection = buildLegalWorkProductPreflightSection(report, args, orgId);
  const archivedContent = `${report}\n\n${preflightSection}`;
  const caseLine = archiveLegalReportToCase(args, {
    orgId,
    userId,
    caseName: params.caseName,
    title: params.title,
    content: archivedContent,
    type: params.type || 'note',
    cause: params.cause,
    court: params.court,
    localPath: params.localPath,
  });

  return `${archivedContent}

## 案件归档与交付边界
${caseLine}
- 内部法律分析：已完成基础事实、证据、法源和风险的工作稿衔接；正式对外使用前必须完成现行有效法律、证据三性、类案和来源复核。
- 正式交付：继续使用 legal_finalize_delivery_package 触发现行有效法律硬门槛和来源登记。`;
}

function meetingSignalBullets(text: string, keywords: RegExp, fallback: string): string[] {
  const lines = String(text || '')
    .split(/\r?\n|[。！？；;]+/)
    .map(line => line.trim())
    .filter(line => line.length >= 6);
  const picked = lines.filter(line => keywords.test(line)).slice(0, 10);
  const source = picked.length ? picked : lines.slice(0, 8);
  return source.length ? source.map(line => `- ${line.slice(0, 180)}`) : [`- ${fallback}`];
}

function buildLegalMeetingMinutesMarkdown(args: Record<string, any>): string {
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const transcript = textArg(args, 'transcript') || textArg(args, 'meetingText') || textArg(args, 'notes');
  const participants = textArg(args, 'participants') || '待补充';
  const meetingTime = textArg(args, 'meetingTime') || new Date().toISOString();
  const objective = textArg(args, 'objective') || textArg(args, 'claims') || '待律师确认';
  const factSignals = meetingSignalBullets(transcript, /合同|付款|交付|质量|借款|工资|解除|侵权|损失|时间|经过|事实|争议|claim|fact/i, '待从会议记录中补充事实线索');
  const evidenceSignals = meetingSignalBullets(transcript, /证据|合同|发票|流水|转账|聊天|微信|短信|邮件|录音|照片|签收|送货|检测|鉴定|原件|evidence|document/i, '待从会议记录中补充证据线索');
  const issueSignals = meetingSignalBullets(transcript, /争议|焦点|对方|抗辩|质证|管辖|时效|责任|违约|赔偿|风险|issue|risk/i, '待从会议记录中提炼争议焦点');
  const deadlineSignals = meetingSignalBullets(transcript, /开庭|举证|答辩|上诉|立案|提交|缴费|送达|截止|期限|日期|deadline|hearing|file/i, '暂未识别明确期限，需人工确认');

  return `# ${caseName} 法律会议纪要

- 会议时间：${meetingTime}
- 参会/沟通人员：${participants}
- 办理目标：${objective}
- 生成时间：${new Date().toISOString()}
- 状态：律师复核稿；不得直接作为最终法律意见、承诺或对外提交文本。

## 一、沟通要点
${meetingSignalBullets(transcript, /./, '待补充会议沟通内容').join('\n')}

## 二、案件事实线索
${factSignals.join('\n')}

## 三、证据线索与三性提示
${evidenceSignals.join('\n')}

| 核验项 | 会议后处理 |
| --- | --- |
| 真实性 | 核对原件、形成时间、签章、电子数据原始载体、聊天/邮件导出方式 |
| 合法性 | 核对取得方式、授权来源、隐私边界、平台规则和证据提交限制 |
| 关联性 | 对应争议焦点、待证事实、证明目的和证明力大小 |

## 四、争议焦点/风险线索
${issueSignals.join('\n')}

## 五、期限和待办
${deadlineSignals.join('\n')}

## 六、建议下一步
1. 使用 legal_case_workspace 更新案件空间。
2. 使用 legal_extract_dispute_focus 提炼争议焦点。
3. 使用 legal_generate_litigation_packet 生成原告/被告诉讼文书包草稿。
4. 使用 legal_external_research_plan 生成法条、类案、主体信息检索行动单。
5. 正式交付前使用 legal_finalize_delivery_package，并接受现行有效法律硬门槛。

## 七、原始转写/沟通记录
${transcript || '待补充'}
`;
}

function legalMeetingBulletsFromTranscript(text: string, keywords: RegExp, fallback: string): string[] {
  const lines = String(text || '')
    .split(/\r?\n|[。！？；;]+/)
    .map(line => line.trim())
    .filter(Boolean);
  const picked = lines.filter(line => keywords.test(line)).slice(0, 12);
  const source = picked.length ? picked : lines.slice(0, 8);
  return source.length ? source.map(line => `- ${line.slice(0, 220).replace(/\|/g, ' ')}`) : [`- ${fallback}`];
}

function buildLegalMeetingActionItemsMarkdown(args: Record<string, any>): string {
  const transcript = textArg(args, 'transcript') || textArg(args, 'meetingText') || textArg(args, 'notes');
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const deadlineLines = legalMeetingBulletsFromTranscript(
    transcript,
    /开庭|举证|答辩|立案|提交|缴费|送达|截止|期限|日期|deadline|hearing|file|submit/i,
    '暂未识别明确期限，需会后人工确认。',
  );
  const evidenceLines = legalMeetingBulletsFromTranscript(
    transcript,
    /证据|原件|合同|发票|流水|转账|聊天|微信|短信|邮件|照片|录音|送货|签收|鉴定|evidence|document/i,
    '待补充证据名称、来源、页码和原件状态。',
  );
  const nextLines = legalMeetingBulletsFromTranscript(
    transcript,
    /需要|确认|补充|整理|生成|起草|检索|联系|提交|下载|归档|核验|review|confirm|draft|search/i,
    '会后先生成案件工作台状态，再提炼争议焦点和证据目录。',
  );

  return [
    `# ${caseName} Meeting Action Items`,
    '',
    '## Deadlines / Time Points',
    ...deadlineLines,
    '',
    '## Evidence To Collect',
    ...evidenceLines,
    '',
    '## Ownerless Next Actions',
    ...nextLines,
    '',
    '## Next Legal Workflow',
    '| Step | Tool | Purpose |',
    '| --- | --- | --- |',
    '| 1 | legal_case_workspace | Update case state, missing fields, and next action. |',
    '| 2 | legal_extract_dispute_focus | Extract issues, facts to prove, and cross-examination points. |',
    '| 3 | legal_case_reasoning_matrix | Build the internal major/minor/conclusion reasoning base. |',
    '| 4 | legal_generate_litigation_packet / legal_generate_argument_or_opinion | Draft lawyer-reviewed work products. |',
    '| 5 | legal_generate_citation_verification_report / legal_finalize_delivery_package | Run current-law and delivery gates before formal use. |',
  ].join('\n');
}

function buildLegalMeetingCaseUpdateMarkdown(args: Record<string, any>): string {
  const transcript = textArg(args, 'transcript') || textArg(args, 'meetingText') || textArg(args, 'notes');
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const participants = textArg(args, 'participants') || '待补充';
  const objective = textArg(args, 'objective') || textArg(args, 'claims') || '待律师确认';
  const facts = legalMeetingBulletsFromTranscript(
    transcript,
    /事实|经过|合同|履行|付款|交付|质量|解除|侵权|损失|争议|claim|fact/i,
    '待从会议记录补充案件事实。',
  );
  const issues = legalMeetingBulletsFromTranscript(
    transcript,
    /争议|焦点|对方|抗辩|质证|管辖|时效|责任|违约|赔偿|风险|issue|risk/i,
    '待从会议记录提炼争议焦点。',
  );
  const evidence = legalMeetingBulletsFromTranscript(
    transcript,
    /证据|合同|发票|流水|转账|聊天|微信|短信|邮件|录音|照片|签收|送货|document|evidence/i,
    '待从会议记录整理证据线索。',
  );

  return [
    `# ${caseName} Case Intake Update`,
    '',
    `- Participants: ${participants}`,
    `- Objective: ${objective}`,
    `- Generated at: ${new Date().toISOString()}`,
    '',
    '## Fact Timeline Seeds',
    ...facts,
    '',
    '## Dispute Focus Seeds',
    ...issues,
    '',
    '## Evidence Seeds',
    ...evidence,
    '',
    '## Case Workspace Fields To Recheck',
    '- Party identity / authorization / service address',
    '- Court / jurisdiction / cause of action',
    '- Claims, amount calculation, limitation period, and deadlines',
    '- Evidence authenticity, legality, relevance, original carrier, and page numbers',
    '- Current effective law and similar-case source registration before formal drafting',
  ].join('\n');
}

function buildLegalMeetingLiveBriefMarkdown(args: Record<string, any>, files: {
  minutesPath: string;
  actionItemsPath: string;
  caseUpdatePath: string;
}): string {
  const transcript = textArg(args, 'transcript') || textArg(args, 'meetingText') || textArg(args, 'notes');
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const summary = legalMeetingBulletsFromTranscript(transcript, /./, '会议内容待补充。').slice(0, 6);

  return [
    `# ${caseName} Live Meeting Brief`,
    '',
    '## Live Meeting Workstream',
    '- Lumi records the meeting transcript into the case space.',
    '- Lumi keeps a rolling summary, action items, case-intake update, and formal minutes as separate files.',
    '- Meeting output is a lawyer-review draft. It is not a final legal opinion, filing submission, settlement commitment, or service confirmation.',
    '',
    '## Rolling Summary',
    ...summary,
    '',
    '## Generated Files',
    `- Formal minutes: ${files.minutesPath}`,
    `- Action items: ${files.actionItemsPath}`,
    `- Case intake update: ${files.caseUpdatePath}`,
    '',
    '## Automatic Follow-Up',
    '- Open the case action board and resolve blockers before drafting.',
    '- Generate dispute focus and reasoning matrix before litigation documents.',
    '- Run current-law and delivery gates before any formal document is marked usable.',
  ].join('\n');
}

async function meetingMinutesToCaseHandler(args: Record<string, any>, context?: any): Promise<string> {
  const transcript = textArg(args, 'transcript') || textArg(args, 'meetingText') || textArg(args, 'notes');
  if (!transcript) return '请提供 transcript / meetingText / notes，用于生成法律会议纪要。';

  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const persist = args.persistCase !== false;
  let caseFile: LegalCases.OrgLegalCaseFile | null = null;
  if (persist) {
    const explicitCaseId = textArg(args, 'caseId');
    caseFile = explicitCaseId ? LegalCases.getCase(orgId, explicitCaseId) : null;
    if (!caseFile) caseFile = LegalCases.listCases(orgId, caseName, 1)[0] || null;
    if (!caseFile) {
      caseFile = LegalCases.createCase(orgId, userId, {
        title: caseName,
        party: textArg(args, 'participants'),
        cause: textArg(args, 'caseType') || textArg(args, 'cause'),
        stage: normalizeLegalCaseStage(textArg(args, 'stage')),
        notes: transcript.slice(0, 3000),
      });
    }
  }

  const outputDir = resolveWritableOutputDir(
    textArg(args, 'outputDir'),
    ensureLegalDeliveryRoot(orgId),
    caseName,
    'meeting_minutes',
  );
  const minutesPath = path.join(outputDir, 'legal-meeting-minutes.md');
  const actionItemsPath = path.join(outputDir, 'legal-meeting-action-items.md');
  const caseUpdatePath = path.join(outputDir, 'legal-meeting-case-update.md');
  const liveBriefPath = path.join(outputDir, 'legal-meeting-live-brief.md');
  const baseMarkdown = buildLegalMeetingMinutesMarkdown(args);
  const actionItemsMarkdown = buildLegalMeetingActionItemsMarkdown(args);
  const caseUpdateMarkdown = buildLegalMeetingCaseUpdateMarkdown(args);
  const liveBriefMarkdown = buildLegalMeetingLiveBriefMarkdown(args, {
    minutesPath,
    actionItemsPath,
    caseUpdatePath,
  });
  const preflightSection = buildLegalWorkProductPreflightSection([
    baseMarkdown,
    actionItemsMarkdown,
    caseUpdateMarkdown,
  ].join('\n\n'), args, orgId);
  const markdown = `${baseMarkdown}\n\n${liveBriefMarkdown}\n\n${preflightSection}`;
  fs.writeFileSync(minutesPath, markdown, 'utf-8');
  fs.writeFileSync(actionItemsPath, actionItemsMarkdown, 'utf-8');
  fs.writeFileSync(caseUpdatePath, caseUpdateMarkdown, 'utf-8');
  fs.writeFileSync(liveBriefPath, liveBriefMarkdown, 'utf-8');

  let archiveLine = '- 案件空间：未归档（persistCase=false）';
  if (persist && caseFile) {
    const material = LegalCases.addMaterial(orgId, userId, caseFile.id, {
      type: 'consultation',
      title: `${caseName}法律会议纪要`,
      content: markdown,
      localPath: minutesPath,
      source: 'meeting',
    });
    LegalCases.addMaterial(orgId, userId, caseFile.id, {
      type: 'note',
      title: `${caseName}会议行动项与期限`,
      content: actionItemsMarkdown,
      localPath: actionItemsPath,
      source: 'meeting',
    });
    LegalCases.addMaterial(orgId, userId, caseFile.id, {
      type: 'note',
      title: `${caseName}会议案件更新`,
      content: caseUpdateMarkdown,
      localPath: caseUpdatePath,
      source: 'meeting',
    });
    archiveLine = material
      ? `- 案件空间：已归档 caseId=${caseFile.id} materialId=${material.id}`
      : `- 案件空间：未归档 caseId=${caseFile.id}`;
  }

  return [
    '# 法律会议纪要已生成',
    '',
    `- 案件：${caseName}`,
    `- 输出目录：${outputDir}`,
    `- 纪要文件：${minutesPath}`,
    `- 实时摘要文件：${liveBriefPath}`,
    `- 行动项文件：${actionItemsPath}`,
    `- 案件更新文件：${caseUpdatePath}`,
    archiveLine,
    '',
    preflightSection,
    '',
    '## 下一步',
    '- 用 legal_case_workspace 查看案件闭环状态。',
    '- 用 legal_extract_dispute_focus 提炼争议焦点。',
    '- 用 legal_generate_litigation_packet 或 legal_generate_argument_or_opinion 生成律师复核稿。',
  ].join('\n');
}

function legalReasoningGateStatus(gate: CurrentLawGateResult): string {
  if (gate.statuteChecks.length === 0) return '待检索/未引用具体法条';
  return gate.passed ? '通过' : '未通过';
}

function buildLegalReasoningMatrixMarkdown(args: Record<string, any>, orgId?: string): string {
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const role = roleLabel(textArg(args, 'role'));
  const caseType = textArg(args, 'caseType') || textArg(args, 'cause') || '待确认案由';
  const facts = textArg(args, 'facts') || textArg(args, 'materials') || textArg(args, 'transcript') || '待补充案件事实';
  const evidence = textArg(args, 'evidence') || '待整理证据材料';
  const legalAuthorities = textArg(args, 'legalAuthorities') || textArg(args, 'statutes') || '待检索现行有效法律、司法解释和裁判规则';
  const similarCases = textArg(args, 'similarCases') || '待按法院层级检索类案';
  const issues = (listArg(args, 'issues').length ? listArg(args, 'issues') : inferDisputeFocuses({ ...args, facts, caseType })).slice(0, 12);
  const queries = buildSearchQueries({ ...args, facts, caseType, issues });
  const evidenceRows = buildEvidenceReviewRows({ ...args, facts, evidence, caseType });
  const lawGate = evaluateCurrentLawGate([
    legalAuthorities,
    textArg(args, 'content'),
    textArg(args, 'documentText'),
  ].filter(Boolean).join('\n'), orgId);
  const gateStatus = legalReasoningGateStatus(lawGate);
  const searchOrder = LEGAL_CASE_SEARCH_ORDER.join(' > ');
  const majorRows = issues.map(issue =>
    `| ${issue.replace(/\|/g, ' ')} | ${legalAuthorities.replace(/\|/g, ' ').slice(0, 160)} | 围绕请求权基础、抗辩构成、举证责任和裁判规则解释适用边界 | ${similarCases.replace(/\|/g, ' ').slice(0, 120)}；检索顺序：${searchOrder} | ${gateStatus} |`,
  ).join('\n');
  const minorRows = evidenceRows.map(row =>
    `| ${row.index} | ${row.fact.replace(/\|/g, ' ')} | ${row.name.replace(/\|/g, ' ')} | ${row.proofPurpose.replace(/\|/g, ' ')} | ${row.authenticity}；${row.legality}；${row.relevance} | ${row.gap} |`,
  ).join('\n');
  const conclusionRows = issues.map(issue =>
    `| ${issue.replace(/\|/g, ' ')} | 以已归集事实和证据目录为基础，未能证明部分标注“待补证” | 将大前提规则适用于小前提事实，形成可复核的支持/抗辩路径 | 可转入答辩状、代理词、法律意见书或诉讼策略；正式交付前必须通过现行有效法律硬门槛 |`,
  ).join('\n');

  return `# ${caseName} 法律分析三段论底稿

- 案由/类型：${caseType}
- 我方身份：${role}
- 生成时间：${new Date().toISOString()}
- 状态：律师复核稿；用于办案分析、文书起草和外部检索，不得直接作为最终对外法律意见。

## 一、大前提：检索法律、解释法律、类案补强

- 现行有效法律预检：${gateStatus}
- 法源处理：先检索现行有效法律和司法解释，再按类案层级补强裁判规则。
- 类案检索顺序：${searchOrder}
- 未核验法条和类案不得进入正式交付包；正式文书需经 legal_finalize_delivery_package 硬门槛。

| 争议焦点 | 检索法律 | 解释法律 | 类案补强 | 当前状态 |
| --- | --- | --- | --- | --- |
${majorRows}

## 二、小前提：待证事实、证据材料、举证质证

- 事实摘要：${facts.slice(0, 800)}
- 证据摘要：${evidence.slice(0, 800)}

| 序号 | 待证事实 | 证据材料 | 证明目的 | 举证/质证处理 | 缺口或风险 |
| --- | --- | --- | --- | --- | --- |
${minorRows}

## 三、结论：涵摄、文书表达、风险

| 争议焦点 | 事实基础 | 涵摄结论 | 可转化成果 |
| --- | --- | --- | --- |
${conclusionRows}

## 四、阻断项和复核项

- 现行有效法律阻断项：${lawGate.blockingStatutes.length}
- 未确认案例引用：${lawGate.missingCaseChecks.length}
- 证据缺口：${evidenceRows.filter(row => /待|缺|补|风险/.test(row.gap)).length}

### 阻断法条
${formatCitationList(lawGate.blockingStatutes).join('\n')}

### 未确认案例
${formatCitationList(lawGate.missingCaseChecks).join('\n')}

## 五、下一步工具链

1. legal_external_research_plan：生成外部法条、类案、主体信息检索行动单。
2. legal_search_external_authorities：在已授权 API 或网页协作结果中登记法源和类案。
3. legal_generate_litigation_packet：生成起诉状、答辩状、质证意见和证据目录工作底稿。
4. legal_generate_argument_or_opinion：生成代理词、法律意见书、庭审提纲或应对策略。
5. legal_finalize_delivery_package：正式交付前强制核验现行有效法律。

## 六、检索关键词
${queries.map((query, index) => `${index + 1}. ${query}`).join('\n')}
`;
}

async function reasoningMatrixHandler(args: Record<string, any>, context?: any): Promise<string> {
  const hasInput = textArg(args, 'facts') || textArg(args, 'materials') || textArg(args, 'evidence') ||
    textArg(args, 'legalAuthorities') || textArg(args, 'complaint') || textArg(args, 'transcript') ||
    listArg(args, 'issues').length > 0;
  if (!hasInput) return '请提供 facts / evidence / legalAuthorities / issues / materials 中至少一项，用于生成法律分析三段论底稿。';

  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const persist = args.persistCase !== false;
  const writeFiles = args.writeFiles !== false && args.writeFile !== false;
  const markdown = buildLegalReasoningMatrixMarkdown(args, orgId);
  const lawGate = evaluateCurrentLawGate([
    textArg(args, 'legalAuthorities'),
    textArg(args, 'content'),
    textArg(args, 'documentText'),
  ].filter(Boolean).join('\n'), orgId);

  let reasoningPath = '';
  if (writeFiles) {
    const outputDir = resolveWritableOutputDir(
      textArg(args, 'outputDir'),
      ensureLegalDeliveryRoot(orgId),
      caseName,
      'reasoning_matrix',
    );
    reasoningPath = path.join(outputDir, 'legal-reasoning-matrix.md');
    fs.writeFileSync(reasoningPath, markdown, 'utf-8');
  }

  let caseFile: LegalCases.OrgLegalCaseFile | null = null;
  let archiveLine = '- 案件空间：未归档（persistCase=false）';
  if (persist) {
    const explicitCaseId = textArg(args, 'caseId');
    caseFile = explicitCaseId ? LegalCases.getCase(orgId, explicitCaseId) : null;
    if (!caseFile) caseFile = LegalCases.listCases(orgId, caseName, 1)[0] || null;
    if (!caseFile) {
      caseFile = LegalCases.createCase(orgId, userId, {
        title: caseName,
        party: textArg(args, 'parties') || roleLabel(textArg(args, 'role')),
        cause: textArg(args, 'caseType') || textArg(args, 'cause'),
        court: textArg(args, 'court'),
        stage: normalizeLegalCaseStage(textArg(args, 'stage')),
        notes: (textArg(args, 'facts') || textArg(args, 'materials') || '').slice(0, 3000),
      });
    }
    const material = LegalCases.addMaterial(orgId, userId, caseFile.id, {
      type: 'note',
      title: `${caseName}法律分析三段论底稿`,
      content: markdown,
      localPath: reasoningPath || undefined,
      source: 'tool',
    });
    archiveLine = material
      ? `- 案件空间：已归档 caseId=${caseFile.id} materialId=${material.id}`
      : `- 案件空间：未归档 caseId=${caseFile.id}`;
  }

  return [
    '# 法律分析三段论底稿已生成',
    '',
    `- 案件：${caseName}`,
    `- 现行有效法律预检：${legalReasoningGateStatus(lawGate)}`,
    reasoningPath ? `- 底稿文件：${reasoningPath}` : '- 底稿文件：未写入（writeFiles=false）',
    archiveLine,
    '',
    '## 下一步',
    '- 用 legal_external_research_plan 补齐法条、类案和主体检索。',
    '- 用 legal_generate_argument_or_opinion 生成代理词/法律意见书律师复核稿。',
    '- 正式交付前用 legal_finalize_delivery_package 触发现行有效法律硬门槛。',
  ].join('\n');
}

async function caseWorkspaceHandler(args: Record<string, any>, context?: any): Promise<string> {
  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || textArg(args, 'title') || '未命名案件';
  const role = roleLabel(textArg(args, 'role'));
  const caseType = textArg(args, 'caseType') || textArg(args, 'cause') || '待确认案由';
  const court = textArg(args, 'court');
  const parties = textArg(args, 'parties');
  const claims = textArg(args, 'claims') || textArg(args, 'objective');
  const facts = textArg(args, 'facts') || textArg(args, 'materials');
  const evidence = textArg(args, 'evidence');
  const stage = normalizeLegalCaseStage(textArg(args, 'stage'));
  const persist = args.persistCase !== false;
  const focuses = inferDisputeFocuses({ ...args, caseType, facts });
  const queries = buildSearchQueries({ ...args, caseType, facts, issues: focuses });
  const lawGate = evaluateCurrentLawGate([
    textArg(args, 'legalAuthorities'),
    textArg(args, 'content'),
    textArg(args, 'documentText'),
    facts,
  ].filter(Boolean).join('\n'), orgId);

  let caseFile: LegalCases.OrgLegalCaseFile | null = null;
  if (persist) {
    const explicitCaseId = textArg(args, 'caseId');
    caseFile = explicitCaseId ? LegalCases.getCase(orgId, explicitCaseId) : null;
    if (!caseFile) {
      caseFile = LegalCases.listCases(orgId, caseName, 1)[0] || null;
    }
    const patch = {
      title: caseName,
      party: parties || role,
      cause: caseType,
      court,
      stage,
      notes: [
        claims ? `办理目标：${claims}` : '',
        facts ? `事实摘要：${facts.slice(0, 2000)}` : '',
        evidence ? `证据摘要：${evidence.slice(0, 1200)}` : '',
      ].filter(Boolean).join('\n'),
    };
    caseFile = caseFile
      ? LegalCases.updateCase(orgId, userId, caseFile.id, patch) || caseFile
      : LegalCases.createCase(orgId, userId, patch);

    for (const material of workspaceMaterialInputs(args)) {
      LegalCases.addMaterial(orgId, userId, caseFile.id, {
        ...material,
        source: 'tool',
      });
    }
    caseFile = LegalCases.getCase(orgId, caseFile.id) || caseFile;
  }

  const caseIdLine = caseFile ? `- 案件ID：${caseFile.id}` : '- 案件ID：未持久化（persistCase=false）';
  const workflowCase = caseFile || makeWorkspaceWorkflowCase(args, {
    orgId,
    caseName,
    role,
    caseType,
    court,
    parties,
    claims,
    facts,
    evidence,
    stage,
  });
  const workflow = LegalCases.evaluateCaseWorkflow(workflowCase, {
    currentLawGate: lawGate.statuteChecks.length === 0 ? 'none' : lawGate.passed ? 'passed' : 'blocked',
    currentLawBlockingSummary: lawGate.blockingStatutes.length
      ? formatCitationList(lawGate.blockingStatutes).join('；')
      : '',
  });
  const workflowNext = workflow.nextStep
    ? `${workflow.nextStep.label}：${workflow.nextStep.nextStep}（推荐 ${workflow.nextStep.tool}）`
    : '闭环已完成，进入持续复核和归档。';
  const materialRows = workspaceMaterialIndexRows(caseFile?.materials || []);
  const evidenceReviewRows = buildEvidenceReviewRows({ ...args, caseType, facts, evidence });

  return `# ${caseName} 案件工作台

## 一、案件空间
${caseIdLine}
- 组织：${orgId}
- 阶段：${stage}
- 我方身份：${role}
- 案由/类型：${caseType}
- 法院/机构：${court || '待确认'}
- 当事人：${parties || '待补充'}
- 办理目标：${claims || '待补充'}

## 二、闭环状态
- 完成度：${workflow.doneCount}/${workflow.steps.length}（${workflow.completionRatio}%）
- 阻断项：${workflow.blockedCount}
- 待补项：${workflow.missingCount}
- 下一动作：${workflowNext}

| 模块 | 状态 | 判断依据 | 下一步 | 推荐工具 |
| --- | --- | --- | --- | --- |
${formatLegalWorkflowRows(workflow.steps)}

${formatLegalWorkflowActionQueue(workflow)}

${formatStandardLegalCaseworkSequence()}

## 三、材料索引
| 序号 | 类型 | 标题 | 来源 | 归档时间 |
| --- | --- | --- | --- | --- |
${materialRows}

## 四、争议焦点
${focuses.map((focus, index) => `${index + 1}. ${focus}`).join('\n')}

## 五、证据目录与三性审查矩阵
| 编号 | 证据名称 | 待证事实 | 证明目的 | 真实性核验 | 合法性核验 | 关联性核验 | 缺口/质证风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${formatEvidenceReviewRows(evidenceReviewRows)}

## 六、证据缺口与补强清单
${formatEvidenceGapList(evidenceReviewRows)}

## 七、法源与类案检索顺序
1. 国家法律法规数据库/已授权权威库：先确认法律、司法解释现行有效。
2. 人民法院案例库：优先检索指导性/参考性/权威案例。
3. 中国裁判文书网：按法院层级筛选，顺序为 ${LEGAL_CASE_SEARCH_ORDER.join(' > ')}。
4. 法蝉 / Alpha：在律所授权账号内补充商业库案例和裁判规则。
5. 企查查 / 国家企业信用信息公示系统 / 执行信息公开网：核验主体、股东、涉诉、被执行人和财产线索。
6. 人民法院在线服务：仅做立案材料核对和人工提交协作。

## 八、推荐检索词
${queries.map((query, index) => `${index + 1}. ${query}`).join('\n')}

## 九、下一步工具链
1. legal_case_reasoning_matrix：展开三段论法律分析底稿，作为后续文书和策略的核心基础。
2. legal_extract_dispute_focus：提炼争议焦点、待证事实和质证点。
3. legal_external_research_plan：生成外部检索行动单和来源登记字段。
4. legal_generate_litigation_packet：按原告/被告生成诉讼文书包草稿。
5. legal_prepare_filing_handoff：生成法院在线服务平台字段映射和上传清单。
6. legal_finalize_delivery_package：生成正式交付包；未通过现行有效法律硬门槛时自动阻断。

## 十、边界
- Lumi 可以归集材料、生成草稿、打开授权网页登录、记录来源和生成交付包。
- 自动立案、签名、盖章、缴费、确认送达、撤回、和解承诺、最终法律意见必须由律师或当事人确认。
`;
}

async function caseWorkflowStatusHandler(args: Record<string, any>, context?: any): Promise<string> {
  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const caseName = textArg(args, 'caseName') || textArg(args, 'title') || textArg(args, 'query');
  const caseId = textArg(args, 'caseId');
  const role = roleLabel(textArg(args, 'role'));
  const caseType = textArg(args, 'caseType') || textArg(args, 'cause') || '待确认案由';
  const court = textArg(args, 'court');
  const parties = textArg(args, 'parties');
  const claims = textArg(args, 'claims') || textArg(args, 'objective');
  const facts = textArg(args, 'facts') || textArg(args, 'materials');
  const evidence = textArg(args, 'evidence');
  const stage = normalizeLegalCaseStage(textArg(args, 'stage'));

  let caseFile = caseId ? LegalCases.getCase(orgId, caseId) : null;
  if (!caseFile && caseName) {
    caseFile = LegalCases.listCases(orgId, caseName, 1)[0] || null;
  }

  const hasInlineMaterial = [
    caseName,
    parties,
    claims,
    facts,
    evidence,
    textArg(args, 'complaint'),
    textArg(args, 'opponentMaterials'),
    textArg(args, 'transcript'),
    textArg(args, 'trialNotes'),
    textArg(args, 'legalAuthorities'),
    textArg(args, 'similarCases'),
    textArg(args, 'content'),
    textArg(args, 'documentText'),
  ].some(Boolean);

  if (!caseFile && !hasInlineMaterial) {
    return '请提供 caseId / caseName，或直接提供 facts、evidence、legalAuthorities 等案件材料，用于评估案件闭环状态。';
  }

  const workflowCase = caseFile || makeWorkspaceWorkflowCase(args, {
    orgId,
    caseName: caseName || '未命名案件',
    role,
    caseType,
    court,
    parties,
    claims,
    facts,
    evidence,
    stage,
  });
  const gateText = [
    textArg(args, 'legalAuthorities'),
    textArg(args, 'content'),
    textArg(args, 'documentText'),
    textArg(args, 'facts'),
    textArg(args, 'materials'),
    caseFile?.notes || '',
    ...(caseFile?.materials || []).map(material => material.content || ''),
  ].filter(Boolean).join('\n');
  const lawGate = evaluateCurrentLawGate(gateText, orgId);
  const workflow = LegalCases.evaluateCaseWorkflow(workflowCase, {
    currentLawGate: lawGate.statuteChecks.length === 0 ? 'none' : lawGate.passed ? 'passed' : 'blocked',
    currentLawBlockingSummary: lawGate.blockingStatutes.length
      ? formatCitationList(lawGate.blockingStatutes).join('；')
      : '',
  });
  const next = workflow.nextStep
    ? `${workflow.nextStep.label}：${workflow.nextStep.nextStep}（推荐 ${workflow.nextStep.tool}）`
    : '闭环已完成，进入持续复核和归档。';
  const title = caseFile?.title || caseName || '未命名案件';

  return `# ${title} 案件闭环状态

- 案件ID：${caseFile?.id || '未持久化/未匹配'}
- 组织：${orgId}
- 完成度：${workflow.doneCount}/${workflow.steps.length}（${workflow.completionRatio}%）
- 阻断项：${workflow.blockedCount}
- 待补项：${workflow.missingCount}
- 可进入文书起草：${workflow.readyForDraft ? '是' : '否'}
- 可进入正式交付：${workflow.readyForFormalDelivery ? '是' : '否'}
- 下一动作：${next}

| 模块 | 状态 | 判断依据 | 下一步 | 推荐工具 |
| --- | --- | --- | --- | --- |
${formatLegalWorkflowRows(workflow.steps)}

${formatLegalWorkflowActionQueue(workflow)}

${formatStandardLegalCaseworkSequence()}

## 边界
- 本状态用于办案推进和工具选择，不替代律师对事实、证据、法源和程序风险的最终判断。
- 状态为“阻断”的模块必须先处理；状态为“待人工确认”的模块不得由 Lumi 自动提交、签名、缴费或对外承诺。`;
}

async function legalMessageIntakeToCaseHandler(args: Record<string, any>, context?: any): Promise<string> {
  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const platform = normalizeLegalRemoteMessagePlatform(
    textArg(args, 'platform') || textArg(args, 'source') || context?.source || 'other',
  );
  const sender = textArg(args, 'sender') || textArg(args, 'from') || textArg(args, 'userName') || '未标注';
  const receivedAt = textArg(args, 'receivedAt') || textArg(args, 'timestamp') || new Date().toISOString();
  const messageText = [
    textArg(args, 'message') || textArg(args, 'text') || textArg(args, 'content') || textArg(args, 'noticeText'),
    ...attachmentContentBlocks(args.attachments),
  ].filter(Boolean).join('\n\n').trim();
  const attachmentNames = Array.from(new Set([
    ...listAttachmentNames(args.attachments),
    ...listArg(args, 'fileNames'),
    ...listArg(args, 'attachmentNames'),
  ]));
  const urls = Array.from(new Set([
    ...listArg(args, 'urls'),
    textArg(args, 'url'),
    textArg(args, 'link'),
    textArg(args, 'noticeUrl'),
    ...extractAllUrls(messageText),
  ].map(item => String(item || '').trim()).filter(Boolean)));

  if (!messageText && attachmentNames.length === 0 && urls.length === 0) {
    return '请提供要入案的消息正文、附件名称或链接。';
  }

  const hints = LegalCases.extractLegalCaseHints(messageText);
  const specificCourt = extractSpecificCourtFromLegalMessage(messageText);
  if (specificCourt) hints.court = specificCourt;
  let caseFile = textArg(args, 'caseId') ? LegalCases.getCase(orgId, textArg(args, 'caseId')) : null;
  const explicitCaseName = textArg(args, 'caseName') || textArg(args, 'title') || extractCaseNameFromLegalMessage(messageText);
  if (!caseFile && explicitCaseName) {
    caseFile = LegalCases.listCases(orgId, explicitCaseName, 1)[0] || null;
  }
  if (!caseFile && hints.caseNumber) {
    caseFile = LegalCases.listCases(orgId, hints.caseNumber, 1)[0] || null;
  }

  const persistCase = args.persistCase !== false;
  const caseName = explicitCaseName || hints.caseNumber || `远程法律消息 ${new Date().toISOString().slice(0, 10)}`;
  if (!caseFile && persistCase) {
    caseFile = LegalCases.createCase(orgId, userId, {
      title: caseName,
      caseNumber: hints.caseNumber || '',
      court: hints.court || textArg(args, 'court'),
      cause: hints.cause || textArg(args, 'caseType') || textArg(args, 'cause'),
      party: textArg(args, 'parties') || textArg(args, 'party'),
      hearingDate: hints.hearingDate || '',
      stage: normalizeLegalCaseStage(textArg(args, 'stage') || (hints.hearingDate ? 'trial' : 'consultation')),
      notes: messageText.slice(0, 3000),
    });
  } else if (caseFile) {
    const patch: Partial<LegalCases.OrgLegalCaseFile> = {};
    if (hints.caseNumber && !caseFile.caseNumber) patch.caseNumber = hints.caseNumber;
    if (hints.court && !caseFile.court) patch.court = hints.court;
    if (hints.cause && !caseFile.cause) patch.cause = hints.cause;
    if (hints.hearingDate && !caseFile.hearingDate) patch.hearingDate = hints.hearingDate;
    if (Object.keys(patch).length > 0) {
      caseFile = LegalCases.updateCase(orgId, userId, caseFile.id, patch) || caseFile;
    }
  }

  const rawMaterialContent = [
    '# 远程法律消息原文',
    '',
    `- 平台：${legalRemoteMessagePlatformLabel(platform)}`,
    `- 发送人：${sender}`,
    `- 收取时间：${receivedAt}`,
    `- 案号：${hints.caseNumber || '未识别'}`,
    `- 法院：${hints.court || textArg(args, 'court') || '未识别'}`,
    `- 开庭/通知日期：${hints.hearingDate || '未识别'}`,
    attachmentNames.length ? `- 附件：${attachmentNames.join('；')}` : '- 附件：无',
    urls.length ? `- 识别链接：${urls.join('；')}` : '- 识别链接：无',
    '',
    '## 原始消息',
    '',
    messageText || '（无正文，仅有附件或链接线索）',
    '',
    '## 入案边界',
    '',
    '- 本材料先作为案件线索和原始沟通记录归档，事实、证据三性、来源权限和法律适用仍需律师复核。',
    '- 涉及签收、提交、缴费、撤回、和解承诺或正式对外发送的动作，不在本入案工具内自动完成。',
  ].join('\n');

  let materialId = '';
  if (caseFile) {
    const material = LegalCases.addMaterial(orgId, userId, caseFile.id, {
      type: 'consultation',
      title: `${legalRemoteMessagePlatformLabel(platform)}法律消息原文`,
      content: rawMaterialContent,
      fileName: attachmentNames.length === 1 ? attachmentNames[0] : undefined,
      source: legalRemoteMessageMaterialSource(platform),
    });
    materialId = material?.id || '';
    caseFile = LegalCases.getCase(orgId, caseFile.id) || caseFile;
  }

  let linkLine = urls.length ? `已识别 ${urls.length} 个链接，暂未处理。` : '未识别链接。';
  const processLinks = args.processLinks !== false && urls.length > 0;
  if (urls.length > 0 && args.processLinks === false) {
    linkLine = `已识别 ${urls.length} 个链接，已按 processLinks=false 只归档不抓取。`;
  } else if (processLinks) {
    try {
      const report = await processNoticeLinkHandler({
        ...args,
        orgId,
        userId,
        caseId: caseFile?.id || textArg(args, 'caseId'),
        caseName: caseFile?.title || caseName,
        url: urls[0],
        message: messageText,
        noticeText: messageText,
        title: '远程消息链接材料',
        persistCase: !!caseFile,
        confirmedForKb: false,
        includeExtractedText: true,
        extractedTextLimit: Number(args.extractedTextLimit) || 6000,
      }, {
        ...context,
        orgId,
        userId,
        domain: 'work',
        source: `${platform}-legal-message-intake`,
      });
      if (/授权网页登录协作|登录|验证码|人脸|短信验证|访问受限|平台限制/.test(report)) {
        linkLine = '链接已登记；目标页面需要授权浏览器登录、验证码、人脸或短信验证，已转为人工协作下一步。';
      } else if (/已下载材料|已直接读取|保存留痕|留痕报告/.test(report)) {
        linkLine = '链接已读取/下载并保存留痕，处理报告已归档到案件空间。';
      } else {
        linkLine = '链接已调用处理工具，结果已记录；请查看案件材料中的链接处理报告。';
      }
      if (caseFile) caseFile = LegalCases.getCase(orgId, caseFile.id) || caseFile;
    } catch (err: any) {
      linkLine = `链接处理未完成：${err?.message || String(err)}`;
    }
  }

  const gate = evaluateCurrentLawGate(rawMaterialContent, orgId);
  const workflow = caseFile
    ? LegalCases.evaluateCaseWorkflow(caseFile, {
        currentLawGate: gate.statuteChecks.length === 0 ? 'none' : gate.passed ? 'passed' : 'blocked',
        currentLawBlockingSummary: gate.blockingStatutes.length
          ? formatCitationList(gate.blockingStatutes).join('；')
          : '',
      })
    : null;
  const next = workflow?.nextStep
    ? `${workflow.nextStep.label}：${workflow.nextStep.nextStep}（推荐 ${workflow.nextStep.tool}）`
    : caseFile
      ? '案件基础材料已归档，后续进入持续复核。'
      : '未归档到案件空间；提供 caseName/caseId 或允许 persistCase 后再继续。';

  return [
    '# 远程法律消息已入案',
    '',
    `- 平台：${legalRemoteMessagePlatformLabel(platform)}`,
    `- 发送人：${sender}`,
    `- 案件：${caseFile?.title || caseName}`,
    `- 案件ID：${caseFile?.id || '未归档'}`,
    `- 案号：${caseFile?.caseNumber || hints.caseNumber || '未识别'}`,
    `- 法院：${caseFile?.court || hints.court || textArg(args, 'court') || '未识别'}`,
    `- 开庭/通知日期：${caseFile?.hearingDate || hints.hearingDate || '未识别'}`,
    `- 原文材料：${materialId || (caseFile ? '已尝试归档' : '未归档')}`,
    `- 附件/文件：${attachmentNames.length ? attachmentNames.join('；') : '无'}`,
    `- 链接处理：${linkLine}`,
    workflow ? `- 案件闭环状态：${workflow.doneCount}/${workflow.steps.length}（${workflow.completionRatio}%），阻断 ${workflow.blockedCount}，待补 ${workflow.missingCount}` : '- 案件闭环状态：未评估',
    `- 下一动作：${next}`,
    '',
    '## 边界',
    '- 这一步完成的是远程消息入案、来源留痕和下一步判断，不等同于正式法律意见或对外提交。',
    '- 如消息中包含法院平台、法蝉、Alpha、企查查等需登录来源，Lumi 只使用授权账号和可见浏览器协作，不绕过验证码、权限、付费墙或平台风控。',
  ].join('\n');
}

async function writeDocxFromMarkdown(markdown: string, filePath: string): Promise<void> {
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
    Table, TableRow, TableCell, WidthType,
  } = await import('docx');

  const children: any[] = [];
  const lines = markdown.replace(/\r/g, '').split('\n');
  const tableBuffer: string[][] = [];

  const flushTable = () => {
    if (tableBuffer.length < 2) {
      tableBuffer.length = 0;
      return;
    }
    const header = tableBuffer[0];
    const rows = tableBuffer.slice(1).filter(row => row.some(cell => cell.trim()));
    if (rows.length === 0) {
      tableBuffer.length = 0;
      return;
    }
    const colCount = Math.max(1, header.length);
    const cellWidth = Math.floor(9000 / colCount);
    children.push(new Table({
      width: { size: 9000, type: WidthType.DXA },
      rows: [
        new TableRow({
          children: header.map(cell => new TableCell({
            width: { size: cellWidth, type: WidthType.DXA },
            children: [new Paragraph({ children: [new TextRun({ text: cell.trim(), bold: true })] })],
          })),
        }),
        ...rows.map(row => new TableRow({
          children: header.map((_, index) => new TableCell({
            width: { size: cellWidth, type: WidthType.DXA },
            children: [new Paragraph({ children: [new TextRun(row[index]?.trim() || '')] })],
          })),
        })),
      ],
    }));
    children.push(new Paragraph({ text: '' }));
    tableBuffer.length = 0;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\|.*\|$/.test(trimmed) && !stripMarkdownTableDivider(trimmed)) {
      tableBuffer.push(trimmed.slice(1, -1).split('|').map(cell => cell.trim()));
      continue;
    }
    if (stripMarkdownTableDivider(trimmed)) continue;
    flushTable();

    if (/^#\s+/.test(trimmed)) {
      children.push(new Paragraph({
        text: trimmed.replace(/^#\s+/, ''),
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { after: 300 },
      }));
    } else if (/^##\s+/.test(trimmed)) {
      children.push(new Paragraph({
        text: trimmed.replace(/^##\s+/, ''),
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 240, after: 120 },
      }));
    } else if (/^###\s+/.test(trimmed)) {
      children.push(new Paragraph({
        text: trimmed.replace(/^###\s+/, ''),
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 100 },
      }));
    } else if (/^[-*]\s+/.test(trimmed)) {
      children.push(new Paragraph({
        children: [new TextRun(trimmed.replace(/^[-*]\s+/, ''))],
        bullet: { level: 0 },
        spacing: { after: 80 },
      }));
    } else {
      children.push(new Paragraph({
        children: [new TextRun(trimmed || ' ')],
        spacing: { after: trimmed ? 100 : 40 },
      }));
    }
  }
  flushTable();

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(filePath, buffer);
}

function tryConvertDocxToPdf(docxPath: string): { ok: boolean; pdfPath?: string; error?: string } {
  const pdfPath = docxPath.replace(/\.docx$/i, '.pdf');
  const script = `
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$doc = $word.Documents.Open('${psEscape(docxPath)}')
$doc.SaveAs([ref]'${psEscape(pdfPath)}', [ref]17)
$doc.Close()
$word.Quit()
Write-Output '${psEscape(pdfPath)}'
`;
  const tmpFile = path.join(os.tmpdir(), `lumi_legal_docx2pdf_${Date.now()}.ps1`);
  fs.writeFileSync(tmpFile, `\uFEFF${script}`, 'utf-8');
  try {
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`, {
      timeout: 45000,
      encoding: 'utf-8',
      windowsHide: true,
    });
    return fs.existsSync(pdfPath)
      ? { ok: true, pdfPath }
      : { ok: false, error: 'Microsoft Word conversion finished but PDF was not created.' };
  } catch (err: any) {
    return { ok: false, error: err?.stderr || err?.message || String(err) };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.includes(':')) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const parts = ipv4.slice(1).map(Number);
  if (parts.some(part => part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function extensionFromUrlOrType(url: URL, contentType: string): string {
  const ext = path.extname(url.pathname).toLowerCase();
  if (LEGAL_MATERIAL_EXTENSIONS.has(ext) || ext === '.html' || ext === '.json' || ext === '.xml') return ext;
  if (/pdf/i.test(contentType)) return '.pdf';
  if (/wordprocessingml|msword/i.test(contentType)) return '.docx';
  if (/spreadsheetml|excel/i.test(contentType)) return '.xlsx';
  if (/presentationml|powerpoint/i.test(contentType)) return '.pptx';
  if (/json/i.test(contentType)) return '.json';
  if (/html/i.test(contentType)) return '.html';
  if (/xml/i.test(contentType)) return '.xml';
  if (/text/i.test(contentType)) return '.txt';
  return '.bin';
}

function extensionFromContentDisposition(header: string): string {
  const match = header.match(/filename\*?=(?:UTF-8''|")?([^";\r\n]+)/i);
  if (!match) return '';
  let filename = match[1].trim().replace(/^"|"$/g, '');
  try { filename = decodeURIComponent(filename); } catch { /* keep raw filename */ }
  const ext = path.extname(filename).toLowerCase();
  return (LEGAL_MATERIAL_EXTENSIONS.has(ext) || ['.html', '.json', '.xml'].includes(ext)) ? ext : '';
}

function sniffDocumentExtension(bytes: Buffer): string {
  if (bytes.length >= 4 && bytes.slice(0, 4).toString('latin1') === '%PDF') return '.pdf';
  return '';
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function extractNoticeHints(input: string): { caseNumber?: string; court?: string; hearingDate?: string } {
  const caseNumber = input.match(/[（(]\d{4}[）)][^，。；;\n]{2,80}(?:号|字第?\d+号?)/)?.[0];
  const court = Array.from(input.matchAll(/[\u4e00-\u9fa5]{2,40}(?:人民法院|法院)/g))
    .map(match => match[0])
    .filter(candidate => !['人民法院', '法院'].includes(candidate))
    .sort((a, b) => b.length - a.length)[0]
    || input.match(/[\u4e00-\u9fa5]{2,40}(?:人民法院|法院)/)?.[0];
  const dateMatch = input.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?(?:\s*(\d{1,2})[:：时](\d{1,2})?分?)?/);
  const hearingDate = dateMatch
    ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}${dateMatch[4] ? ` ${dateMatch[4].padStart(2, '0')}:${(dateMatch[5] || '00').padStart(2, '0')}` : ''}`
    : undefined;
  return { caseNumber, court, hearingDate };
}

function noticeNeedsBrowser(status: number, contentType: string, textSample: string): boolean {
  if ([401, 403, 407, 429].includes(status)) return true;
  if (!/html|text|json|xml/i.test(contentType)) return false;
  return /登录|登陆|验证码|短信验证|身份认证|人脸|扫码|未授权|访问受限|captcha|login|sign in|access denied/i.test(textSample.slice(0, 6000));
}

function loginPresetForNoticeUrl(url: URL): string {
  const host = url.hostname.toLowerCase();
  if (host.includes('wenshu.court.gov.cn')) return 'china-judgments-online';
  if (host.includes('zxfw.court.gov.cn') || host.includes('court.gov.cn') || host.includes('court')) return 'court-online-service';
  return '';
}

function normalizeMaterialArticleType(input: string): LegalArticleType {
  if (/裁判|判决|裁定|judg/i.test(input)) return 'judgment';
  if (/法条|法规|法律|statute/i.test(input)) return 'statute';
  if (/合同|协议|contract/i.test(input)) return 'contract';
  if (/证据|evidence/i.test(input)) return 'evidence';
  if (/起诉|答辩|申请书|诉状|代理词|pleading/i.test(input)) return 'pleading';
  if (/笔录|庭审|会议|录音|转写|transcript/i.test(input)) return 'transcript';
  if (/标书|投标|招标|bid|tender/i.test(input)) return 'bid_template';
  if (/意见书|法律意见|opinion/i.test(input)) return 'legal_opinion';
  if (/检索|摘录|类案|research/i.test(input)) return 'research_note';
  if (/企查查|工商|企业|股东|被执行|company/i.test(input)) return 'company_report';
  return 'case_material';
}

function materialCategory(articleType: LegalArticleType): string {
  return `legal_${articleType}`;
}

function normalizeTagsFromArgs(args: Record<string, any>, articleType: LegalArticleType, source: string): string[] {
  const tags = new Set<string>([
    'legal_material',
    `material:${articleType}`,
    `source:${source}`,
  ]);
  for (const tag of listArg(args, 'tags')) tags.add(tag);
  const caseName = textArg(args, 'caseName');
  const caseType = textArg(args, 'caseType');
  if (caseName) tags.add(`caseName:${caseName}`);
  if (caseType) tags.add(`caseType:${caseType}`);
  return [...tags];
}

function buildImportedMaterialContent(args: Record<string, any>, item: {
  title: string;
  text: string;
  source: string;
  format?: string;
  articleType: LegalArticleType;
}): string {
  const header = [
    '# Lumi 法律材料入库记录',
    `- 标题: ${item.title}`,
    `- 来源: ${item.source}`,
    `- 格式: ${item.format || 'text'}`,
    `- 材料类型: ${item.articleType}`,
    `- 案件名称: ${textArg(args, 'caseName') || '未指定'}`,
    `- 案由/类型: ${textArg(args, 'caseType') || '未指定'}`,
    `- 导入时间: ${new Date().toISOString()}`,
    '- 使用边界: 本材料为知识库检索来源，进入正式文书前必须核对原件、来源、页码、形成时间和律师复核意见。',
  ].join('\n');
  return `${header}\n\n---\n\n${item.text.trim()}`;
}

function collectMaterialFiles(folderPath: string, recursive: boolean, maxFiles: number): string[] {
  const out: string[] = [];
  const root = path.resolve(folderPath);
  const visit = (dir: string) => {
    if (out.length >= maxFiles) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive && !entry.name.startsWith('.')) visit(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push(fullPath);
    }
  };
  visit(root);
  return out;
}

function expandLocalPath(input: string): string {
  const raw = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) return '';
  const home = os.homedir();
  if (/^~(?=$|[\\/])/.test(raw)) return raw.replace(/^~(?=$|[\\/])/, home);
  if (/^(桌面|desktop)(?=$|[\\/])/i.test(raw)) {
    return path.join(home, 'Desktop', raw.replace(/^(桌面|desktop)[\\/]?/i, ''));
  }
  if (/^(文档|documents?)(?=$|[\\/])/i.test(raw)) {
    return path.join(home, 'Documents', raw.replace(/^(文档|documents?)[\\/]?/i, ''));
  }
  return raw;
}

function resolveLegalFolderPath(folderPath: string, folderName: string): string {
  const direct = expandLocalPath(folderPath);
  if (direct && fs.existsSync(path.resolve(direct)) && fs.statSync(path.resolve(direct)).isDirectory()) {
    return path.resolve(direct);
  }

  const name = safeFileSegment(folderName || folderPath, '').replace(/_/g, ' ').trim();
  if (!name) return direct ? path.resolve(direct) : '';

  const home = os.homedir();
  const bases = [
    path.join(home, 'Desktop'),
    path.join(home, '桌面'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    process.env.OneDrive ? path.join(process.env.OneDrive, 'Desktop') : '',
    process.cwd(),
  ].filter(Boolean);

  for (const base of bases) {
    try {
      if (!fs.existsSync(base)) continue;
      const exact = path.join(base, name);
      if (fs.existsSync(exact) && fs.statSync(exact).isDirectory()) return path.resolve(exact);
      const entries = fs.readdirSync(base, { withFileTypes: true });
      const hit = entries.find(entry => entry.isDirectory() && entry.name.includes(name));
      if (hit) return path.resolve(path.join(base, hit.name));
    } catch { /* ignore inaccessible folders */ }
  }

  return direct ? path.resolve(direct) : '';
}

function legalOutputDirName(input: string): string {
  return safeFileSegment(input || 'Lumi代理词草稿', 'Lumi代理词草稿');
}

function buildEvidencePurpose(name: string, text: string): string {
  const source = `${name}\n${text}`;
  if (/合同|协议|订单|报价|补充协议/.test(source)) return '证明双方法律关系、权利义务、履行条件及违约责任约定。';
  if (/转账|银行|流水|付款|收款|发票|收据|对账|结算/.test(source)) return '证明款项支付、结算金额、欠款金额或损失计算基础。';
  if (/微信|短信|邮件|聊天|催告|通知|函/.test(source)) return '证明沟通过程、通知送达、催告事实、对方确认或抗辩内容。';
  if (/送货|签收|验收|交付|物流|出库/.test(source)) return '证明合同履行、交付、验收或对方接收事实。';
  if (/起诉状|答辩状|申请书|裁判|判决|裁定|庭审|笔录/.test(source)) return '证明诉讼程序、对方主张、法院查明事实或既有裁判情况。';
  if (/营业执照|身份证|统一社会信用代码|法定代表人/.test(source)) return '证明当事人主体资格、身份信息和诉讼主体适格。';
  return '证明案件相关事实，具体证明目的待律师结合原件和争议焦点复核。';
}

function inferFolderCaseType(corpus: string, explicit = ''): string {
  if (explicit) return explicit;
  if (/买卖合同|货款|供货|订单|对账/.test(corpus)) return '买卖合同纠纷';
  if (/借款|借条|本金|利息|还款/.test(corpus)) return '民间借贷纠纷';
  if (/劳动|工资|加班|解除劳动|社保/.test(corpus)) return '劳动争议';
  if (/租赁|租金|房屋|承租|出租/.test(corpus)) return '租赁合同纠纷';
  if (/建设工程|施工|工程款|竣工|结算/.test(corpus)) return '建设工程施工合同纠纷';
  if (/侵权|损害|赔偿|过错|事故/.test(corpus)) return '侵权责任纠纷';
  return '民事纠纷';
}

function extractFolderParties(corpus: string): string {
  const matches = Array.from(corpus.matchAll(/(?:原告|被告|上诉人|被上诉人|申请人|被申请人|甲方|乙方|委托人|受托人)[：:\s]*([\u4e00-\u9fa5A-Za-z0-9（）()·._-]{2,50})/g))
    .map(match => match[0].replace(/\s+/g, ' ').trim());
  return Array.from(new Set(matches)).slice(0, 12).join('；');
}

function summarizeFilesForFolder(files: Array<{ name: string; path: string; format: string; chars: number; excerpt: string }>): string {
  return files.map((file, index) =>
    `${index + 1}. ${file.name}（${file.format}，${file.chars}字）\n   路径：${file.path}\n   摘要：${file.excerpt.slice(0, 240).replace(/\s+/g, ' ')}`,
  ).join('\n');
}

function buildFolderEvidenceTable(files: Array<{ name: string; excerpt: string; path: string }>): string {
  if (files.length === 0) {
    return '| 编号 | 证据名称 | 来源 | 证明目的 | 原件/复印件 | 复核状态 |\n| --- | --- | --- | --- | --- | --- |\n| 1 | 待补充 | 案件文件夹 | 待补充 | 待核对 | 律师复核 |';
  }
  const rows = files.map((file, index) =>
    `| ${index + 1} | ${file.name} | ${file.path} | ${buildEvidencePurpose(file.name, file.excerpt)} | 待核对 | 律师复核 |`,
  );
  return ['| 编号 | 证据名称 | 来源 | 证明目的 | 原件/复印件 | 复核状态 |', '| --- | --- | --- | --- | --- | --- |', ...rows].join('\n');
}

async function readLegalFolderMaterials(args: Record<string, any>): Promise<{
  folderPath: string;
  filesRead: Array<{ name: string; path: string; format: string; chars: number; excerpt: string }>;
  skipped: Array<{ path: string; reason: string }>;
  corpus: string;
}> {
  const folderPath = resolveLegalFolderPath(textArg(args, 'folderPath'), textArg(args, 'folderName'));
  if (!folderPath || !fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    throw new Error(`案件文件夹不存在或无法访问：${textArg(args, 'folderPath') || textArg(args, 'folderName') || '(未提供)'}`);
  }

  const recursive = args.recursive !== false;
  const maxFiles = Math.max(1, Math.min(Number(args.maxFiles) || 80, 200));
  const maxChars = Math.max(10000, Math.min(Number(args.maxChars) || 220000, 800000));
  const files = collectMaterialFiles(folderPath, recursive, maxFiles);
  const filesRead: Array<{ name: string; path: string; format: string; chars: number; excerpt: string }> = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  let corpus = '';

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!LEGAL_MATERIAL_EXTENSIONS.has(ext)) {
      skipped.push({
        path: file,
        reason: LEGAL_IMAGE_EXTENSIONS.has(ext)
          ? '图片/扫描件需先用 ocr_image_file 识别，或在聊天中上传后让 Lumi OCR'
          : `暂不支持该格式：${ext || '无扩展名'}`,
      });
      continue;
    }
    if (corpus.length >= maxChars) {
      skipped.push({ path: file, reason: '已达到本次读取字数上限' });
      continue;
    }
    const parsed = await parseDocument(file);
    if (!parsed?.text?.trim()) {
      skipped.push({ path: file, reason: '解析失败或文本为空' });
      continue;
    }
    const text = parsed.text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
    const remaining = maxChars - corpus.length;
    const clipped = text.slice(0, remaining);
    corpus += `\n\n# ${path.basename(file)}\n${clipped}`;
    filesRead.push({
      name: path.basename(file),
      path: file,
      format: parsed.format,
      chars: text.length,
      excerpt: text.slice(0, 1500),
    });
  }

  return { folderPath, filesRead, skipped, corpus: corpus.trim() };
}

// ── legal_search_case ───────────────────────────────────────────────────

async function searchCaseHandler(args: Record<string, any>, context?: any): Promise<string> {
  const query = args.query as string;
  const limit = (args.limit as number) || 5;
  if (!query) return '请提供案由或事实描述（query参数）';

  // Search local KB
  const orgId = args.orgId || 'default';
  const localResults = await searchSimilarCases(orgId, query, limit);

  if (localResults.length > 0) {
    const lines = localResults.map((r, i) =>
      `${i + 1}. **${r.title}** [相似度: ${r.score}]\n   案号: ${r.caseNumber || 'N/A'} | 法院: ${r.court || 'N/A'}\n   摘要: ${r.chunk.slice(0, 300)}...`,
    );
    return `本地知识库检索到 ${localResults.length} 个相似案例：\n\n${lines.join('\n\n')}\n\n*来源: 本地裁判文书知识库*`;
  }

  // Fallback: search wenshu
  return '本地知识库中未找到相似案例。建议导入相关裁判文书到知识库，或访问中国裁判文书网 (wenshu.court.gov.cn) 手动检索。';
}

// ── legal_search_statute ────────────────────────────────────────────────

async function searchStatuteHandler(args: Record<string, any>): Promise<string> {
  const query = args.query as string;
  if (!query) return '请提供法条名称或关键词（query参数）';

  const orgId = args.orgId || 'default';
  const results = await searchStatutes(orgId, query);
  const externalResults = await searchLegalAuthorityDatabase({
    query,
    type: 'law',
    sourceIds: [
      ...listArg(args, 'sourceIds'),
      ...listArg(args, 'sources'),
      ...listArg(args, 'platforms'),
    ],
    includeOfficialWeb: args.includeOfficialWeb === true,
    limit: Number(args.limit) || 5,
  });

  if (results.length === 0 && externalResults.length === 0) {
    return `未找到与"${query}"相关的法条。建议通过国家法律法规数据库 (flk.npc.gov.cn) 核实。`;
  }

  const lines = results.map((r, i) =>
    `${i + 1}. **${r.title}** ${r.isEffective ? '✓ 现行有效' : '✗ 已废止'}\n   ${r.chunk.slice(0, 200)}`,
  );
  const externalLines = externalResults.map((r, i) =>
    `${results.length + i + 1}. **${r.title}** ${r.effectiveStatus || '待律师复核'}\n   来源: ${r.sourceName}${r.url ? ` | ${r.url}` : ''}\n   ${r.summary.slice(0, 200)}`,
  );
  return [...lines, ...externalLines].join('\n\n')
    + '\n\n*来源: 本地法条库、已配置授权法律数据库；未配置 API 的平台需通过网页登录协作核验。*';
}

// ── legal_generate_bid ──────────────────────────────────────────────────

async function readBidRequirementInput(args: Record<string, any>): Promise<{
  requirements: string;
  sources: string[];
  skipped: string[];
}> {
  const sources: string[] = [];
  const skipped: string[] = [];
  const chunks: string[] = [];
  const maxChars = Math.max(5000, Math.min(Number(args.maxChars) || 180000, 600000));

  const addText = (title: string, text: string) => {
    const clean = String(text || '').replace(/\r/g, '').trim();
    if (!clean) return;
    const used = chunks.join('\n\n').length;
    if (used >= maxChars) {
      skipped.push(`${title}: 已达到本次读取字数上限`);
      return;
    }
    const clipped = clean.slice(0, maxChars - used);
    chunks.push(`# ${title}\n${clipped}`);
    sources.push(title);
  };

  addText('粘贴的招标要求', textArg(args, 'requirements') || textArg(args, 'content') || textArg(args, 'text'));

  const filePaths = Array.from(new Set([
    textArg(args, 'filePath'),
    ...listArg(args, 'filePaths'),
  ].filter(Boolean)));

  const addFile = async (rawPath: string) => {
    const resolved = path.resolve(expandLocalPath(rawPath));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      skipped.push(`${rawPath}: 文件不存在或不可访问`);
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    if (!LEGAL_MATERIAL_EXTENSIONS.has(ext)) {
      skipped.push(`${resolved}: 暂不支持该格式 ${ext || '(无扩展名)'}`);
      return;
    }
    const parsed = await parseDocument(resolved);
    if (!parsed?.text?.trim()) {
      skipped.push(`${resolved}: 未提取到可用文本`);
      return;
    }
    addText(`招标文件 ${path.basename(resolved)}`, parsed.text);
  };

  for (const filePath of filePaths) {
    await addFile(filePath);
  }

  if (textArg(args, 'folderPath') || textArg(args, 'folderName')) {
    const folder = resolveLegalFolderPath(textArg(args, 'folderPath'), textArg(args, 'folderName'));
    if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
      skipped.push(`${textArg(args, 'folderPath') || textArg(args, 'folderName')}: 文件夹不存在或不可访问`);
    } else {
      const files = collectMaterialFiles(
        folder,
        args.recursive !== false,
        Math.max(1, Math.min(Number(args.maxFiles) || 30, 100)),
      );
      for (const file of files) {
        await addFile(file);
      }
    }
  }

  return {
    requirements: chunks.join('\n\n').trim(),
    sources,
    skipped,
  };
}

async function generateBidHandler(args: Record<string, any>, context?: any): Promise<string> {
  const bidInput = await readBidRequirementInput(args);
  const requirements = bidInput.requirements;
  const projectName = (args.projectName as string) || '项目';
  if (!requirements) {
    const skipped = bidInput.skipped.length ? `\n\n## 未读取材料\n${bidInput.skipped.map(item => `- ${item}`).join('\n')}` : '';
    return `请提供招标要求内容（requirements参数），或提供可读取的 filePath / filePaths / folderPath。${skipped}`;
  }
  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || projectName;

  // Try to find relevant templates
  const templates = await searchMOHURDTemplates('施工');

  const prompt = `你是一名专业标书撰写师。请根据以下招标要求，生成一份完整的投标书框架。

## 招标要求
${requirements}

## 可用合同模板参考
${templates.slice(0, 3).map(t => `- ${t.title}`).join('\n')}

## 要求
1. 生成完整的标书目录结构
2. 每个章节写核心内容概要（商务标+技术标）
3. 标注每部分需要从招标文件中提取的具体信息
4. 所有引用的法条必须标注来源（法条名称+条款号）
5. 不要编造任何公司资质、业绩数据——标注为"[待填写]"

请用中文输出，格式清晰。`;

  // Try to use LLM
  let report = '';
  try {
    const text = await runLegalLLM(prompt, context, 2048);
    if (text) report = sanitizeLegalWorkProductOutput(text);
  } catch { /* LLM unavailable, return structured outline */ }

  if (!report) {
    report = `[标书生成 — 无LLM可用时的结构化大纲]

# ${projectName} 投标书

## 一、商务标
### 1.1 投标函及投标函附录 [待填写]
### 1.2 法定代表人身份证明 [待填写]
### 1.3 授权委托书 [待填写]
### 1.4 投标保证金 [待填写]
### 1.5 资格审查资料 [待填写]
  - 营业执照、资质证书
  - 近年财务状况
  - 近年类似项目业绩
### 1.6 已标价工程量清单 [待填写]

## 二、技术标
### 2.1 施工组织设计
### 2.2 项目管理机构
### 2.3 拟分包项目情况

## 三、报价策略建议
[基于招标文件的评分规则分析]

*注: 请连接LLM以生成完整标书内容。标注"[待填写]"处需根据实际公司资料补充。*`;
  }

  const sourceSection = [
    '## 招标文件来源',
    bidInput.sources.length ? bidInput.sources.map(source => `- ${source}`).join('\n') : '- 粘贴文本',
    bidInput.skipped.length ? ['', '## 未读取材料', bidInput.skipped.map(item => `- ${item}`).join('\n')].join('\n') : '',
  ].filter(Boolean).join('\n');
  const archivedReport = `${report}\n\n${sourceSection}`;
  const preflightSection = buildLegalWorkProductPreflightSection(archivedReport, args, orgId);
  const caseLine = archiveLegalReportToCase(args, {
    orgId,
    userId,
    caseName,
    title: `${projectName} 投标书工作底稿`,
    content: `${archivedReport}\n\n${preflightSection}`,
    type: 'note',
    cause: textArg(args, 'caseType') || '投标/招标文件响应',
  });
  return `${archivedReport}

${preflightSection}

## 案件归档与交付边界
${caseLine}
- 三段论核心基础：已作为内部合规和风险分析逻辑使用；正式投标文件仍需人工补齐资质、业绩、报价和签章材料。
- 正式交付：如需生成律所/团队正式交付包，请继续使用 legal_finalize_delivery_package 进行现行有效法律硬门槛和来源登记。`;
}

// ── legal_review_contract ───────────────────────────────────────────────

async function reviewContractHandler(args: Record<string, any>, context?: any): Promise<string> {
  const contractText = args.contract as string;
  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || textArg(args, 'title') || '合同审查';
  if (!contractText) return '请提供合同文本（contract参数）';

  // Search for similar cases to identify risk areas
  const riskKeywords = ['合同纠纷', '违约', '合同无效', '合同解除', '违约责任'];
  const caseResults: string[] = [];

  for (const kw of riskKeywords.slice(0, 3)) {
    const cases = await searchSimilarCases(orgId, kw, 3);
    for (const c of cases) {
      caseResults.push(`- ${c.title} (${c.caseNumber || 'N/A'}): ${c.chunk.slice(0, 150)}`);
    }
  }

  const prompt = `你是一名专业合同审查律师。请审查以下合同，标注风险条款。

## 合同文本
${contractText.slice(0, 8000)}

## 相关判例参考
${caseResults.slice(0, 10).join('\n')}

## 底层处理逻辑
${LEGAL_REASONING_BASELINE}

## 审查要求
1. 逐一标注风险条款（条款号+风险等级 高/中/低）
2. 每处风险提供：法律依据 + 修改建议
3. 引用真实法条并标注法条号（禁止编造）
4. 如合同类型有住建部示范文本，建议比对差异
5. 标注可能导致的违约责任范围

请用中文输出。`;

  let report = '';
  try {
    const text = await runLegalLLM(prompt, context, 2048);
    if (text) report = sanitizeLegalWorkProductOutput(text);
  } catch { /* fall through */ }

  if (!report) {
    report = `[合同审查 — 基于规则分析]

## 自动检测的风险条款

对合同文本中常见风险条款进行关键词检测：

${detectRiskClauses(contractText)}

## 建议
1. 参照住建部示范文本比对标准条款
2. 核实所有引用法条的有效性
3. 建议人工审查后定稿

*注: 连接LLM以进行深度合同审查分析。*`;
  }

  const preflightSection = buildLegalWorkProductPreflightSection(report, args, orgId);
  const caseLine = archiveLegalReportToCase(args, {
    orgId,
    userId,
    caseName,
    title: `${caseName} 合同审查报告`,
    content: `${report}\n\n${preflightSection}`,
    type: 'contract',
    cause: textArg(args, 'caseType') || '合同审查',
  });
  return `${report}

${preflightSection}

## 案件归档与交付边界
${caseLine}
- 三段论核心基础：已作为内部审查逻辑使用；风险条款需继续对应现行有效法律、合同事实和证据材料。
- 正式交付：如需形成正式法律意见书/合同审查意见，请继续使用 legal_finalize_delivery_package 触发现行有效法律硬门槛。`;
}

function detectRiskClauses(text: string): string {
  const risks: string[] = [];
  const patterns: Record<string, string> = {
    '违约金.*超过.*%|违约金.*(合同总价|总价|价款|金额).*[0-9０-９]{2,}\\s*%|[0-9０-９]{2,}\\s*%.*违约金|逾期.*违约金.*[0-9０-９]{2,}\\s*%': '违约金比例可能过高，依据《民法典》第585条，违约金明显高于实际损失的，人民法院或仲裁机构可以根据请求予以调整',
    '不可抗力': '不可抗力条款需要明确界定范围，避免模糊表述',
    '单方.*解除权|单方.*解除|任意解除': '单方解除权条款需注意《民法典》第563条关于法定解除权的限制，并明确触发条件、通知义务和补救期',
    '管辖.*法院|法院.*管辖|仲裁.*机构': '争议解决条款需明确管辖法院或仲裁机构，单方所在地管辖约定应复核是否与合同履行地、被告住所地等连接点匹配',
    '连带.*责任|无限.*责任': '连带责任或无限责任条款需审慎评估风险敞口',
    '知识产权.*归属|保密.*永久': '知识产权归属条款需明确，保密期限"永久"可能不合理',
    '转让.*提前.*三个月': '合同权利义务转让需双方协商一致（《民法典》第545条）',
  };

  for (const [pattern, advice] of Object.entries(patterns)) {
    if (new RegExp(pattern).test(text)) {
      risks.push(`- ⚠️ ${advice}`);
    }
  }
  return risks.length > 0 ? risks.join('\n') : '未检测到明显风险条款模式。建议使用LLM进行深度分析。';
}

// ── legal_draft_contract ────────────────────────────────────────────────

async function draftContractHandler(args: Record<string, any>, context?: any): Promise<string> {
  const contractType = (args.type as string) || '';
  const details = (args.details as string) || '';
  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || `${contractType || '合同'}起草`;
  const templates = await searchMOHURDTemplates(contractType);

  if (templates.length === 0) {
    return `未找到"${contractType}"类型的住建部合同模板。可用模板类型：建设工程施工合同、商品房买卖合同（预售/现售）、工程总承包合同、建筑工人简易劳动合同、物业临时管理规约。请指定具体类型。`;
  }

  const prompt = `你是一名专业合同律师。请根据住建部示范文本起草一份${contractType}合同。

## 合同要求
${details || '标准合同'}

## 住建部示范文本
${templates[0].title} (${templates[0].publishDate})

## 底层处理逻辑
${LEGAL_REASONING_BASELINE}

## 要求
1. 按照住建部示范文本结构起草
2. 所有条款必须符合现行法律（民法典为主，标注引用法条号）
3. 需要填写的地方标注[请填写]
4. 可选项标注[可选]
5. 禁止编造法律条文

请输出完整合同文本。`;

  let report = '';
  try {
    const text = await runLegalLLM(prompt, context, 2048);
    if (text) report = sanitizeLegalWorkProductOutput(text);
  } catch { /* fall through */ }

  if (!report) {
    report = `[合同起草 — 模板]

使用住建部示范文本: **${templates[0].title}** (${templates[0].publishDate})

请访问 ${templates[0].url} 下载完整模板。

*注: 连接LLM可自动填充合同具体条款。*`;
  }

  const preflightSection = buildLegalWorkProductPreflightSection(report, args, orgId);
  const caseLine = archiveLegalReportToCase(args, {
    orgId,
    userId,
    caseName,
    title: `${caseName} 合同起草底稿`,
    content: `${report}\n\n${preflightSection}`,
    type: 'contract',
    cause: textArg(args, 'caseType') || contractType || '合同起草',
  });
  return `${report}

${preflightSection}

## 案件归档与交付边界
${caseLine}
- 三段论核心基础：已作为内部条款构造和风险配置逻辑使用；空白项、主体信息、价款、期限、违约责任仍需人工补齐。
- 正式交付：如需形成正式合同文本，请继续使用 legal_finalize_delivery_package 触发现行有效法律硬门槛。`;
}

// ── legal_trace_assets ──────────────────────────────────────────────────

async function traceAssetsHandler(args: Record<string, any>, context?: any): Promise<string> {
  const subjectName = args.name as string;
  if (!subjectName) return '请提供被执行主体名称（name参数）';
  const caseName = textArg(args, 'caseName') || `${subjectName}财产线索`;

  const lines: string[] = [`# 被执行人"${subjectName}"财产线索报告\n`];

  // 1. Company info
  const company = await searchCompany(subjectName);
  if (company) {
    lines.push('## 企业基本信息');
    lines.push(`- 名称: ${company.name}`);
    lines.push(`- 法定代表人: ${company.legalPerson}`);
    lines.push(`- 注册资本: ${company.registeredCapital}`);
    lines.push(`- 状态: ${company.status}`);
    lines.push(`- 成立日期: ${company.establishDate}`);
    lines.push(`- 统一社会信用代码: ${company.unifiedCode}`);
    if (company.shareholders.length > 0) {
      lines.push('- 股东结构:');
      for (const s of company.shareholders) {
        lines.push(`  - ${s.name}: ${s.ratio}% (${s.type})`);
      }
    }
    lines.push(`\n## 风险信息`);
    lines.push(`- 被执行记录: ${company.riskInfo.enforcementCount} 条`);
    lines.push(`- 失信记录: ${company.riskInfo.dishonestyCount} 条`);
    lines.push(`- 限制消费: ${company.riskInfo.restrictionsCount} 条`);
    lines.push(`- 查询来源: ${company.sourceName || '企业信息数据源'} ${company.queriedAt ? `(${company.queriedAt.slice(0, 10)})` : ''}`);
  } else {
    lines.push('## 企业基本信息');
    lines.push('- 未通过已配置 API 查询到企业信息，或尚未配置企查查官方 API 凭证。');
    lines.push('- 可执行：web_login_profile_save_from_preset {"presetId":"qichacha"}');
    lines.push('- 然后执行：web_login_run {"profileId":"qichacha","headless":false}');
    lines.push('- 律师在授权网页内确认企业信息、股东信息、涉诉/被执行信息后，使用 legal_import_materials_to_kb 导入知识库。');
  }

  // 2. Enforcement records
  const enforcements = await searchEnforcementRecords(subjectName);
  if (enforcements.length > 0) {
    lines.push('\n## 公开执行记录');
    for (const e of enforcements) {
      lines.push(`- [${e.caseNumber}] ${e.court} | 立案: ${e.filingDate} | 执行标的: ${e.executionTarget} | ${e.status}`);
    }
  }

  lines.push('\n## 财产线索分析');
  lines.push('1. **银行账户**: 建议通过法院执行系统查询被执行人银行开户信息');
  lines.push('2. **不动产**: 建议查询被执行人及其配偶名下不动产登记信息');
  lines.push('3. **车辆**: 建议通过车管所查询被执行人名下机动车辆');
  lines.push('4. **股权**: 通过股权穿透分析关联企业（见legal_equity_penetration工具）');
  lines.push('5. **婚姻状况**: 建议查询被执行人婚姻登记信息，判断是否涉及夫妻共同财产');
  lines.push('6. **知识产权**: 建议查询被执行人名下专利、商标、著作权');
  lines.push(`\n*数据来源: ${company?.sourceName || '授权网页登录协作/待人工确认'} | 全国法院被执行人信息(zhixing.court.gov.cn) | ${new Date().toISOString().slice(0, 10)}*`);

  const report = lines.join('\n');
  return appendLegalWorkProductArchiveSection(report, args, context, {
    caseName,
    title: `${subjectName}财产线索报告`,
    type: 'evidence',
    cause: textArg(args, 'caseType') || '执行/财产保全线索',
  });
}

// ── legal_equity_penetration ─────────────────────────────────────────────

async function equityPenetrationHandler(args: Record<string, any>, context?: any): Promise<string> {
  const companyName = args.name as string;
  if (!companyName) return '请提供公司名称（name参数）';
  const caseName = textArg(args, 'caseName') || `${companyName}股权穿透`;

  const company = await searchCompany(companyName);
  if (!company) {
    const report = `未通过已配置 API 查询到"${companyName}"的企业信息，或尚未配置企查查官方 API 凭证。

可执行以下授权网页登录协作：
1. web_login_profile_save_from_preset {"presetId":"qichacha"}
2. web_login_run {"profileId":"qichacha","headless":false}
3. 律师在网页内确认股东、对外投资、风险信息后，使用 legal_import_materials_to_kb 导入 Lumi 知识库。

边界：这不是平台数据接入；不自动抓取、不批量同步、不绕过验证码、付费墙、账号权限或频控。`;
    return appendLegalWorkProductArchiveSection(report, args, context, {
      caseName,
      title: `${companyName}股权穿透协作报告`,
      type: 'evidence',
      cause: textArg(args, 'caseType') || '主体/股权穿透',
    });
  }

  const lines: string[] = [`# ${companyName} 股权穿透分析\n`];
  lines.push('## 第一层：直接股东');
  for (const s of company.shareholders) {
    lines.push(`- ${s.name}: 持股 ${s.ratio}% (${s.type})`);
  }

  // Recursively trace each shareholder (max 3 levels)
  for (const s of company.shareholders.slice(0, 5)) {
    const subCompany = await searchCompany(s.name);
    if (subCompany && subCompany.shareholders.length > 0) {
      lines.push(`\n## 穿透 ${s.name} 的股东`);
      for (const ss of subCompany.shareholders) {
        const indirectRatio = Math.round(s.ratio * ss.ratio / 100);
        lines.push(`- ${ss.name}: 间接持股 ~${indirectRatio}% (${ss.type})`);
      }
    }
  }

  lines.push('\n## 财产线索');
  lines.push(`- 实际控制人: 需结合工商登记+公司章程判断`);
  lines.push(`- 注册资本: ${company.registeredCapital}`);
  lines.push('- 建议进一步查询: 银行流水、关联交易、对外投资');
  lines.push('\n*注意: 股权穿透信息基于公开工商数据，实际控制关系需综合判断。*');
  lines.push(`*数据来源: ${company.sourceName || '企查查授权数据源'} | ${new Date().toISOString().slice(0, 10)}*`);

  const report = lines.join('\n');
  return appendLegalWorkProductArchiveSection(report, args, context, {
    caseName,
    title: `${companyName}股权穿透分析报告`,
    type: 'evidence',
    cause: textArg(args, 'caseType') || '主体/股权穿透',
  });
}

// ── legal_case_strategy ─────────────────────────────────────────────────

async function caseStrategyHandler(args: Record<string, any>, context?: any): Promise<string> {
  const facts = args.facts as string;
  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const caseName = textArg(args, 'caseName') || '诉讼策略分析';
  const caseType = textArg(args, 'caseType') || '诉讼策略';
  if (!facts) return '请提供案件事实描述（facts参数）';

  // Search similar cases
  const similarCases = await searchSimilarCases(orgId, facts, 5);
  // Search relevant statutes
  const statutes = await searchStatutes(orgId, facts, 5);

  const caseRefs = similarCases.map(c =>
    `- ${c.title} (${c.caseNumber || 'N/A'}, ${c.court || ''}, 相似度: ${c.score})`,
  ).join('\n');

  const statuteRefs = statutes.filter(s => s.isEffective).map(s =>
    `- ${s.title}: ${s.chunk.slice(0, 200)}`,
  ).join('\n');

  const prompt = `你是一名资深诉讼律师。请根据以下事实和相关法条、判例，制定诉讼策略。

## 案件事实
${facts}

## 相关法条（已验证有效）
${statuteRefs || '（未在本地法条库中找到直接相关法条，建议使用legal_search_statute补充检索）'}

## 相似判例
${caseRefs || '（未在本地知识库中找到相似判例）'}

## 底层处理逻辑
${LEGAL_REASONING_BASELINE}

## 分析要求
1. 确定案由和法律关系
2. 分析原告/被告的有利点和风险点
3. 证据链建议（需要收集什么证据）
4. 适用法条（必须标注法条号+来源，不得编造）
5. 参考判例的判决倾向
6. 诉前保全/财产保全建议
7. 预估诉讼风险和时间成本

**重要：不得编造任何法条或判例。如无法确认，标注"待核实"。**`;

  try {
    const text = await runLegalLLM(prompt, context, 2048);
    if (text) {
      const report = sanitizeLegalWorkProductOutput(text);
      return appendLegalWorkProductArchiveSection(report, args, context, {
        caseName,
        title: `${caseName}诉讼策略分析`,
        type: 'note',
        cause: caseType,
      });
    }
  } catch { /* fall through */ }

  const report = `[诉讼策略分析 — 无LLM可用时的结构化框架]

## 案件初步分析

**案件事实**: ${facts.slice(0, 500)}...

## 相似判例
${caseRefs || '未找到相似判例'}

## 适用法条
${statuteRefs || '未找到直接相关法条'}

## 策略要点
1. 确定管辖权 — 核实被告住所地/合同履行地/侵权行为地
2. 证据保全 — 对关键证据申请公证/证据保全
3. 财产保全 — 查询被告财产线索，申请诉前/诉中财产保全
4. 诉讼时效 — 核实是否在诉讼时效期间内（民法典第188条: 3年）

*注: 连接LLM以进行完整诉讼策略分析。*`;
  return appendLegalWorkProductArchiveSection(report, args, context, {
    caseName,
    title: `${caseName}诉讼策略分析`,
    type: 'note',
    cause: caseType,
  });
}

// ── legal_generate_litigation_packet ────────────────────────────────────

async function generateLitigationPacketHandler(args: Record<string, any>, context?: any): Promise<string> {
  const role = roleLabel(textArg(args, 'role'));
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const facts = textArg(args, 'facts');
  const evidence = textArg(args, 'evidence');
  const caseContext = buildCaseContext(args);
  if (!facts && !evidence) return '请至少提供案件事实 facts 或证据材料 evidence。';
  const evidenceReviewRows = buildEvidenceReviewRows({ ...args, facts, evidence });
  const evidenceReviewTable = formatEvidenceReviewRows(evidenceReviewRows);
  const evidenceGapList = formatEvidenceGapList(evidenceReviewRows);
  const writeFiles = args.writeFiles !== false && args.writeFile !== false;
  const finish = (report: string) => {
    let packetPath = '';
    let filingChecklistPath = '';
    let authorizationChecklistPath = '';
    let evidenceMatrixPath = '';
    if (writeFiles) {
      const outputDir = resolveWritableOutputDir(
        textArg(args, 'outputDir'),
        ensureLegalDeliveryRoot(orgId),
        caseName,
        'litigation_packet',
      );
      packetPath = path.join(outputDir, '00_litigation-packet.md');
      filingChecklistPath = path.join(outputDir, '01_filing-material-checklist.md');
      authorizationChecklistPath = path.join(outputDir, '02_authorization-checklist.md');
      evidenceMatrixPath = path.join(outputDir, '03_evidence-review-matrix.md');
      fs.writeFileSync(packetPath, report, 'utf-8');
      fs.writeFileSync(filingChecklistPath, [
        `# ${caseName} Filing Material Checklist`,
        '',
        '| No. | Material | Use | Review point |',
        '| --- | --- | --- | --- |',
        '| 1 | Complaint / application / answer materials | Court filing or defense response | Lawyer review, signature, seal |',
        '| 2 | Party identity materials | Subject qualification | ID, business license, legal representative certificate |',
        '| 3 | Authorization materials | Attorney authority | Engagement, power of attorney, law firm letter, lawyer certificate |',
        '| 4 | Evidence catalog and copies | Proof package | Originals, page numbers, copy count, proof purpose |',
        '| 5 | Service address / fee / preservation materials | Court platform fields | Manual confirmation before submission |',
        '',
        'Boundary: Lumi prepares and names materials only; court submission, signature, seal, payment, service confirmation, withdrawal, and settlement commitment require lawyer or party confirmation.',
      ].join('\n'), 'utf-8');
      fs.writeFileSync(authorizationChecklistPath, [
        `# ${caseName} Authorization Checklist`,
        '',
        '- Engagement / retainer key terms',
        '- Power of attorney scope and special authorization items',
        '- Law firm letter',
        '- Lawyer certificate copy',
        '- Party identity / business license / legal representative certificate',
        '- Signature and seal status',
        '',
        'All authorization scope and signature/seal status must be reviewed manually.',
      ].join('\n'), 'utf-8');
      fs.writeFileSync(evidenceMatrixPath, [
        `# ${caseName} Evidence Catalog And Three-Property Review`,
        '',
        '| 编号 | 证据名称 | 待证事实 | 证明目的 | 真实性核验 | 合法性核验 | 关联性核验 | 缺口/质证风险 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        evidenceReviewTable,
        '',
        '## Evidence Gaps',
        evidenceGapList,
      ].join('\n'), 'utf-8');
    }
    const reportWithFiles = packetPath
      ? `${report}

## 七、诉讼文书包文件输出
- 文书包总稿文件：${packetPath}
- 立案材料清单文件：${filingChecklistPath}
- 授权委托手续清单文件：${authorizationChecklistPath}
- 证据目录与三性矩阵文件：${evidenceMatrixPath}`
      : report;
    return appendLegalWorkProductArchiveSection(reportWithFiles, args, context, {
    caseName,
    title: `${caseName}半自动诉讼文书包`,
    type: 'pleading',
    cause: textArg(args, 'caseType') || '诉讼文书包',
    court: textArg(args, 'court'),
    localPath: packetPath || undefined,
  });
  };

  const prompt = `你是一名律所诉讼支持律师。请生成半自动诉讼文书包草稿，所有内容均用于律师复核，不得宣称可直接提交。

## 案件信息
${caseContext}

## 底层处理逻辑
${LEGAL_REASONING_BASELINE}

## 证据三性审查底稿
| 编号 | 证据名称 | 待证事实 | 证明目的 | 真实性核验 | 合法性核验 | 关联性核验 | 缺口/质证风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${evidenceReviewTable}

## 输出要求
1. 明确区分“系统草稿”“律师待确认”“当事人/法院系统填写项”。
2. 我方为${role}时，生成相应文书包：
   - 原告：起诉状、要素式诉状要点、委托手续、立案材料清单、证据目录、证明目的、法院立案系统填写项。
   - 被告：答辩状、质证意见、证据反驳表、管辖/时效/主体资格等程序抗辩检查项、代理词框架。
   - 通用：案件摘要、证据清单、争议焦点、待补材料、法律检索清单。
3. 证据目录必须逐项包含真实性、合法性、关联性、证明目的、补强缺口和质证风险。
4. 所有事实必须绑定证据或标注“待补证”。
5. 所有法律依据只写“待检索/待核验”或引用已确认法律名称，不得编造条文。
6. 保留提交、签字、盖章、立案、发送给对方等人工确认节点。
请用中文 Markdown 输出。`;

  try {
    const text = await runLegalLLM(prompt, context, 3000);
    if (text) return finish(sanitizeLegalWorkProductOutput(text));
  } catch { /* fall through */ }

  const plaintiffDocs = [
    '起诉状草稿：当事人信息、诉讼请求、事实与理由、证据和来源、受诉法院。',
    '要素式诉状要点：主体、法律关系、请求权基础、争议事实、证据对应、金额计算。',
    '委托手续：委托代理合同要点、授权委托书、律所函、律师证复印件清单。',
    '立案材料组卷：主体材料、证据副本、送达地址确认书、缴费/保全材料。',
    '证据目录：证据名称、来源、页码、证明对象、证明目的、原件核验状态。',
  ];
  const defendantDocs = [
    '答辩状草稿：基本答辩立场、逐项回应诉请、事实反驳、程序抗辩、证据目录。',
    '质证意见：真实性、合法性、关联性、证明目的是否成立、反证或补证需求。',
    '程序抗辩清单：管辖、诉讼时效、主体资格、重复起诉/仲裁条款、送达瑕疵。',
    '代理词框架：争议焦点、事实认定、法律适用、证据评价、结论请求。',
  ];
  const docs = role === '原告' ? plaintiffDocs : role === '被告' ? defendantDocs : [...plaintiffDocs, ...defendantDocs.slice(0, 2)];

  return finish(`# ${caseName} 半自动诉讼文书包

## 一、人工边界
- 本文书包为系统草稿，只能作为律师工作底稿。
- 最终法律意见、签字盖章、立案提交、送达和对外发送必须由律师或当事人确认。
- 未能绑定证据的事实统一标注为“待补证”，不得直接写入最终文书。

## 二、案件信息
${caseContext}

## 三、文书包清单
${docs.map((item, index) => `${index + 1}. ${item}`).join('\n')}

## 四、证据目录与三性审查矩阵
| 编号 | 证据名称 | 待证事实 | 证明目的 | 真实性核验 | 合法性核验 | 关联性核验 | 缺口/质证风险 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${evidenceReviewTable}

## 五、证据缺口与补强清单
${evidenceGapList}

## 六、立案/提交前确认点
- 当事人身份信息、统一社会信用代码、送达地址和联系方式。
- 管辖法院、案由、诉讼请求、金额计算、诉讼费和保全需求。
- 法条引用、类案引用、证据三性、证明目的、证据页码、附件份数。
- 提交平台：如需网上立案，使用 web_login_run 打开“人民法院在线服务”，由律师人工核对并提交。
`);
}

// ── legal_prepare_filing_handoff ────────────────────────────────────────

async function prepareFilingHandoffHandler(args: Record<string, any>): Promise<string> {
  const orgId = textArg(args, 'orgId') || 'default';
  const userId = textArg(args, 'userId') || 'system';
  const caseId = textArg(args, 'caseId');
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const role = roleLabel(textArg(args, 'role'));
  const court = textArg(args, 'court') || '待确认法院';
  const caseType = textArg(args, 'caseType') || '民事纠纷';
  const claims = textArg(args, 'claims') || textArg(args, 'objective') || '待补充';
  const parties = textArg(args, 'parties') || '待补充当事人身份信息';
  const facts = textArg(args, 'facts') || '待补充案件事实';
  const evidence = textArg(args, 'evidence') || textArg(args, 'materials') || '待补充证据材料';
  const portalUrl = textArg(args, 'portalUrl') || 'https://zxfw.court.gov.cn/';
  const requestedMaterials = listArg(args, 'materials');
  const materialRows = requestedMaterials.length > 0
    ? requestedMaterials.map((item, index) => `| ${index + 1} | ${item} | 待匹配上传项 | 律师复核 |`).join('\n')
    : [
      '| 1 | 起诉状/申请书或答辩相关材料 | 诉状/申请书 | 律师复核 |',
      '| 2 | 当事人主体资格材料 | 身份证明/营业执照/法定代表人身份证明 | 律师复核 |',
      '| 3 | 授权委托手续 | 授权委托书、律所函、律师证 | 律师复核 |',
      '| 4 | 证据目录和证据副本 | 证据材料 | 原件核验/页码复核 |',
      '| 5 | 送达地址确认、收款账户、保全材料 | 其他材料 | 按法院要求补充 |',
    ].join('\n');

  const handoff = `# ${caseName} 半自动立案网交接单

## 一、边界
- 本单用于人民法院在线服务/地方在线诉讼服务平台的材料准备和人工提交交接。
- Lumi 可以整理字段、命名文件、生成核对清单、打开授权网页登录会话；不自动点击提交、签名、缴费、确认送达、撤回或代替身份认证。
- 所有诉请、金额、管辖、案由、法条、证据页码和附件份数必须由律师复核。

## 二、案件概要
- 我方身份：${role}
- 案由/类型：${caseType}
- 拟提交法院：${court}
- 当事人：${parties}
- 诉请/办理目标：${claims}
- 事实摘要：${facts}
- 证据摘要：${evidence}

## 三、立案系统字段映射
| 平台字段 | 建议填入 | 人工确认点 |
| --- | --- | --- |
| 案件类型/案由 | ${caseType} | 以法院平台可选案由为准 |
| 受诉法院 | ${court} | 管辖依据和级别管辖 |
| 当事人信息 | ${parties} | 身份证号/统一社会信用代码/地址/电话 |
| 诉讼请求 | ${claims} | 金额、利息、违约金、保全请求 |
| 事实与理由 | ${facts.slice(0, 500)} | 事实必须绑定证据 |
| 证据目录 | ${evidence.slice(0, 500)} | 证据名称、页码、证明目的、原件状态 |

## 四、上传材料清单
| 序号 | 材料 | 平台上传项 | 复核状态 |
| --- | --- | --- | --- |
${materialRows}

## 五、文件命名建议
1. 01_起诉状或申请书_${caseName}.pdf
2. 02_主体资格_${caseName}.pdf
3. 03_授权委托手续_${caseName}.pdf
4. 04_证据目录_${caseName}.pdf
5. 05_证据材料一_${caseName}.pdf
6. 06_送达地址确认及其他_${caseName}.pdf

## 六、网页登录动作
1. web_login_profile_save_from_preset {"presetId":"court-online-service"}
2. web_login_run {"profileId":"court-online-service","url":"${portalUrl}","headless":false}
3. 律师在可见浏览器内完成登录、身份核验、验证码、人脸或短信验证。
4. 按本交接单逐项填报、上传、核对；提交前截图或保存页面草稿编号。

## 七、提交前确认
- 管辖法院、案由、诉讼请求、金额计算、诉讼费、保全和送达地址。
- 起诉状/申请书是否签名盖章，授权手续是否完整。
- 证据是否按目录顺序合并，页码、份数、原件核验状态是否一致。
- 是否存在诉讼时效、仲裁条款、重复起诉、主体资格或管辖风险。

## 八、告知模板
材料已按半自动立案口径整理完毕，当前状态为“待律师登录法院平台人工核对并提交”。Lumi 未自动提交、未签名、未缴费、未确认送达；提交结果以法院平台回执为准。`;
  const preflightSection = buildLegalWorkProductPreflightSection(handoff, args, orgId);
  const archivedHandoff = `${handoff}\n\n${preflightSection}`;
  const archivedMaterial = appendLegalCaseMaterial({
    orgId,
    userId,
    caseId,
    type: 'note',
    title: `${caseName}半自动立案交接单`,
    content: archivedHandoff,
  });
  const archiveLine = caseId
    ? archivedMaterial ? `已归档到案件空间 materialId=${archivedMaterial.id}` : '未归档（caseId 不存在或无权限）'
    : '未归档（未提供 caseId）';
  return `${archivedHandoff}

## 九、案件空间归档
${archiveLine}`;
}

// ── legal_extract_dispute_focus ─────────────────────────────────────────

async function extractDisputeFocusHandler(args: Record<string, any>, context?: any): Promise<string> {
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const role = roleLabel(textArg(args, 'role'));
  const caseType = textArg(args, 'caseType') || '民事纠纷';
  const facts = textArg(args, 'facts');
  const materials = materialSummary(args);
  const hasInput = facts || textArg(args, 'materials') || textArg(args, 'complaint') ||
    textArg(args, 'evidence') || textArg(args, 'transcript') || textArg(args, 'trialNotes');

  if (!hasInput) return '请提供起诉状、证据材料、庭审笔录、案件事实或其他案件材料。';
  const finish = (report: string) => appendLegalWorkProductArchiveSection(report, args, context, {
    caseName,
    title: `${caseName}争议焦点提炼`,
    type: 'note',
    cause: caseType,
  });

  const prompt = `你是一名律所诉讼支持律师。请根据案件材料提炼争议焦点，输出律师可复核的办案工作稿。

## 案件信息
${buildCaseContext(args)}

## 材料范围
${materials}

## 底层处理逻辑
${LEGAL_REASONING_BASELINE}

## 输出要求
1. 按争议焦点逐项输出：我方立场、对方可能主张、待证事实、已有证据、待补证据、质证/抗辩点、外部检索关键词。
2. 事实必须绑定证据；不能绑定证据的标注“待补证”。
3. 法条和类案只写“待检索/待核验”或引用已确认来源，不得编造。
4. 给出检索顺序：现行有效法律、人民法院案例库、裁判文书网、法蝉/Alpha、企业/被执行人查询。
5. 输出面向聊天窗或语音办理结果，不要输出内部方法论标题。
请用中文 Markdown 输出。`;

  try {
    const text = await runLegalLLM(prompt, context, 2500);
    if (text) return finish(sanitizeLegalWorkProductOutput(text));
  } catch { /* fall through */ }

  const focuses = inferDisputeFocuses(args);
  const queries = buildSearchQueries({ ...args, caseType, facts, issues: focuses });
  const evidence = textArg(args, 'evidence') || '待拆分并编号';

  return finish(sanitizeLegalWorkProductOutput(`# ${caseName} 争议焦点提炼稿

## 一、材料范围
${materials}

## 二、争议焦点清单
${focuses.map((focus, index) => `### ${index + 1}. ${focus}
- 我方立场：以${role}办理目标为准，需律师结合诉请、抗辩目标和证据强度确认。
- 对方可能主张：待从起诉状、答辩状、庭审笔录或沟通记录中逐项摘录。
- 待证事实：围绕“${focus}”拆分时间、主体、行为、金额、通知、履行结果等要件事实。
- 已有证据：${evidence}
- 待补证据：原件核验、送达/签收记录、付款或履行凭证、沟通记录、金额计算表。
- 质证/抗辩点：审查真实性、合法性、关联性、证明目的能否成立，以及是否存在反证。
- 外部检索关键词：${caseType} ${focus} 裁判规则；${caseType} ${focus} 举证责任。`).join('\n\n')}

## 三、检索与复核
- 先用 legal_search_statute 或国家法律法规数据库核验现行有效法律。
- 再按人民法院案例库、中国裁判文书网、法蝉、Alpha 的顺序补强类案。
- 涉企业、股东、被执行人线索时，使用企查查和国家企业信用信息公示系统的授权浏览器会话核验。
- 推荐检索词：${queries.join('；')}

## 四、律师确认
- 本稿仅用于办案梳理，不能直接作为最终法律意见或庭审发言。
- 争议焦点、证据取舍、法条引用、类案引用和对外提交文本必须由律师复核确认。
`));
}

// ── legal_generate_argument_or_opinion ─────────────────────────────────

function normalizeLegalWorkProductType(type: string): '代理词' | '法律意见书' | '庭审提纲' | '应对策略' {
  if (/法律意见|意见书|legal\s+opinion/i.test(type)) return '法律意见书';
  if (/庭审|提纲|开庭|trial/i.test(type)) return '庭审提纲';
  if (/策略|应对|方案|strategy/i.test(type)) return '应对策略';
  return '代理词';
}

async function generateArgumentOrOpinionHandler(args: Record<string, any>, context?: any): Promise<string> {
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const role = roleLabel(textArg(args, 'role'));
  const caseType = textArg(args, 'caseType') || '民事纠纷';
  const documentType = normalizeLegalWorkProductType(textArg(args, 'documentType') || textArg(args, 'type') || '代理词');
  const facts = textArg(args, 'facts') || textArg(args, 'materials');
  const evidence = textArg(args, 'evidence') || '待整理证据目录';
  const opponentArguments = textArg(args, 'opponentArguments') || textArg(args, 'opponentMaterials') || '待从对方材料中摘录';
  const objective = textArg(args, 'objective') || textArg(args, 'claims') || '待律师确认办理目标';
  const hasInput = facts || textArg(args, 'evidence') || textArg(args, 'opponentArguments') ||
    textArg(args, 'opponentMaterials') || listArg(args, 'issues').length > 0;
  const issues = inferDisputeFocuses(args);

  if (!hasInput) {
    return '请提供案件事实、争议焦点、证据材料或对方材料，以便生成代理词/法律意见书草稿。';
  }
  const finish = (report: string) => appendLegalWorkProductArchiveSection(report, args, context, {
    caseName,
    title: `${caseName}${documentType}草稿`,
    type: 'pleading',
    cause: caseType,
  });

  const prompt = `你是一名资深诉讼律师。请生成“${documentType}”草稿，供律师复核后使用。

## 案件信息
${buildCaseContext(args)}

## 材料范围
${materialSummary(args)}

## 办理目标
${objective}

## 争议焦点
${issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n')}

## 底层处理逻辑
${LEGAL_REASONING_BASELINE}

## 输出要求
1. 输出${documentType}草稿，不要输出内部方法论标题。
2. 所有事实必须对应证据；证据不足处标注“待补证”。
3. 所有法条、案例、裁判规则必须标注“待检索/待核验”或已确认来源，不得编造。
4. 结尾加入律师复核清单和人工确认节点。
5. 根据文书类型调整结构：
   - 代理词：首部、案件事实摘要、争议焦点、事实认定与证据评价、法律适用意见、结论请求、复核清单。
   - 法律意见书：委托事项、事实摘要、问题清单、法律分析、风险提示、处理建议、附件清单。
   - 庭审提纲：庭审目标、发问提纲、举证质证、争点回应、庭后补充事项。
请用中文 Markdown 输出。`;

  try {
    const text = await runLegalLLM(prompt, context, 3000);
    if (text) return finish(sanitizeLegalWorkProductOutput(text));
  } catch { /* fall through */ }

  const focusLines = issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n');
  const commonReview = [
    '核验所有法条是否现行有效，并补充条款号和来源。',
    '核验类案的案号、法院、裁判日期、裁判规则和引用边界。',
    '核对证据原件、页码、形成时间、来源、证明目的和质证风险。',
    '最终签发、提交、发送或庭审发表前由律师人工确认。',
  ];

  if (documentType === '法律意见书') {
    return finish(sanitizeLegalWorkProductOutput(`# ${caseName} 法律意见书草稿

## 一、委托事项
围绕${caseType}，就“${objective}”形成初步法律意见，供律师复核。

## 二、事实摘要
${facts || '待补充案件事实和时间线。'}

## 三、问题清单
${focusLines}

## 四、法律分析
- 我方身份：${role}
- 对方主张/风险：${opponentArguments}
- 证据基础：${evidence}
- 法律依据：待检索现行有效法律、司法解释和可比类案后补充。

## 五、风险提示
- 事实不能被证据证明的部分应标注“待补证”，不得作为确定性结论。
- 金额、期限、利息、违约金、责任比例等需结合合同、流水、票据和鉴定材料复核。
- 未核验的法条和案例不得对外引用。

## 六、处理建议
- 先补齐争议焦点对应证据，再形成最终意见。
- 需要类案补强时，按人民法院案例库、中国裁判文书网、法蝉、Alpha 顺序检索。
- 涉公司主体和财产线索时，使用授权浏览器核验企查查和国家企业信用信息公示系统。

## 七、复核清单
${commonReview.map(item => `- ${item}`).join('\n')}
`));
  }

  if (documentType === '庭审提纲') {
    return finish(sanitizeLegalWorkProductOutput(`# ${caseName} 庭审提纲草稿

## 一、庭审目标
以${role}立场围绕“${objective}”组织发问、举证、质证和争点回应。

## 二、争议焦点
${focusLines}

## 三、发问提纲
- 围绕合同/行为形成、履行过程、通知送达、金额计算、损失后果逐项发问。
- 对对方证据来源、形成时间、原件状态、证明目的和前后矛盾进行追问。
- 对我方关键证据的形成过程、真实性和关联性进行补强说明。

## 四、举证质证
- 我方证据：${evidence}
- 对方观点：${opponentArguments}
- 质证方向：真实性、合法性、关联性、证明目的、证明力大小和反证需求。

## 五、庭后补充事项
- 补交证据目录、金额计算表、类案检索表和法条核验表。
- 根据庭审归纳焦点调整代理词和书面意见。

## 六、复核清单
${commonReview.map(item => `- ${item}`).join('\n')}
`));
  }

  if (documentType === '应对策略') {
    return finish(sanitizeLegalWorkProductOutput(`# ${caseName} 应对策略草稿

## 一、办理目标
${objective}

## 二、争议焦点
${focusLines}

## 三、我方有利点
- 已有证据：${evidence}
- 可从事实经过、履行行为、通知记录、金额计算和对方违约/过错中提炼有利事实。

## 四、主要风险
- 对方观点：${opponentArguments}
- 待补证或待核验事实不得作为确定性结论。
- 管辖、时效、主体资格、证据原件和金额计算需单独复核。

## 五、行动清单
- 先补齐证据目录和证明目的。
- 核验现行有效法律和司法解释。
- 按法院层级检索类案，并登记来源。
- 涉执行或财产保全时，补充企业信息、股权穿透和被执行人情况查询。

## 六、复核清单
${commonReview.map(item => `- ${item}`).join('\n')}
`));
  }

  return finish(sanitizeLegalWorkProductOutput(`# ${caseName} 代理词草稿

## 一、首部
代理人接受委托，依据已提交材料和庭审情况，就${caseType}发表代理意见。本稿为系统草稿，需律师复核后使用。

## 二、案件事实摘要
${facts || '待补充案件事实、时间线和庭审确认事项。'}

## 三、争议焦点
${focusLines}

## 四、事实认定与证据评价
- 我方证据：${evidence}
- 对方主张：${opponentArguments}
- 证据评价方向：真实性、合法性、关联性、证明目的、证明力大小、是否存在反证或待补证。

## 五、法律适用意见
- 法律依据需以现行有效法律、司法解释和可比类案为准。
- 未完成核验的条款和案例统一标注“待检索/待核验”。
- 围绕争议焦点逐项说明请求或抗辩理由。

## 六、结论请求
请法院结合查明事实、证据规则和已核验法律依据，支持我方关于“${objective}”的意见。

## 七、复核清单
${commonReview.map(item => `- ${item}`).join('\n')}
`));
}

// ── legal_analyze_folder_and_draft_argument ────────────────────────────

async function analyzeFolderAndDraftArgumentHandler(args: Record<string, any>, context?: any): Promise<string> {
  const read = await readLegalFolderMaterials(args);
  const folderBaseName = path.basename(read.folderPath);
  const caseName = textArg(args, 'caseName') || folderBaseName || '未命名案件';
  const caseType = inferFolderCaseType(read.corpus, textArg(args, 'caseType') || textArg(args, 'matterType'));
  const role = roleLabel(textArg(args, 'role') || textArg(args, 'clientRole'));
  const objective = textArg(args, 'objective') || textArg(args, 'claims') || '形成代理词草稿并准备律师复核';
  const parties = textArg(args, 'parties') || extractFolderParties(read.corpus) || '待从主体材料中补充';

  if (read.filesRead.length === 0) {
    const skipped = read.skipped.map(item => `- ${item.path}: ${item.reason}`).join('\n') || '- 未发现可读材料';
    return `未能从案件文件夹中读取到可分析的文本材料。

文件夹：${read.folderPath}

## 暂未读取材料
${skipped}

请确认文件夹路径是否正确；若材料主要是图片/扫描件，请先使用 OCR 识别后再生成代理词。`;
  }

  const evidenceTable = buildFolderEvidenceTable(read.filesRead);
  const fileSummary = summarizeFilesForFolder(read.filesRead);
  const issues = inferDisputeFocuses({
    caseName,
    role,
    caseType,
    facts: read.corpus,
    materials: read.corpus,
    evidence: evidenceTable,
  });
  const issueLines = issues.map((issue, index) => `${index + 1}. ${issue}`).join('\n');
  const skippedLines = read.skipped.length
    ? read.skipped.map(item => `- ${item.path}: ${item.reason}`).join('\n')
    : '- 无';

  const analysisPrompt = `你是一名诉讼律师助理。请根据本地案件文件夹材料，形成可保存的案件分析工作底稿。

## 案件信息
- 案件名称：${caseName}
- 案由/类型：${caseType}
- 我方身份：${role}
- 当事人：${parties}
- 办理目标：${objective}

## 已读取文件
${fileSummary.slice(0, 8000)}

## 材料正文节选
${read.corpus.slice(0, 24000)}

## 底层处理逻辑
${LEGAL_REASONING_BASELINE}

## 输出要求
1. 整理案件事实时间线。
2. 提炼争议焦点和待证事实。
3. 指出证据缺口和质证风险。
4. 给出代理词写作方向。
5. 所有法条、案例只能标注“待检索/待核验”，不得编造。
请用中文 Markdown 输出。`;

  let analysis = '';
  try {
    analysis = await runLegalLLM(analysisPrompt, context, 3500) || '';
  } catch { /* fall through */ }
  if (!analysis) {
    analysis = `# ${caseName} 案情分析工作底稿

## 一、案件概要
- 案由/类型：${caseType}
- 我方身份：${role}
- 当事人：${parties}
- 办理目标：${objective}

## 二、已读取材料
${fileSummary}

## 三、初步争议焦点
${issueLines}

## 四、证据目录草稿
${evidenceTable}

## 五、证据缺口与质证风险
- 图片、扫描件、加密文件或无法解析文件需补 OCR 或重新提供可读版本。
- 所有证据需核对原件、形成时间、来源、页码和证明目的。
- 法条、类案、裁判规则进入代理词前必须另行检索并登记来源。

## 六、代理词写作方向
- 围绕争议焦点逐项绑定事实和证据。
- 对证据不足部分标注“待补证”，避免写成确定性事实。
- 根据我方身份选择请求支持或抗辩驳回的表达。`;
  } else {
    analysis = sanitizeLegalWorkProductOutput(analysis);
  }

  const argumentDraft = await generateArgumentOrOpinionHandler({
    caseName,
    role,
    documentType: '代理词',
    caseType,
    facts: read.corpus.slice(0, 45000),
    issues,
    evidence: evidenceTable,
    opponentMaterials: textArg(args, 'opponentMaterials'),
    objective,
    materials: read.corpus.slice(0, 45000),
  }, context);

  const researchPlan = `# ${caseName} 外部检索与复核清单

## 一、法条核验
- 先检索国家法律法规数据库，确认拟引用法律、司法解释是否现行有效。
- 代理词中所有条款号、施行日期、修订状态均需复核。

## 二、类案检索
1. 人民法院案例库：检索权威案例和裁判规则。
2. 中国裁判文书网：按最高人民法院 > 高级人民法院 > 中级人民法院 > 基层人民法院顺序筛选。
3. 法蝉 / Alpha：使用律所授权账号补充商业库资料。

## 三、推荐检索词
${buildSearchQueries({ caseType, facts: read.corpus, issues }).map((query, index) => `${index + 1}. ${query}`).join('\n')}

## 四、人工确认点
- 争议焦点、证据取舍、法条引用、类案引用和对外提交文本必须由律师复核。
- 外部平台材料属于授权网页登录协作；确认后的摘录或下载文件再导入知识库。
`;

  const readReport = `# ${caseName} 文件夹读取报告

## 一、读取结果
- 文件夹：${read.folderPath}
- 已读取：${read.filesRead.length} 个文件
- 暂未读取：${read.skipped.length} 个文件
- 文本总量：${read.corpus.length} 字

## 二、已读取文件
${fileSummary}

## 三、暂未读取文件
${skippedLines}

## 四、说明
- 图片、扫描件、加密 PDF、损坏文件可能需要 OCR 或人工转换后再分析。
- 本报告和后续文书为律师工作底稿，不作为最终法律意见。
`;

  const outputDir = textArg(args, 'outputDir')
    ? path.resolve(expandLocalPath(textArg(args, 'outputDir')))
    : path.join(read.folderPath, legalOutputDirName(textArg(args, 'outputDirName') || 'Lumi代理词草稿'));
  const writeFiles = args.writeFiles !== false;
  const outputs: Array<{ name: string; path?: string; content: string }> = [
    { name: '00_文件夹读取报告.md', content: readReport },
    { name: '01_案情分析与争议焦点.md', content: analysis },
    { name: '02_证据目录草稿.md', content: `# ${caseName} 证据目录草稿\n\n${evidenceTable}\n\n## 复核提示\n- 提交前逐项核对真实性、合法性、关联性、页码和原件状态。\n- 证明目的需与最终争议焦点保持一致。\n` },
    { name: '03_代理词草稿.md', content: argumentDraft },
    { name: '04_外部检索与复核清单.md', content: researchPlan },
  ];

  if (writeFiles) {
    fs.mkdirSync(outputDir, { recursive: true });
    for (const item of outputs) {
      const target = path.join(outputDir, item.name);
      fs.writeFileSync(target, item.content, 'utf-8');
      item.path = target;
    }
  }

  let kbLine = '';
  if (args.importToKb === true || args.confirmedForKb === true) {
    const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
    const userId = textArg(args, 'userId') || context?.userId || 'system';
    const article = createLegalArticle(orgId, userId, {
      title: `${caseName} 代理词工作底稿`,
      content: outputs.map(item => `# ${item.name}\n\n${item.content}`).join('\n\n---\n\n'),
      articleType: 'pleading',
      category: 'legal_pleading',
      tags: ['legal:folder-argument', `caseName:${caseName}`, `caseType:${caseType}`],
      metadata: { articleType: 'pleading' },
    });
    const indexed = await indexLegalArticle(orgId, article.id);
    kbLine = `\n- 知识库：已导入 articleId=${article.id}，索引块数=${indexed}`;
  }

  return `# 案件文件夹代理词生成完成

## 一、处理结果
- 案件：${caseName}
- 文件夹：${read.folderPath}
- 已读取材料：${read.filesRead.length} 个
- 暂未读取材料：${read.skipped.length} 个
- 案由/类型：${caseType}
- 我方身份：${role}
- 输出模式：${writeFiles ? '已保存文件' : '仅生成预览'}${kbLine}

## 二、生成文件
${outputs.map(item => `- ${item.name}${item.path ? `：${item.path}` : ''}`).join('\n')}

## 三、初步争议焦点
${issueLines}

## 四、未读取材料提示
${skippedLines}

## 五、边界
- 代理词是律师工作底稿，不能直接作为最终庭审发表或提交文本。
- 未核验法条、类案、证据原件和页码前，正式文书中应保留“待检索/待核验/待补证”标记。`;
}

// ── legal_import_materials_to_kb ────────────────────────────────────────

async function importMaterialsToKbHandler(args: Record<string, any>, context?: any): Promise<string> {
  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const filePath = textArg(args, 'filePath');
  const folderPath = textArg(args, 'folderPath');
  const content = textArg(args, 'content');
  const recursive = args.recursive !== false;
  const maxFiles = Math.max(1, Math.min(Number(args.maxFiles) || 30, 100));
  const materialType = textArg(args, 'materialType');
  const defaultArticleType = normalizeMaterialArticleType(materialType || textArg(args, 'title'));

  if (!filePath && !folderPath && !content) {
    return '请提供 filePath、folderPath 或 content。Lumi 可以导入本地案件材料、下载后的网页材料或直接粘贴文本。';
  }

  const imported: Array<{ title: string; articleId: string; chunks: number; category: string }> = [];
  const skipped: Array<{ source: string; reason: string }> = [];

  const ingestOne = async (source: string, rawText: string, format: string, title: string, articleType: LegalArticleType) => {
    const text = rawText.trim();
    if (text.length < 20) {
      skipped.push({ source, reason: '文本过短或解析为空' });
      return;
    }
    const metadata = articleType === 'judgment' ? extractLegalMetadata(text) : undefined;
    const article = createLegalArticle(orgId, userId, {
      title,
      content: buildImportedMaterialContent(args, { title, text, source, format, articleType }),
      category: materialCategory(articleType),
      tags: normalizeTagsFromArgs(args, articleType, source),
      articleType,
      metadata: metadata ? {
        articleType,
        caseNumber: metadata.caseNumber,
        court: metadata.court,
        parties: metadata.parties,
        causeOfAction: metadata.causeOfAction,
        judgmentDate: metadata.judgmentDate,
        statutesCited: metadata.statutesCited,
        jurisdiction: metadata.court,
      } : { articleType },
    });
    const chunks = await indexLegalArticle(orgId, article.id);
    imported.push({ title, articleId: article.id, chunks, category: article.category });
  };

  if (content) {
    const title = textArg(args, 'title') || textArg(args, 'caseName') || '粘贴法律材料';
    await ingestOne('pasted-content', content, 'text', title, defaultArticleType);
  }

  if (filePath) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      skipped.push({ source: resolved, reason: '文件不存在' });
    } else if (!fs.statSync(resolved).isFile()) {
      skipped.push({ source: resolved, reason: '不是文件' });
    } else if (!LEGAL_MATERIAL_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
      const ext = path.extname(resolved).toLowerCase();
      skipped.push({
        source: resolved,
        reason: LEGAL_IMAGE_EXTENSIONS.has(ext)
          ? '图片材料需先使用 ocr_image_file 提取文字，再将 OCR 文本导入知识库'
          : `暂不支持该格式：${ext || '无扩展名'}`,
      });
    } else {
      const parsed = await parseDocument(resolved);
      if (!parsed?.text) {
        skipped.push({ source: resolved, reason: '解析失败或内容为空' });
      } else {
        const inferredType = normalizeMaterialArticleType(materialType || path.basename(resolved));
        await ingestOne(resolved, parsed.text, parsed.format, textArg(args, 'title') || path.basename(resolved), inferredType);
      }
    }
  }

  if (folderPath) {
    const resolvedFolder = path.resolve(folderPath);
    if (!fs.existsSync(resolvedFolder)) {
      skipped.push({ source: resolvedFolder, reason: '文件夹不存在' });
    } else if (!fs.statSync(resolvedFolder).isDirectory()) {
      skipped.push({ source: resolvedFolder, reason: '不是文件夹' });
    } else {
      const files = collectMaterialFiles(resolvedFolder, recursive, maxFiles);
      if (files.length === 0) skipped.push({ source: resolvedFolder, reason: '未找到可导入的文档格式' });
      for (const file of files) {
        try {
          const ext = path.extname(file).toLowerCase();
          if (!LEGAL_MATERIAL_EXTENSIONS.has(ext)) {
            skipped.push({
              source: file,
              reason: LEGAL_IMAGE_EXTENSIONS.has(ext)
                ? '图片材料需先使用 ocr_image_file 提取文字，再将 OCR 文本导入知识库'
                : `暂不支持该格式：${ext || '无扩展名'}`,
            });
            continue;
          }
          const parsed = await parseDocument(file);
          if (!parsed?.text) {
            skipped.push({ source: file, reason: '解析失败或内容为空' });
            continue;
          }
          const inferredType = normalizeMaterialArticleType(materialType || path.basename(file));
          await ingestOne(file, parsed.text, parsed.format, path.basename(file), inferredType);
        } catch (err: any) {
          skipped.push({ source: file, reason: err?.message || '导入失败' });
        }
      }
    }
  }

  const totalChunks = imported.reduce((sum, item) => sum + item.chunks, 0);
  const importedLines = imported.length > 0
    ? imported.map((item, index) =>
      `${index + 1}. ${item.title}\n   - articleId: ${item.articleId}\n   - category: ${item.category}\n   - indexedChunks: ${item.chunks}`,
    ).join('\n')
    : '无';
  const skippedLines = skipped.length > 0
    ? skipped.map((item, index) => `${index + 1}. ${item.source} — ${item.reason}`).join('\n')
    : '无';

  return `# 法律材料导入知识库报告

## 一、导入结果
- 工具：legal_import_materials_to_kb
- 组织：${orgId}
- 成功导入：${imported.length} 份
- 索引块数：${totalChunks}
- 跳过/失败：${skipped.length} 份

## 二、已导入材料
${importedLines}

## 三、跳过/失败材料
${skippedLines}

## 四、后续可用能力
- 这些材料已进入组织知识库，可用于案件问答、争议焦点提炼、代理词/法律意见书、证据目录和类案检索底稿。
- 若 indexedChunks 为 0，通常是当前未配置向量模型；材料仍保存在知识库中，可通过标题、标签和关键词检索。
- 从外部网站获得的网页、下载文件或摘录，应先由律师确认来源和使用权限，再由本工具入库。
`;
}

// ── legal_process_notice_link ──────────────────────────────────────────

async function processNoticeLinkHandler(args: Record<string, any>, context?: any): Promise<string> {
  const isDocumentLink = args.documentLink === true || /document|doc|legal/i.test(textArg(args, 'mode') || textArg(args, 'sourceType'));
  const resultTitle = isDocumentLink ? '文书链接下载与提取结果' : '短信/通知链接处理结果';
  const rawInput = [
    textArg(args, 'url'),
    textArg(args, 'message'),
    textArg(args, 'noticeText'),
    textArg(args, 'linkText'),
  ].filter(Boolean).join('\n');
  const urlValue = textArg(args, 'url') || extractFirstUrl(rawInput);
  const caseName = textArg(args, 'caseName');
  const materialTitle = textArg(args, 'title') || (isDocumentLink ? '链接文书材料' : '短信/法院通知链接材料');
  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const confirmedForKb = args.confirmedForKb === true || args.importToKb === true;
  const includeExtractedText = args.includeExtractedText !== false;
  const extractedTextLimit = Math.max(500, Math.min(Number(args.extractedTextLimit) || 4000, 20000));

  if (!urlValue) {
    return isDocumentLink
      ? '请提供需要下载和提取正文的 http(s) 文书链接，或把包含链接的文本粘贴到 message / linkText 参数。'
      : '请提供短信/通知中的 http(s) 链接，或把完整短信粘贴到 message / noticeText 参数。';
  }

  let target: URL;
  try {
    target = new URL(urlValue);
  } catch {
    return `链接格式无效：${urlValue}`;
  }

  if (!['http:', 'https:'].includes(target.protocol)) {
    return '仅支持 http/https 链接；不读取 file、内网协议或其他本地资源。';
  }
  if (isPrivateOrLocalHost(target.hostname)) {
    return '出于安全原因，链接下载工具不抓取 localhost、内网 IP 或本地域名。请在授权浏览器中人工打开后导入已确认材料。';
  }

  const hints = extractNoticeHints(rawInput);
  const presetId = loginPresetForNoticeUrl(target);
  const browserSteps = [
    presetId ? `1. web_login_profile_save_from_preset {"presetId":"${presetId}"}` : '1. 如该站点需要登录，先用 web_login_profile_save 保存授权网页登录配置。',
    `2. web_login_run {${presetId ? `"profileId":"${presetId}",` : ''}"url":"${target.href}","headless":false}`,
    '3. 律师/工作人员在真实浏览器中完成登录、验证码、人脸、短信验证或下载确认。',
    '4. 下载后的 PDF/DOCX/网页摘录，再用 legal_import_materials_to_kb 导入组织知识库。',
  ].join('\n');

  const archiveNoticeReport = (report: string, localPath?: string) => {
    const archiveLine = archiveLegalReportToCase(args, {
      orgId,
      userId,
      caseName: caseName || materialTitle,
      title: caseName ? `${caseName} ${materialTitle}` : materialTitle,
      content: report,
      type: 'note',
      localPath,
    });
    return `${report}\n\n## 案件空间归档\n${archiveLine}`;
  };

  const authFallback = (reason: string) => archiveNoticeReport(`# ${resultTitle}

## 一、处理结论
- 链接：${target.href}
- 结果：${reason}
- 当前模式：授权网页登录协作，不承诺自动绕过登录、验证码、人脸、短信验证、平台频控或下载限制。

## 二、已识别信息
- 案号：${hints.caseNumber || '未识别'}
- 法院：${hints.court || '未识别'}
- 开庭/通知日期：${hints.hearingDate || '未识别'}
- 案件：${caseName || '未指定'}

## 三、建议动作
${browserSteps}
`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response: Response;
  try {
    response = await fetch(target.href, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 LumiLegalIntake/1.0',
        'Accept': 'application/pdf,text/html,application/xhtml+xml,application/xml,text/plain,application/json,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
  } catch (err: any) {
    clearTimeout(timeout);
    return authFallback(`无法直接读取链接：${err?.message || '网络请求失败'}`);
  }
  clearTimeout(timeout);

  const contentType = response.headers.get('content-type') || '';
  const contentDisposition = response.headers.get('content-disposition') || '';
  const contentLength = Number(response.headers.get('content-length') || 0);
  const preliminaryExt = extensionFromContentDisposition(contentDisposition) || extensionFromUrlOrType(target, contentType);
  const textLike = /text|html|json|xml/i.test(contentType) || ['.html', '.json', '.xml', '.txt', '.md', '.csv'].includes(preliminaryExt);

  if (contentLength > NOTICE_LINK_MAX_BYTES) {
    return authFallback(`链接内容过大（${Math.round(contentLength / 1024 / 1024)}MB），需在授权浏览器中人工下载后导入`);
  }

  if (textLike) {
    const body = await response.text();
    if (!response.ok || noticeNeedsBrowser(response.status, contentType, body)) {
      return authFallback(`页面需要登录/验证或返回异常状态（HTTP ${response.status}）`);
    }

    const ext = extensionFromContentDisposition(contentDisposition) || extensionFromUrlOrType(target, contentType);
    const intakeDir = ensureLegalIntakeDir(orgId);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = safeFileSegment(`${stamp}_${caseName || materialTitle}`, 'notice_link');
    const rawPath = path.join(intakeDir, `${base}${ext === '.bin' ? '.txt' : ext}`);
    fs.writeFileSync(rawPath, body, 'utf-8');

    const extractedText = ext === '.html' ? stripHtmlToText(body) : body.trim();
    const report = [
      `# ${materialTitle}`,
      '',
      `- 来源链接：${target.href}`,
      `- 抓取时间：${new Date().toISOString()}`,
      `- HTTP 状态：${response.status}`,
      `- Content-Type：${contentType || '未提供'}`,
      `- 案件：${caseName || '未指定'}`,
      `- 案号：${hints.caseNumber || '未识别'}`,
      `- 法院：${hints.court || '未识别'}`,
      `- 开庭/通知日期：${hints.hearingDate || '未识别'}`,
      '',
      '## 提取文本',
      '',
      extractedText.slice(0, 30000) || '未提取到可读文本。',
    ].join('\n');
    const reportPath = path.join(intakeDir, `${base}_source-note.md`);
    fs.writeFileSync(reportPath, report, 'utf-8');

    let kbLine = '- 知识库：未导入。若律师已确认来源和使用权限，可再次设置 confirmedForKb=true，或使用 legal_import_materials_to_kb 导入。';
    if (confirmedForKb) {
      const article = createLegalArticle(orgId, userId, {
        title: caseName ? `${caseName} ${materialTitle}` : materialTitle,
        content: report,
        articleType: 'case_material',
        category: 'legal_notice',
        tags: ['legal:notice-link', `source:${target.hostname}`],
        metadata: {
          articleType: 'case_material',
          caseNumber: hints.caseNumber,
          court: hints.court,
        },
      });
      const indexed = await indexLegalArticle(orgId, article.id);
      kbLine = `- 知识库：已导入 articleId=${article.id}，索引块数=${indexed}`;
    }

    const excerptSection = includeExtractedText
      ? `\n## 四、文书内容摘录\n${(extractedText || '未提取到可读文本。').slice(0, extractedTextLimit)}\n`
      : '';

    const output = `# ${resultTitle}

## 一、处理结论
- 链接：${target.href}
- 结果：已直接读取并保存网页/文本留痕。
- 原始文件：${rawPath}
- 留痕报告：${reportPath}
${kbLine}

## 二、已识别信息
- 案号：${hints.caseNumber || '未识别'}
- 法院：${hints.court || '未识别'}
- 开庭/通知日期：${hints.hearingDate || '未识别'}

## 三、边界
- 当前保存的是网页/文本留痕，不等同于法院系统下载的正式 PDF。
- 如法院页面提供正式 PDF 下载，请用授权浏览器打开并人工下载，再导入知识库或案件材料。${excerptSection}`;
    return archiveNoticeReport(output, reportPath);
  }

  if (!response.ok || noticeNeedsBrowser(response.status, contentType, '')) {
    return authFallback(`下载返回异常状态（HTTP ${response.status}）`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > NOTICE_LINK_MAX_BYTES) {
    return authFallback(`下载内容过大（${Math.round(bytes.length / 1024 / 1024)}MB），需在授权浏览器中人工下载后导入`);
  }

  let ext = extensionFromContentDisposition(contentDisposition) || extensionFromUrlOrType(target, contentType);
  if (ext === '.bin') ext = sniffDocumentExtension(bytes) || ext;
  const intakeDir = ensureLegalIntakeDir(orgId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = safeFileSegment(`${stamp}_${caseName || materialTitle}`, 'notice_link');
  const filePath = path.join(intakeDir, `${base}${ext}`);
  fs.writeFileSync(filePath, bytes);

  let parsedText = '';
  let parseStatus = '未解析文本';
  if (LEGAL_MATERIAL_EXTENSIONS.has(ext)) {
    const parsed = await parseDocument(filePath).catch(() => null);
    if (parsed?.text) {
      parsedText = parsed.text;
      parseStatus = `已解析为 ${parsed.format}`;
    }
  }

  const report = [
    `# ${materialTitle}`,
    '',
    `- 来源链接：${target.href}`,
    `- 下载时间：${new Date().toISOString()}`,
    `- HTTP 状态：${response.status}`,
    `- Content-Type：${contentType || '未提供'}`,
    `- 保存文件：${filePath}`,
    `- 文件大小：${bytes.length} bytes`,
    `- 解析状态：${parseStatus}`,
    `- 案件：${caseName || '未指定'}`,
    `- 案号：${hints.caseNumber || '未识别'}`,
    `- 法院：${hints.court || '未识别'}`,
    `- 开庭/通知日期：${hints.hearingDate || '未识别'}`,
    '',
    '## 文本摘录',
    '',
    parsedText ? parsedText.slice(0, 30000) : '二进制材料已保存；如需文本，请使用 read_pdf / extract_document_text 或人工确认后导入。',
  ].join('\n');
  const reportPath = path.join(intakeDir, `${base}_source-note.md`);
  fs.writeFileSync(reportPath, report, 'utf-8');

  let kbLine = '- 知识库：未导入。若律师已确认来源和使用权限，可再次设置 confirmedForKb=true，或使用 legal_import_materials_to_kb 导入保存文件。';
  if (confirmedForKb) {
    const content = parsedText || report;
    const article = createLegalArticle(orgId, userId, {
      title: caseName ? `${caseName} ${materialTitle}` : materialTitle,
      content,
      articleType: 'case_material',
      category: 'legal_notice',
      tags: ['legal:notice-link', `source:${target.hostname}`, ext.replace('.', 'format:')],
      metadata: {
        articleType: 'case_material',
        caseNumber: hints.caseNumber,
        court: hints.court,
      },
    });
    const indexed = await indexLegalArticle(orgId, article.id);
    kbLine = `- 知识库：已导入 articleId=${article.id}，索引块数=${indexed}`;
  }

  const excerptSection = includeExtractedText
    ? `\n## 四、文书内容摘录\n${(parsedText || '未提取到可读文本。若这是扫描件或图片型 PDF，请使用 OCR 后再导入。').slice(0, extractedTextLimit)}\n`
    : '';

  const output = `# ${resultTitle}

## 一、处理结论
- 链接：${target.href}
- 结果：已下载材料并保存。
- 保存文件：${filePath}
- 留痕报告：${reportPath}
- 类型：${contentType || ext}
- 大小：${bytes.length} bytes
- 解析状态：${parseStatus}
${kbLine}

## 二、已识别信息
- 案号：${hints.caseNumber || '未识别'}
- 法院：${hints.court || '未识别'}
- 开庭/通知日期：${hints.hearingDate || '未识别'}

## 三、人工确认
- 请律师核对链接来源、下载文件是否为法院或平台正式文书，以及是否需要补充签收/送达时间记录。
- 若需提交、签收、撤回、缴费或确认送达，必须由律师或当事人在授权页面人工完成。${excerptSection}`;
  return archiveNoticeReport(output, reportPath);
}

// ── legal_external_source_status ────────────────────────────────────────

function mdCell(value: unknown): string {
  return String(value ?? '').replace(/\|/g, ' ').replace(/\n+/g, ' ').trim() || '待登记';
}

function normalizeExternalLegalKind(value: string): ExternalLegalSearchKind {
  if (/案例|判例|裁判|case|judgment/i.test(value)) return 'case';
  if (/法条|法规|法律|statute|law/i.test(value)) return 'law';
  return 'mixed';
}

async function searchExternalAuthoritiesHandler(args: Record<string, any>, context?: any): Promise<string> {
  const query = textArg(args, 'query') || textArg(args, 'facts') || textArg(args, 'issue') || textArg(args, 'caseType');
  if (!query) return '请提供 query（检索词、争议焦点、案由或案件事实）。';

  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || '外部法律数据库检索';
  const sourceIds = [
    ...listArg(args, 'sourceIds'),
    ...listArg(args, 'sources'),
    ...listArg(args, 'platforms'),
  ];
  const type = normalizeExternalLegalKind(textArg(args, 'type') || textArg(args, 'kind'));
  const limit = Math.max(1, Math.min(Number(args.limit) || 5, 20));
  const includeOfficialWeb = args.includeOfficialWeb === true;

  const results = await searchLegalAuthorityDatabase({
    query,
    type,
    sourceIds,
    limit,
    includeOfficialWeb,
  });
  const orderedResults = [...results].sort((a, b) => {
    const aRank = courtLevelRank([a.court, a.title, a.summary].filter(Boolean).join(' '));
    const bRank = courtLevelRank([b.court, b.title, b.summary].filter(Boolean).join(' '));
    return aRank - bRank;
  });
  const capabilities = listLegalSourceCapabilities()
    .filter(source => ['pkulaw', 'farui', 'people-court-case-library', 'china-judgments-online'].includes(source.id));

  const resultRows = orderedResults.length
    ? orderedResults.map((item, index) =>
      `| ${index + 1} | ${mdCell(item.sourceName)} | ${mdCell(item.title)} | ${mdCell(item.caseNumber || item.effectiveStatus)} | ${mdCell(item.publishDate || item.court)} | ${mdCell(item.url || item.summary)} | 律师复核 |`,
    ).join('\n')
    : '| 1 | 未命中 | 未通过已配置 API 返回结果 | 待补充 | 待补充 | 请配置授权 API 或使用网页登录协作 | 律师复核 |';

  const statusRows = capabilities.map(source =>
    `| ${mdCell(source.label)} | ${source.accessMode} | ${source.configured ? '已配置/可用' : '未配置或网页登录'} | ${source.canAutoQuery ? '可以' : '不承诺'} | ${mdCell(source.nextAction)} |`,
  ).join('\n');
  const sourceRegisterRows = orderedResults.length
    ? orderedResults.map((item, index) =>
      `| ${index + 1} | ${mdCell(item.sourceName)} | ${mdCell(query)} | ${mdCell(item.title)} | ${mdCell(item.caseNumber || item.effectiveStatus)} | ${mdCell(item.court || item.publishDate)} | ${mdCell(item.url)} | ${mdCell(item.summary || '待摘录')} | 律师复核 |`,
    ).join('\n')
    : '| 1 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待摘录 | 律师复核 |';

  const report = `# ${caseName} 外部法律数据库检索

## 一、检索条件
- 检索词：${query}
- 检索类型：${type}
- 指定数据源：${sourceIds.join('；') || '自动选择已配置 API'}
- 官方网页兜底：${includeOfficialWeb ? '启用' : '未启用'}
- 类案排序：${LEGAL_CASE_SEARCH_ORDER.join(' > ')}；无法识别法院层级的结果列后。

## 二、API 查询结果
| 序号 | 数据源 | 标题 | 案号/效力 | 日期/法院 | 链接或摘要 | 复核状态 |
| --- | --- | --- | --- | --- | --- | --- |
${resultRows}

## 三、来源登记回填
| 序号 | 来源 | 检索词 | 标题 | 案号/效力 | 法院/发布日期 | 链接 | 关键摘录 | 复核状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${sourceRegisterRows}

## 四、接入状态
| 数据源 | 模式 | 状态 | 自动查询 | 下一步 |
| --- | --- | --- | --- | --- |
${statusRows}

## 五、边界
- 仅调用已配置且授权的 API/网关；未配置的数据源不承诺自动查询。
- 人民法院案例库、裁判文书网、法蝉、Alpha 默认仍按授权网页登录协作和材料导入处理。
- 所有法条效力、案例适用性和引用表述必须由律师最终复核。`;

  let kbLine = '- 知识库：未导入。律师确认来源和授权范围后，可设置 confirmedForKb=true 入库。';
  if (args.confirmedForKb === true && orderedResults.length > 0) {
    const article = createLegalArticle(orgId, userId, {
      title: `${caseName} 外部法律数据库检索`,
      content: report,
      articleType: 'research_note',
      category: 'legal_research',
      tags: [
        'legal:external-api',
        `query:${query.slice(0, 40)}`,
        ...Array.from(new Set(orderedResults.map(item => `source:${item.sourceId}`))),
      ],
      metadata: {
        articleType: 'research_note',
      },
    });
    const chunks = await indexLegalArticle(orgId, article.id);
    kbLine = `- 知识库：已导入（articleId=${article.id}，索引块=${chunks}）。`;
  }

  const caseLine = archiveLegalReportToCase(args, {
    orgId,
    userId,
    caseName,
    title: `${caseName} 外部法律数据库检索`,
    content: report,
    type: type === 'case' ? 'judgment' : 'note',
    cause: textArg(args, 'caseType') || query,
  });

  return `${report}\n\n## 六、入库与案件归档\n${kbLine}\n${caseLine}`;
}

async function companyDatabaseLookupHandler(args: Record<string, any>, context?: any): Promise<string> {
  const name = textArg(args, 'name') || textArg(args, 'companyName') || textArg(args, 'subjectName');
  if (!name) return '请提供 name 或 companyName（公司/被执行主体名称）。';

  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || `${name} 主体信息查询`;
  const sourceIds = [
    ...listArg(args, 'sourceIds'),
    ...listArg(args, 'sources'),
    ...listArg(args, 'platforms'),
  ];

  const companies = await searchCompanySources(name, sourceIds);
  const capabilities = listLegalSourceCapabilities()
    .filter(source => ['qichacha', 'tianyancha', 'national-enterprise-credit'].includes(source.id));

  const companyRows = companies.length
    ? companies.map((company, index) =>
      `| ${index + 1} | ${mdCell(company.sourceName)} | ${mdCell(company.name)} | ${mdCell(company.legalPerson)} | ${mdCell(company.registeredCapital)} | ${mdCell(company.status)} | ${mdCell(company.unifiedCode)} | ${mdCell(company.url)} |`,
    ).join('\n')
    : '| 1 | 未命中 | 未通过已配置 API 查询到主体信息 | 待补充 | 待补充 | 待补充 | 待补充 | 使用授权网页登录协作 |';

  const statusRows = capabilities.map(source =>
    `| ${mdCell(source.label)} | ${source.accessMode} | ${source.configured ? '已配置/可用' : '未配置或网页登录'} | ${source.canAutoQuery ? '可以' : '不承诺'} | ${mdCell(source.nextAction)} |`,
  ).join('\n');
  const sourceRegisterRows = companies.length
    ? companies.map((company, index) =>
      `| ${index + 1} | ${mdCell(company.sourceName)} | ${mdCell(company.name)} | ${mdCell(company.unifiedCode)} | ${mdCell(company.legalPerson)} | ${mdCell(company.status)} | ${mdCell(company.url)} | 股东、涉诉、被执行和限制高消费信息待律师继续核验 | 律师复核 |`,
    ).join('\n')
    : '| 1 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 授权网页核验后回填 | 律师复核 |';

  const report = `# ${caseName} 企业/被执行主体数据库查询

## 一、查询对象
- 主体名称：${name}
- 指定数据源：${sourceIds.join('；') || '企查查、天眼查优先，官方网页兜底'}

## 二、API 查询结果
| 序号 | 数据源 | 主体名称 | 法定代表人 | 注册资本 | 状态 | 统一社会信用代码 | 来源链接 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${companyRows}

## 三、主体信息来源登记
| 序号 | 来源 | 主体名称 | 统一社会信用代码 | 法定代表人 | 状态 | 链接 | 后续核验 | 复核状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${sourceRegisterRows}

## 四、接入状态
| 数据源 | 模式 | 状态 | 自动查询 | 下一步 |
| --- | --- | --- | --- | --- |
${statusRows}

## 五、下一步
- 若 API 未命中或未配置，请使用 web_login_profile_save_from_preset {"presetId":"qichacha"} 或 {"presetId":"national-enterprise-credit"} 打开授权网页核验。
- 律师确认股东、涉诉、被执行、失信和限制高消费信息后，再用 legal_import_materials_to_kb 导入组织知识库。
- Lumi 不绕过验证码、付费墙、账号权限、平台频控或下载限制。`;

  let kbLine = '- 知识库：未导入。律师确认来源和使用权限后，可设置 confirmedForKb=true 入库。';
  if (args.confirmedForKb === true && companies.length > 0) {
    const article = createLegalArticle(orgId, userId, {
      title: `${caseName} 企业主体信息`,
      content: report,
      articleType: 'company_report',
      category: 'legal_company_report',
      tags: [
        'legal:company-api',
        `company:${name}`,
        ...Array.from(new Set(companies.map(company => `source:${company.sourceName || 'company-api'}`))),
      ],
      metadata: {
        articleType: 'company_report',
      },
    });
    const chunks = await indexLegalArticle(orgId, article.id);
    kbLine = `- 知识库：已导入（articleId=${article.id}，索引块=${chunks}）。`;
  }

  const caseLine = archiveLegalReportToCase(args, {
    orgId,
    userId,
    caseName,
    title: `${caseName} 企业/被执行主体数据库查询`,
    content: report,
    type: 'evidence',
    cause: textArg(args, 'caseType') || '主体信息核验',
  });

  return `${report}\n\n## 六、入库与案件归档\n${kbLine}\n${caseLine}`;
}

async function externalSourceStatusHandler(): Promise<string> {
  const rows = listLegalSourceCapabilities().map(source =>
    `| ${source.label} | ${source.accessMode} | ${source.configured ? '已配置/可用' : '未配置或网页登录'} | ${source.canAutoQuery ? '可以' : '不承诺'} | ${source.boundary} | ${source.nextAction} |`,
  ).join('\n');

  return `# 外部法律数据源接入状态

| 数据源 | 当前模式 | 状态 | 自动查询 | 边界 | 下一步 |
| --- | --- | --- | --- | --- | --- |
${rows}

## 统一口径
- 只有配置官方 API 凭证并受合同授权的数据源，才称为“平台数据接入”。
- 其他站点按“授权网页登录协作”处理：Lumi 可打开页面、组织检索词、辅助登记来源，但不绕过验证码、付费墙、账号权限、频控或下载限制。
- 律师确认后的网页摘录、下载文件和本地材料，可以用 legal_import_materials_to_kb 导入组织知识库。`;
}

// ── legal_external_research_plan ────────────────────────────────────────

async function externalResearchPlanHandler(args: Record<string, any>, context?: any): Promise<string> {
  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseName = textArg(args, 'caseName') || '半自动外部检索行动单';
  const facts = textArg(args, 'facts');
  const caseType = textArg(args, 'caseType') || '民事纠纷';
  const issues = listArg(args, 'issues');
  const companyNames = listArg(args, 'companyNames');
  const queries = buildSearchQueries({ ...args, caseType, facts, issues });
  const courtLevels = ['最高人民法院', '高级人民法院', '中级人民法院', '基层人民法院'];
  const sourceCapabilities = listLegalSourceCapabilities();
  const loginActions = EXTERNAL_LEGAL_SOURCES
    .filter(source => source.presetId)
    .map(source => `- ${source.label} (${source.presetId})
  1. web_login_profile_save_from_preset {"presetId":"${source.presetId}"}
  2. web_login_run {"profileId":"${source.presetId}","headless":false}
  3. 律师在网页内检索、筛选、摘录，并回填来源登记表。`)
    .join('\n');

  const report = `# ${caseName}

## 一、检索边界
- Lumi 不复制第三方平台数据，不绕过验证码、付费墙、账号权限或频控。
- 只有已配置官方 API 凭证并受合同授权的数据源，才称为“平台数据接入”；未配置 API 的数据源按授权网页登录协作处理。
- 使用 web_login_profile_save_from_preset 保存授权站点，再用 web_login_run 打开真实浏览器。
- 律师在网页内确认检索结果后，将标题、链接、案号、法院、裁判日期、关键摘录和使用理由登记回案件；确认后的文件或摘录可由 legal_import_materials_to_kb 自动导入知识库。

## 数据源接入状态
${sourceCapabilities.map(source => `- ${source.label}: ${source.accessMode} / ${source.configured ? '已配置或官网可用' : '未配置 API'} / ${source.canAutoQuery ? '可自动查询' : '网页登录或人工确认'}`).join('\n')}

## 二、案件线索
- 案由/类型：${caseType}
- 争议焦点：${issues.join('；') || '待补充'}
- 事实摘要：${facts || '待补充'}
- 企业/被执行人：${companyNames.join('；') || '待补充'}

## 三、推荐检索顺序
1. 国家法律法规数据库：先核验法律依据是否现行有效。
2. 人民法院案例库：优先查权威案例和裁判规则。
3. 中国裁判文书网：按法院层级筛选，顺序为 ${courtLevels.join(' > ')}。
4. 法蝉 / Alpha：使用律所授权账号补充商业库资料。
5. 企查查 / 国家企业信用信息公示系统：核验公司和被执行人情况。
6. 人民法院在线服务：仅用于半自动立案材料核对和人工提交。

## 四、网页登录动作
${loginActions}

## 五、站点打开清单
${EXTERNAL_LEGAL_SOURCES.map(source => {
  const preset = source.presetId ? `presetId: ${source.presetId}` : '无需登录预设或使用通用网页登录';
  return `- ${source.label}（${preset}）：${source.use}\n  ${source.url}`;
}).join('\n')}

## 六、检索词
${queries.map((q, index) => `${index + 1}. ${q}`).join('\n')}

## 七、来源登记表字段
| 来源 | 检索词 | 标题/案号 | 法院层级 | 裁判日期/发布日期 | 链接 | 关键摘录 | 对我方有利点 | 不利/区分点 | 复核人 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 |
`;
  const caseLine = archiveLegalReportToCase(args, {
    orgId,
    userId,
    caseName,
    title: `${caseName} 外部检索行动单`,
    content: report,
    type: 'note',
    cause: caseType,
  });
  return `${report}\n## 八、案件空间归档\n${caseLine}`;
}

// ── legal_generate_citation_verification_report ─────────────────────────

async function readLegalTextForReport(args: Record<string, any>): Promise<{ text: string; title: string; source: string }> {
  const content = textArg(args, 'text') || textArg(args, 'content');
  if (content) {
    return {
      text: content,
      title: textArg(args, 'title') || textArg(args, 'caseName') || '粘贴文本',
      source: 'pasted_text',
    };
  }

  const filePath = textArg(args, 'filePath');
  if (filePath) {
    const resolved = path.resolve(expandLocalPath(filePath));
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new Error(`待核验文件不存在：${resolved}`);
    }
    const parsed = await parseDocument(resolved);
    if (!parsed?.text?.trim()) throw new Error(`无法从文件中提取文本：${resolved}`);
    return {
      text: parsed.text,
      title: textArg(args, 'title') || path.basename(resolved),
      source: resolved,
    };
  }

  throw new Error('请提供 text/content 或 filePath，用于生成引用核验报告。');
}

async function generateCitationVerificationReportHandler(args: Record<string, any>, context?: any): Promise<string> {
  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const input = await readLegalTextForReport({ ...args, orgId });
  const caseName = textArg(args, 'caseName') || input.title || '未命名案件';
  const outputDir = resolveWritableOutputDir(
    textArg(args, 'outputDir'),
    ensureLegalDeliveryRoot(orgId),
    caseName,
    'citation_report',
  );
  const report = formatCitationReportMarkdown({ ...args, caseName, orgId }, input.text, input.source);
  const reportPath = path.join(outputDir, 'citation-verification-report.md');
  fs.writeFileSync(reportPath, report, 'utf-8');

  let kbLine = '- 知识库：未导入。';
  if (args.importToKb === true || args.confirmedForKb === true) {
    const article = createLegalArticle(orgId, userId, {
      title: `${caseName} 引用核验报告`,
      content: report,
      articleType: 'research_note',
      category: 'legal_research_note',
      tags: ['legal:citation-verification', `caseName:${caseName}`],
    });
    const indexed = await indexLegalArticle(orgId, article.id);
    kbLine = `- 知识库：已导入 articleId=${article.id}，索引块数=${indexed}`;
  }

  const checks = verifyMultipleCitations(input.text, orgId);
  const repealed = checks.filter(item => item.isEffective === false).length;
  const missing = checks.filter(item => !item.exists).length;

  return [
    '# 引用核验报告已生成',
    '',
    `- 案件：${caseName}`,
    `- 来源：${input.source}`,
    `- 报告文件：${reportPath}`,
    `- 引用总数：${checks.length}`,
    `- 已废止/失效风险：${repealed}`,
    `- 未确认存在：${missing}`,
    kbLine,
    '',
    '## 下一步',
    '- 已废止法条请替换为现行有效法律或司法解释。',
    '- 未在本地库命中的案号，请到人民法院案例库、裁判文书网或授权商业库人工复核。',
  ].join('\n');
}

// ── legal_finalize_delivery_package ─────────────────────────────────────

async function finalizeDeliveryPackageHandler(args: Record<string, any>, context?: any): Promise<string> {
  const content = textArg(args, 'content') || textArg(args, 'packetText') || textArg(args, 'documentText');
  if (!content) return '请提供 content / packetText / documentText，用于生成正式交付包。';

  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const userId = textArg(args, 'userId') || context?.userId || 'system';
  const caseId = textArg(args, 'caseId');
  const caseName = textArg(args, 'caseName') || markdownTitle(content, '未命名案件');
  const documentType = normalizeFormalDocumentType(textArg(args, 'documentType') || textArg(args, 'type'));
  const outputDir = resolveWritableOutputDir(
    textArg(args, 'outputDir'),
    ensureLegalDeliveryRoot(orgId),
    caseName,
    'delivery_package',
  );

  const archivedReasoning = findArchivedLegalReasoningGateText(args, orgId);
  const reasoningArgs = archivedReasoning ? { ...args, archivedReasoning } : args;
  const formalMarkdown = buildFormalLegalMarkdown({ ...args, caseName, documentType }, content);
  const citationReport = formatCitationReportMarkdown({ ...args, caseName, orgId }, formalMarkdown, 'formal_delivery_document');
  const currentLawGate = evaluateCurrentLawGate(formalMarkdown, orgId);
  const reasoningGate = evaluateLegalReasoningGate(reasoningArgs, content);
  const reasoningSourceRow = archivedReasoning
    ? '| 内部推理底稿 | 案件工作台 | 已归档三段论底稿 | 案件材料 | 已归档 | 三段论推理链 gate | 已复用 |'
    : '| 内部推理底稿 | legal_case_reasoning_matrix / reasoningSummary | 待登记 | 待登记 | 待登记 | 三段论推理链 gate | 待补充 |';
  const sourceRegister = [
    `# ${caseName} 来源登记表`,
    '',
    '| 来源类型 | 来源名称/平台 | 标题/案号 | 链接/文件路径 | 取得时间 | 用途 | 复核状态 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| 法律法规 | 国家法律法规数据库/本地法条库 | 待登记 | 待登记 | 待登记 | 核验现行有效法律 | 律师复核 |',
    '| 类案案例 | 人民法院案例库/裁判文书网/法蝉/Alpha | 待登记 | 待登记 | 待登记 | 类案补强 | 律师复核 |',
    '| 证据材料 | 本地案件材料/当事人提供 | 待登记 | 待登记 | 待登记 | 证明待证事实 | 原件核对 |',
    reasoningSourceRow,
    '| 外部主体信息 | 企查查/国家企业信用/执行信息公开网 | 待登记 | 待登记 | 待登记 | 主体与财产线索核验 | 律师复核 |',
    '',
    '边界：未登记来源的法条、案例、网页摘录和主体信息，不应作为最终对外文书中的确定性依据。',
    '',
  ].join('\n');
  const manifest = [
    `# ${caseName} 正式交付包`,
    '',
    `- 文书类型：${documentType}`,
    `- 生成时间：${new Date().toISOString()}`,
    `- 输出目录：${outputDir}`,
    `- 状态：律师复核稿（现行有效法律硬门槛、三段论推理链硬门槛已通过）`,
    '',
    '## 文件清单',
    '- 01_formal-document.md：正式文书复核稿',
    '- 02_citation-verification-report.md：法条/案例引用核验报告',
    '- 03_source-register.md：来源登记表',
    '- 04_filing-and-signature-checklist.md：提交、签署、盖章、送达确认清单',
    '',
    '## 边界',
    '- Lumi 只生成本地文件和复核清单，不自动提交、签名、盖章、缴费、发送或确认送达。',
    '- 已废止、失效或未确认的法条引用会阻断正式交付包生成。',
    '- 缺少大前提、小前提或涵摄结论的三段论推理链会阻断正式交付包生成。',
    '- 若需 PDF，请在安装 Microsoft Word 的 Windows 环境中设置 includePdf=true 生成，或由律师确认后另行导出。',
    '',
  ].join('\n');
  const filingChecklist = [
    `# ${caseName} 提交与签署确认清单`,
    '',
    '- 当事人身份、主体资格、授权委托手续是否齐全。',
    '- 诉讼请求/抗辩目标、金额、利息、违约金、保全、诉讼费是否复核。',
    '- 管辖法院、案由、法院平台字段是否与材料一致。',
    '- 证据目录、证明目的、页码、份数、原件核对状态是否一致。',
    '- 律师签字、律所盖章、当事人签章、特别授权范围是否确认。',
    '- 网上立案、缴费、送达确认、撤回、和解等动作必须人工完成。',
    '',
  ].join('\n');

  const formalPath = path.join(outputDir, '01_formal-document.md');
  const reportPath = path.join(outputDir, '02_citation-verification-report.md');
  const sourcePath = path.join(outputDir, '03_source-register.md');
  const checklistPath = path.join(outputDir, '04_filing-and-signature-checklist.md');
  const manifestPath = path.join(outputDir, '00_manifest.md');
  const gatePath = path.join(outputDir, '00_current-law-gate-blocked.md');
  const reasoningGatePath = path.join(outputDir, '00_reasoning-gate-blocked.md');

  if (!currentLawGate.passed) {
    const gateReport = formatCurrentLawGateBlock({
      caseName,
      documentType,
      outputDir,
      reportPath,
      sourcePath,
      gate: currentLawGate,
    });
    fs.writeFileSync(reportPath, citationReport, 'utf-8');
    fs.writeFileSync(sourcePath, sourceRegister, 'utf-8');
    fs.writeFileSync(gatePath, gateReport, 'utf-8');
    const blockedMaterial = appendLegalCaseMaterial({
      orgId,
      userId,
      caseId,
      type: 'note',
      title: `${documentType}交付包阻断记录`,
      content: gateReport,
      localPath: outputDir,
    });
    const caseArchiveLine = caseId
      ? blockedMaterial ? `- 案件空间：已归档阻断记录 materialId=${blockedMaterial.id}` : '- 案件空间：未归档（caseId 不存在或无权限）'
      : '- 案件空间：未归档（未提供 caseId）';

    return [
      '# 正式交付包未生成',
      '',
      `- 案件：${caseName}`,
      `- 文书类型：${documentType}`,
      `- 输出目录：${outputDir}`,
      `- 阻断原因：现行有效法律硬门槛未通过。存在已废止、失效或未确认的法条引用。`,
      `- 阻断法条数：${currentLawGate.blockingStatutes.length}`,
      `- 引用核验报告：${reportPath}`,
      `- 来源登记表：${sourcePath}`,
      `- 阻断记录：${gatePath}`,
      caseArchiveLine,
      '',
      '## 阻断项',
      ...formatCitationList(currentLawGate.blockingStatutes),
      '',
      '请先替换或核验法条，再重新运行 legal_finalize_delivery_package。',
    ].join('\n');
  }

  if (!reasoningGate.passed) {
    const reasoningReport = [
      `# ${caseName} reasoning gate blocked`,
      '',
      `- Document type: ${documentType}`,
      `- Checked at: ${new Date().toISOString()}`,
      `- Output directory: ${outputDir}`,
      `- Citation report: ${reportPath}`,
      `- Source register: ${sourcePath}`,
      `- Major premise present: ${reasoningGate.hasMajorPremise ? 'yes' : 'no'}`,
      `- Minor premise present: ${reasoningGate.hasMinorPremise ? 'yes' : 'no'}`,
      `- Conclusion/subsumption present: ${reasoningGate.hasConclusion ? 'yes' : 'no'}`,
      '',
      '## Missing Reasoning Links',
      '',
      ...(reasoningGate.missing.length ? reasoningGate.missing.map(item => `- ${item}`) : ['- None']),
      '',
      '## Required Fix',
      '',
      '- Run legal_case_reasoning_matrix or provide reasoningMatrix/reasoningSummary before generating the formal delivery package.',
      '- The formal package must show a reviewable chain from current law, to facts/evidence, to application/conclusion.',
      '',
    ].join('\n');
    fs.writeFileSync(reportPath, citationReport, 'utf-8');
    fs.writeFileSync(sourcePath, sourceRegister, 'utf-8');
    fs.writeFileSync(reasoningGatePath, reasoningReport, 'utf-8');
    const blockedMaterial = appendLegalCaseMaterial({
      orgId,
      userId,
      caseId,
      type: 'note',
      title: `${documentType}三段论推理链阻断记录`,
      content: reasoningReport,
      localPath: outputDir,
    });
    const caseArchiveLine = caseId
      ? blockedMaterial ? `- 案件空间：已归档阻断记录 materialId=${blockedMaterial.id}` : '- 案件空间：未归档（caseId 不存在或无权限）'
      : '- 案件空间：未归档（未提供 caseId）';

    return [
      '# 正式交付包未生成',
      '',
      `- 案件：${caseName}`,
      `- 文书类型：${documentType}`,
      `- 输出目录：${outputDir}`,
      '- 阻断原因：三段论推理链硬门槛未通过。缺少可复核的大前提、小前提或涵摄结论。',
      `- 大前提：${reasoningGate.hasMajorPremise ? '已识别' : '缺失'}`,
      `- 小前提：${reasoningGate.hasMinorPremise ? '已识别' : '缺失'}`,
      `- 涵摄结论：${reasoningGate.hasConclusion ? '已识别' : '缺失'}`,
      `- 引用核验报告：${reportPath}`,
      `- 来源登记表：${sourcePath}`,
      `- 阻断记录：${reasoningGatePath}`,
      caseArchiveLine,
      '',
      '请先运行 legal_case_reasoning_matrix，或提供 reasoningMatrix/reasoningSummary，再重新运行 legal_finalize_delivery_package。',
    ].join('\n');
  }

  fs.writeFileSync(manifestPath, manifest, 'utf-8');
  fs.writeFileSync(formalPath, formalMarkdown, 'utf-8');
  fs.writeFileSync(reportPath, citationReport, 'utf-8');
  fs.writeFileSync(sourcePath, sourceRegister, 'utf-8');
  fs.writeFileSync(checklistPath, filingChecklist, 'utf-8');

  const docxLines: string[] = [];
  if (args.includeDocx !== false) {
    const docxPath = path.join(outputDir, `${safeFileSegment(`${caseName}_${documentType}`, 'formal-document')}.docx`);
    await writeDocxFromMarkdown(formalMarkdown, docxPath);
    docxLines.push(`- DOCX：${docxPath}`);
    if (args.includePdf === true) {
      const pdf = tryConvertDocxToPdf(docxPath);
      docxLines.push(pdf.ok ? `- PDF：${pdf.pdfPath}` : `- PDF：未生成（${String(pdf.error || '').slice(0, 300)}）`);
    }
  }

  const riskCount = currentLawGate.checks.filter(item => !item.exists || item.isEffective === false).length;
  const archivedMaterial = appendLegalCaseMaterial({
    orgId,
    userId,
    caseId,
    type: 'pleading',
    title: `${documentType}正式交付包`,
    content: [
      formalMarkdown,
      '',
      '---',
      '',
      citationReport,
      '',
      '---',
      '',
      sourceRegister,
    ].join('\n'),
    localPath: outputDir,
  });
  const caseArchiveLine = caseId
    ? archivedMaterial ? `- 案件空间：已归档正式交付包 materialId=${archivedMaterial.id}` : '- 案件空间：未归档（caseId 不存在或无权限）'
    : '- 案件空间：未归档（未提供 caseId）';

  return [
    '# 正式交付包已生成',
    '',
    `- 案件：${caseName}`,
    `- 文书类型：${documentType}`,
    `- 输出目录：${outputDir}`,
    `- 交付清单：${manifestPath}`,
    `- 正式文书复核稿：${formalPath}`,
    `- 引用核验报告：${reportPath}`,
    `- 来源登记表：${sourcePath}`,
    `- 提交确认清单：${checklistPath}`,
    caseArchiveLine,
    ...docxLines,
    '- 现行有效法律硬门槛：通过',
    '- 三段论推理链硬门槛：通过',
    `- 引用风险项：${riskCount}`,
    '',
    '## 人工边界',
    'Lumi 已生成本地交付文件，但没有自动提交、签发、盖章、缴费、发送或确认送达。正式使用前必须由律师复核。',
  ].join('\n');
}

// ── legal_prepare_external_browser_workspace ────────────────────────────

function pickExternalLegalSources(args: Record<string, any>): typeof EXTERNAL_LEGAL_SOURCES {
  const rawSources = [
    ...listArg(args, 'sourceIds'),
    ...listArg(args, 'sources'),
    ...listArg(args, 'platforms'),
  ].map(item => item.toLowerCase());
  const action = `${textArg(args, 'action')} ${textArg(args, 'purpose')} ${textArg(args, 'caseType')}`;
  let selected = EXTERNAL_LEGAL_SOURCES.filter(source => {
    const haystack = `${source.label} ${source.presetId} ${source.url}`.toLowerCase();
    return rawSources.length > 0 && rawSources.some(item => haystack.includes(item));
  });

  if (selected.length === 0) {
    selected = EXTERNAL_LEGAL_SOURCES.filter(source =>
      ['people-court-case-library', 'china-judgments-online', 'fachan', 'alpha-lawyer'].includes(source.presetId),
    );
  }
  if (/公司|企业|被执行|股权|工商|企查查|信用/i.test(action) || listArg(args, 'companyNames').length > 0) {
    for (const source of EXTERNAL_LEGAL_SOURCES.filter(item => ['qichacha', 'national-enterprise-credit'].includes(item.presetId))) {
      if (!selected.includes(source)) selected.push(source);
    }
  }
  if (/立案|法院在线|提交|filing/i.test(action)) {
    const filing = EXTERNAL_LEGAL_SOURCES.find(item => item.presetId === 'court-online-service');
    if (filing && !selected.includes(filing)) selected.push(filing);
  }
  return selected;
}

async function prepareExternalBrowserWorkspaceHandler(args: Record<string, any>, context?: any): Promise<string> {
  const orgId = textArg(args, 'orgId') || context?.orgId || 'default';
  const caseName = textArg(args, 'caseName') || '外部检索';
  const caseType = textArg(args, 'caseType') || '民事纠纷';
  const issues = listArg(args, 'issues');
  const facts = textArg(args, 'facts');
  const companyNames = listArg(args, 'companyNames');
  const selectedSources = pickExternalLegalSources(args);
  const queries = [
    ...listArg(args, 'queries'),
    ...buildSearchQueries({ ...args, caseType, facts, issues }),
  ].filter((item, index, arr) => item && arr.indexOf(item) === index).slice(0, 18);
  const outputDir = resolveWritableOutputDir(
    textArg(args, 'outputDir'),
    ensureLegalExternalWorkspaceRoot(orgId),
    caseName,
    'browser_workspace',
  );

  const commands = selectedSources
    .filter(source => source.presetId)
    .map(source => [
      `# ${source.label}`,
      `web_login_profile_save_from_preset {"presetId":"${source.presetId}"}`,
      `web_login_run {"profileId":"${source.presetId}","headless":false}`,
    ].join('\n'))
    .join('\n\n');
  const runbook = [
    `# ${caseName} 外部网页登录工作区`,
    '',
    `- 案由/类型：${caseType}`,
    `- 争议焦点：${issues.join('；') || '待补充'}`,
    `- 企业/被执行人：${companyNames.join('；') || '待补充'}`,
    `- 生成时间：${new Date().toISOString()}`,
    '',
    '## 工作边界',
    '- 当前是“授权网页登录协作”，不是平台数据库接入。',
    '- Lumi 可打开可见浏览器、复用授权会话、整理检索词和来源登记表。',
    '- Lumi 不绕过验证码、二维码、人脸、短信验证、付费墙、账号权限、频控或下载限制。',
    '- 律师确认后的下载文件、网页摘录和来源登记，可再导入组织知识库。',
    '',
    '## 建议检索词',
    queries.map((query, index) => `${index + 1}. ${query}`).join('\n') || '1. 待补充检索词',
    '',
    '## 站点与用途',
    selectedSources.map(source => `- ${source.label}：${source.use}\n  ${source.url}`).join('\n'),
    '',
    '## 浏览器动作',
    commands || '无需登录预设；使用普通浏览器打开官网并人工确认。',
    '',
  ].join('\n');
  const sourceRegisterCsv = [
    'source,query,title_or_case_number,court_level,date,url,key_excerpt,favorable_point,unfavorable_or_distinguish,reviewer,status',
    '待登记,待登记,待登记,待登记,待登记,待登记,待登记,待登记,待登记,待登记,待复核',
  ].join('\n');
  const commandsMd = [
    '# web_login commands',
    '',
    commands || 'No preset command generated.',
    '',
    'After the lawyer confirms a source, import it with legal_import_materials_to_kb.',
    '',
  ].join('\n');

  const runbookPath = path.join(outputDir, '00_browser-workspace.md');
  const registerPath = path.join(outputDir, '01_source-register.csv');
  const commandsPath = path.join(outputDir, '02_web-login-commands.md');
  fs.writeFileSync(runbookPath, runbook, 'utf-8');
  fs.writeFileSync(registerPath, sourceRegisterCsv, 'utf-8');
  fs.writeFileSync(commandsPath, commandsMd, 'utf-8');

  return [
    '# 外部网页登录工作区已生成',
    '',
    `- 案件：${caseName}`,
    `- 输出目录：${outputDir}`,
    `- 操作手册：${runbookPath}`,
    `- 来源登记表：${registerPath}`,
    `- 登录命令：${commandsPath}`,
    `- 站点数量：${selectedSources.length}`,
    '',
    '## 可执行命令',
    commands || '无网页登录预设。',
    '',
    '边界：不自动抓取、不批量同步、不绕过平台限制；登录、验证码、下载权限和最终引用均由律师确认。',
  ].join('\n');
}

// ── legal_verify_citation ───────────────────────────────────────────────

async function verifyCitationHandler(args: Record<string, any>): Promise<string> {
  const citation = args.citation as string;
  const text = args.text as string;
  const orgId = (args.orgId as string) || undefined;

  if (text) {
    const checks = verifyMultipleCitations(text, orgId);
    if (checks.length === 0) return '未在文本中检测到法条引用（《XX法》格式）或案号引用。';
    return checks.map(c =>
      `${c.citation}\n  类型: ${c.type === 'statute' ? '法条引用' : '案例引用'}\n  存在: ${c.exists ? '是' : '否'}\n  有效: ${c.isEffective === null ? '不适用' : c.isEffective ? '现行有效' : '已废止'}\n  ${c.detail}\n  来源: ${c.source || 'N/A'}`,
    ).join('\n\n');
  }

  if (citation) {
    const check = verifyCitation(citation, orgId);
    return `${check.citation}\n  类型: ${check.type === 'statute' ? '法条引用' : '案例引用'}\n  存在: ${check.exists ? '是' : '否'}\n  有效: ${check.isEffective === null ? '不适用' : check.isEffective ? '现行有效' : '已废止'}\n  ${check.detail}\n  来源: ${check.source || 'N/A'}`;
  }

  return '请提供citation（单个引用）或text（批量验证）参数。';
}

// ── legal_import_judgment ───────────────────────────────────────────────

async function importJudgmentHandler(args: Record<string, any>): Promise<string> {
  const filePath = args.filePath as string;
  const orgId = (args.orgId as string) || 'default';
  const userId = (args.userId as string) || 'system';
  const content = args.content as string;

  if (!filePath && !content) return '请提供filePath（文件路径）或content（文书正文）。';

  let text: string;
  if (content) {
    text = content;
  } else {
    const result = await parseDocument(filePath);
    if (!result) return `无法解析文件: ${filePath}`;
    text = result.text;
  }

  const metadata = extractLegalMetadata(text);
  const title = metadata.caseNumber
    ? `${metadata.caseNumber} ${metadata.causeOfAction || ''}`
    : (filePath ? filePath.split('/').pop()?.split('\\').pop() || '裁判文书' : '裁判文书');

  const article = createLegalArticle(orgId, userId, {
    title,
    content: text,
    articleType: 'judgment',
    metadata: {
      articleType: 'judgment',
      caseNumber: metadata.caseNumber,
      court: metadata.court,
      parties: metadata.parties,
      causeOfAction: metadata.causeOfAction,
      judgmentDate: metadata.judgmentDate,
      statutesCited: metadata.statutesCited,
    },
  });

  const indexed = await indexLegalArticle(orgId, article.id);

  return `裁判文书导入成功。

- 标题: ${title}
- 案号: ${metadata.caseNumber || '未识别'}
- 审理法院: ${metadata.court || '未识别'}
- 案由: ${metadata.causeOfAction || '未识别'}
- 当事人: ${metadata.parties?.join(', ') || '未识别'}
- 引用法条: ${metadata.statutesCited?.join(', ') || '未识别'}
- 裁判日期: ${metadata.judgmentDate || '未识别'}
- 索引状态: ${indexed} 个文本块已向量化

该文书已录入组织知识库，可通过类案检索查询。`;
}

// ── Register All ────────────────────────────────────────────────────────

export function registerLegalTools(registry: ToolRegistry): void {
  registry.register({
    name: 'legal_search_case',
    description: '类案检索 — 根据案由或事实描述在本地裁判文书库中搜索相似案例，返回案号、法院、相似度分数、摘要。数据来源：本地导入的中国裁判文书网公开文书。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '案由或事实描述，如"民间借贷纠纷"或"开发商逾期交房"' },
        limit: { type: 'number', description: '返回结果数量上限，默认5' },
        orgId: { type: 'string', description: '组织ID' },
      },
      required: ['query'],
    },
    handler: searchCaseHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_search_statute',
    description: '法条检索 — 按关键词或法条号搜索现行有效法律法规。数据来源：国家法律法规数据库 (flk.npc.gov.cn) 及本地法条库。自动标注已废止法条。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '法条名称或关键词，如"民法典合同编"或"劳动合同法"' },
        sourceIds: { type: 'array', items: { type: 'string' }, description: '可选外部授权库，如 pkulaw、farui、national-law-regulations' },
        sources: { type: 'array', items: { type: 'string' }, description: 'sourceIds 的别名' },
        includeOfficialWeb: { type: 'boolean', description: '是否同时尝试国家法律法规数据库公开网页检索，默认 false' },
        limit: { type: 'number', description: '外部授权库返回数量上限，默认 5' },
        orgId: { type: 'string', description: '组织ID' },
      },
      required: ['query'],
    },
    handler: searchStatuteHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_generate_bid',
    description: '标书生成 — 导入招标文件要求，生成对应投标书框架（商务标+技术标）。使用住建部合同模板作为参考。',
    parameters: {
      type: 'object',
      properties: {
        requirements: { type: 'string', description: '招标文件中的技术要求/评分标准/合同条款要求' },
        content: { type: 'string', description: 'requirements 的别名，可粘贴招标文件正文' },
        text: { type: 'string', description: 'requirements 的别名，可粘贴招标文件正文' },
        filePath: { type: 'string', description: '单个招标文件路径，支持 PDF/DOCX/XLSX/PPTX/RTF/TXT/MD/CSV' },
        filePaths: { type: 'array', items: { type: 'string' }, description: '多个招标文件路径' },
        folderPath: { type: 'string', description: '招标文件夹路径，会批量读取支持的文档格式' },
        folderName: { type: 'string', description: '桌面/文档/下载目录中的招标文件夹名称或关键词' },
        recursive: { type: 'boolean', description: '读取文件夹时是否递归子目录，默认 true' },
        maxFiles: { type: 'number', description: '文件夹读取最大文件数，默认 30，最高 100' },
        maxChars: { type: 'number', description: '最多提取文本字数，默认 180000，最高 600000' },
        projectName: { type: 'string', description: '项目名称' },
        caseId: { type: 'string', description: '已有案件工作台 ID；提供后会把标书工作底稿归档到该案件空间' },
        caseName: { type: 'string', description: '案件、项目或工作空间名称' },
        caseType: { type: 'string', description: '事项类型，例如投标/招标文件响应' },
        persistCase: { type: 'boolean', description: '是否归档到案件空间；提供 caseId/caseName 时默认归档，设置 false 可关闭' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
    },
    handler: generateBidHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_review_contract',
    description: '合同审查 — 对照本地案例库审查合同条款风险，标注风险等级、法律依据和修改建议。所有法条引用均会标注来源。',
    parameters: {
      type: 'object',
      properties: {
        contract: { type: 'string', description: '待审查的合同全文' },
        caseId: { type: 'string', description: '已有案件工作台 ID；提供后会把合同审查报告归档到该案件空间' },
        caseName: { type: 'string', description: '案件、项目或合同审查事项名称' },
        title: { type: 'string', description: 'caseName 的别名' },
        caseType: { type: 'string', description: '案由、事项类型或合同类型' },
        persistCase: { type: 'boolean', description: '是否归档到案件空间；提供 caseId/caseName 时默认归档，设置 false 可关闭' },
        orgId: { type: 'string', description: '组织ID' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
      required: ['contract'],
    },
    handler: reviewContractHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_draft_contract',
    description: '合同起草 — 基于中国住建部示范文本生成合同。支持施工合同、买卖合同、工程总承包、劳动合同等类型。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '合同类型：建设工程施工合同 / 商品房买卖合同 / 工程总承包合同 / 建筑工人劳动合同' },
        details: { type: 'string', description: '合同具体要求（项目信息、工期、价款等）' },
        caseId: { type: 'string', description: '已有案件工作台 ID；提供后会把合同起草底稿归档到该案件空间' },
        caseName: { type: 'string', description: '案件、项目或合同起草事项名称' },
        caseType: { type: 'string', description: '案由、事项类型或合同类型' },
        persistCase: { type: 'boolean', description: '是否归档到案件空间；提供 caseId/caseName 时默认归档，设置 false 可关闭' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
      required: ['type'],
    },
    handler: draftContractHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_trace_assets',
    description: '财产线索追踪 — 查询被执行人企业信息、公开执行记录、失信记录等财产线索。企查查仅在配置官方 API 凭证后自动查询；未配置时输出授权网页登录协作步骤。后续可查询婚姻状况和股权穿透。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '被执行主体名称（个人姓名/公司名称）' },
        caseId: { type: 'string', description: '已有案件工作台 ID；提供后会把财产线索报告归档到该案件空间' },
        caseName: { type: 'string', description: '关联案件名称或简称' },
        caseType: { type: 'string', description: '案由或事项类型；用于新建案件或归档标记' },
        persistCase: { type: 'boolean', description: '是否归档到案件空间；提供 caseId/caseName 时默认归档，设置 false 可关闭' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
      required: ['name'],
    },
    handler: traceAssetsHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_equity_penetration',
    description: '股权穿透分析 — 追溯目标公司的股东结构，多层穿透识别实际控制人和关联财产线索。企查查仅在配置官方 API 凭证后自动查询；未配置时输出授权网页登录协作和材料入库步骤。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '公司名称' },
        caseId: { type: 'string', description: '已有案件工作台 ID；提供后会把股权穿透报告归档到该案件空间' },
        caseName: { type: 'string', description: '关联案件名称或简称' },
        caseType: { type: 'string', description: '案由或事项类型；用于新建案件或归档标记' },
        persistCase: { type: 'boolean', description: '是否归档到案件空间；提供 caseId/caseName 时默认归档，设置 false 可关闭' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
      required: ['name'],
    },
    handler: equityPenetrationHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_case_strategy',
    description: '诉讼策略分析 — 给定案件事实，结合相关法条和相似判例，制定应诉方案，包括：案由确定、证据建议、保全策略、风险预估。所有分析基于真实法条和判例，绝不编造。',
    parameters: {
      type: 'object',
      properties: {
        facts: { type: 'string', description: '案件事实描述（时间、地点、主体、行为、争议焦点）' },
        caseId: { type: 'string', description: '已有案件工作台 ID；提供后会把策略分析归档到该案件空间' },
        caseName: { type: 'string', description: '关联案件名称或简称' },
        caseType: { type: 'string', description: '案由或案件类型' },
        persistCase: { type: 'boolean', description: '是否归档到案件空间；提供 caseId/caseName 时默认归档，设置 false 可关闭' },
        orgId: { type: 'string', description: '组织ID' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
      required: ['facts'],
    },
    handler: caseStrategyHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_case_workspace',
    description: '统一案件工作台 — 创建或更新案件空间，归集身份信息、事实、证据、争议焦点、法源、类案、文书包、立案状态，并输出下一步工具链。用于把会议、聊天、材料、诉讼文书和外部检索串成同一个案件闭环。',
    parameters: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: '已有案件 ID；提供时更新该案件空间' },
        caseName: { type: 'string', description: '案件名称或简称' },
        title: { type: 'string', description: 'caseName 的别名' },
        stage: { type: 'string', description: '阶段：consultation/filing/trial/judgment/enforcement/closed，或中文阶段' },
        role: { type: 'string', description: '我方身份：原告/被告/申请人/被申请人等' },
        caseType: { type: 'string', description: '案由或案件类型' },
        cause: { type: 'string', description: 'caseType 的别名' },
        court: { type: 'string', description: '法院、仲裁机构或拟提交平台' },
        parties: { type: 'string', description: '当事人身份信息、主体信息和联系方式摘要' },
        claims: { type: 'string', description: '诉讼请求、抗辩目标或办理目标' },
        objective: { type: 'string', description: 'claims 的别名' },
        facts: { type: 'string', description: '案件事实、时间线或沟通记录摘要' },
        materials: { type: 'string', description: '综合案件材料摘要，facts 的补充来源' },
        evidence: { type: 'string', description: '证据材料、证据目录或零碎证据列表' },
        complaint: { type: 'string', description: '起诉状、申请书、答辩状或对方文书摘要' },
        opponentMaterials: { type: 'string', description: '对方起诉状、证据、答辩意见或代理意见摘要' },
        transcript: { type: 'string', description: '会议、庭审、沟通或询问笔录' },
        trialNotes: { type: 'string', description: 'transcript 的别名' },
        legalAuthorities: { type: 'string', description: '已检索或拟引用的法条、司法解释、裁判规则' },
        similarCases: { type: 'string', description: '已检索类案、案号、法院层级和有利/不利点' },
        persistCase: { type: 'boolean', description: '是否写入组织案件档案，默认 true' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
    },
    handler: caseWorkspaceHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_case_workflow_status',
    description: '案件闭环状态评估 — 只读取已有案件或临时案件材料，不创建文书；输出材料入案、身份主体、事实时间线、证据三性、三段论、现行有效法律、类案来源、文书策略、立案协作、正式交付的完成度、阻断项、待补项和下一步推荐工具。适合聊天、语音、飞书/企微里询问“这个案子还缺什么/下一步做什么/能不能正式交付”。',
    parameters: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: '已有案件 ID；提供时优先读取该案件空间' },
        caseName: { type: 'string', description: '案件名称或简称；未提供 caseId 时按名称查找' },
        title: { type: 'string', description: 'caseName 的别名' },
        query: { type: 'string', description: 'caseName 的别名，适合自然语言查找' },
        stage: { type: 'string', description: '阶段：consultation/filing/trial/judgment/enforcement/closed，或中文阶段' },
        role: { type: 'string', description: '我方身份：原告/被告/申请人/被申请人等' },
        caseType: { type: 'string', description: '案由或案件类型' },
        cause: { type: 'string', description: 'caseType 的别名' },
        court: { type: 'string', description: '法院、仲裁机构或拟提交平台' },
        parties: { type: 'string', description: '当事人身份信息、主体信息和联系方式摘要' },
        claims: { type: 'string', description: '诉讼请求、抗辩目标或办理目标' },
        objective: { type: 'string', description: 'claims 的别名' },
        facts: { type: 'string', description: '案件事实、时间线或沟通记录摘要' },
        materials: { type: 'string', description: '综合案件材料摘要，facts 的补充来源' },
        evidence: { type: 'string', description: '证据材料、证据目录或零碎证据列表' },
        complaint: { type: 'string', description: '起诉状、申请书、答辩状或对方文书摘要' },
        opponentMaterials: { type: 'string', description: '对方起诉状、证据、答辩意见或代理意见摘要' },
        transcript: { type: 'string', description: '会议、庭审、沟通或询问笔录' },
        trialNotes: { type: 'string', description: 'transcript 的别名' },
        legalAuthorities: { type: 'string', description: '已检索或拟引用的法条、司法解释、裁判规则' },
        similarCases: { type: 'string', description: '已检索类案、案号、法院层级和有利/不利点' },
        content: { type: 'string', description: '需要纳入法源预检的文书或材料内容' },
        documentText: { type: 'string', description: 'content 的别名' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
      },
    },
    handler: caseWorkflowStatusHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_message_intake_to_case',
    description: '远程法律消息入案 — 把微信、飞书、企微、短信或聊天里转发的案件材料、法院短信链接、通知链接、附件说明和沟通记录写入统一案件空间，归档原文、识别案号/法院/日期、半自动处理链接，并返回案件闭环状态和下一步。适合 Lumi bot 收到“把这个发给 Lumi 入案/归档到案件/法院短信链接/案件材料”时使用。',
    parameters: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: '来源平台：feishu/wechat/wecom/sms/other，或中文“飞书/微信/企微/短信”' },
        sender: { type: 'string', description: '发送人、联系人或群名' },
        message: { type: 'string', description: '原始消息正文、短信原文、聊天记录或案件材料说明' },
        text: { type: 'string', description: 'message 的别名' },
        content: { type: 'string', description: 'message 的别名' },
        receivedAt: { type: 'string', description: '收到消息的时间，默认当前时间' },
        attachments: { type: 'array', items: { type: 'object' }, description: '附件对象，可包含 fileName/localPath/extractedText/content' },
        fileNames: { type: 'array', items: { type: 'string' }, description: '附件文件名列表' },
        urls: { type: 'array', items: { type: 'string' }, description: '消息中的链接列表；未提供时会从正文提取' },
        url: { type: 'string', description: '单个链接；未提供时会从正文提取' },
        caseId: { type: 'string', description: '已有案件工作台 ID；提供后归档到该案件' },
        caseName: { type: 'string', description: '案件名称或简称；未提供时按案号或消息自动新建' },
        title: { type: 'string', description: 'caseName 的别名' },
        caseType: { type: 'string', description: '案由或案件类型' },
        cause: { type: 'string', description: 'caseType 的别名' },
        court: { type: 'string', description: '法院或仲裁机构' },
        parties: { type: 'string', description: '当事人或主体信息' },
        stage: { type: 'string', description: '案件阶段，默认咨询；识别到开庭日期时偏向庭审阶段' },
        processLinks: { type: 'boolean', description: '是否处理识别到的链接，默认 true；false 时只归档不抓取' },
        persistCase: { type: 'boolean', description: '是否写入案件空间，默认 true' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
    },
    handler: legalMessageIntakeToCaseHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_meeting_minutes_to_case',
    description: '法律会议模式入案 — 将语音转写、会议沟通记录或咨询笔记整理为律师复核版会议纪要，同时生成实时滚动摘要、行动项/期限、案件入案更新文件，提取事实、证据三性提示、争议焦点和下一步，并归档到统一案件空间。',
    parameters: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: '已有案件 ID；提供时归档到该案件空间' },
        caseName: { type: 'string', description: '案件名称或简称' },
        caseType: { type: 'string', description: '案由或案件类型' },
        cause: { type: 'string', description: 'caseType 的别名' },
        stage: { type: 'string', description: '阶段：consultation/filing/trial/judgment/enforcement/closed，或中文阶段' },
        participants: { type: 'string', description: '参会、沟通或咨询人员' },
        meetingTime: { type: 'string', description: '会议或沟通时间' },
        objective: { type: 'string', description: '办理目标、咨询目标或会议目标' },
        claims: { type: 'string', description: 'objective 的别名；也可填写诉求或抗辩目标' },
        transcript: { type: 'string', description: '会议、语音、咨询或庭审转写全文' },
        meetingText: { type: 'string', description: 'transcript 的别名' },
        notes: { type: 'string', description: 'transcript 的别名；可填写沟通笔记' },
        outputDir: { type: 'string', description: '可选输出目录；默认写入 data/legal_delivery/{orgId}' },
        persistCase: { type: 'boolean', description: '是否写入组织案件档案，默认 true' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
    },
    handler: meetingMinutesToCaseHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_case_reasoning_matrix',
    description: '法律分析三段论底稿 — 围绕争议焦点生成“大前提/小前提/涵摄结论”办案分析矩阵，覆盖检索法律、解释法律、类案补强、待证事实、证据材料、举证质证和可转化文书成果，并可归档到案件空间。',
    parameters: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: '已有案件 ID；提供时归档到该案件空间' },
        caseName: { type: 'string', description: '案件名称或简称' },
        role: { type: 'string', description: '我方身份：原告/被告/申请人/被申请人等' },
        caseType: { type: 'string', description: '案由或案件类型' },
        cause: { type: 'string', description: 'caseType 的别名' },
        court: { type: 'string', description: '法院、仲裁机构或拟提交平台' },
        parties: { type: 'string', description: '当事人身份信息、主体信息和联系方式摘要' },
        claims: { type: 'string', description: '诉讼请求、抗辩目标或办理目标' },
        objective: { type: 'string', description: 'claims 的别名' },
        facts: { type: 'string', description: '案件事实、时间线或沟通记录摘要' },
        materials: { type: 'string', description: '综合案件材料摘要，facts 的补充来源' },
        evidence: { type: 'string', description: '证据材料、证据目录或零碎证据列表' },
        complaint: { type: 'string', description: '起诉状、申请书、答辩状或对方文书摘要' },
        opponentMaterials: { type: 'string', description: '对方起诉状、证据、答辩意见或代理意见摘要' },
        transcript: { type: 'string', description: '会议、庭审、沟通或询问笔录' },
        issues: { type: 'array', items: { type: 'string' }, description: '争议焦点列表；未提供时由工具从材料中推断' },
        legalAuthorities: { type: 'string', description: '已检索或拟引用的法条、司法解释、裁判规则' },
        similarCases: { type: 'string', description: '已检索类案、案号、法院层级和有利/不利点' },
        outputDir: { type: 'string', description: '可选输出目录；默认写入 data/legal_delivery/{orgId}' },
        writeFiles: { type: 'boolean', description: '是否写入 Markdown 底稿，默认 true' },
        persistCase: { type: 'boolean', description: '是否写入组织案件档案，默认 true' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
    },
    handler: reasoningMatrixHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_generate_litigation_packet',
    description: '半自动诉讼文书包 — 根据我方身份和案件材料生成起诉/答辩/质证/委托/立案组卷等律师工作底稿，并明确所有人工确认点。不会自动提交或签发。',
    parameters: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: '已有案件工作台 ID；提供后会把诉讼文书包归档到该案件空间' },
        caseName: { type: 'string', description: '案件名称或简称' },
        role: { type: 'string', description: '我方身份：原告/被告/申请人/被申请人等' },
        caseType: { type: 'string', description: '案由或案件类型' },
        court: { type: 'string', description: '拟立案法院或审理法院' },
        parties: { type: 'string', description: '当事人身份信息摘要' },
        claims: { type: 'string', description: '诉讼请求、抗辩目标或办理目标' },
        facts: { type: 'string', description: '案件事实和时间线' },
        evidence: { type: 'string', description: '已有证据材料摘要' },
        opponentMaterials: { type: 'string', description: '对方起诉状、证据或其他材料摘要' },
        outputDir: { type: 'string', description: '可选输出目录；默认写入 data/legal_delivery/{orgId}' },
        writeFiles: { type: 'boolean', description: '是否写入诉讼文书包 Markdown 文件，默认 true' },
        persistCase: { type: 'boolean', description: '是否归档到案件空间；提供 caseId/caseName 时默认归档，设置 false 可关闭' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
    },
    handler: generateLitigationPacketHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_prepare_filing_handoff',
    description: '半自动立案网交接单 — 根据案件材料生成法院在线服务/网上立案字段映射、上传材料清单、文件命名建议、人工确认点和授权网页登录动作。不会自动提交、签名、缴费或确认送达。',
    parameters: {
      type: 'object',
      properties: {
        caseName: { type: 'string', description: '案件名称或简称' },
        caseId: { type: 'string', description: '已有案件工作台 ID；提供后会把立案交接单归档到该案件空间' },
        role: { type: 'string', description: '我方身份：原告/申请人/被告等' },
        caseType: { type: 'string', description: '案由或案件类型' },
        court: { type: 'string', description: '拟立案法院或审理法院' },
        parties: { type: 'string', description: '当事人身份信息摘要' },
        claims: { type: 'string', description: '诉讼请求、申请事项或办理目标' },
        facts: { type: 'string', description: '案件事实和时间线' },
        evidence: { type: 'string', description: '已有证据材料摘要' },
        materials: { type: 'array', items: { type: 'string' }, description: '已准备或待上传的材料名称列表' },
        portalUrl: { type: 'string', description: '法院在线服务或地方诉讼服务平台 URL，默认人民法院在线服务' },
        orgId: { type: 'string', description: '组织 ID，默认 default' },
        userId: { type: 'string', description: '操作用户 ID，默认 system' },
      },
    },
    handler: prepareFilingHandoffHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_extract_dispute_focus',
    description: '争议焦点提炼 — 根据起诉状、证据材料、庭审笔录、会议记录等案件材料，整理争议焦点、待证事实、证据对应、质证/抗辩点和外部检索关键词。用于聊天或语音办案结果，需律师复核。',
    parameters: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: '已有案件工作台 ID；提供后会把争议焦点底稿归档到该案件空间' },
        caseName: { type: 'string', description: '案件名称或简称' },
        role: { type: 'string', description: '我方身份：原告/被告/申请人/被申请人等' },
        caseType: { type: 'string', description: '案由或案件类型' },
        facts: { type: 'string', description: '案件事实和时间线' },
        issues: { type: 'array', items: { type: 'string' }, description: '已知争议焦点，可为空，由系统从材料中提炼' },
        materials: { type: 'string', description: '综合案件材料摘要' },
        complaint: { type: 'string', description: '起诉状、申请书或仲裁申请书内容' },
        evidence: { type: 'string', description: '证据材料摘要或证据目录' },
        transcript: { type: 'string', description: '庭审笔录、会议纪要或语音转写内容' },
        trialNotes: { type: 'string', description: '庭审记录、律师笔记或沟通记录' },
        opponentMaterials: { type: 'string', description: '对方起诉状、证据、代理意见等材料' },
        persistCase: { type: 'boolean', description: '是否归档到案件空间；提供 caseId/caseName 时默认归档，设置 false 可关闭' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
    },
    handler: extractDisputeFocusHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_generate_argument_or_opinion',
    description: '代理词/法律意见书生成 — 根据案件事实、争议焦点、证据材料、对方观点和办理目标，生成代理词、法律意见书、庭审提纲或应对策略草稿。保留法条核验、证据补强和律师人工确认节点。',
    parameters: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: '已有案件工作台 ID；提供后会把文书草稿归档到该案件空间' },
        caseName: { type: 'string', description: '案件名称或简称' },
        role: { type: 'string', description: '我方身份：原告/被告/申请人/被申请人等' },
        documentType: { type: 'string', description: '文书类型：代理词 / 法律意见书 / 庭审提纲 / 应对策略' },
        caseType: { type: 'string', description: '案由或案件类型' },
        facts: { type: 'string', description: '案件事实、时间线或材料摘要' },
        issues: { type: 'array', items: { type: 'string' }, description: '争议焦点列表' },
        evidence: { type: 'string', description: '证据材料摘要或证据目录' },
        opponentArguments: { type: 'string', description: '对方主张、起诉状、答辩意见或代理意见摘要' },
        objective: { type: 'string', description: '我方办理目标、诉请或抗辩目标' },
        materials: { type: 'string', description: '综合案件材料摘要' },
        persistCase: { type: 'boolean', description: '是否归档到案件空间；提供 caseId/caseName 时默认归档，设置 false 可关闭' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
    },
    handler: generateArgumentOrOpinionHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_analyze_folder_and_draft_argument',
    description: '一句话案件文件夹代理词 — 读取本地案件材料文件夹，自动分析案情、提炼争议焦点、整理证据目录、生成代理词草稿，并默认保存 Markdown 工作底稿到案件文件夹下。适合用户说“读取桌面某案件文件夹，分析并生成代理词”。图片/扫描件会提示 OCR，不编造法条和类案。',
    parameters: {
      type: 'object',
      properties: {
        folderPath: { type: 'string', description: '本地案件材料文件夹路径，例如 C:\\Users\\name\\Desktop\\张三借款案；也支持“桌面\\张三借款案”' },
        folderName: { type: 'string', description: '如果未提供完整路径，可提供桌面/文档/下载目录中的文件夹名称或关键词' },
        caseName: { type: 'string', description: '案件名称或简称，默认使用文件夹名' },
        role: { type: 'string', description: '我方身份：原告/被告/申请人/被申请人等' },
        clientRole: { type: 'string', description: '我方身份别名，和 role 二选一' },
        caseType: { type: 'string', description: '案由或案件类型，未提供时从材料推断' },
        matterType: { type: 'string', description: '案由或案件类型别名' },
        parties: { type: 'string', description: '当事人身份信息摘要' },
        objective: { type: 'string', description: '办理目标或代理词立场' },
        claims: { type: 'string', description: '诉请、抗辩目标或结论请求' },
        opponentMaterials: { type: 'string', description: '对方主张、起诉状、答辩意见或代理意见摘要，可为空' },
        outputDir: { type: 'string', description: '可选输出目录，默认在案件文件夹下创建 Lumi代理词草稿' },
        outputDirName: { type: 'string', description: '默认输出目录名称' },
        writeFiles: { type: 'boolean', description: '是否写入 Markdown 文件，默认 true；false 时只返回预览' },
        recursive: { type: 'boolean', description: '是否递归读取子目录，默认 true' },
        maxFiles: { type: 'number', description: '最多读取文件数，默认 80，最高 200' },
        maxChars: { type: 'number', description: '最多提取文本字数，默认 220000，最高 800000' },
        importToKb: { type: 'boolean', description: '律师确认后是否把生成的工作底稿导入组织知识库，默认 false' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
    },
    handler: analyzeFolderAndDraftArgumentHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_import_materials_to_kb',
    description: '法律材料导入知识库 — Lumi 自主解析本地文件、案件文件夹或粘贴文本，导入组织知识库并建立法律标签。支持起诉状、证据、庭审笔录、合同、裁判文书、网页摘录、检索笔记等材料；外部网站材料需由律师确认来源和权限后再入库。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '单个本地材料文件路径，支持 PDF/DOCX/XLSX/PPTX/RTF/TXT/MD/CSV' },
        folderPath: { type: 'string', description: '案件材料文件夹路径，会批量导入支持的文档格式' },
        content: { type: 'string', description: '直接粘贴的材料文本、网页摘录或律师确认后的外部检索结果' },
        title: { type: 'string', description: '材料标题，未提供时使用文件名或案件名' },
        caseName: { type: 'string', description: '案件名称或简称' },
        caseType: { type: 'string', description: '案由或案件类型' },
        materialType: { type: 'string', description: '材料类型：起诉状/答辩状/证据/庭审笔录/合同/裁判文书/检索笔记/工商信息等' },
        tags: { type: 'array', items: { type: 'string' }, description: '附加标签' },
        recursive: { type: 'boolean', description: '导入文件夹时是否递归子目录，默认 true' },
        maxFiles: { type: 'number', description: '文件夹导入最大文件数，默认 30，最高 100' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '导入人 ID，默认上下文 userId 或 system' },
      },
    },
    handler: importMaterialsToKbHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_process_notice_link',
    description: '短信/法院通知链接处理 — 从法院短信、开庭通知、送达通知中的链接半自动下载 PDF/DOCX/网页材料，保存本地留痕；需要登录、验证码、人脸或短信验证时生成授权网页登录步骤，不绕过平台限制。律师确认来源和权限后可导入组织知识库。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '短信或通知中的 http(s) 链接；未提供时会从 message/noticeText 中提取第一个链接' },
        message: { type: 'string', description: '完整短信原文，可用于提取案号、法院、开庭/通知日期和链接' },
        noticeText: { type: 'string', description: '法院通知或送达通知文本' },
        caseId: { type: 'string', description: '已有案件工作台 ID；提供后会把短信/通知处理结果归档到该案件空间' },
        caseName: { type: 'string', description: '关联案件名称或简称' },
        title: { type: 'string', description: '材料标题，默认“短信/法院通知链接材料”' },
        includeExtractedText: { type: 'boolean', description: '是否在返回结果中包含正文摘录，默认 true' },
        extractedTextLimit: { type: 'number', description: '返回正文摘录最大字符数，默认 4000，最高 20000' },
        persistCase: { type: 'boolean', description: '是否归档到案件空间；提供 caseId/caseName 时默认归档，设置 false 可关闭' },
        confirmedForKb: { type: 'boolean', description: '律师已确认来源、授权和使用权限后设为 true，工具会导入组织知识库' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '导入人 ID，默认上下文 userId 或 system' },
      },
    },
    handler: processNoticeLinkHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_download_and_extract_document',
    description: '文书链接自动下载与正文提取 — 用户发送裁判文书、起诉状、合同、法院通知等 PDF/DOCX/网页链接后，Lumi 自动下载原文件、保存来源留痕、提取正文内容并返回摘要；需要登录/验证码时转授权浏览器协作，不绕过平台限制。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '需要下载和提取正文的 http(s) 文书链接；未提供时会从 message/linkText 中提取第一个链接' },
        message: { type: 'string', description: '包含链接的用户消息、短信或网页摘录' },
        linkText: { type: 'string', description: '包含链接的文本' },
        caseId: { type: 'string', description: '已有案件工作台 ID；提供后会把文书链接处理结果归档到该案件空间' },
        caseName: { type: 'string', description: '关联案件名称或简称' },
        title: { type: 'string', description: '材料标题，默认“链接文书材料”' },
        includeExtractedText: { type: 'boolean', description: '是否在返回结果中包含正文摘录，默认 true' },
        extractedTextLimit: { type: 'number', description: '返回正文摘录最大字符数，默认 4000，最高 20000' },
        persistCase: { type: 'boolean', description: '是否归档到案件空间；提供 caseId/caseName 时默认归档，设置 false 可关闭' },
        confirmedForKb: { type: 'boolean', description: '律师已确认来源、授权和使用权限后设为 true，工具会导入组织知识库' },
        importToKb: { type: 'boolean', description: 'confirmedForKb 的别名' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '导入人 ID，默认上下文 userId 或 system' },
      },
    },
    handler: (args, context) => processNoticeLinkHandler({ ...args, documentLink: true, mode: 'document' }, context),
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_external_source_status',
    description: '外部法律数据源接入状态 — 明确企查查、Alpha、法蝉、裁判文书网、人民法院案例库、国家企业信用等数据源当前是官方 API 接入、授权网页登录协作还是材料导入，不夸大自动抓取能力。',
    parameters: {
      type: 'object',
      properties: {},
    },
    handler: externalSourceStatusHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_search_external_authorities',
    description: '外部法律数据库 API 检索 — 调用已配置授权网关（如北大法宝、通义法睿）检索法规、法条、案例和裁判规则；未配置时明确降级到授权网页登录协作，不抓取平台数据库。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词、争议焦点、案由、法条名称或案件事实摘要' },
        type: { type: 'string', description: '检索类型：law/case/mixed，或中文“法规/案例/综合”' },
        kind: { type: 'string', description: 'type 的别名' },
        sourceIds: { type: 'array', items: { type: 'string' }, description: '指定数据源，如 pkulaw、farui、national-law-regulations' },
        sources: { type: 'array', items: { type: 'string' }, description: 'sourceIds 的别名' },
        platforms: { type: 'array', items: { type: 'string' }, description: 'sourceIds 的别名' },
        includeOfficialWeb: { type: 'boolean', description: '是否同时尝试国家法律法规数据库公开网页检索，默认 false' },
        limit: { type: 'number', description: '返回结果数量上限，默认 5，最高 20' },
        caseId: { type: 'string', description: '已有案件工作台 ID；提供后会把检索报告和来源登记归档到该案件空间' },
        caseName: { type: 'string', description: '关联案件名称或简称' },
        caseType: { type: 'string', description: '案由或案件类型；用于新建案件或归档标记' },
        confirmedForKb: { type: 'boolean', description: '律师确认来源和授权后设为 true，可将检索报告导入组织知识库' },
        persistCase: { type: 'boolean', description: '是否归档到案件空间；提供 caseId/caseName 时默认归档，设置 false 可关闭' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
      required: ['query'],
    },
    handler: searchExternalAuthoritiesHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_company_database_lookup',
    description: '企业主体数据库 API 查询 — 调用已配置的企查查/天眼查官方 API 查询公司、股东和被执行主体基础信息；未配置时输出网页登录协作和材料入库步骤。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '公司、被执行人或主体名称' },
        companyName: { type: 'string', description: 'name 的别名' },
        subjectName: { type: 'string', description: 'name 的别名' },
        sourceIds: { type: 'array', items: { type: 'string' }, description: '指定数据源，如 qichacha、tianyancha' },
        sources: { type: 'array', items: { type: 'string' }, description: 'sourceIds 的别名' },
        platforms: { type: 'array', items: { type: 'string' }, description: 'sourceIds 的别名' },
        caseId: { type: 'string', description: '已有案件工作台 ID；提供后会把主体信息报告归档到该案件空间' },
        caseName: { type: 'string', description: '关联案件名称或简称' },
        caseType: { type: 'string', description: '案由或案件类型；用于新建案件或归档标记' },
        confirmedForKb: { type: 'boolean', description: '律师确认来源和授权后设为 true，可将报告导入组织知识库' },
        persistCase: { type: 'boolean', description: '是否归档到案件空间；提供 caseId/caseName 时默认归档，设置 false 可关闭' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
      required: ['name'],
    },
    handler: companyDatabaseLookupHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_external_research_plan',
    description: '半自动外部检索行动单 — 生成法条、人民法院案例库、裁判文书网、法蝉、Alpha、企查查、国家企业信用、法院在线服务的检索顺序、网页登录预设和来源登记表。',
    parameters: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: '已有案件工作台 ID；提供后会把外部检索行动单归档到该案件空间' },
        caseName: { type: 'string', description: '案件名称或简称' },
        caseType: { type: 'string', description: '案由或案件类型' },
        facts: { type: 'string', description: '案件事实摘要' },
        issues: { type: 'array', items: { type: 'string' }, description: '争议焦点列表' },
        companyNames: { type: 'array', items: { type: 'string' }, description: '需要查询的公司或被执行人名称' },
        persistCase: { type: 'boolean', description: '是否归档到案件空间；提供 caseId/caseName 时默认归档，设置 false 可关闭' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
    },
    handler: externalResearchPlanHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_generate_citation_verification_report',
    description: '引用核验报告 — 对文书全文或文件中的法条、案号引用生成可落盘的核验报告，统计现行有效、已废止、未确认存在的风险项，并可导入组织知识库。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '需要核验的文书全文、代理词、法律意见或合同审查结果' },
        content: { type: 'string', description: 'text 的别名' },
        filePath: { type: 'string', description: '需要核验的本地文件路径，支持 PDF/DOCX/TXT/MD 等法律材料格式' },
        caseName: { type: 'string', description: '案件名称或简称' },
        title: { type: 'string', description: '报告标题或来源材料标题' },
        outputDir: { type: 'string', description: '可选输出目录；默认写入 data/legal_delivery/{orgId}' },
        importToKb: { type: 'boolean', description: '律师确认后是否导入组织知识库，默认 false' },
        confirmedForKb: { type: 'boolean', description: 'importToKb 的确认别名' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
    },
    handler: generateCitationVerificationReportHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_finalize_delivery_package',
    description: '正式文书交付包 — 将代理词、起诉状、答辩状、法律意见书、证据目录等草稿整理为律所交付包，生成正式 Markdown、DOCX、引用核验报告、来源登记表和提交签署清单。不会自动签发、提交、缴费或送达。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '需要整理成正式交付包的文书草稿或工作底稿' },
        packetText: { type: 'string', description: 'content 的别名，用于诉讼文书包结果' },
        documentText: { type: 'string', description: 'content 的别名，用于单份文书结果' },
        reasoningMatrix: { type: 'string', description: 'legal_case_reasoning_matrix 生成的大前提/小前提/涵摄结论底稿；正式交付前建议提供' },
        reasoningSummary: { type: 'string', description: '三段论推理摘要：现行法/类案、事实证据、涵摄结论' },
        legalReasoning: { type: 'string', description: 'reasoningMatrix 的别名，用于传入可复核的法律推理链' },
        caseId: { type: 'string', description: '已有案件工作台 ID；提供后会把交付包或阻断记录归档到该案件空间' },
        caseName: { type: 'string', description: '案件名称或简称' },
        documentType: { type: 'string', description: '文书类型：起诉状/答辩状/质证意见/代理词/法律意见书/证据目录/合同文本/投标书等' },
        role: { type: 'string', description: '我方身份' },
        caseType: { type: 'string', description: '案由或案件类型' },
        court: { type: 'string', description: '拟提交或使用法院' },
        lawFirmName: { type: 'string', description: '律所名称，未提供时使用占位符' },
        lawyerName: { type: 'string', description: '承办律师，未提供时使用占位符' },
        outputDir: { type: 'string', description: '可选输出目录；默认写入 data/legal_delivery/{orgId}' },
        includeDocx: { type: 'boolean', description: '是否生成 DOCX，默认 true' },
        includePdf: { type: 'boolean', description: '是否尝试用 Microsoft Word 转 PDF，默认 false' },
        markDraft: { type: 'boolean', description: '是否标记为律师复核稿，默认 true' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
        userId: { type: 'string', description: '操作用户 ID，默认上下文 userId 或 system' },
      },
    },
    handler: finalizeDeliveryPackageHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_prepare_external_browser_workspace',
    description: '外部网页登录工作区 — 为人民法院案例库、裁判文书网、法蝉、Alpha、企查查、国家企业信用、法院在线服务等生成可见浏览器登录命令、检索词、来源登记表和授权边界说明。',
    parameters: {
      type: 'object',
      properties: {
        caseName: { type: 'string', description: '案件名称或简称' },
        caseType: { type: 'string', description: '案由或案件类型' },
        facts: { type: 'string', description: '案件事实摘要' },
        issues: { type: 'array', items: { type: 'string' }, description: '争议焦点列表' },
        queries: { type: 'array', items: { type: 'string' }, description: '额外检索词' },
        companyNames: { type: 'array', items: { type: 'string' }, description: '需要查询的公司或被执行人名称' },
        sourceIds: { type: 'array', items: { type: 'string' }, description: '指定数据源/preset，如 people-court-case-library、china-judgments-online、fachan、alpha-lawyer、qichacha、national-enterprise-credit、court-online-service' },
        sources: { type: 'array', items: { type: 'string' }, description: 'sourceIds 的别名' },
        platforms: { type: 'array', items: { type: 'string' }, description: 'sourceIds 的别名' },
        action: { type: 'string', description: '检索目的：类案检索/立案/企业查询/合同审查等' },
        outputDir: { type: 'string', description: '可选输出目录；默认写入 data/legal_external_workspaces/{orgId}' },
        orgId: { type: 'string', description: '组织 ID，默认上下文 orgId 或 default' },
      },
    },
    handler: prepareExternalBrowserWorkspaceHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_verify_citation',
    description: '引用校验 — 验证法条引用和案例引用是否真实有效。可检查单个引用或全文中的所有引用，标注：存在/不存在、有效/已废止。禁止使用虚构法条和案例。',
    parameters: {
      type: 'object',
      properties: {
        citation: { type: 'string', description: '单个引用文本，如"《民法典》第585条"或"(2024)京0105民初12345号"' },
        text: { type: 'string', description: '包含多个引用的完整文本（将自动识别所有《XX法》和案号引用）' },
        orgId: { type: 'string', description: '组织ID' },
      },
    },
    handler: verifyCitationHandler,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'legal_import_judgment',
    description: '导入裁判文书 — 上传或粘贴裁判文书全文（PDF/DOCX/TXT），自动提取案号、法院、当事人、法条引用等元数据，分块并向量化索引到组织知识库。导入后可通过类案检索查询。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '裁判文书文件路径（PDF/DOCX/TXT）' },
        content: { type: 'string', description: '直接粘贴的裁判文书全文（与filePath二选一）' },
        orgId: { type: 'string', description: '组织ID' },
        userId: { type: 'string', description: '操作用户ID' },
      },
    },
    handler: importJudgmentHandler,
    permission: 'user',
    securityLevel: 'safe',
  });
}
