import { inspectLegalReasoningStructure } from './legal_reasoning_structure';
import { isLegalSourceMaterial, legalCaseSourceFingerprint, type LegalWorkflowRun } from './legal_workflow_receipts';
import { CN_LEGAL_REASONING_DRAFT_MESSAGES } from '../server/regions/messages/skill_messages';
export function normalizeLegalClientRole(value: unknown): string {
  // i18n-allow: Exact stored role values; never infer a litigation role from party text.
  return Object.entries({
    plaintiff: 'plaintiff', 原告: 'plaintiff', defendant: 'defendant', 被告: 'defendant',
    applicant: 'applicant', 申请人: 'applicant', respondent: 'respondent', 被申请人: 'respondent',
    }).find(([stored]) => stored === String(value || '').trim().toLowerCase())?.[1] || '';
}

export type LegalCaseWorkflowStepState = 'done' | 'ready' | 'missing' | 'blocked' | 'manual';

export interface LegalCaseWorkflowMaterialLike {
  id?: string;
  type?: string;
  title?: string;
  content?: string;
  source?: string;
  fileName?: string;
  localPath?: string;
}

export interface LegalCaseWorkflowInput {
  title?: string;
  caseNumber?: string;
  party?: string;
  cause?: string;
  court?: string;
  judge?: string;
  notes?: string;
  clientPartyName?: string;
  clientRole?: string;
  objective?: string;
  workflowRuns?: LegalWorkflowRun[];
  materials?: LegalCaseWorkflowMaterialLike[];
}

export interface LegalCaseWorkflowStep {
  key: string;
  label: string;
  state: LegalCaseWorkflowStepState;
  summary: string;
  nextStep: string;
  tool: string;
  blocking?: boolean;
}

export interface LegalCaseWorkflowEvaluation {
  steps: LegalCaseWorkflowStep[];
  doneCount: number;
  blockedCount: number;
  missingCount: number;
  completionRatio: number;
  nextStep: LegalCaseWorkflowStep | null;
  readyForDraft: boolean;
  readyForFormalDelivery: boolean;
}

export interface LegalCaseWorkflowOptions {
  currentLawGate?: 'passed' | 'blocked' | 'none';
  currentLawBlockingSummary?: string;
}

function normalizeText(value: unknown): string {
  return String(value || '').trim();
}

function materialText(caseFile: LegalCaseWorkflowInput): string {
  return [
    caseFile.title,
    caseFile.caseNumber,
    caseFile.party,
    caseFile.cause,
    caseFile.court,
    caseFile.judge,
    caseFile.notes,
    ...(caseFile.materials || []).map(material => [
      material.type,
      material.title,
      material.source,
      material.content,
      material.fileName,
      material.localPath,
    ].join('\n')),
  ].join('\n').toLowerCase();
}

function has(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

function step(
  key: string,
  label: string,
  state: LegalCaseWorkflowStepState,
  summary: string,
  nextStep: string,
  tool: string,
): LegalCaseWorkflowStep {
  return { key, label, state, summary, nextStep, tool, blocking: state === 'blocked' };
}

/**
 * The single workflow evaluator used by both the legal client and server tools.
 * It deliberately evaluates persisted case evidence instead of UI state or model prose.
 */
export function evaluateLegalCaseWorkflow(
  caseFile: LegalCaseWorkflowInput,
  options: LegalCaseWorkflowOptions = {},
): LegalCaseWorkflowEvaluation {
  const materials = caseFile.materials || [];
  const sourceMaterials = materials.filter(isLegalSourceMaterial);
  const sourceNotes = normalizeText(caseFile.notes).replace(/^【材料归档】.*$/gm, '').trim();
  const sourceText = materialText({ ...caseFile, notes: sourceNotes, materials: sourceMaterials });
  const text = materialText(caseFile);
  const hasMaterials = materials.length > 0;
  const hasParty = Boolean(normalizeText(caseFile.party)) || has(sourceText, [/当事人|原告|被告|委托人|申请人|respondent|claimant/i]);
  const hasIdentityDocs = has(sourceText, [/身份证|营业执照|统一社会信用代码|主体资格|法定代表人|授权委托|律所函|律师证/i]);
  const hasFacts = sourceNotes.length >= 20
    || has(sourceText, [/事实摘要|案件事实|时间线|履行|付款|交付|解除|侵权|损失|庭审|会谈|会议纪要/i]);
  const hasEvidence = sourceMaterials.some(material => material.type === 'evidence')
    || has(sourceText, [/证据目录|证明目的|三性|真实性|合法性|关联性|质证|原件|页码|证据材料/i]);
  const hasReasoning = inspectLegalReasoningStructure(text).passed;
  const basis = legalCaseSourceFingerprint(caseFile);
  const runs = (caseFile.workflowRuns || []).filter(run => run.basis === basis);
  const completed = (tools: string[]) => runs.some(run => run.ok && run.draftMode !== 'template' && run.draftMode !== 'mixed' && tools.includes(run.tool)
    && run.materialIds.some(id => materials.some(material => material.id === id)));
  // Law checks are point-in-time results, never an everlasting promise. Expired
  // checks and changed case inputs require rechecking; old failures stay in history.
  const latestLaw = runs.find(run => run.currentLawGate
    && Date.now() - Date.parse(run.checkedAt) >= 0 && Date.now() - Date.parse(run.checkedAt) < 24 * 60 * 60_000);
  const lawState = options.currentLawGate && options.currentLawGate !== 'none' ? options.currentLawGate : latestLaw?.currentLawGate;
  const lawBlocked = lawState === 'blocked';
  const lawPassed = lawState === 'passed';
  const linkedReasoning = runs.some(run => run.ok && run.reasoningLinked);
  const hasSources = completed(['legal_import_judgment']);
  const hasWorkProduct = completed(['legal_generate_litigation_packet', 'legal_generate_argument_or_opinion', 'legal_review_contract', 'legal_draft_contract', 'legal_generate_bid']);
  const hasFilingHandoff = completed(['legal_prepare_filing_handoff']);
  const hasFormalDelivery = !lawBlocked && runs.some(run => run.ok && run.tool === 'legal_finalize_delivery_package'
    && run.reasoningLinked && run.artifacts.length > 0 && run.materialIds.some(id => materials.some(material => material.id === id)));

  const steps: LegalCaseWorkflowStep[] = [
    step('intake', '材料入案', hasMaterials || hasFacts || hasParty ? 'done' : 'missing', hasMaterials ? `已归档 ${materials.length} 份材料` : hasFacts ? '已有事实摘要，材料仍需归档' : '尚未形成案件材料池', '导入会谈、起诉状、证据、短信链接或本地案件文件夹。', 'legal_import_materials_to_kb / legal_meeting_minutes_to_case'),
    step('identity', '身份与主体', hasParty && hasIdentityDocs ? 'manual' : hasParty ? 'ready' : 'missing', hasParty && hasIdentityDocs ? '主体材料已有线索，完整性和真实性仍需人工核验' : hasParty ? '有当事人信息，主体资格仍待核验' : '缺当事人身份/主体信息', '补齐身份证、营业执照、统一社会信用代码、授权委托手续和送达地址。', 'legal_case_workspace / legal_import_materials_to_kb'),
    step('facts', '事实时间线', hasFacts ? 'done' : hasMaterials ? 'ready' : 'missing', hasFacts ? '已有事实摘要或时间线线索' : hasMaterials ? '可从材料中整理事实时间线' : '缺案件事实基础', '按主体、行为、金额、通知、履行结果和期限拆解事实。', 'legal_meeting_minutes_to_case / legal_case_workspace'),
    step('evidence', '证据三性', hasEvidence ? 'manual' : hasMaterials || hasFacts ? 'ready' : 'missing', hasEvidence ? '已有证据目录，真实性、合法性、关联性仍需人工核验' : hasMaterials ? '材料已入案，待整理证据目录' : '缺证据材料', '逐项绑定待证事实、证明目的、原件状态、页码和真实性/合法性/关联性。', 'legal_generate_litigation_packet'),
    step('reasoning', '三段论分析', hasReasoning ? 'ready' : hasFacts || hasEvidence ? 'ready' : 'missing', hasReasoning ? CN_LEGAL_REASONING_DRAFT_MESSAGES.ready : CN_LEGAL_REASONING_DRAFT_MESSAGES.missing, '先形成法律依据、事实证据、适用结论的三段论底稿。', 'legal_case_reasoning_matrix'),
    step('current-law', '现行有效法律', lawBlocked ? 'blocked' : lawPassed ? 'done' : hasReasoning || hasWorkProduct ? 'ready' : 'missing', lawBlocked ? (options.currentLawBlockingSummary || '存在已废止、失效或未确认的法条引用') : lawPassed ? '法源预检或正式 gate 已通过' : '尚未完成法条现行有效核验', lawBlocked ? '先替换或核验阻断法条，再继续文书正式化。' : '核验所有法条、司法解释和引用来源，未核验不得正式交付。', 'legal_search_statute / legal_generate_citation_verification_report'),
    step('sources', '类案与来源', hasSources ? 'done' : hasReasoning || hasFacts ? 'ready' : 'missing', hasSources ? '已有外部检索或来源登记' : '待按法院层级检索类案并登记来源', '按最高院、高院、中院、基层法院顺序登记有利/不利裁判规则。', 'legal_external_research_plan / legal_search_external_authorities / legal_search_tender_projects'),
    step('drafts', '文书策略', hasWorkProduct ? 'done' : hasEvidence && hasReasoning ? 'ready' : 'missing', hasWorkProduct ? '已有文书或策略底稿' : '待生成起诉/答辩/质证/代理词/合同/标书底稿', '根据角色生成文书包、代理词、法律意见书或合同/标书底稿。', 'legal_generate_litigation_packet / legal_generate_argument_or_opinion'),
    step('filing', '立案协作', hasFilingHandoff ? 'done' : hasWorkProduct ? 'manual' : 'missing', hasFilingHandoff ? '已有半自动立案交接单' : hasWorkProduct ? '可准备法院平台字段和材料清单' : '未到立案协作阶段', '生成字段映射和上传清单；提交、签名、缴费、送达必须人工确认。', 'legal_prepare_filing_handoff'),
    step('delivery', '正式交付', lawBlocked ? 'blocked' : hasFormalDelivery ? 'done' : lawPassed && hasWorkProduct && linkedReasoning ? 'ready' : 'missing', lawBlocked ? '法源 gate 阻断，不能正式交付' : hasFormalDelivery ? '已有交付包生成记录，法律结论仍须律师复核' : '尚无通过检查的交付包', '运行正式交付 gate，生成引用核验报告、来源登记和交付包。', 'legal_finalize_delivery_package'),
  ];

  const doneCount = steps.filter(item => item.state === 'done').length;
  const blockedCount = steps.filter(item => item.state === 'blocked').length;
  const missingCount = steps.filter(item => item.state === 'missing').length;
  const nextStep = steps.find(item => item.state === 'blocked')
    || steps.find(item => item.state === 'ready')
    || steps.find(item => item.state === 'missing')
    || steps.find(item => item.state === 'manual')
    || null;

  return {
    steps,
    doneCount,
    blockedCount,
    missingCount,
    completionRatio: Math.round((doneCount / steps.length) * 100),
    nextStep,
    readyForDraft: hasEvidence && hasReasoning && !lawBlocked,
    readyForFormalDelivery: lawPassed && hasWorkProduct && linkedReasoning && !lawBlocked,
  };
}
