import type { OperationMode } from './operation_modes';
import {
  detectRequestedOperationMode,
  getOperationModeConfig,
  normalizeOperationMode,
} from './operation_modes';
import {
  hasClientActionOnlyIntent,
  hasExplicitNoMutationInstruction,
  hasExplicitNoToolInstruction,
  hasExplicitTeamExecutionRequest,
  hasExplicitToolIntent,
  isCurrentClientDiagnosticRequest,
  isDiagnosticOrRepairRequest,
  shouldAllowToolUseForTurn,
  shouldExposeAgentWork,
} from './tool_intent';
import { hasVisionIntent } from './vision_routing';
import { resolveWorkSurfaceRoute } from './work_surface';
import { hasExplicitBackgroundDelegationPreference } from '../agents/background_delegation';
import { matchSkillWorkflow, type SkillWorkflowDescriptor } from '../skills/workflow_registry';
import { needsCompletionEvidence } from '../work_product/completion_guard';
import {
  buildWorkTakeoverContinuityContext,
  type WorkTakeoverContinuityContext,
  type WorkTakeoverTurnSurface,
} from '../work_takeover/continuity';
import { buildActionContract } from './action_contract';
import {
  classifyRecentActionFollowupIntent,
  isRecoveredCurrentAppEditingContinuation,
  needsRecentActionContinuationContext,
} from './action_continuation';
import { isCapabilityMetaQuestion } from './capability_meta';

export type LumiTurnChannel = 'chat' | 'voice' | 'task' | 'scheduler' | 'agent';
export type LumiVerificationIntent = 'none' | 'completion_evidence' | 'work_takeover_result' | 'capability_experiment';
export type LumiDelegationIntent = 'none' | 'explicit_team' | 'explicit_background' | 'consider_background' | 'foreground_owned';
export type LumiCapabilityLearningIntent = 'none' | 'inspect_reuse' | 'learn_missing' | 'stabilize_existing';

export interface LumiTurnFlowInput {
  userId: string;
  text: string;
  /** Prior-turn detail used only to fill a genuinely underspecified action. */
  continuationContext?: string;
  channel: LumiTurnChannel;
  source?: string;
  category?: string;
  domain?: string;
  orgId?: string;
  operationMode?: string;
  requestedMode?: OperationMode | null;
  targetIsLumi?: boolean;
  surface?: WorkTakeoverTurnSurface;
}

export interface LumiTurnFlow {
  channel: LumiTurnChannel;
  source?: string;
  surface: WorkTakeoverTurnSurface;
  domain?: string;
  orgId?: string;
  operationMode: OperationMode;
  effectiveOperationMode: OperationMode;
  requestedMode: OperationMode | null;
  autoPromoteToAssistant: boolean;
  conceptualCapabilityQuestion?: boolean;
  allowToolUseForTurn: boolean;
  selfRepairTurn: boolean;
  clientActionOnlyTurn: boolean;
  visionIntent: boolean;
  exposeAgentWork: boolean;
  workSurfaceRoute: ReturnType<typeof resolveWorkSurfaceRoute>;
  workTakeover: WorkTakeoverContinuityContext;
  specialWorkflow: SkillWorkflowDescriptor | null;
  executionGovernance: LumiExecutionGovernance;
  completionEvidenceNeeded: boolean;
  routeText: string;
  promptOverlay: string;
}

export interface LumiExecutionGovernance {
  verificationIntent: LumiVerificationIntent;
  verificationReason: string;
  delegationIntent: LumiDelegationIntent;
  delegationReason: string;
  capabilityLearningIntent: LumiCapabilityLearningIntent;
  capabilityLearningReason: string;
  shouldInspectCapabilitiesFirst: boolean;
}

const QUESTION_RE = /[?？]\s*$|是不是|为什么|怎么回事|有没有|找到了吗|听见了吗/u;
const WORK_ACTION_RE = /桌面|文件|文件夹|目录|草稿图|图纸|平面图|施工图|设计图|cad|CAD|DXF|运行日志|日志|生成|创建|画一|画个|按照.*画|找|搜索|打开|执行|运行|去干活|开始干活|开始处理|继续处理|继续做|接着做/u;
const WORK_SOURCE_RE = /(?:work|task|takeover|org|organization|job|workflow|workspace|任务|工作|接管|组织)/i;
const WORK_PRODUCT_RE = /交付|方案|报告|PPT|PDF|CAD|DXF|DWG|文档|文件|报价|视频|发布|草稿|微信|回复|账号|店铺|立案|装修|设计|图纸|素材|脚本|表格|合同|起诉状|诉状|包\b|\b(package|deliverable|draft|publish|export|file|document|cad|dxf|ppt|pdf)\b/i;
const MULTI_STEP_WORK_RE = /完整流程|闭环|多步|批量|行业|客户|店铺|账号管理|短视频|电商|装修|立案|发布|交付包|内容矩阵|自动生成|自动处理|接管|推进|编排|产出结果/u;
const CAPABILITY_CONTEXT_RE = /lumi|能力|技能|工具|接入|集成|mcp|网页登录|自动登录|外部软件|桌面感知|屏幕|客户端|任务中心|agent|adapter|适配器|沉淀|学会|复用|脚本|内置|通用化/i;
const CAPABILITY_ACTION_RE = /沉淀|学会|记住|优化|完善|做实|稳定|接入|集成|拆|复用|通用|自学习|自动登录|控制|能力提升|补齐|修好|别写死|不要写死/u;
const CAPABILITY_REUSE_AUDIT_RE = /重复|复用|够不够稳定|是不是.*写进|写进.*程序|内置|脚本|固定|白改|之前.*做过|已有能力|拆|不要写死|别写死/u;
const CAPABILITY_GAP_RE = /不会|不能|打不开|没找到|失败|不稳定|卡死|做不好|很烂|缺|缺口|补齐|修好|问题|掉了|崩|崩溃|不顺手/u;

export function resolveTurnSurface(input: {
  channel: LumiTurnChannel;
  source?: string;
  category?: string;
  domain?: string;
  explicitSurface?: WorkTakeoverTurnSurface;
}): WorkTakeoverTurnSurface {
  if (input.explicitSurface) return input.explicitSurface;
  if (input.channel === 'voice') return 'voice';
  if (input.channel === 'task' || input.channel === 'scheduler' || input.channel === 'agent') return 'work';
  if (input.domain === 'work') return 'work';
  const source = String(input.source || '');
  const category = String(input.category || '');
  if (source === 'org-chat' || WORK_SOURCE_RE.test(source) || category === 'organization') return 'work';
  return 'chat';
}

export function shouldAutoPromoteWorkTurn(
  text: string,
  operationMode: OperationMode,
  requestedMode: OperationMode | null,
  channel: LumiTurnChannel,
): boolean {
  if (operationMode !== 'chat' || requestedMode) return false;
  if (isCurrentClientDiagnosticRequest(text)) return true;
  if (QUESTION_RE.test(text)) return false;
  if (!hasExplicitToolIntent(text)) return false;
  if (channel === 'voice') return WORK_ACTION_RE.test(text);
  return channel === 'chat';
}

function buildTurnFlowPromptOverlay(flow: Omit<LumiTurnFlow, 'promptOverlay'>): string {
  const focus: string[] = [];
  if (flow.specialWorkflow) focus.push(`skill_workflow=${flow.specialWorkflow.skillId}`);
  if (!flow.conceptualCapabilityQuestion && flow.workTakeover.shouldResumeTask) focus.push(`active_task=${flow.workTakeover.latestTask?.id || 'unknown'}`);
  if (!flow.conceptualCapabilityQuestion && flow.workTakeover.strength === 'hint') focus.push(`task_hint=${flow.workTakeover.latestTask?.id || 'unknown'}`);
  if (flow.conceptualCapabilityQuestion) focus.push('capability_explanation');
  if (flow.workSurfaceRoute.directDesktop) focus.push('external_desktop');
  if (flow.workSurfaceRoute.artifactFirst) focus.push('artifact_first');
  if (flow.clientActionOnlyTurn) focus.push('client_surface');
  if (flow.selfRepairTurn) focus.push('self_repair');
  if (flow.visionIntent) focus.push('vision');
  if (flow.executionGovernance.verificationIntent !== 'none') focus.push(`verify=${flow.executionGovernance.verificationIntent}`);
  if (flow.executionGovernance.delegationIntent !== 'none') focus.push(`delegate=${flow.executionGovernance.delegationIntent}`);
  if (flow.executionGovernance.capabilityLearningIntent !== 'none') focus.push(`capability=${flow.executionGovernance.capabilityLearningIntent}`);

  return [
    '## Lumi Turn Flow',
    `Channel: ${flow.channel}. Surface: ${flow.surface}. Mode: ${flow.operationMode} -> ${flow.effectiveOperationMode}. Tool access: ${flow.allowToolUseForTurn ? 'available' : 'chat-only'}.`,
    focus.length ? `Current capability focus: ${focus.join(', ')}.` : 'Current capability focus: natural conversation unless the user asks for action.',
    'Decision order for this turn:',
    '1. Stay as Lumi first: understand the user, the surface, the unfinished task pointer, and the current screen/work context before choosing a capability.',
    '2. Use normal language when the user is chatting, reflecting, correcting, or asking a conceptual question. Do not force a task/tool path just because a task exists.',
    flow.conceptualCapabilityQuestion
      ? 'This is a conceptual question about Lumi modes or tool access. Explain the real per-turn routing model without calling tools, inspecting client state, resuming a task, or claiming tools are missing from the session.'
      : '',
    flow.source === 'command-center-chat'
      ? 'The command-center office text panel is Lumi\'s only text entry. Never direct the user to another chat screen or tell them to go to the command center; they are already there.'
      : '',
    '3. Use the task center only for persistent work with state, follow-up, artifacts, blockers, and confirmation boundaries.',
    '4. Use skill workflows for learned repeatable capabilities, but never let a demo/script override the current user wording or task parameters.',
    '5. Use external software, browser, desktop control, and MCP/tools as Lumi\'s hands, not as separate agents. Verify visible or file results before claiming completion.',
    '6. Delegate to background agents only for explicit delegation or genuinely multi-step work; keep Lumi responsible for the user-facing summary and next decision.',
    'Execution governance:',
    `- Result verification: ${flow.executionGovernance.verificationIntent} (${flow.executionGovernance.verificationReason}). Before saying work is done, rely on tool evidence, visible desktop evidence, file existence/content checks, or work_product_verify/work_takeover_task_verify_result.`,
    `- Background delegation: ${flow.executionGovernance.delegationIntent} (${flow.executionGovernance.delegationReason}). Agents are optional workers; Lumi remains the owner and explains the result humanly.`,
    `- Capability learning: ${flow.executionGovernance.capabilityLearningIntent} (${flow.executionGovernance.capabilityLearningReason}). Before adding new code or wrappers, inspect capability_learning_list/self_extension_plan, reuse learned skills/adapters/tools when possible, and use capability_gap_autofix only for a real missing or brittle capability.`,
    'If chat/work intent is ambiguous, ask one short clarification or continue the conversation naturally.',
    flow.conceptualCapabilityQuestion ? '' : flow.workTakeover.promptOverlay,
  ].filter(Boolean).join('\n');
}

function compact(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function taskContextText(workTakeover: WorkTakeoverContinuityContext): string {
  const task = workTakeover.latestTask;
  if (!task) return '';
  return [
    task.title,
    task.summary,
    task.recommendedWorkflow,
    task.sourceMessage,
    task.nextActions.join(' '),
    task.artifacts.map(artifact => artifact.label).join(' '),
    task.drafts.map(draft => draft.text).join(' '),
    task.blockedBy.join(' '),
    task.confirmationRequired.join(' '),
  ].map(compact).filter(Boolean).join(' ');
}

function classifyCapabilityLearningIntent(
  text: string,
  input: Pick<LumiTurnFlowInput, 'targetIsLumi'>,
): Pick<LumiExecutionGovernance, 'capabilityLearningIntent' | 'capabilityLearningReason' | 'shouldInspectCapabilitiesFirst'> {
  if (isRecoveredCurrentAppEditingContinuation(text)) {
    return {
      capabilityLearningIntent: 'none',
      capabilityLearningReason: 'current-app editing continues through visible UI controls instead of capability learning',
      shouldInspectCapabilitiesFirst: false,
    };
  }
  const englishCapabilityContext = /\b(lumi|capabilit(?:y|ies)|skill|tool|adapter|workflow|mcp|agent|desktop|browser|login|client|task\s*center)\b/i.test(text);
  const englishReuseAudit = /\b(duplicate|reuse|reusable|hard-?coded|script|built-?in|demo|already|existing|fragmented|same\s+path)\b/i.test(text);
  const englishCapabilityAction = /\b(learn|stabili[sz]e|remember|optimi[sz]e|improve|wire|integrate|make\s+real|make\s+reusable|fix|repair)\b/i.test(text);
  const englishCapabilityGap = /\b(can'?t|cannot|fail(?:s|ed)?|broken|unstable|missing|brittle|bad|not\s+working|crash(?:ed)?|stuck|forgot)\b/i.test(text);
  const directActionContract = buildActionContract(text);
  const explicitCapabilityMeta = /(?:Lumi|lumi).{0,32}(?:能力|技能|工具|权限|认知|稳定|优化|修|学会|通用|复用|脚本|接入|边界|桌面|后台)|(?:能力|技能|工具|权限|认知|稳定|优化|修|学会|通用|复用|脚本|接入|边界|桌面|后台).{0,32}(?:Lumi|lumi)|\b(?:capabilit(?:y|ies)|skill|tool|adapter|workflow|mcp|agent)\b.*\b(?:learn|stabili[sz]e|improve|fix|reuse|reusable|hard-?coded|script)\b|\b(?:learn|stabili[sz]e|improve|fix|reuse|reusable|hard-?coded|script)\b.*\b(?:capabilit(?:y|ies)|skill|tool|adapter|workflow|mcp|agent)\b/i.test(text);
  if (directActionContract.applies && directActionContract.kind !== 'none' && !explicitCapabilityMeta) {
    return {
      capabilityLearningIntent: 'none',
      capabilityLearningReason: 'direct external action contract should execute instead of entering capability learning',
      shouldInspectCapabilitiesFirst: false,
    };
  }
  const inCapabilityContext = input.targetIsLumi || CAPABILITY_CONTEXT_RE.test(text) || englishCapabilityContext;
  if (!inCapabilityContext) {
    return {
      capabilityLearningIntent: 'none',
      capabilityLearningReason: 'no capability-learning signal',
      shouldInspectCapabilitiesFirst: false,
    };
  }

  if (CAPABILITY_REUSE_AUDIT_RE.test(text) || (englishCapabilityContext && englishReuseAudit)) {
    return {
      capabilityLearningIntent: 'inspect_reuse',
      capabilityLearningReason: 'user is asking about duplication, scripts, hard-coding, or reuse',
      shouldInspectCapabilitiesFirst: true,
    };
  }

  if ((CAPABILITY_ACTION_RE.test(text) || englishCapabilityAction) && (CAPABILITY_GAP_RE.test(text) || englishCapabilityGap)) {
    return {
      capabilityLearningIntent: 'learn_missing',
      capabilityLearningReason: 'user described a brittle or missing capability that should become reusable',
      shouldInspectCapabilitiesFirst: true,
    };
  }

  if (CAPABILITY_ACTION_RE.test(text) || englishCapabilityAction) {
    return {
      capabilityLearningIntent: 'stabilize_existing',
      capabilityLearningReason: 'user wants an existing Lumi capability made stable or reusable',
      shouldInspectCapabilitiesFirst: true,
    };
  }

  return {
    capabilityLearningIntent: 'none',
    capabilityLearningReason: 'no capability-learning action requested',
    shouldInspectCapabilitiesFirst: false,
  };
}

function classifyDelegationIntent(input: {
  text: string;
  allowToolUseForTurn: boolean;
  clientActionOnlyTurn: boolean;
  selfRepairTurn: boolean;
  workSurfaceRoute: ReturnType<typeof resolveWorkSurfaceRoute>;
  workTakeover: WorkTakeoverContinuityContext;
}): Pick<LumiExecutionGovernance, 'delegationIntent' | 'delegationReason'> {
  if (!input.allowToolUseForTurn) {
    return { delegationIntent: 'none', delegationReason: 'tools are not enabled for this conversational turn' };
  }
  if (input.clientActionOnlyTurn) {
    return { delegationIntent: 'none', delegationReason: 'client mode/control turn must stay on the client surface' };
  }
  if (input.selfRepairTurn) {
    return { delegationIntent: 'none', delegationReason: 'self-repair should stay foreground and inspect client state directly' };
  }
  if (hasExplicitBackgroundDelegationPreference(input.text)) {
    return { delegationIntent: 'explicit_background', delegationReason: 'user explicitly asked for background/parallel delegation' };
  }
  if (hasExplicitTeamExecutionRequest(input.text)) {
    return { delegationIntent: 'explicit_team', delegationReason: 'user explicitly requested team or multi-agent execution' };
  }
  if (input.workSurfaceRoute.directDesktop) {
    return { delegationIntent: 'foreground_owned', delegationReason: 'visible desktop/software work should be controlled and verified in foreground' };
  }
  if (input.workSurfaceRoute.artifactFirst) {
    return { delegationIntent: 'foreground_owned', delegationReason: 'artifact-first work should proceed sequentially with local output checks' };
  }
  if (input.workTakeover.shouldResumeTask || MULTI_STEP_WORK_RE.test(input.text)) {
    return { delegationIntent: 'consider_background', delegationReason: 'multi-step work may use agents after Lumi keeps ownership of the plan' };
  }
  return { delegationIntent: 'none', delegationReason: 'simple foreground turn' };
}

function classifyVerificationIntent(input: {
  text: string;
  taskText: string;
  completionEvidenceNeeded: boolean;
  workTakeover: WorkTakeoverContinuityContext;
  capabilityLearningIntent: LumiCapabilityLearningIntent;
}): Pick<LumiExecutionGovernance, 'verificationIntent' | 'verificationReason'> {
  if (input.capabilityLearningIntent !== 'none' && /(验证|稳定|做实|测试|沉淀|学会|修好|补齐)/u.test(input.text)) {
    return { verificationIntent: 'capability_experiment', verificationReason: 'capability changes need a minimal verified experiment before being claimed stable' };
  }
  if (input.workTakeover.shouldResumeTask && WORK_PRODUCT_RE.test(`${input.text} ${input.taskText}`)) {
    return { verificationIntent: 'work_takeover_result', verificationReason: 'continuing a task that may produce files, drafts, desktop actions, or deliverables' };
  }
  if (input.completionEvidenceNeeded) {
    return { verificationIntent: 'completion_evidence', verificationReason: 'the user asked for external work or a deliverable that requires evidence' };
  }
  return { verificationIntent: 'none', verificationReason: 'no completion claim should be made without action evidence' };
}

function buildExecutionGovernance(input: {
  text: string;
  flowInput: LumiTurnFlowInput;
  allowToolUseForTurn: boolean;
  clientActionOnlyTurn: boolean;
  selfRepairTurn: boolean;
  workSurfaceRoute: ReturnType<typeof resolveWorkSurfaceRoute>;
  workTakeover: WorkTakeoverContinuityContext;
}): { governance: LumiExecutionGovernance; completionEvidenceNeeded: boolean } {
  const taskText = taskContextText(input.workTakeover);
  const completionEvidenceNeeded =
    needsCompletionEvidence(input.text) ||
    needsCompletionEvidence(taskText) ||
    Boolean(input.workTakeover.shouldResumeTask && WORK_PRODUCT_RE.test(`${input.text} ${taskText}`));
  const capability = classifyCapabilityLearningIntent(input.text, input.flowInput);
  const verification = classifyVerificationIntent({
    text: input.text,
    taskText,
    completionEvidenceNeeded,
    workTakeover: input.workTakeover,
    capabilityLearningIntent: capability.capabilityLearningIntent,
  });
  const delegation = classifyDelegationIntent({
    text: input.text,
    allowToolUseForTurn: input.allowToolUseForTurn,
    clientActionOnlyTurn: input.clientActionOnlyTurn,
    selfRepairTurn: input.selfRepairTurn,
    workSurfaceRoute: input.workSurfaceRoute,
    workTakeover: input.workTakeover,
  });

  return {
    completionEvidenceNeeded,
    governance: {
      ...verification,
      ...delegation,
      ...capability,
    },
  };
}

export function buildLumiTurnFlow(input: LumiTurnFlowInput): LumiTurnFlow {
  const explicitNoToolInstruction = hasExplicitNoToolInstruction(input.text);
  const explicitNoMutationInstruction = hasExplicitNoMutationInstruction(input.text);
  const conceptualCapabilityQuestion = isCapabilityMetaQuestion(input.text);
  const continuationContext = compact(input.continuationContext);
  const hasContinuationContext = Boolean(continuationContext);
  const directActionFollowupIntent = classifyRecentActionFollowupIntent(input.text);
  const recoveredActionFollowupIntent = /(?:^|\n)- followupIntent:\s*status(?:\s|$)/i.test(continuationContext)
    ? 'status' as const
    : /(?:^|\n)- followupIntent:\s*execute(?:\s|$)/i.test(continuationContext)
      ? 'execute' as const
      : 'none' as const;
  const actionFollowupIntent = directActionFollowupIntent !== 'none'
    ? directActionFollowupIntent
    : recoveredActionFollowupIntent;
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const explicitContinuationConfirmation =
    /^(?:确认|确定|嗯|好|好的|可以|行|开始|yes|ok|okay|confirm|go)[。！？.!?]*$/iu.test(input.text.trim()); // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const currentAcceptsContinuationContext = needsRecentActionContinuationContext(input.text)
    || explicitContinuationConfirmation
    || recoveredActionFollowupIntent !== 'none';
  const continuationMayDriveAction = !conceptualCapabilityQuestion && hasContinuationContext
    && (actionFollowupIntent === 'execute' || explicitContinuationConfirmation);
  const statusOnlyContinuation = !conceptualCapabilityQuestion && hasContinuationContext && actionFollowupIntent === 'status';
  const contextualText = hasContinuationContext
    ? `${input.text}\n\n${continuationContext}`
    : input.text;
  // Status/why/recall follow-ups still need the recovered evidence in the model
  // context, but only execute/confirmation follow-ups may turn it into tool work.
  const routingText = conceptualCapabilityQuestion
    ? input.text
    : hasContinuationContext && currentAcceptsContinuationContext
    ? contextualText
    : input.text;
  const explicitTeamExecution = !conceptualCapabilityQuestion && hasExplicitTeamExecutionRequest(routingText);
  const operationMode = normalizeOperationMode(input.operationMode);
  const requestedMode = input.requestedMode || detectRequestedOperationMode(input.text);
  const surface = resolveTurnSurface({
    channel: input.channel,
    source: input.source,
    category: input.category,
    domain: input.domain,
    explicitSurface: input.surface,
  });
  const workTakeover = buildWorkTakeoverContinuityContext(input.userId, input.text, {
    domain: input.domain,
    orgId: input.orgId,
    surface,
  });
  const rawClientActionIntent = !conceptualCapabilityQuestion
    && !explicitNoToolInstruction
    && hasClientActionOnlyIntent(input.text);
  // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const continuationNamesExternalTarget = continuationMayDriveAction
    && /(?:desktop_|wechat_|browser_|mcp_|AutoCAD|\bCAD\b|微信|浏览器)/iu.test(continuationContext); // i18n-allow: Chinese input-recognition pattern; not user-visible copy.
  const clientActionIntent = rawClientActionIntent && !continuationNamesExternalTarget;
  const currentActionContract = buildActionContract(input.text);
  const readOnlyConversationTurn = explicitNoMutationInstruction
    && currentActionContract.kind === 'none'
    && /[？?]|(?:先聊|只回答|告诉我|你认为|解释|reply|answer|explain)/iu.test(input.text);
  const actionContract = currentActionContract.applies || !continuationMayDriveAction
    ? currentActionContract
    : buildActionContract(routingText);
  const actionContractRequiresTools = actionContract.applies && actionContract.kind !== 'none' && !clientActionIntent;
  const autoPromoteToAssistant = !conceptualCapabilityQuestion && (shouldAutoPromoteWorkTurn(
    input.text,
    operationMode,
    requestedMode,
    input.channel,
  ) || Boolean(
    explicitTeamExecution
    && operationMode === 'chat'
    && !requestedMode
  ) || Boolean(
    continuationMayDriveAction
    && operationMode === 'chat'
    && !requestedMode
    && actionContractRequiresTools
  ));
  const taskEntryTurn = input.channel === 'task';
  const chatModePureConversation = operationMode === 'chat' && !requestedMode && !taskEntryTurn && !autoPromoteToAssistant;
  const shouldPromoteForAction =
    operationMode === 'chat' &&
    !requestedMode &&
    !chatModePureConversation &&
    (taskEntryTurn || autoPromoteToAssistant || workTakeover.shouldResumeTask || actionContractRequiresTools);
  const effectiveOperationMode = requestedMode || (shouldPromoteForAction ? 'assistant' : operationMode);
  const capabilityLearningPreview = classifyCapabilityLearningIntent(input.text, input);
  const explicitCapabilityMaintenance =
    capabilityLearningPreview.capabilityLearningIntent === 'inspect_reuse'
    || capabilityLearningPreview.capabilityLearningIntent === 'stabilize_existing';
  const selfRepairTurn = !conceptualCapabilityQuestion
    && !statusOnlyContinuation
    && !chatModePureConversation
    && !explicitCapabilityMaintenance
    && isDiagnosticOrRepairRequest(input.text);
  const clientActionOnlyTurn = !selfRepairTurn && clientActionIntent;
  const visionIntent = hasVisionIntent(routingText);
  const workSurfaceRoute = resolveWorkSurfaceRoute(routingText);
  const recoveredCurrentAppEdit = isRecoveredCurrentAppEditingContinuation(routingText);
  const explicitBackgroundDelegation = hasExplicitBackgroundDelegationPreference(input.text);
  const allowToolUseForTurn = explicitNoToolInstruction || readOnlyConversationTurn
    ? false
    : conceptualCapabilityQuestion || statusOnlyContinuation
      ? false
      : chatModePureConversation
        ? clientActionOnlyTurn
        : clientActionOnlyTurn ||
          taskEntryTurn ||
          autoPromoteToAssistant ||
          actionContractRequiresTools ||
          continuationMayDriveAction ||
          workTakeover.shouldResumeTask ||
          explicitTeamExecution ||
          explicitBackgroundDelegation ||
          shouldAllowToolUseForTurn(input.text, input.source, effectiveOperationMode);
  const specialWorkflow = conceptualCapabilityQuestion || recoveredCurrentAppEdit
    ? null
    : matchSkillWorkflow(routingText, { targetIsLumi: input.targetIsLumi });
  const exposeAgentWork = !conceptualCapabilityQuestion && (explicitTeamExecution || shouldExposeAgentWork(input.text));
  const derivedExecution = buildExecutionGovernance({
    text: routingText,
    flowInput: input,
    allowToolUseForTurn,
    clientActionOnlyTurn,
    selfRepairTurn,
    workSurfaceRoute,
    workTakeover,
  });
  const execution = conceptualCapabilityQuestion || readOnlyConversationTurn
    ? {
        completionEvidenceNeeded: false,
        governance: {
          verificationIntent: 'none' as const,
          verificationReason: conceptualCapabilityQuestion
            ? 'conceptual capability explanation does not execute work'
            : 'the current turn explicitly requests conversation without modifying the prior work product',
          delegationIntent: 'none' as const,
          delegationReason: conceptualCapabilityQuestion
            ? 'conceptual capability explanation stays in the foreground conversation'
            : 'a read-only conversational follow-up stays in the foreground conversation',
          capabilityLearningIntent: 'none' as const,
          capabilityLearningReason: conceptualCapabilityQuestion
            ? 'the user asked how existing capability routing works'
            : 'the current turn does not request capability learning',
          shouldInspectCapabilitiesFirst: false,
        },
      }
    : derivedExecution;

  const flowWithoutPrompt: Omit<LumiTurnFlow, 'promptOverlay'> = {
    channel: input.channel,
    source: input.source,
    surface,
    domain: input.domain,
    orgId: input.orgId,
    operationMode,
    effectiveOperationMode,
    requestedMode,
    autoPromoteToAssistant,
    conceptualCapabilityQuestion,
    allowToolUseForTurn,
    selfRepairTurn,
    clientActionOnlyTurn,
    visionIntent,
    exposeAgentWork,
    workSurfaceRoute,
    workTakeover,
    specialWorkflow,
    executionGovernance: execution.governance,
    completionEvidenceNeeded: execution.completionEvidenceNeeded,
    routeText: readOnlyConversationTurn
      ? input.text
      : !conceptualCapabilityQuestion && !statusOnlyContinuation && workTakeover.shouldResumeTask && workTakeover.routeText
      ? workTakeover.routeText
      : routingText,
  };

  return {
    ...flowWithoutPrompt,
    promptOverlay: [
      buildTurnFlowPromptOverlay(flowWithoutPrompt),
      readOnlyConversationTurn
        ? [
            '## Current-turn read-only conversation boundary',
            'The newest user turn asks for a direct conversational answer and explicitly forbids modifying the prior artifact.',
            'Answer the question now from the conversation context already supplied. Do not read, write, inspect, resume, or verify files; do not announce a plan; and never emit tool-call syntax or ask the user to wait.',
            'Use explicit facts in recent user messages before generic domain advice. For a question about missing information, prioritize facts already marked incomplete, missing, risky, or awaiting confirmation; never claim such visible conversation facts are unavailable.',
            'If the user asks for one or the only item, give exactly one concise item and its direct reason. Do not add alternatives or offer a forbidden follow-up action.',
            'The prior task may be discussed as context, but it does not become the action for this turn.',
          ].join('\n')
        : '',
    ].filter(Boolean).join('\n\n'),
  };
}

export function buildInteractionModeOverlay(flow: LumiTurnFlow): string {
  const opModeConfig = getOperationModeConfig(flow.effectiveOperationMode);
  const restatementOverlay = /(?:只|仅)?(?:复述|重复|完整说出|原样说出)|其他不变|只(?:说|保留|复述)事实/u.test(flow.routeText)
    ? '\n\n## Factual Restatement Fidelity\nUse only facts explicitly stated by the user in the relevant recent turns. Apply the latest correction as a replacement and keep every other fact unchanged. Do not add reminders, scheduling, ownership, implications, advice, inferred next steps, or claims that anything was saved or recorded.'
    : '';
  if (flow.conceptualCapabilityQuestion) {
    return '## Capability Explanation\nThis turn only explains how Lumi modes and per-turn capability routing work. Do not call tools, inspect client state, resume an existing task, or delegate work. A routed subset is not the installed tool inventory; never ask the user to enable, mount, or switch to a fictional tool mode.' + restatementOverlay;
  }
  if (flow.clientActionOnlyTurn) {
    return '## Client Mode Control\nThe user is asking Lumi to change a client mode or open a client-native surface. You may only use client_get_state and client_action. Do not use file, terminal, desktop mouse/keyboard, web, team, or external-app tools. For meeting/autonomous mode, use the client action confirmation flow when required.' + restatementOverlay;
  }
  if (flow.selfRepairTurn) {
    return '## Client Self-Repair Turn\nThe user is reporting that Lumi or one of its client workflows is failing. Do not only apologize or repeat the raw error. Use client_get_state first when tools are available, inspect relevant status/log/config surfaces, apply one safe recovery or retry when the cause is clear, verify the result, and then give a concise report. Reads and status checks are allowed; writes, desktop control, external app automation, and system changes still require confirmation.' + restatementOverlay;
  }
  if (opModeConfig && (flow.allowToolUseForTurn || flow.effectiveOperationMode === 'meeting')) {
    return opModeConfig.promptOverlay + restatementOverlay;
  }
  return '## Interaction Mode\nThis turn is chat-only. Do not call tools, operate the desktop, or claim that you are taking actions. Answer naturally unless the user gives an explicit command.' + restatementOverlay;
}
