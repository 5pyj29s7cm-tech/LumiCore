import { legalWorkspaceNamespace } from '../../../../org/legal_cases';
import type { CitationVerificationOptions } from '../../../../legal/kb';
import { assertLegalExecutionActive, legalExecutionSignal, legalWrite } from "../../../../legal/execution";
import { type NormalizedMessage, type LLMCallConfig, makeLLMCall, ModelAttemptDeadlineError } from "../../../../llm/providers";
import { promptBlockMessage } from "../../../../llm/prompt_blocks";
import { LEGAL_REASONING_MODEL_TIMEOUT_MS } from "../../../../legal/budgets";
import * as LegalCases from "../../../../org/legal_cases";
import { isLegalSourceMaterial } from "../../../../../shared/legal_workflow_receipts";
import { normalizeLegalClientRole } from "../../../../../shared/legal_case_workflow";
import { getActiveIndustryWorkspaceContext } from "../../../../industry/workspace_context";
import { getMessageByRequestId } from "../../../../conversation/manager/request_identity";
import { getConversationActionTurn, listConversationActionTurns } from "../../../../conversation/action_turn_ledger";
import { actualDocumentReadContent, documentReadMatchesRequestedTarget, isSuccessfulExactDocumentRead } from "../../../../cognition/action_desktop_evidence";
import { getUserPreferredLLMConfig } from "../../../../llm/user_preferences";
import { providerGetterArguments } from "../../../../llm/provider_getters";
import { getDataDirectory } from "../../../../config/data_path";
import path from "path";
import fs from "fs";
import os from "os";

export async function runLegalLLM(prompt: string, context?: any, maxTokens = 2048, jsonObject = false, timeoutMs = LEGAL_REASONING_MODEL_TIMEOUT_MS, reasoningEffort?: LLMCallConfig['reasoningEffort']): Promise<string | null> {
  assertLegalExecutionActive(context);
  const getters = context?.llmGetters;
  if (!getters) return null;
  const userId = context?.userId || 'anonymous';
  const messages: NormalizedMessage[] = [promptBlockMessage({ id: 'legal-case-time', kind: 'task_state', authority: 'server', required: true,
    content: '实体事实日期与程序行为时点分别核验，不能相互替代；案件基准事实日期也不能替代未提供的合同签署、实际付款、交付或送达日期。案件已保存的事实日期不可在续办中改写；需通过案件工作台明确修改。旧法须有对应历史原文、有效区间及权威时间效力条文连续摘录；缺依据时保留待复核，不机械换成现行法。时间效力说明仍待律师确认，不能把来源存在等同于本案适用结论正确。', fields: { factDate: context?.factDate || null, procedureDate: context?.procedureDate || null, temporalReviews: context?.temporalReviews || [] } }), promptBlockMessage({ id: 'legal-original-input', kind: 'task_state', authority: 'server', required: true, content: prompt }, 'user')];
  const response = await makeLLMCall(
    messages,
    [],
    { ...getUserPreferredLLMConfig(userId, { maxTokens, domain: context?.domain, orgId: context?.orgId, requestId: context?.requestId, source: context?.source, conversationId: context?.conversationId }), signal: context?.executionSignal || legalExecutionSignal(), dataRoutingPolicy: context?.dataRoutingPolicy, relayStreaming: true, ...(reasoningEffort ? { reasoningEffort } : {}), ...(jsonObject ? { responseFormat: 'json_object' as const } : {}), attemptTimeouts: { absoluteMs: timeoutMs, semanticContentMs: timeoutMs } },
    ...providerGetterArguments(getters),
  ).catch(error => {
    const reason = error instanceof ModelAttemptDeadlineError && error.completedEmpty
      ? error.finishReason === 'length' ? 'output_limit' : 'empty_response'
      : (error as { routing?: { fallbackReason?: string } })?.routing?.fallbackReason;
    if (jsonObject && (reason === 'output_limit' || reason === 'empty_response')) throw new LegalStructuredResponseError(reason === 'output_limit' ? 'output_limit' : 'empty');
    throw error;
  });
  assertLegalExecutionActive(context);
  if (['length', 'max_tokens', 'MAX_TOKENS'].includes(response.finishReason || '')) throw new LegalStructuredResponseError('output_limit');
  if (jsonObject && !response.text?.trim()) throw new LegalStructuredResponseError('empty');
  return response.text || null;
}

export async function runLegalLLMWithin(prompt: string, context: any, maxTokens: number, timeoutMs: number, jsonObject = false, reasoningEffort?: LLMCallConfig['reasoningEffort']): Promise<string | null> {
  assertLegalExecutionActive(context);
  const controller = new AbortController();
  const parent = context?.executionSignal || legalExecutionSignal();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  parent?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new DOMException('Legal model subtask timed out.', 'TimeoutError')), timeoutMs);
  try {
    return await runLegalLLM(prompt, { ...context, executionSignal: controller.signal }, maxTokens, jsonObject, timeoutMs, reasoningEffort);
  } catch (error) {
    assertLegalExecutionActive(context);
    if (controller.signal.aborted) return null;
    throw error;
  } finally {
    clearTimeout(timeout);
    parent?.removeEventListener('abort', abort);
  }
}

export const EXTERNAL_LEGAL_SOURCES = [
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

export const LEGAL_REASONING_BASELINE = [
  '三段论是 Lumi 法律工作的核心基础：所有法律任务都必须先形成内部“大前提/小前提/涵摄结论”，再生成用户要求的工作产物。',
  '大前提：按本案关键事实日期核验法律版本、时间效力规则、司法解释和可比类案，不能机械套用现行法；小前提：将事实、证据、举证责任和质证风险对应到具体法律要件；结论：完成涵摄、风险提示和文书表达。',
  '普通文书和聊天结果不要把“大前提/小前提/结论”“三段论”等方法论标题作为交付内容输出，除非用户明确要求法律分析底稿。',
  '各项主张、承认/否认、付款方向、事件日期和证据描述只依对应原文；当事人陈述、截图及图片的文字简介不等于已证事实或实看图片。未提供、未回应不代表不存在或承认/否认，案件时间基准不能补具体事件。未提供的委托、庭审或诉请不写为已发生；论证、立场和请求仅作拟议或条件意见。未确认的前提和法条、类案保持待核验，不能以笼统复核备注掩盖确定断言。',
].join('\n');

export function sanitizeLegalWorkProductOutput(text: string): string {
  return text
    .replace(/底层三段论|三段论检索框架|三段论/g, '法律分析框架')
    .replace(/大前提/g, '法律依据与裁判规则')
    .replace(/小前提/g, '事实与证据')
    .replace(/涵摄/g, '事实适用分析');
}

export function textArg(args: Record<string, any>, key: string): string {
  return String(args[key] || '').trim();
}

export function legalWorkspaceId(args: Record<string, any>, context?: any): string {
  if (context?.domain === 'work') {
    const orgId = String(context.orgId || '').trim();
    if (!orgId) throw new Error('Organization legal work requires an active organization context.');
    return orgId;
  }
  if (context?.domain === 'personal') {
    return legalWorkspaceNamespace(context.userId || textArg(args, 'userId') || 'anonymous');
  }

  // ToolRegistry always injects runtime services into context. Their presence
  // alone does not select a personal data domain; preserve an explicit legacy
  // organization id unless the caller supplied an authoritative domain.
  const explicit = textArg(args, 'orgId');
  if (explicit) return explicit;
  const contextualOrgId = String(context?.orgId || '').trim();
  if (contextualOrgId) return contextualOrgId;
  return legalWorkspaceNamespace(context?.userId || textArg(args, 'userId') || 'anonymous');
}

export function listArg(args: Record<string, any>, key: string): string[] {
  const value = args[key];
  if (Array.isArray(value)) return value.map(String).map(s => s.trim()).filter(Boolean);
  return String(value || '').split(/\n|,|;|，|；/).map(s => s.trim()).filter(Boolean);
}

export function roleLabel(role: string): '原告' | '被告' | '通用' {
  if (/被告|被申请人|被上诉人|respondent|defendant/i.test(role)) return '被告';
  if (/原告|申请人|上诉人|plaintiff|claimant/i.test(role)) return '原告';
  return '通用';
}

export function buildCaseContext(args: Record<string, any>): string {
  const fields = [
    ['案件名称', textArg(args, 'caseName')],
    ['我方身份', textArg(args, 'role')],
    ['案由/类型', textArg(args, 'caseType')],
    ['实体法律适用时间基准（仅案件级，不代表各事件日期）', textArg(args, 'factDate') || '待确认'],
    ['程序法律适用时间基准（仅案件级，不代表具体程序已发生）', textArg(args, 'procedureDate') || '待确认'],
    ['管辖/法院', textArg(args, 'court')],
    ['当事人', textArg(args, 'parties')],
    ['我方委托人', textArg(args, 'clientPartyName')],
    ['诉请/抗辩目标', textArg(args, 'claims') || textArg(args, 'objective')],
    ['事实摘要', textArg(args, 'facts')],
    ['证据材料', textArg(args, 'evidence')],
    ['起诉状/申请书', textArg(args, 'complaint')],
    ['对方材料', textArg(args, 'opponentMaterials')],
    ['本轮办理要求', textArg(args, 'requirements')],
    ['案件材料（未指定当事人角色）', textArg(args, 'materials')],
    ['庭审/会议记录', textArg(args, 'transcript') || textArg(args, 'trialNotes')],
    ['已提供法律来源（适用待核验）', textArg(args, 'legalAuthorities')],
  ];
  return fields
    .filter(([, value]) => value)
    .map(([label, value]) => `- ${label}: ${value}`)
    .join('\n') || '- 待补充案件基础信息';
}

export function buildSearchQueries(args: Record<string, any>): string[] {
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

export function inferDisputeFocuses(args: Record<string, any>): string[] {
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

export function materialSummary(args: Record<string, any>): string {
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

export const LEGAL_MATERIAL_EXTENSIONS = new Set([
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.csv', '.txt', '.md', '.rtf',
]);

export const LEGAL_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']);

export const NOTICE_LINK_MAX_BYTES = 25 * 1024 * 1024;

export function extractFirstUrl(input: string): string {
  const match = input.match(/https?:\/\/[^\s<>"'，。；、）)\]]+/i);
  return match ? match[0].replace(/[。。，，；;、]+$/u, '') : '';
}

export function safeFileSegment(input: string, fallback = 'material'): string {
  const cleaned = String(input || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 90);
  return cleaned || fallback;
}

export function ensureLegalIntakeDir(orgId: string): string {
  return getDataDirectory(path.join('legal_intake', safeFileSegment(orgId || 'default', 'default')));
}

export function ensureLegalDeliveryRoot(orgId: string): string {
  return getDataDirectory(path.join('legal_delivery', safeFileSegment(orgId || 'default', 'default')));
}

export function ensureLegalExternalWorkspaceRoot(orgId: string): string {
  return getDataDirectory(path.join('legal_external_workspaces', safeFileSegment(orgId || 'default', 'default')));
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
  legalWrite(() => fs.mkdirSync(candidate, { recursive: true }));
  return candidate;
}

export function resolveWritableOutputDir(input: string, fallbackRoot: string, caseName: string, suffix: string): string {
  if (input) {
    const resolved = path.resolve(expandLocalPath(input));
    legalWrite(() => fs.mkdirSync(resolved, { recursive: true }));
    return resolved;
  }
  return uniqueLegalFolder(fallbackRoot, caseName, suffix);
}

export function expandLocalPath(input: string): string {
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


export function legalTemporalOptions(args: Record<string, any>): CitationVerificationOptions {
  return { factDate: textArg(args, 'factDate'), procedureDate: textArg(args, 'procedureDate'),
    temporalReviews: Array.isArray(args.temporalReviews) ? args.temporalReviews : undefined };
}

export class LegalStructuredResponseError extends Error {
  constructor(readonly reason: 'output_limit' | 'empty') { super(`Legal structured response: ${reason}`); }
}

export function withActiveLegalWorkspace(args: Record<string, any>, context?: any): Record<string, any> {
  try {
    const active = getActiveIndustryWorkspaceContext({
      userId: String(context?.userId || textArg(args, 'userId') || 'anonymous'),
      domain: context?.domain === 'work' ? 'work' : 'personal',
      orgId: context?.domain === 'work' ? String(context?.orgId || '') : '',
    });
    if (!active || active.productLine !== 'legal') return args;
    const attributes = active.attributes || {};
    const currentRequest = String(context?.actionIntent || context?.routedTaskText || '').trim();
    const createRequested = /(?:\u65b0\u5efa|\u521b\u5efa|\u5efa\u7acb).{0,32}(?:\u6848\u4ef6|\u5de5\u4f5c\u53f0|\u6848\u4ef6\u7a7a\u95f4)/u.test(currentRequest);
    const explicitCaseId = textArg(args, 'caseId');
    const userNamedCaseId = explicitCaseId && currentRequest.includes(explicitCaseId);
    const usableCaseId = /\{\{[^}]+\}\}/u.test(explicitCaseId)
      || (createRequested && !userNamedCaseId)
      ? ''
      : explicitCaseId;
    // An explicit ID owns the target. Never fill its identity from a different
    // active case; the persisted case will supply any omitted fields below.
    if (usableCaseId) return { ...args, caseId: usableCaseId };
    const explicitCaseName = textArg(args, 'caseName') || textArg(args, 'title');
    const activeCaseName = attributes.caseName || active.name;
    // "New" always creates a new identity, including when an earlier failed
    // attempt already renamed the active case to the same requested title.
    // Falling through to attributes.caseId in that situation would silently
    // mutate the old case again on every retry.
    if (createRequested && !userNamedCaseId) {
      return {
        ...args,
        caseId: '',
        caseName: explicitCaseName || textArg(args, 'title') || '未命名案件',
      };
    }
    // Naming a different case is a new identity, not a continuation of the
    // currently selected case. Never inject the old caseId, parties, court or
    // stage into that explicit new target.
    if (
      explicitCaseName
      && activeCaseName
      && explicitCaseName.trim().toLowerCase() !== activeCaseName.trim().toLowerCase()
    ) {
      return {
        ...args,
        caseId: usableCaseId,
        caseName: explicitCaseName,
      };
    }
    return {
      ...args,
      caseId: usableCaseId || attributes.caseId || '',
      caseName: explicitCaseName || attributes.caseName || active.name,
      caseNumber: textArg(args, 'caseNumber') || attributes.caseNumber || '',
      parties: textArg(args, 'parties') || attributes.clientName || '',
      court: textArg(args, 'court') || attributes.court || '',
      stage: textArg(args, 'stage') || attributes.stage || '',
    };
  } catch {
    return args;
  }
}

export const CASE_CONTINUATION_TOOLS = new Set([
  'legal_case_reasoning_matrix', 'legal_generate_litigation_packet',
  'legal_case_strategy', 'legal_generate_argument_or_opinion', 'legal_extract_dispute_focus',
  'legal_prepare_filing_handoff', 'legal_finalize_delivery_package',
  'legal_case_workflow_status',
]);

export function resolveLegalCaseArguments(name: string, input: Record<string, any>, context?: any): Record<string, any> {
  const chat = context?.source !== 'legal-direct-tool' && context?.userId && context?.conversationId && context?.requestId;
  let sourceInput = context?.userId ? { ...input, userId: context.userId } : input;
  let nativeRequirements = '';
  const nativeReadMaterials: string[] = [];
  if (chat) {
    const scope = { userId: context.userId, conversationId: context.conversationId,
      domain: context.domain || 'personal', orgId: context.orgId || '' };
    const current = getMessageByRequestId({ ...scope, requestId: context.requestId, role: 'user' });
    const turn = getConversationActionTurn({ ...scope, requestId: context.requestId });
    if (!current || (context.taskId && (!turn || turn.taskId !== context.taskId
      || turn.userMessageId !== current.id || turn.domain !== scope.domain || turn.orgId !== scope.orgId))) {
      throw new Error('The original legal user message is unavailable for this exact request scope.');
    }
    const boundSource = context.resolveServerBoundCapabilitySource?.({
      name, arguments: input, scope, requestId: context.requestId, taskId: context.taskId || '',
    });
    if (context.resolveServerBoundCapabilitySource && (!boundSource
      || boundSource.selectionText !== current.message.trim())) {
      throw new Error('The original legal user message is unavailable for this exact request scope.');
    }
    const turns = context.trustedActionContinuation && context.taskId
      ? listConversationActionTurns({ ...scope, taskId: context.taskId })
        .filter(item => item.domain === scope.domain && item.orgId === scope.orgId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      : [turn || { requestId: context.requestId, userMessageId: current.id }];
    const messages = turns.map(item => {
      const message = getMessageByRequestId({ ...scope, requestId: item.requestId, role: 'user' });
      if (!message || message.id !== item.userMessageId) throw new Error('An original legal task message is unavailable.');
      return message.message;
    });
    nativeRequirements = Array.from(new Set(messages)).join('\n\n');
    const records = context.getCurrentToolRecords?.() || [];
    for (const record of records) {
      if (!context.taskId || record.requestId !== context.requestId || record.taskId !== context.taskId
        || record.envelope?.requestId !== context.requestId || record.envelope?.taskId !== context.taskId
        || record.envelope?.status !== 'verified_success' || record.envelope.verification?.status !== 'verified'
        || !isSuccessfulExactDocumentRead(record)
        || !documentReadMatchesRequestedTarget(record, current.message, context.acceptedTaskTarget, [], scope)) continue;
      nativeReadMaterials.push('[附件实际读取/OCR文字，需核对原件]\n' + actualDocumentReadContent(record));
    }
    sourceInput = { ...input, userId: context.userId, ...(boundSource ? {} : { materials: Array.from(new Set([...messages, ...nativeReadMaterials])).join('\n\n') }) };
    if (name === 'legal_generate_litigation_packet') {
      for (const field of ['parties', 'clientPartyName', 'role', 'claims', 'objective', 'caseNumber', 'court', 'caseType', 'cause', 'stage']) delete sourceInput[field];
      sourceInput.packetFieldConflicts = [];
    }
    for (const field of ['facts', 'evidence', 'complaint', 'opponentMaterials', 'opponentArguments',
      'transcript', 'trialNotes', 'meetingText', 'notes', 'contract', 'details', 'requirements', 'templateText']) delete sourceInput[field];
  }
  const args = CASE_CONTINUATION_TOOLS.has(name) || name === 'legal_case_workspace'
    ? withActiveLegalWorkspace(sourceInput, context) : sourceInput;
  const caseId = textArg(args, 'caseId');
  if (!caseId) return args;
  const caseFile = LegalCases.getCase(legalWorkspaceId(args, context), caseId, context?.userId || textArg(args, 'userId') || 'system');
  if (!caseFile) throw new Error('The selected legal case is unavailable; select an authorized case before continuing.');
  const packetChat = chat && name === 'legal_generate_litigation_packet';
  const packetFields = { parties: 'party', clientPartyName: 'clientPartyName', role: 'clientRole', claims: 'objective', objective: 'objective',
    caseNumber: 'caseNumber', court: 'court', caseType: 'cause', cause: 'cause', stage: 'stage' } as const;
  const resolved = {
    ...args, caseId,
    caseName: caseFile.title, caseNumber: packetChat ? caseFile.caseNumber : textArg(args, 'caseNumber') || caseFile.caseNumber,
    parties: packetChat ? caseFile.party : textArg(args, 'parties') || caseFile.party,
    clientPartyName: packetChat ? caseFile.clientPartyName || ''
      : typeof args.clientPartyName === 'string' ? textArg(args, 'clientPartyName') : caseFile.clientPartyName || '',
    role: packetChat ? normalizeLegalClientRole(caseFile.clientRole) : textArg(args, 'role') || caseFile.clientRole || '',
    claims: packetChat ? caseFile.objective || '' : textArg(args, 'claims') || caseFile.objective || '',
    caseType: packetChat ? caseFile.cause : textArg(args, 'caseType') || caseFile.cause,
    court: packetChat ? caseFile.court : textArg(args, 'court') || caseFile.court,
    stage: packetChat ? caseFile.stage : textArg(args, 'stage') || caseFile.stage,
    ...(packetChat ? { packetFieldConflicts: Object.entries(packetFields)
      .filter(([field, stored]) => Object.hasOwn(input, field) && (field === 'role'
        ? !normalizeLegalClientRole(input[field]) || normalizeLegalClientRole(input[field]) !== normalizeLegalClientRole(caseFile[stored])
        : textArg(input, field) !== textArg(caseFile, stored)))
      .map(([field, stored]) => ({ field, stored: textArg(caseFile, stored), proposed: textArg(input, field) })) } : {}),
    factDate: name === 'legal_case_workspace' ? textArg(args, 'factDate') || caseFile.factDate || ''
      : caseFile.factDate || textArg(args, 'factDate'),
    factDateConflict: name !== 'legal_case_workspace' && !!caseFile.factDate
      && !!textArg(args, 'factDate') && textArg(args, 'factDate') !== caseFile.factDate,
  };
  if (name === 'legal_case_workspace') {
    // Explicit renames are supported by the workspace editor, but follow-up
    // generators cannot silently rename or redirect the case.
    return { ...resolved, caseName: textArg(input, 'caseName') || textArg(input, 'title') || caseFile.title };
  }
  if (!CASE_CONTINUATION_TOOLS.has(name)) return resolved;
  const originals = caseFile.materials.filter(item => chat
    ? item.source === 'manual' || item.source === 'import' : isLegalSourceMaterial(item));
  const render = (items: LegalCases.OrgLegalCaseMaterial[]) => items.map(item =>
    `[材料 ${item.id}：${item.title}]\n${item.content}`).join('\n\n');
  if (packetChat && originals.length) return { ...resolved, requirements: nativeRequirements,
    materials: [...new Set(nativeReadMaterials), render(originals)].filter(Boolean).join('\n\n') };
  if (chat) return { ...resolved, materials: [textArg(args, 'materials'), render(originals)].filter(Boolean).join('\n\n') };
  const facts = originals.filter(item => item.type === 'consultation' || /事实|时间线/.test(item.title));
  const evidence = originals.filter(item => item.type === 'evidence' || item.type === 'contract');
  // Materials do not carry a party assignment. Keep imported pleadings neutral;
  // only explicit arguments may assign complaint or opponent fields.
  const pleadings = originals.filter(item => item.type === 'pleading');
  return {
    ...resolved,
    facts: textArg(args, 'facts') || render(facts) || caseFile.notes.replace(/^【材料归档】.*$/gm, '').trim(),
    evidence: textArg(args, 'evidence') || render(evidence),
    materials: [textArg(args, 'materials'), render(pleadings)].filter(Boolean).join('\n\n'),
    complaint: textArg(args, 'complaint'),
    opponentMaterials: textArg(args, 'opponentMaterials'),
    transcript: textArg(args, 'transcript') || render(originals.filter(item => item.type === 'consultation')),
    legalAuthorities: textArg(args, 'legalAuthorities') || render(originals.filter(item => /法条|法律依据|检索记录/.test(item.title))),
  };
}
