import * as LegalCases from "../../../../org/legal_cases";
import { legalWrite } from "../../../../legal/execution";
import { textArg, roleLabel, legalTemporalOptions } from "./context";
import { buildMaterialSources, type Source } from "../legal_reasoning_generation";
import { inspectLegalReasoningLinks, type LegalReasoningLink } from "../legal_reasoning_links";
import { legalCaseSourceFingerprint } from "../../../../../shared/legal_workflow_receipts";

export const LEGAL_CASE_SEARCH_ORDER = ['最高人民法院', '高级人民法院', '中级人民法院', '基层人民法院'];

export function normalizeLegalCaseStage(input: string): LegalCases.LegalCaseStage {
  if (/立案|filing/i.test(input)) return 'filing';
  if (/开庭|庭审|trial/i.test(input)) return 'trial';
  if (/判决|judgment/i.test(input)) return 'judgment';
  if (/执行|enforcement/i.test(input)) return 'enforcement';
  if (/结案|closed/i.test(input)) return 'closed';
  return 'consultation';
}

export function legalCaseStageLabel(stage: LegalCases.LegalCaseStage): string {
  if (stage === 'filing') return '立案';
  if (stage === 'trial') return '庭审';
  if (stage === 'judgment') return '判决';
  if (stage === 'enforcement') return '执行';
  if (stage === 'closed') return '结案';
  return '诉前';
}

function legalWorkflowStateLabel(state: LegalCases.LegalCaseWorkflowStepState): string {
  if (state === 'done') return '已完成';
  if (state === 'ready') return '可推进';
  if (state === 'blocked') return '阻断';
  if (state === 'manual') return '待人工确认';
  return '待补充';
}

export function formatLegalWorkflowRows(steps: LegalCases.LegalCaseWorkflowStep[]): string {
  return steps.map(step => [
    step.label,
    legalWorkflowStateLabel(step.state),
    step.summary,
    step.nextStep,
  ].map(value => String(value || '').replace(/\|/g, ' ')).join(' | ')).map(row => `| ${row} |`).join('\n');
}

export function formatLegalWorkflowActionQueue(workflow: LegalCases.LegalCaseWorkflowEvaluation): string {
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
    '| 顺位 | 模块 | 状态 | 下一步 |',
    '| --- | --- | --- | --- |',
    ...queue.map((step, index) => `| ${index + 1} | ${clean(step.label)} | ${clean(legalWorkflowStateLabel(step.state))} | ${clean(step.nextStep)} |`),
  ].join('\n');
}

export function makeWorkspaceWorkflowCase(args: Record<string, any>, params: {
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
    factDate: textArg(args, 'factDate') || undefined,
    notes: [
      params.claims ? `办理目标：${params.claims}` : '',
      params.facts ? `事实摘要：${params.facts.slice(0, 2000)}` : '',
      params.evidence ? `证据摘要：${params.evidence.slice(0, 1200)}` : '',
    ].filter(Boolean).join('\n'),
    materials,
  };
}

export interface EvidenceReviewRow {
  index: number;
  name: string;
  fact: string;
  proofPurpose: string;
  authenticity: string;
  legality: string;
  relevance: string;
  gap: string;
  materialId?: string;
  sourceLabel: string;
  sources: Source[];
  pendingCompilation: boolean;
  proposals: LegalReasoningLink[];
}

export function buildEvidenceReviewRows(args: Record<string, any>, sourceCase?: LegalCases.OrgLegalCaseFile | null): EvidenceReviewRow[] {
  // Only server-loaded originals own material IDs. Generated drafts and input
  // metadata cannot promote themselves into evidence records.
  const originals = sourceCase?.materials.filter(material => material.source !== 'tool') || [];
  const render = (items: typeof originals) => items.map(material => `[材料 ${material.id}：${material.title}]\n${material.content}`).join('\n\n').trim();
  const serialized = [render(originals), render(originals.filter(material => material.type === 'evidence' || material.type === 'contract')),
    render(originals.filter(material => material.type === 'pleading')), ...originals.map(material => material.content.trim())].filter(Boolean);
  const pending = ['evidence', 'materials'].flatMap(field => {
    let content = textArg(args, field);
    if (!content || serialized.includes(content)) return [];
    // The neutral chat context appends this exact server-owned serialization.
    // Remove only that complete copy; mixed or edited input remains verbatim.
    const suffix = field === 'materials' && serialized.find(value => content.endsWith('\n\n' + value));
    if (suffix) content = content.slice(0, -suffix.length - 2);
    return content.trim() ? [{ id: `input:${field}`, title: '本次' + (field === 'evidence' ? '证据输入' : '中性材料输入') + '（未编目）', content }] : [];
  });
  const sources = buildMaterialSources([...originals, ...pending]);
  const currentBasis = sourceCase ? legalCaseSourceFingerprint(sourceCase) : '';
  const links = sourceCase?.materials.filter(material => material.source === 'tool' && material.reasoningBasis === currentBasis && material.reasoningLinks?.length)
    .flatMap(material => {
      const inspected = inspectLegalReasoningLinks(material.reasoningLinks, { ...sourceCase, materials: originals }, sourceCase.orgId,
        { ...legalTemporalOptions(args), actorUserId: textArg(args, 'userId') || undefined });
      return inspected.passed ? inspected.links : [];
    }) || [];
  const records = [...originals, ...pending];
  return (records.length ? records : [{ id: 'missing', title: '待整理证据材料', content: '' }]).map((material, index) => {
    const materialSources = sources.filter(source => source.materialId === material.id);
    const original = originals.find(record => record.id === material.id);
    const related = original ? links.filter(link => link.evidence.some(evidence => materialSources.some(source =>
      source.materialId === evidence.materialId && source.quote === evidence.quote && source.locator === evidence.locator))) : [];
    return {
      index: index + 1,
      name: material.title,
      materialId: original?.id,
      sourceLabel: original ? `材料 ${index + 1}；登记类型 ${original.type}；来源 ${original.source}` : '本次输入未编目，不代表已取得原件',
      sources: materialSources,
      pendingCompilation: !original,
      proposals: related,
      fact: materialSources.map(source => source.quote).join('\n'),
      proofPurpose: related.length ? related.map(link => `拟议关联争点：${link.issue}\n限制与反证：${link.limitations}\n证明目的待律师确定。`).join('\n\n')
        : '待律师确认证明目的，不根据文件名称推定；当前仅登记材料原句。',
      authenticity: '未核验；核对原件/形成时间/签章或电子数据原始载体',
      legality: '未核验；核对取得方式、授权来源、隐私与平台规则',
      relevance: '未核验；关联争点与拟议分析不代表证明目的成立',
      gap: original ? '证据用途、页码、原件状态、来源及反证风险待律师核对' : '需逐份编目并补充材料名称、来源、页码和原件状态',
    };
  });
}

const evidenceCell = (value: unknown) => String(value || '').replace(/\|/g, '｜').replace(/\r?\n/g, '；');

export function formatEvidenceOriginals(rows: EvidenceReviewRow[]): string {
  return '\n\n## 材料原句与拟议关联（未核准）\n\n本次仅登记材料原句；证据用途、三性及法律分析未因此核准，未编目输入仍须逐份登记。\n\n' + rows.map(row => [
    `### ${row.index}. ${row.name}`, row.sourceLabel,
    ...row.sources.flatMap(source => [`- ${source.id}；${source.locator}`, `> ${source.quote}`]),
    ...(row.proposals.length ? row.proposals.map(link => `拟议关联争点：${link.issue}\n\n拟议分析：${link.application}\n\n拟议结论：${link.conclusion}\n\n限制与反证：${link.limitations}`) : [row.proofPurpose]), row.gap,
  ].join('\n\n')).join('\n\n');
}

export function formatEvidenceReviewRows(rows: EvidenceReviewRow[]): string {
  return rows.map(row =>
    [row.index, row.name, row.sources.map(source => source.id).join('、') || '未提供原句', '见下方拟议关联；待律师确认', row.authenticity, row.legality, row.relevance, row.gap]
      .map(evidenceCell).join(' | '),
  ).map(row => `| ${row} |`).join('\n') + formatEvidenceOriginals(rows);
}

export function formatEvidenceCatalogRows(rows: EvidenceReviewRow[]): string {
  return ['| 编号 | 材料名称 | 登记来源/类型 | 原句位置 | 拟议证明目的 | 编目状态 |',
    '| --- | --- | --- | --- | --- | --- |', ...rows.map(row => '| ' + [row.index, row.name, row.sourceLabel,
      row.sources.map(source => `${source.id}：${source.locator}`).join('；') || '未提供', '见下方拟议关联；待律师确认', row.pendingCompilation ? '未编目' : '已登记原文，证据用途待核验']
      .map(evidenceCell).join(' | ') + ' |')].join('\n')
    + '\n\n## 编目说明（未核准）\n\n原句、拟议证明目的和三性核对按材料列于下方；上述正文行位不是外部原件页码。登记材料不等于证明目的或证据三性已成立。\n\n'
    + rows.map(row => [
      `### ${row.index}. ${row.name}`, '外部原件页码：[待逐份核对补录]（上述行位仅供本程序定位）',
      ...row.sources.flatMap(source => [`- ${source.id}；${source.locator}`, `> ${source.quote}`]),
      row.proofPurpose, `真实性：${row.authenticity}\n\n合法性：${row.legality}\n\n关联性：${row.relevance}`, `缺口/质证风险：${row.gap}`,
    ].join('\n\n')).join('\n\n');
}

export function formatEvidenceGapList(rows: EvidenceReviewRow[]): string {
  return rows.map(row => `- ${row.index}. ${row.name}：${row.gap}`).join('\n');
}

export function workspaceMaterialIndexRows(materials: LegalCases.OrgLegalCaseMaterial[]): string {
  if (!materials.length) return '| 1 | 待归集 | 待归集 | 待归集 | 待归集 |';
  return materials.slice(0, 20).map((material, index) =>
    `| ${index + 1} | ${material.type} | ${material.title.replace(/\|/g, ' ')} | ${material.source} | ${material.createdAt} |`,
  ).join('\n');
}

export function workspaceMaterialInputs(args: Record<string, any>): Array<{ type: LegalCases.LegalCaseMaterialType; title: string; content: string }> {
  const entries: Array<{ type: LegalCases.LegalCaseMaterialType; title: string; content: string }> = [
    { type: 'note', title: '聊天原始材料', content: textArg(args, 'materials') },
    { type: 'note', title: '案件事实与时间线', content: textArg(args, 'facts') },
    { type: 'evidence', title: '证据材料与证明目的', content: textArg(args, 'evidence') },
    { type: 'pleading', title: '起诉状/答辩状/对方材料', content: textArg(args, 'complaint') || textArg(args, 'opponentMaterials') },
    { type: 'consultation', title: '庭审/会议/沟通记录', content: textArg(args, 'transcript') || textArg(args, 'trialNotes') },
    { type: 'note', title: '法条、类案与外部检索记录', content: textArg(args, 'legalAuthorities') || textArg(args, 'similarCases') },
  ];
  return entries.filter(item => item.content.trim());
}

export function courtLevelRank(value: string): number {
  const text = String(value || '');
  if (/最高人民法院|最高法/.test(text)) return 0;
  if (/高级人民法院|高院/.test(text)) return 1;
  if (/中级人民法院|中院/.test(text)) return 2;
  if (/基层人民法院|基层法院|区人民法院|县人民法院|旗人民法院|市人民法院|人民法庭/.test(text)) return 3;
  return 4;
}

export function appendLegalCaseMaterial(args: {
  orgId: string;
  userId: string;
  caseId: string;
  type: LegalCases.LegalCaseMaterialType;
  title: string;
  content: string;
  localPath?: string;
}): LegalCases.OrgLegalCaseMaterial | null {
  if (!args.caseId) return null;
  const caseFile = LegalCases.getCase(args.orgId, args.caseId, args.userId, 'write');
  if (!caseFile) return null;
  return legalWrite(() => LegalCases.addMaterial(args.orgId, args.userId, args.caseId, {
    type: args.type,
    title: args.title,
    content: args.content,
    localPath: args.localPath,
    source: 'tool',
  }));
}

export function archiveLegalReportToCase(args: Record<string, any>, params: {
  orgId: string;
  userId: string;
  caseName: string;
  title: string;
  content: string;
  type?: LegalCases.LegalCaseMaterialType;
  cause?: string;
  court?: string;
  localPath?: string;
  source?: LegalCases.OrgLegalCaseMaterial['source'];
  reasoningLinks?: LegalCases.OrgLegalCaseMaterial['reasoningLinks'];
  reasoningBasis?: string;
}): string {
  if (args.persistCase === false) return '- 案件空间：未归档';

  const explicitCaseId = textArg(args, 'caseId');
  const explicitCaseName = textArg(args, 'caseName') || textArg(args, 'title');
  const shouldArchive = args.persistCase === true || !!explicitCaseId || !!explicitCaseName;
  if (!shouldArchive) return '- 案件空间：未归档（尚未关联案件）';

  let caseFile = explicitCaseId ? LegalCases.getCase(params.orgId, explicitCaseId, params.userId, 'write') : null;
  if (explicitCaseId && !caseFile) return '- 案件空间：未归档（关联案件不存在或无访问权限）';
  if (!caseFile && explicitCaseName) {
    caseFile = LegalCases.listCases(params.orgId, explicitCaseName, 1, params.userId)[0] || null;
  }
  if (!caseFile && explicitCaseId && !explicitCaseName && args.persistCase !== true) {
    return '- 案件空间：未归档（关联案件不存在或无访问权限）';
  }
  if (!caseFile) {
    caseFile = legalWrite(() => LegalCases.createCase(params.orgId, params.userId, {
      title: explicitCaseName || params.caseName,
      party: textArg(args, 'parties') || roleLabel(textArg(args, 'role')),
      cause: params.cause || textArg(args, 'caseType') || textArg(args, 'cause'),
      court: params.court || textArg(args, 'court'),
      stage: normalizeLegalCaseStage(textArg(args, 'stage')),
      notes: textArg(args, 'facts') || textArg(args, 'contract') || textArg(args, 'requirements'),
    }));
  }

  const material = legalWrite(() => LegalCases.addMaterial(params.orgId, params.userId, caseFile.id, {
    type: params.type || 'note',
    title: params.title,
    content: params.content,
    localPath: params.localPath,
    source: params.source || 'tool',
    reasoningLinks: params.reasoningLinks, reasoningBasis: params.reasoningBasis,
  }));
  return material
    ? `- 案件空间：已归档至「${caseFile.title}」`
    : '- 案件空间：未归档（保存未完成）';
}
