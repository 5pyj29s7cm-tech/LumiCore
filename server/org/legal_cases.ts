import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getDataPath } from '../config/data_path';
import * as EDB from './db';
import {
  assertOrganizationResourceAccess,
  authorizeOrganizationResource,
  getOrganizationResourcePolicy,
  removeOrganizationResourcePolicy,
  type OrganizationResourcePermission,
} from './resource_acl';

export type LegalCaseStage = 'consultation' | 'filing' | 'trial' | 'judgment' | 'enforcement' | 'closed';
export type LegalCaseMaterialType = 'consultation' | 'evidence' | 'pleading' | 'judgment' | 'contract' | 'note';

export interface OrgLegalCaseMaterial {
  id: string;
  type: LegalCaseMaterialType;
  title: string;
  content: string;
  fileName?: string;
  localPath?: string;
  source: 'manual' | 'meeting' | 'feishu' | 'wecom' | 'wechat' | 'tool' | 'import';
  createdBy: string;
  createdAt: string;
}

export interface OrgLegalCaseFile {
  id: string;
  orgId: string;
  title: string;
  caseNumber: string;
  party: string;
  cause: string;
  court: string;
  judge: string;
  stage: LegalCaseStage;
  hearingDate: string;
  judgmentDate: string;
  appealDeadline: string;
  enforcementDeadline: string;
  notes: string;
  materials: OrgLegalCaseMaterial[];
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export type LegalCaseWorkflowStepState = 'done' | 'ready' | 'missing' | 'blocked' | 'manual';

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

const STORE_PATH = getDataPath(path.join('org', 'legal_cases.json'));

interface StoreShape {
  cases: OrgLegalCaseFile[];
}

function now() {
  return new Date().toISOString();
}

function readStore(): StoreShape {
  try {
    if (!fs.existsSync(STORE_PATH)) return { cases: [] };
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return { cases: Array.isArray(parsed?.cases) ? parsed.cases : [] };
  } catch {
    return { cases: [] };
  }
}

function writeStore(store: StoreShape) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), 'utf8');
}

function normalizeText(value: unknown): string {
  return String(value || '').trim();
}

function caseWorkflowMaterialText(caseFile: Partial<OrgLegalCaseFile>): string {
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

function caseWorkflowHas(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

function makeWorkflowStep(
  key: string,
  label: string,
  state: LegalCaseWorkflowStepState,
  summary: string,
  nextStep: string,
  tool: string,
): LegalCaseWorkflowStep {
  return {
    key,
    label,
    state,
    summary,
    nextStep,
    tool,
    blocking: state === 'blocked',
  };
}

export function evaluateCaseWorkflow(
  caseFile: Partial<OrgLegalCaseFile>,
  options: LegalCaseWorkflowOptions = {},
): LegalCaseWorkflowEvaluation {
  const materials = caseFile.materials || [];
  const text = caseWorkflowMaterialText(caseFile);
  const hasMaterials = materials.length > 0;
  const hasParty = Boolean(normalizeText(caseFile.party)) || caseWorkflowHas(text, [/当事人|原告|被告|委托人|申请人|respondent|claimant/i]);
  const hasIdentityDocs = caseWorkflowHas(text, [/身份证|营业执照|统一社会信用代码|主体资格|法定代表人|授权委托|律所函|律师证/i]);
  const hasFacts = Boolean(normalizeText(caseFile.notes).length >= 20)
    || caseWorkflowHas(text, [/事实摘要|案件事实|时间线|履行|付款|交付|解除|侵权|损失|庭审|会谈|会议纪要/i]);
  const hasEvidence = materials.some(material => material.type === 'evidence')
    || caseWorkflowHas(text, [/证据目录|证明目的|三性|真实性|合法性|关联性|质证|原件|页码|证据材料/i]);
  const hasReasoning = caseWorkflowHas(text, [/三段论|大前提|小前提|涵摄|法律分析三段论|legal_case_reasoning_matrix/i]);
  const lawBlocked = options.currentLawGate === 'blocked'
    || caseWorkflowHas(text, [/现行有效法律预检：未通过|现行有效法律硬门槛未通过|正式交付包未生成|current-law gate blocked|不得标记为正式成果|已废止|失效风险：[1-9]/i]);
  const lawPassed = !lawBlocked && (
    options.currentLawGate === 'passed'
    || caseWorkflowHas(text, [/现行有效法律预检：通过|现行有效法律硬门槛：通过|引用核验报告|引用校验|citation-verification-report/i])
  );
  const hasSources = caseWorkflowHas(text, [/来源登记表|source-register|外部检索行动单|外部检索|人民法院案例库|裁判文书网|法蝉|alpha|legal_external_research_plan|legal_search_external_authorities/i]);
  const hasWorkProduct = materials.some(material => material.type === 'pleading' || material.type === 'contract')
    || caseWorkflowHas(text, [/起诉状|要素式诉状|答辩状|质证意见|代理词|法律意见书|合同审查|合同起草|投标书|标书|诉讼策略|legal_generate_litigation_packet|legal_generate_argument_or_opinion/i]);
  const hasFilingHandoff = caseWorkflowHas(text, [/半自动立案交接单|立案网交接单|法院在线服务|人民法院在线服务|legal_prepare_filing_handoff/i]);
  const hasFormalDelivery = !lawBlocked && caseWorkflowHas(text, [/正式交付包已生成|已归档正式交付包|正式法律交付包|01_formal-document|现行有效法律硬门槛：通过/i]);

  const steps: LegalCaseWorkflowStep[] = [
    makeWorkflowStep(
      'intake',
      '材料入案',
      hasMaterials || hasFacts || hasParty ? 'done' : 'missing',
      hasMaterials ? `已归档 ${materials.length} 份材料` : hasFacts ? '已有事实摘要，材料仍需归档' : '尚未形成案件材料池',
      '导入会谈、起诉状、证据、短信链接或本地案件文件夹。',
      'legal_import_materials_to_kb / legal_meeting_minutes_to_case',
    ),
    makeWorkflowStep(
      'identity',
      '身份与主体',
      hasParty && hasIdentityDocs ? 'done' : hasParty ? 'ready' : 'missing',
      hasParty && hasIdentityDocs ? '当事人和主体资格材料已有线索' : hasParty ? '有当事人信息，主体资格仍待核验' : '缺当事人身份/主体信息',
      '补齐身份证、营业执照、统一社会信用代码、授权委托手续和送达地址。',
      'legal_case_workspace / legal_import_materials_to_kb',
    ),
    makeWorkflowStep(
      'facts',
      '事实时间线',
      hasFacts ? 'done' : hasMaterials ? 'ready' : 'missing',
      hasFacts ? '已有事实摘要或时间线线索' : hasMaterials ? '可从材料中整理事实时间线' : '缺案件事实基础',
      '按主体、行为、金额、通知、履行结果和期限拆解事实。',
      'legal_meeting_minutes_to_case / legal_case_workspace',
    ),
    makeWorkflowStep(
      'evidence',
      '证据三性',
      hasEvidence ? 'done' : hasMaterials || hasFacts ? 'ready' : 'missing',
      hasEvidence ? '已有证据目录/三性审查线索' : hasMaterials ? '材料已入案，待整理证据目录' : '缺证据材料',
      '逐项绑定待证事实、证明目的、原件状态、页码和真实性/合法性/关联性。',
      'legal_generate_litigation_packet',
    ),
    makeWorkflowStep(
      'reasoning',
      '三段论分析',
      hasReasoning ? 'done' : hasFacts || hasEvidence ? 'ready' : 'missing',
      hasReasoning ? '已形成三段论底稿' : '底层必经，尚未形成法律分析矩阵',
      '先形成法律依据、事实证据、适用结论的三段论底稿。',
      'legal_case_reasoning_matrix',
    ),
    makeWorkflowStep(
      'current-law',
      '现行有效法律',
      lawBlocked ? 'blocked' : lawPassed ? 'done' : hasReasoning || hasWorkProduct ? 'ready' : 'missing',
      lawBlocked ? (options.currentLawBlockingSummary || '存在已废止、失效或未确认的法条引用') : lawPassed ? '法源预检或正式 gate 已通过' : '尚未完成法条现行有效核验',
      lawBlocked ? '先替换或核验阻断法条，再继续文书正式化。' : '核验所有法条、司法解释和引用来源，未核验不得正式交付。',
      'legal_search_statute / legal_generate_citation_verification_report',
    ),
    makeWorkflowStep(
      'sources',
      '类案与来源',
      hasSources ? 'done' : hasReasoning || hasFacts ? 'ready' : 'missing',
      hasSources ? '已有外部检索或来源登记' : '待按法院层级检索类案并登记来源',
      '按最高院、高院、中院、基层法院顺序登记有利/不利裁判规则。',
      'legal_external_research_plan / legal_search_external_authorities',
    ),
    makeWorkflowStep(
      'drafts',
      '文书策略',
      hasWorkProduct ? 'done' : hasEvidence && hasReasoning ? 'ready' : 'missing',
      hasWorkProduct ? '已有文书或策略底稿' : '待生成起诉/答辩/质证/代理词/合同/标书底稿',
      '根据角色生成文书包、代理词、法律意见书或合同/标书底稿。',
      'legal_generate_litigation_packet / legal_generate_argument_or_opinion',
    ),
    makeWorkflowStep(
      'filing',
      '立案协作',
      hasFilingHandoff ? 'done' : hasWorkProduct ? 'manual' : 'missing',
      hasFilingHandoff ? '已有半自动立案交接单' : hasWorkProduct ? '可准备法院平台字段和材料清单' : '未到立案协作阶段',
      '生成字段映射和上传清单；提交、签名、缴费、送达必须人工确认。',
      'legal_prepare_filing_handoff',
    ),
    makeWorkflowStep(
      'delivery',
      '正式交付',
      lawBlocked ? 'blocked' : hasFormalDelivery ? 'done' : lawPassed && hasWorkProduct ? 'ready' : 'missing',
      lawBlocked ? '法源 gate 阻断，不能正式交付' : hasFormalDelivery ? '已有正式交付包或 gate 通过记录' : '正式交付包未生成',
      '运行正式交付 gate，生成引用核验报告、来源登记和交付包。',
      'legal_finalize_delivery_package',
    ),
  ];

  const doneCount = steps.filter(step => step.state === 'done').length;
  const blockedCount = steps.filter(step => step.state === 'blocked').length;
  const missingCount = steps.filter(step => step.state === 'missing').length;
  const nextStep = steps.find(step => step.state === 'blocked')
    || steps.find(step => step.state === 'ready')
    || steps.find(step => step.state === 'missing')
    || steps.find(step => step.state === 'manual')
    || null;

  return {
    steps,
    doneCount,
    blockedCount,
    missingCount,
    completionRatio: Math.round((doneCount / steps.length) * 100),
    nextStep,
    readyForDraft: hasEvidence && hasReasoning && !lawBlocked,
    readyForFormalDelivery: lawPassed && hasWorkProduct && !lawBlocked,
  };
}

function normalizeLegalDateMatch(match?: RegExpMatchArray | null): string {
  if (!match) return '';
  return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`
    + (match[4] ? ` ${match[4].padStart(2, '0')}:${(match[5] || '00').padStart(2, '0')}` : '');
}

function extractHearingDate(text: string): string {
  const datePattern = /(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?(?:\s*(\d{1,2})[:：时](\d{1,2})?分?)?/;
  const hearingWindow = text.match(new RegExp(`(?:开庭|庭审|审理)[^\n。；;]{0,80}${datePattern.source}|${datePattern.source}[^\n。；;]{0,40}(?:开庭|庭审|审理)`));
  if (hearingWindow) {
    const nested = hearingWindow[0].match(datePattern);
    if (nested) return normalizeLegalDateMatch(nested);
  }
  return normalizeLegalDateMatch(text.match(datePattern));
}

export function extractLegalCaseHints(text: string): Partial<Pick<OrgLegalCaseFile, 'caseNumber' | 'court' | 'hearingDate' | 'judgmentDate' | 'cause'>> {
  const hints: Partial<Pick<OrgLegalCaseFile, 'caseNumber' | 'court' | 'hearingDate' | 'judgmentDate' | 'cause'>> = {};
  const caseNumber = text.match(/[（(]\d{4}[）)][^，。；;\n]{2,80}(?:号|字第?\d+号?)/)?.[0] || '';
  const court = text.match(/[\u4e00-\u9fa5]{2,40}(?:人民法院|法院)/)?.[0] || '';
  const hearingDate = extractHearingDate(text);
  const cause = text.match(/案由[：:\s]+([^\n，。；;]{2,40})/)?.[1] || '';
  if (caseNumber) hints.caseNumber = caseNumber;
  if (court) hints.court = court;
  if (hearingDate) hints.hearingDate = hearingDate;
  if (cause) hints.cause = cause.trim();
  return hints;
}

function canAccessCase(
  caseFile: OrgLegalCaseFile,
  actorUserId?: string,
  permission: OrganizationResourcePermission = 'read',
): boolean {
  const { policy } = getOrganizationResourcePolicy(caseFile.orgId, 'legal_case', caseFile.id);
  if (!policy) return true;
  if (!actorUserId) return false;
  return authorizeOrganizationResource({
    orgId: caseFile.orgId,
    actorUserId,
    resourceType: 'legal_case',
    resourceId: caseFile.id,
    permission,
    ownerUserId: caseFile.createdBy,
  }).allowed;
}

export function listCases(orgId: string, query = '', limit = 50, actorUserId?: string): OrgLegalCaseFile[] {
  const q = query.trim().toLowerCase();
  let cases = readStore().cases.filter(item => item.orgId === orgId && canAccessCase(item, actorUserId, 'read'));
  if (q) {
    cases = cases.filter(item => {
      const haystack = [
        item.title,
        item.caseNumber,
        item.party,
        item.cause,
        item.court,
        item.judge,
        item.notes,
        ...(item.materials || []).map(mat => `${mat.title}\n${mat.content.slice(0, 2000)}`),
      ].join('\n').toLowerCase();
      return haystack.includes(q);
    });
  }
  return cases
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(1, Math.min(limit, 200)));
}

export function getCase(
  orgId: string,
  caseId: string,
  actorUserId?: string,
  permission: OrganizationResourcePermission = 'read',
): OrgLegalCaseFile | null {
  const caseFile = readStore().cases.find(item => item.orgId === orgId && item.id === caseId) || null;
  return caseFile && canAccessCase(caseFile, actorUserId, permission) ? caseFile : null;
}

export function createCase(orgId: string, userId: string, input: Partial<OrgLegalCaseFile>): OrgLegalCaseFile {
  const store = readStore();
  const ts = now();
  const caseFile: OrgLegalCaseFile = {
    id: randomUUID(),
    orgId,
    title: normalizeText(input.title) || '未命名案件',
    caseNumber: normalizeText(input.caseNumber),
    party: normalizeText(input.party),
    cause: normalizeText(input.cause),
    court: normalizeText(input.court),
    judge: normalizeText(input.judge),
    stage: (input.stage as LegalCaseStage) || 'consultation',
    hearingDate: normalizeText(input.hearingDate),
    judgmentDate: normalizeText(input.judgmentDate),
    appealDeadline: normalizeText(input.appealDeadline),
    enforcementDeadline: normalizeText(input.enforcementDeadline),
    notes: normalizeText(input.notes),
    materials: Array.isArray(input.materials) ? input.materials : [],
    createdBy: userId,
    updatedBy: userId,
    createdAt: ts,
    updatedAt: ts,
  };
  store.cases.unshift(caseFile);
  writeStore(store);
  EDB.logAudit({
    orgId,
    userId,
    action: 'legal_case.create',
    resourceType: 'legal_case',
    resourceId: caseFile.id,
    details: { title: caseFile.title, caseNumber: caseFile.caseNumber },
  });
  return caseFile;
}

export function updateCase(orgId: string, userId: string, caseId: string, patch: Partial<OrgLegalCaseFile>): OrgLegalCaseFile | null {
  const store = readStore();
  const idx = store.cases.findIndex(item => item.orgId === orgId && item.id === caseId);
  if (idx < 0) return null;
  const current = store.cases[idx];
  if (getOrganizationResourcePolicy(orgId, 'legal_case', caseId).policy) {
    assertOrganizationResourceAccess({
      orgId, actorUserId: userId, resourceType: 'legal_case', resourceId: caseId,
      permission: 'write', ownerUserId: current.createdBy,
    });
  }
  const next: OrgLegalCaseFile = {
    ...current,
    ...patch,
    id: current.id,
    orgId: current.orgId,
    materials: patch.materials || current.materials || [],
    updatedBy: userId,
    updatedAt: now(),
  };
  store.cases[idx] = next;
  writeStore(store);
  EDB.logAudit({
    orgId,
    userId,
    action: 'legal_case.update',
    resourceType: 'legal_case',
    resourceId: caseId,
    details: { fields: Object.keys(patch) },
  });
  return next;
}

export function deleteCase(orgId: string, userId: string, caseId: string): OrgLegalCaseFile | null {
  const store = readStore();
  const index = store.cases.findIndex(item => item.orgId === orgId && item.id === caseId);
  if (index < 0) return null;
  const current = store.cases[index];
  if (getOrganizationResourcePolicy(orgId, 'legal_case', caseId).policy) {
    assertOrganizationResourceAccess({
      orgId, actorUserId: userId, resourceType: 'legal_case', resourceId: caseId,
      permission: 'write', ownerUserId: current.createdBy,
    });
  }
  const [deleted] = store.cases.splice(index, 1);
  writeStore(store);
  removeOrganizationResourcePolicy({
    orgId,
    actorUserId: userId,
    resourceType: 'legal_case',
    resourceId: caseId,
  });
  EDB.logAudit({
    orgId,
    userId,
    action: 'legal_case.delete',
    resourceType: 'legal_case',
    resourceId: caseId,
    details: {
      title: deleted.title,
      caseNumber: deleted.caseNumber,
      materialCount: deleted.materials?.length || 0,
    },
  });
  return deleted;
}

export function addMaterial(
  orgId: string,
  userId: string,
  caseId: string,
  material: Omit<OrgLegalCaseMaterial, 'id' | 'createdBy' | 'createdAt'>,
): OrgLegalCaseMaterial | null {
  const current = getCase(orgId, caseId, userId, 'write');
  if (!current) return null;
  const nextMaterial: OrgLegalCaseMaterial = {
    id: randomUUID(),
    type: material.type,
    title: normalizeText(material.title) || '案件材料',
    content: normalizeText(material.content),
    fileName: material.fileName,
    localPath: material.localPath,
    source: material.source,
    createdBy: userId,
    createdAt: now(),
  };
  const nextMaterials = [nextMaterial, ...(current.materials || [])];
  updateCase(orgId, userId, caseId, {
    materials: nextMaterials,
    notes: [current.notes, material.content ? `【材料归档】${nextMaterial.title}` : ''].filter(Boolean).join('\n'),
  });
  EDB.logAudit({
    orgId,
    userId,
    action: 'legal_case.material.add',
    resourceType: 'legal_case',
    resourceId: caseId,
    details: { title: nextMaterial.title, source: nextMaterial.source, fileName: nextMaterial.fileName },
  });
  return nextMaterial;
}

export function createCaseFromRemoteMaterial(params: {
  orgId: string;
  userId: string;
  title: string;
  text: string;
  fileName?: string;
  localPath?: string;
  source?: OrgLegalCaseMaterial['source'];
}): OrgLegalCaseFile {
  const hints = extractLegalCaseHints(params.text);
  const caseFile = createCase(params.orgId, params.userId, {
    title: params.title || hints.caseNumber || params.fileName || '远程案件材料',
    caseNumber: hints.caseNumber || '',
    court: hints.court || '',
    cause: hints.cause || '',
    hearingDate: hints.hearingDate || '',
    notes: params.text.slice(0, 4000),
    stage: 'consultation',
  });
  addMaterial(params.orgId, params.userId, caseFile.id, {
    type: 'evidence',
    title: params.fileName || params.title || '远程案件材料',
    content: params.text,
    fileName: params.fileName,
    localPath: params.localPath,
    source: params.source || 'feishu',
  });
  return getCase(params.orgId, caseFile.id) || caseFile;
}
