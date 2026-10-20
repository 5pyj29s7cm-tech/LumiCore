import * as LegalCases from "../../../../org/legal_cases";
import { legalWrite } from "../../../../legal/execution";
import { textArg, roleLabel } from "./context";

export const LEGAL_CASE_SEARCH_ORDER = ['最高人民法院', '高级人民法院', '中级人民法院', '基层人民法院'];

export function normalizeLegalCaseStage(input: string): LegalCases.LegalCaseStage {
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

export function buildEvidenceReviewRows(args: Record<string, any>): EvidenceReviewRow[] {
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

export function formatEvidenceReviewRows(rows: EvidenceReviewRow[]): string {
  return rows.map(row =>
    `| ${row.index} | ${row.name} | ${row.fact} | ${row.proofPurpose} | ${row.authenticity} | ${row.legality} | ${row.relevance} | ${row.gap} |`,
  ).join('\n');
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
}): string {
  if (args.persistCase === false) return '- 案件空间：未归档（persistCase=false）';

  const explicitCaseId = textArg(args, 'caseId');
  const explicitCaseName = textArg(args, 'caseName') || textArg(args, 'title');
  const shouldArchive = args.persistCase === true || !!explicitCaseId || !!explicitCaseName;
  if (!shouldArchive) return '- 案件空间：未归档（未提供 caseId/caseName；设置 persistCase=true 可创建案件）';

  let caseFile = explicitCaseId ? LegalCases.getCase(params.orgId, explicitCaseId, params.userId, 'write') : null;
  if (!caseFile && explicitCaseName) {
    caseFile = LegalCases.listCases(params.orgId, explicitCaseName, 1, params.userId)[0] || null;
  }
  if (!caseFile && explicitCaseId && !explicitCaseName && args.persistCase !== true) {
    return '- 案件空间：未归档（caseId 不存在或无权限）';
  }
  if (!caseFile) {
    caseFile = legalWrite(() => LegalCases.createCase(params.orgId, params.userId, {
      title: explicitCaseName || params.caseName,
      party: textArg(args, 'parties') || roleLabel(textArg(args, 'role')),
      cause: params.cause || textArg(args, 'caseType') || textArg(args, 'cause'),
      court: params.court || textArg(args, 'court'),
      stage: normalizeLegalCaseStage(textArg(args, 'stage')),
      notes: params.content.slice(0, 3000),
    }));
  }

  const material = legalWrite(() => LegalCases.addMaterial(params.orgId, params.userId, caseFile.id, {
    type: params.type || 'note',
    title: params.title,
    content: params.content,
    localPath: params.localPath,
    source: 'tool',
  }));
  return material
    ? `- 案件空间：已归档 caseId=${caseFile.id} materialId=${material.id}`
    : `- 案件空间：未归档 caseId=${caseFile.id}`;
}
