import { type CitationCheck, type CitationVerificationOptions, isLegalReferenceDate, verifyMultipleCitations } from "../../../../legal/kb";
import { inspectLegalReasoningStructure } from "../legal_reasoning_structure";
import * as LegalCases from "../../../../org/legal_cases";
import { textArg, listArg, legalWorkspaceId, legalTemporalOptions } from "./context";
import { archiveLegalReportToCase } from "./case_workflow";

function normalizeCaseCitation(value: string): string {
  return String(value || '').replace(/[（）()\s]/g, '').trim();
}

function caseCitationMatches(a: string, b: string): boolean {
  const left = normalizeCaseCitation(a);
  const right = normalizeCaseCitation(b);
  return !!left && !!right && (left.includes(right) || right.includes(left));
}

export function ownCaseNumbersFromArgs(args: Record<string, any>): string[] {
  return [
    textArg(args, 'caseNumber'),
    textArg(args, 'filingCaseNumber'),
    ...listArg(args, 'ownCaseNumbers'),
  ].filter(Boolean);
}

function isOwnCaseCitation(item: CitationCheck, ownCaseNumbers: string[]): boolean {
  return ownCaseNumbers.some(caseNumber => caseCitationMatches(item.citation, caseNumber));
}

export function formatCitationReportMarkdown(args: Record<string, any>, text: string, sourceLabel: string): string {
  const factDate = textArg(args, 'factDate');
  const caseName = textArg(args, 'caseName') || '未命名案件';
  const orgId = textArg(args, 'orgId') || undefined;
  const ownCaseNumbers = ownCaseNumbersFromArgs(args);
  const gate = evaluateCurrentLawGate(text, orgId, ownCaseNumbers, factDate, legalTemporalOptions(args));
  const { checks, statuteChecks } = gate;
  const caseChecks = checks.filter(item => item.type === 'case');
  const missing = checks.filter(item => !item.exists);
  const repealed = checks.filter(item => item.isEffective === false);
  const valid = checks.filter(item => item.type === 'case' ? item.exists : item.exists && item.isEffective === true && item.provisionVerified === true && item.quotationVerified !== false && item.temporalApplicabilityVerified !== false);

  const rows = checks.length
    ? checks.map((item, index) =>
      `| ${index + 1} | ${item.type === 'statute' ? '法条' : '案例'} | ${item.citation.replace(/\|/g, ' ')} | ${item.exists ? '存在' : '未确认'} | ${item.applicabilityStatus === 'historical_version_verified' ? '历史版本及时间效力来源已核验' : item.temporalApplicabilityVerified === false || item.isEffective === null ? '本案时点适用待复核' : item.isEffective ? '所核验时点有效' : '已废止/不在有效区间'} | ${(item.source || 'N/A').replace(/\|/g, ' ')} | ${item.detail.replace(/\|/g, ' ')} |`,
    ).join('\n')
    : '| 1 | 无 | 未检测到《XX法》或案号格式引用 | 待补充 | 待核验 | N/A | 建议在正式文书中补充引用来源 |';

  return [
    `# ${caseName} 引用核验报告`,
    '',
    `- 来源材料：${sourceLabel}`,
    `- 关键事实发生日期：${factDate || '待确认，法律适用尚未核准'}`,
    `- 程序行为发生日期：${textArg(args, 'procedureDate') || '待确认；不得用事实日期替代'}`,
    '- 时间效力边界：历史原文、有效区间和时间效力条文来源检查，与具体案件适用结论的律师复核分别进行。',
    `- 生成时间：${new Date().toISOString()}`,
    `- 核验范围：法条引用、案号引用、是否存在、是否已废止、本地知识库是否收录。`,
    `- 核验边界：本报告不能替代律师最终检索；未在本地库命中的案例需到人民法院案例库/裁判文书网/法蝉/Alpha 等授权来源人工复核。`,
    '',
    '## 统计',
    '',
    `- 引用总数：${checks.length}`,
    `- 法条引用：${statuteChecks.length}`,
    `- 案例引用：${caseChecks.length}`,
    `- 已对照权威原文（本案适用另行复核）：${valid.length}`,
    `- 未确认存在：${missing.length}`,
    `- 已废止/失效风险：${repealed.length}`,
    `- 现行有效法律硬门槛：${gate.passed ? '通过' : '未通过'}`,
    `- 类案/案号来源硬门槛：${gate.caseSourcePassed ? '通过' : '未通过'}`,
    '',
    '## 明细',
    '',
    '| 序号 | 类型 | 引用 | 存在性 | 有效性 | 来源 | 说明 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    rows,
    '',
    '## 时间效力依据与适用复核',
    '',
    '| 本次引用 | 对应时点 | 时间效力条文 | 连续原文摘录 | 权威来源 | 边界 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...statuteChecks.filter(item => item.temporalBasisCitation || item.temporalApplicabilityVerified === false || item.applicabilityStatus === 'historical_review_required')
      .map(item => `| ${item.citation} | ${item.temporalScope === 'procedure' ? '程序' : '事实'}：${item.referenceDate || '待确认'} | ${item.temporalBasisCitation || '待核验'} | ${(item.temporalBasisQuote || '未取得权威连续摘录').replace(/[|\n]/g, ' ')} | ${item.temporalBasisSource || '待核验'} | 来源核验与本案适用结论分别进行，仍须律师复核 |`),
    '',
    '## 处理建议',
    '',
    '- 已废止法条不得直接作为现行法律依据；历史事实应核验对应历史原文、有效区间及时间效力规则，不能机械替换为现行法。',
    '- 未确认案例不得写成“已有裁判支持”，应先完成来源登记和律师复核。',
    '- 最终文书应保留来源名称、发布日期/裁判日期、案号、法院层级、链接或下载文件路径。',
    '',
  ].join('\n');
}

export interface CurrentLawGateResult {
  passed: boolean;
  missingStatuteCitation: boolean;
  missingFactDate: boolean;
  missingProcedureDate: boolean;
  caseSourcePassed: boolean;
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

export function evaluateCurrentLawGate(text: string, orgId?: string, ownCaseNumbers: string[] = [], factDate?: string, options: CitationVerificationOptions = {}): CurrentLawGateResult {
  const checks = verifyMultipleCitations(text, orgId, { ...options, factDate });
  const statuteChecks = checks.filter(item => item.type === 'statute');
  const blockingStatutes = statuteChecks.filter(item => !item.exists || item.isEffective !== true || item.provisionVerified !== true || item.quotationVerified === false || item.temporalApplicabilityVerified === false);
  const missingCaseChecks = checks.filter(item => item.type === 'case' && !item.exists && !isOwnCaseCitation(item, ownCaseNumbers));
  const missingStatuteCitation = statuteChecks.length === 0;
  const missingFactDate = (statuteChecks.length === 0 || statuteChecks.some(item => item.temporalScope !== 'procedure')) && !isLegalReferenceDate(factDate);
  const missingProcedureDate = statuteChecks.some(item => item.temporalScope === 'procedure') && !isLegalReferenceDate(options.procedureDate);
  return {
    passed: !missingStatuteCitation && !missingFactDate && !missingProcedureDate && blockingStatutes.length === 0,
    missingStatuteCitation,
    missingFactDate,
    missingProcedureDate,
    caseSourcePassed: missingCaseChecks.length === 0,
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

export function evaluateLegalReasoningGate(args: Record<string, any>, sourceText: string): LegalReasoningGateResult {
  const text = collectLegalReasoningGateText(args, sourceText);
  const { hasMajorPremise, hasMinorPremise, hasConclusion } = inspectLegalReasoningStructure(text);
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

export function findArchivedLegalReasoningGateText(args: Record<string, any>, orgId: string, userId?: string): string {
  const caseId = textArg(args, 'caseId');
  if (!caseId) return '';
  const caseFile = LegalCases.getCase(orgId, caseId, userId);
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

export function formatCitationList(items: CitationCheck[]): string[] {
  if (items.length === 0) return ['- 无'];
  return items.map(item => `- ${item.citation} | exists=${item.exists ? 'yes' : 'no'} | effective=${item.isEffective === null ? 'n/a' : item.isEffective ? 'yes' : 'no'} | source=${item.source || 'N/A'} | ${item.detail}`);
}

export function formatCurrentLawGateBlock(args: {
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
    `- Missing statute citation: ${args.gate.missingStatuteCitation ? 'yes' : 'no'}`,
    `- Missing or invalid case fact date: ${args.gate.missingFactDate ? 'yes' : 'no'}`,
    `- Missing or invalid procedure date: ${args.gate.missingProcedureDate ? 'yes' : 'no'}`,
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
    '- Add at least one reviewable current effective statute or judicial interpretation citation for formal legal delivery.',
    '- Confirm the case fact date and verify the applicable historical version and temporal rules; never substitute the generation or hearing date.',
    '- Verify procedural rules against the relevant procedure date and a quoted authoritative temporal rule; do not substitute the substantive fact date.',
    '- For historical facts, verify the historical original, its effective interval and a sourced temporal rule; do not mechanically replace old law with current law.',
    '- Verify unknown statutes against an authoritative source before generating the formal delivery package.',
    '- Re-run 正式交付核验 after the legal authority text is corrected.',
    '',
  ].join('\n');
}

export function formatCaseSourceGateBlock(args: {
  caseName: string;
  documentType: string;
  outputDir: string;
  reportPath: string;
  sourcePath: string;
  gate: CurrentLawGateResult;
}): string {
  return [
    `# ${args.caseName} case-source gate blocked`,
    '',
    `- Document type: ${args.documentType}`,
    `- Checked at: ${new Date().toISOString()}`,
    `- Output directory: ${args.outputDir}`,
    `- Citation report: ${args.reportPath}`,
    `- Source register: ${args.sourcePath}`,
    `- Case citations checked: ${args.gate.checks.filter(item => item.type === 'case').length}`,
    `- Missing case citations: ${args.gate.missingCaseChecks.length}`,
    '',
    '## Missing Case Citations',
    '',
    ...formatCitationList(args.gate.missingCaseChecks),
    '',
    '## Required Fix',
    '',
    '- Import the judgment or authorized case source into the organization legal knowledge base.',
    '- Or remove the case citation from the formal document until its source, court level, date, URL/file path, and favorable point are verified.',
    '- Re-run legal_finalize_delivery_package after the case source is archived and reviewable.',
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

export function buildLegalWorkProductPreflightSection(
  report: string,
  args: Record<string, any>,
  orgId?: string,
): string {
  const gate = evaluateCurrentLawGate(collectLegalWorkProductGateText(report, args), orgId, ownCaseNumbersFromArgs(args), textArg(args, 'factDate'), legalTemporalOptions(args));
  const statuteStatus = legalReasoningGateStatus(gate);
  const blocking = compactCitationListForPreflight(gate.blockingStatutes);
  const missingCases = compactCitationListForPreflight(gate.missingCaseChecks);
  const deliveryRule = gate.passed
    ? '草稿可继续进入律师复核；正式对外文件仍必须完成交付核验，生成来源登记和交付包。'
    : gate.statuteChecks.length === 0
      ? '本稿未引用具体法条；正式对外前如补充法条或案例，必须逐项核验来源、效力和适用边界，再完成正式交付核验。'
      : '如存在已废止、失效或未确认的法条引用，不得标记为正式成果；需先替换或核验后再完成正式交付核验。';

  return [
    '## 法律成果预检',
    `- 现行有效法律预检：${statuteStatus}（识别法条 ${gate.statuteChecks.length} 项，阻断 ${gate.blockingStatutes.length} 项）。`,
    `- 法条阻断项：${blocking}。`,
    `- 类案待复核项：${missingCases}。`,
    `- 正式交付规则：${deliveryRule}`,
  ].join('\n');
}

export function appendLegalWorkProductArchiveSection(
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
    reasoningLinks?: LegalCases.OrgLegalCaseMaterial['reasoningLinks'];
    reasoningBasis?: string;
  },
): string {
  const orgId = legalWorkspaceId(args, context);
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
    reasoningLinks: params.reasoningLinks, reasoningBasis: params.reasoningBasis,
  });

  return `${archivedContent}

## 案件归档与交付边界
${caseLine}
- 正式交付：继续进行正式交付核验，核对案件时点法律与来源登记。`;
}

export function legalReasoningGateStatus(gate: CurrentLawGateResult): string {
  if (gate.statuteChecks.length === 0) return '待检索/未引用具体法条';
  return gate.passed ? '通过' : '未通过';
}
