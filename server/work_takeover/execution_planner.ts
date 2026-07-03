import type { WechatWorkCategory } from './wechat_intake';
import { getIndustryWorkStandard } from './industry_standards';
import type { WorkTakeoverArtifact, WorkTakeoverDraft, WorkTakeoverTask } from './tasks';

export type WorkTakeoverExecutionMode = 'plan_only' | 'prepare_work' | 'visible_external_work';

export interface WorkTakeoverCapabilitySelection {
  id: string;
  label: string;
  kind: 'intake' | 'document' | 'external_app' | 'messaging' | 'automation' | 'verification';
  tools: string[];
  confirmationRequired: string[];
  reason: string;
  matchedBy: string[];
}

export interface WorkTakeoverExecutionStep {
  id: string;
  title: string;
  goal: string;
  capabilityIds: string[];
  suggestedTools: string[];
  expectedArtifacts: string[];
  confirmationRequired: string[];
  status: 'ready' | 'needs_input' | 'confirmation_required' | 'blocked';
}

export interface WorkTakeoverExecutionPlan {
  planId: string;
  generatedAt: string;
  taskId: string;
  category: WechatWorkCategory;
  mode: WorkTakeoverExecutionMode;
  objective: string;
  contextSignals: string[];
  capabilities: WorkTakeoverCapabilitySelection[];
  steps: WorkTakeoverExecutionStep[];
  nextStep?: WorkTakeoverExecutionStep;
  safeActions: string[];
  confirmationRequired: string[];
  blockers: string[];
  verificationChecklist: string[];
  handoffPrompt: string;
}

export interface WorkTakeoverStepExecutionArtifact {
  type: WorkTakeoverArtifact['type'];
  label: string;
  content: string;
  status: WorkTakeoverArtifact['status'];
}

export interface WorkTakeoverStepExecutionResult {
  executionId: string;
  executedAt: string;
  taskId: string;
  planId: string;
  step: WorkTakeoverExecutionStep;
  status: 'prepared' | 'waiting_confirmation' | 'blocked';
  summary: string;
  artifacts: WorkTakeoverStepExecutionArtifact[];
  draftReply?: string;
  suggestedToolCalls: Array<{ name: string; reason: string }>;
  confirmationRequired: string[];
  blockers: string[];
  nextInstruction: string;
}

export interface WorkTakeoverExecutionProgress {
  executedStepIds: string[];
  remainingStepIds: string[];
  nextStep?: WorkTakeoverExecutionStep;
  complete: boolean;
}

type CapabilityRule = Omit<WorkTakeoverCapabilitySelection, 'reason' | 'matchedBy'> & {
  keywords: string[];
  categoryHints?: WechatWorkCategory[];
  workflowHints?: string[];
  always?: boolean;
};

const CAPABILITY_RULES: CapabilityRule[] = [
  {
    id: 'task.context_structuring',
    label: '任务上下文结构化',
    kind: 'intake',
    tools: ['work_takeover_task_update', 'work_product_plan'],
    confirmationRequired: [],
    keywords: ['需求', '摘要', '任务', '客户', '消息', '资料', '整理', '背景'],
    always: true,
  },
  {
    id: 'document.proposal_packet',
    label: '文档/方案/报价材料',
    kind: 'document',
    tools: ['create_docx', 'create_xlsx', 'create_pdf', 'work_takeover_task_prepare_design_delivery', 'work_product_verify'],
    confirmationRequired: ['对外承诺最终价格、合同条款、交付周期前需要确认'],
    keywords: ['方案', '报价', '预算', '材料', '清单', '合同', '报告', '文档', 'pdf', 'PDF', '表格', 'xlsx', 'Excel'],
    categoryHints: ['customer', 'store', 'account', 'design_delivery', 'general_work'],
  },
  {
    id: 'presentation.client_deck',
    label: '客户可看的汇报/PPT',
    kind: 'document',
    tools: ['create_ppt', 'create_pdf', 'desktop_open', 'work_product_verify'],
    confirmationRequired: ['正式交付客户前需要确认内容和口径'],
    keywords: ['PPT', 'ppt', '汇报', '演示', '方案包', '客户可看', '提案', 'deck'],
    categoryHints: ['design_delivery', 'customer', 'video_publish', 'account'],
  },
  {
    id: 'cad_bim.design_handoff',
    label: 'CAD/BIM 交付物',
    kind: 'external_app',
    tools: ['work_takeover_task_prepare_design_delivery', 'floorplan_extract_geometry', 'cad_generate_dxf', 'desktop_open', 'desktop_run_command', 'work_product_verify'],
    confirmationRequired: ['生产图纸、尺寸、结构、水电和施工承诺需要确认'],
    keywords: ['CAD', 'cad', 'DXF', 'dxf', '图纸', '平面图', '施工图', 'Revit', 'revit', 'Dynamo', 'BIM', '户型'],
    categoryHints: ['design_delivery'],
    workflowHints: ['design_delivery'],
  },
  {
    id: 'messaging.reply_handoff',
    label: '微信/消息回复草稿',
    kind: 'messaging',
    tools: ['wechat_prepare_reply', 'wechat_copy_reply_draft', 'desktop_clipboard_write', 'desktop_active_window', 'desktop_open', 'desktop_run_command'],
    confirmationRequired: ['发送消息、首次登录、扫码/验证码、切换账号、对外承诺最终条件前需要确认'],
    keywords: ['微信', 'WeChat', 'weixin', '消息', '回复', '草稿', '客户回复', '跟进', '对接'],
    categoryHints: ['customer', 'store', 'account', 'legal_case', 'video_publish', 'design_delivery', 'general_work'],
  },
  {
    id: 'account.session_reuse',
    label: '已登录账号会话复用',
    kind: 'external_app',
    tools: ['desktop_active_window', 'desktop_capture_screen', 'desktop_open', 'desktop_run_command', 'web_login_profile_list', 'browser_open_task'],
    confirmationRequired: ['首次登录、扫码、验证码、人脸/短信验证、切换账号、授权第三方或保存凭据前需要用户确认或接管'],
    keywords: ['已登录', '登录', '账号', '账户', '任务栏', '后台', '微信', 'WeChat', 'Weixin', '抖音', '抖店', '小红书', '视频号', '店铺后台', '商家后台', '创作者中心'],
    categoryHints: ['customer', 'store', 'account', 'video_publish', 'design_delivery'],
  },
  {
    id: 'browser.account_platform_work',
    label: '浏览器/平台账号操作',
    kind: 'external_app',
    tools: ['browser_open_task', 'web_login_profile_list', 'web_login_run', 'desktop_open', 'work_product_verify'],
    confirmationRequired: ['首次登录、切换账号、发布、投放、下单、付款或提交表单前需要确认；已登录会话可在可见窗口中复用'],
    keywords: ['账号', '发布', '平台', '浏览器', '小红书', '抖音', '视频号', '投放', '店铺', '订单', '库存', '上架', '下架'],
    categoryHints: ['store', 'account', 'video_publish'],
  },
  {
    id: 'video.content_publish_pack',
    label: '视频内容生成与发布准备',
    kind: 'automation',
    tools: ['short_video_script', 'content_topic_pipeline', 'content_calendar_builder', 'create_docx', 'browser_open_task'],
    confirmationRequired: ['正式发布、账号操作、投放预算前需要确认'],
    keywords: ['视频', '脚本', '标题', '封面', '字幕', '剪辑', '发布', '口播'],
    categoryHints: ['video_publish', 'account'],
  },
  {
    id: 'legal.case_filing_pack',
    label: '立案/法律材料包',
    kind: 'document',
    tools: ['legal_case_intake', 'legal_generate_litigation_packet', 'legal_prepare_filing_handoff', 'create_docx', 'create_pdf'],
    confirmationRequired: ['提交立案、签名、付款、正式法律意见前需要确认'],
    keywords: ['立案', '起诉', '法院', '律师', '诉讼', '证据', '仲裁', '案由', '保全', '法律'],
    categoryHints: ['legal_case'],
  },
  {
    id: 'result.visible_execution',
    label: '可见桌面执行和结果验证',
    kind: 'verification',
    tools: ['desktop_capture_screen', 'desktop_active_window', 'work_product_verify', 'work_takeover_task_verify_result', 'work_takeover_task_update'],
    confirmationRequired: ['外部软件写入、发送、提交、付款等动作按工具规则确认'],
    keywords: ['打开', '操作', '桌面', '验证', '结果', '交付', '文件', '外部软件'],
    always: true,
  },
];

const CATEGORY_CAPABILITY_HINTS: Partial<Record<WechatWorkCategory, string[]>> = {
  customer: ['document.proposal_packet', 'messaging.reply_handoff'],
  store: ['browser.account_platform_work', 'messaging.reply_handoff', 'document.proposal_packet'],
  account: ['browser.account_platform_work', 'video.content_publish_pack', 'document.proposal_packet'],
  legal_case: ['legal.case_filing_pack', 'messaging.reply_handoff'],
  video_publish: ['video.content_publish_pack', 'browser.account_platform_work', 'presentation.client_deck'],
  design_delivery: ['document.proposal_packet', 'presentation.client_deck', 'cad_bim.design_handoff', 'messaging.reply_handoff'],
  general_work: ['document.proposal_packet', 'messaging.reply_handoff'],
  personal: ['messaging.reply_handoff'],
};

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function unique(items: string[]): string[] {
  return Array.from(new Set(items.map(item => compact(item)).filter(Boolean)));
}

function includesKeyword(text: string, keyword: string): boolean {
  return text.toLowerCase().includes(keyword.toLowerCase());
}

function collectTaskText(task: WorkTakeoverTask): string {
  return [
    task.title,
    task.summary,
    task.sourceMessage,
    task.recommendedWorkflow,
    ...task.nextActions,
    ...task.allowedNow,
    ...task.confirmationRequired,
    ...task.blockedBy,
    ...task.risks,
    ...task.artifacts.map(artifact => `${artifact.label} ${artifact.type} ${artifact.content || ''}`),
    ...task.drafts.map(draft => draft.text),
  ].map(compact).filter(Boolean).join(' | ');
}

function categoryHintMatches(rule: CapabilityRule, category: WechatWorkCategory): boolean {
  return Boolean(rule.categoryHints?.includes(category) || CATEGORY_CAPABILITY_HINTS[category]?.includes(rule.id));
}

function workflowHintMatches(rule: CapabilityRule, workflow: string): boolean {
  const text = workflow.toLowerCase();
  return Boolean(rule.workflowHints?.some(hint => text.includes(hint.toLowerCase())));
}

function inferCapabilities(task: WorkTakeoverTask): WorkTakeoverCapabilitySelection[] {
  const haystack = collectTaskText(task);
  const selections: WorkTakeoverCapabilitySelection[] = [];

  for (const rule of CAPABILITY_RULES) {
    const matchedBy: string[] = [];
    if (rule.always) matchedBy.push('base-pattern');
    if (categoryHintMatches(rule, task.category)) matchedBy.push(`category:${task.category}`);
    if (workflowHintMatches(rule, task.recommendedWorkflow || '')) matchedBy.push(`workflow:${task.recommendedWorkflow}`);
    for (const keyword of rule.keywords) {
      if (includesKeyword(haystack, keyword)) matchedBy.push(`keyword:${keyword}`);
    }
    if (matchedBy.length === 0) continue;
    selections.push({
      id: rule.id,
      label: rule.label,
      kind: rule.kind,
      tools: rule.tools,
      confirmationRequired: rule.confirmationRequired,
      matchedBy: unique(matchedBy),
      reason: unique(matchedBy).slice(0, 4).join(', '),
    });
  }

  return selections;
}

function capabilityTools(capabilities: WorkTakeoverCapabilitySelection[]): string[] {
  return unique(capabilities.flatMap(capability => capability.tools));
}

function artifactsForTask(task: WorkTakeoverTask): string[] {
  const standard = getIndustryWorkStandard(task.category);
  return unique([
    ...task.artifacts.map(artifact => artifact.label),
    ...standard.deliverables,
  ]);
}

function findCapabilities(capabilities: WorkTakeoverCapabilitySelection[], kinds: WorkTakeoverCapabilitySelection['kind'][]): WorkTakeoverCapabilitySelection[] {
  return capabilities.filter(capability => kinds.includes(capability.kind));
}

function makeStep(
  id: string,
  title: string,
  goal: string,
  capabilities: WorkTakeoverCapabilitySelection[],
  expectedArtifacts: string[],
  status: WorkTakeoverExecutionStep['status'] = 'ready',
): WorkTakeoverExecutionStep | null {
  if (capabilities.length === 0) return null;
  const confirmationRequired = unique(capabilities.flatMap(capability => capability.confirmationRequired));
  return {
    id,
    title,
    goal,
    capabilityIds: capabilities.map(capability => capability.id),
    suggestedTools: capabilityTools(capabilities),
    expectedArtifacts: unique(expectedArtifacts),
    confirmationRequired,
    status: confirmationRequired.length && status === 'ready' ? 'confirmation_required' : status,
  };
}

function buildSteps(task: WorkTakeoverTask, capabilities: WorkTakeoverCapabilitySelection[], blockers: string[]): WorkTakeoverExecutionStep[] {
  const artifactLabels = artifactsForTask(task);
  const intake = findCapabilities(capabilities, ['intake']);
  const documents = findCapabilities(capabilities, ['document', 'automation']);
  const external = findCapabilities(capabilities, ['external_app']);
  const messaging = findCapabilities(capabilities, ['messaging']);
  const verification = findCapabilities(capabilities, ['verification']);

  const steps = [
    makeStep(
      'understand_context',
      '理解任务和确认边界',
      '把用户目标、客户上下文、可自动完成的部分、需要确认的部分拆清楚。',
      intake,
      ['任务摘要', '执行边界', '验收标准'],
      blockers.length ? 'blocked' : 'ready',
    ),
    makeStep(
      'prepare_artifacts',
      '准备核心交付物',
      '根据任务内容生成客户/项目需要的文件、清单、方案、报价、法律材料或内容包。',
      documents,
      artifactLabels.length ? artifactLabels : ['核心交付物草稿'],
    ),
    makeStep(
      'external_tool_handoff',
      '交给外部工具或桌面软件',
      '在确认边界内打开或交接到浏览器、CAD、办公软件、平台账号等外部工具；优先恢复已登录会话和任务栏中已运行的窗口，遇到扫码、验证码、首次登录或切换账号就停下。',
      external,
      artifactLabels.filter(label => /CAD|DXF|Revit|Dynamo|平台|账号|发布|店铺|订单|图纸/i.test(label)),
    ),
    makeStep(
      'communication_handoff',
      '准备对外沟通草稿',
      '生成微信或其他渠道的回复草稿，默认只准备和复制，不自动发送。',
      messaging,
      ['回复草稿', '待确认发送边界'],
    ),
    makeStep(
      'verify_and_record',
      '验证结果并回写任务中心',
      '检查交付物是否存在、外部窗口是否打开成功、回复草稿是否准备好，并把结果写回任务中心。',
      verification,
      ['验证记录', '下一步动作', '阻塞点'],
    ),
  ].filter(Boolean) as WorkTakeoverExecutionStep[];

  return steps;
}

function buildContextSignals(task: WorkTakeoverTask): string[] {
  const standard = getIndustryWorkStandard(task.category);
  const signals = [
    `category=${task.category}`,
    `industryStandard=${standard.label}`,
    `externalSurfaces=${standard.externalSurfaces.slice(0, 6).join(', ')}`,
    task.recommendedWorkflow ? `workflow=${task.recommendedWorkflow}` : '',
    task.contact ? `contact=${task.contact}` : '',
    task.urgency ? `urgency=${task.urgency}` : '',
    task.source ? `source=${task.source}` : '',
    task.artifacts.length ? `artifacts=${task.artifacts.map(a => a.label).slice(0, 6).join(', ')}` : '',
    task.allowedNow.length ? `allowedNow=${task.allowedNow.slice(0, 4).join(', ')}` : '',
    task.confirmationRequired.length ? `confirmationRequired=${task.confirmationRequired.slice(0, 4).join(', ')}` : '',
  ];
  return signals.map(compact).filter(Boolean);
}

function inferBlockers(task: WorkTakeoverTask): string[] {
  const blockers = [...task.blockedBy];
  if (task.category === 'unknown') blockers.push('任务类型不明确，需要先确认工作方向。');
  if (!task.summary && !task.sourceMessage && task.nextActions.length === 0) blockers.push('任务上下文不足，需要用户补充目标或原始消息。');
  return unique(blockers);
}

function buildVerificationChecklist(task: WorkTakeoverTask, capabilities: WorkTakeoverCapabilitySelection[]): string[] {
  const standard = getIndustryWorkStandard(task.category);
  const checklist = [
    '任务中心已有摘要、下一步动作、风险和确认边界。',
    '所有生成的文件/草稿/清单都已记录到任务 artifacts 或 result。',
    '对外发送、提交、付款、签约、发布和最终承诺没有越过确认边界。',
    ...standard.verificationFocus,
  ];
  if (capabilities.some(capability => capability.id === 'presentation.client_deck')) checklist.push('PPT/PDF 内容是客户任务内容，不是 Lumi 自我介绍话术。');
  if (capabilities.some(capability => capability.id === 'cad_bim.design_handoff')) checklist.push('CAD/Revit 结果以可审阅草稿或交接数据呈现，生产图纸仍需尺寸和专业复核。');
  if (capabilities.some(capability => capability.id === 'messaging.reply_handoff')) checklist.push('回复草稿已准备，但未自动发送。');
  if (capabilities.some(capability => capability.id === 'account.session_reuse')) checklist.push('已优先复用已登录账号窗口或浏览器会话；首次登录、扫码、验证码、切换账号和授权未自动完成。');
  if (capabilities.some(capability => capability.kind === 'external_app')) checklist.push('外部软件或平台操作完成后需要读取窗口/文件状态确认结果。');
  return unique(checklist);
}

function buildHandoffPrompt(task: WorkTakeoverTask, plan: Omit<WorkTakeoverExecutionPlan, 'handoffPrompt'>): string {
  const artifacts = artifactsForTask(task);
  const standard = getIndustryWorkStandard(task.category);
  return [
    `接管任务：${task.title}`,
    `目标：${plan.objective}`,
    `行业接管标准：${standard.label} - ${standard.objective}`,
    `外部系统优先：${standard.externalSurfaces.join('；')}`,
    `原则：不要播放固定脚本；根据当前任务内容、交付物、已安装工具和确认边界组织步骤。`,
    `账号原则：优先恢复任务栏/后台已有窗口和已登录浏览器会话；不要代替用户完成密码、扫码、验证码、人脸/短信验证、账号切换或授权。`,
    artifacts.length ? `要准备的交付物：${artifacts.join('；')}` : '',
    plan.nextStep ? `下一步：${plan.nextStep.title} - ${plan.nextStep.goal}` : '',
    plan.nextStep?.suggestedTools.length ? `优先工具：${plan.nextStep.suggestedTools.join(', ')}` : '',
    plan.confirmationRequired.length ? `确认边界：${plan.confirmationRequired.join('；')}` : '',
    plan.blockers.length ? `当前阻塞：${plan.blockers.join('；')}` : '',
  ].map(compact).filter(Boolean).join('\n');
}

function artifactTypeFromLabel(label: string, stepId: string): WorkTakeoverArtifact['type'] {
  if (/CAD|DXF|Revit|Dynamo|BIM|图纸/i.test(label)) return 'cad';
  if (/合同/i.test(label)) return 'contract';
  if (/报价|预算|价格/i.test(label)) return 'quote';
  if (/视频|脚本|标题|封面|发布/i.test(label)) return 'video';
  if (/回复|草稿|微信|消息/i.test(label)) return 'draft';
  if (/PPT|PDF|文档|方案|报告|材料|清单/i.test(label)) return 'document';
  if (stepId === 'verify_and_record' || /验证|边界|摘要|清单/i.test(label)) return 'checklist';
  return 'other';
}

function latestDraft(task: WorkTakeoverTask): WorkTakeoverDraft | undefined {
  return task.drafts[task.drafts.length - 1];
}

function executionHistory(task: WorkTakeoverTask): any[] {
  const history = task.metadata?.workTakeoverExecution?.history;
  return Array.isArray(history) ? history : [];
}

function executedStepIds(task: WorkTakeoverTask): string[] {
  return unique(executionHistory(task)
    .filter(item => item?.status !== 'blocked')
    .map(item => item?.step?.id || item?.stepId));
}

export function getWorkTakeoverExecutionProgress(
  task: WorkTakeoverTask,
  plan: Pick<WorkTakeoverExecutionPlan, 'steps'>,
): WorkTakeoverExecutionProgress {
  const executed = executedStepIds(task);
  const remaining = plan.steps
    .filter(step => step.status !== 'blocked' && !executed.includes(step.id))
    .map(step => step.id);
  const nextStep = plan.steps.find(step => step.id === remaining[0])
    || plan.steps.find(step => step.id === 'verify_and_record')
    || plan.steps.find(step => step.status !== 'blocked')
    || plan.steps[0];
  return {
    executedStepIds: executed,
    remainingStepIds: remaining,
    nextStep,
    complete: remaining.length === 0,
  };
}

function selectExecutionStep(task: WorkTakeoverTask, plan: WorkTakeoverExecutionPlan, stepId?: string): WorkTakeoverExecutionStep {
  const byId = stepId ? plan.steps.find(step => step.id === stepId) : undefined;
  return byId || getWorkTakeoverExecutionProgress(task, plan).nextStep || plan.nextStep || plan.steps[0];
}

function toolReasons(step: WorkTakeoverExecutionStep): Array<{ name: string; reason: string }> {
  return step.suggestedTools.map(name => ({
    name,
    reason: `${step.title}：${step.goal}`,
  }));
}

function buildExecutionArtifactContent(
  task: WorkTakeoverTask,
  plan: WorkTakeoverExecutionPlan,
  step: WorkTakeoverExecutionStep,
  label: string,
): string {
  return [
    `任务：${task.title}`,
    `目标：${plan.objective}`,
    `当前步骤：${step.title}`,
    `步骤目的：${step.goal}`,
    step.suggestedTools.length ? `建议工具：${step.suggestedTools.join(', ')}` : '',
    step.confirmationRequired.length ? `确认边界：${step.confirmationRequired.join('；')}` : '',
    plan.verificationChecklist.length ? `验收检查：${plan.verificationChecklist.join('；')}` : '',
    `说明：这是任务接管执行准备记录，不代表已经对外发送、提交、发布、付款或形成最终承诺。`,
    `交付项：${label}`,
  ].map(compact).filter(Boolean).join('\n');
}

function buildStepArtifacts(
  task: WorkTakeoverTask,
  plan: WorkTakeoverExecutionPlan,
  step: WorkTakeoverExecutionStep,
): WorkTakeoverStepExecutionArtifact[] {
  if (step.id === 'understand_context') {
    return [{
      type: 'checklist',
      label: '任务接管执行摘要',
      status: 'prepared',
      content: [
        `任务：${task.title}`,
        `目标：${plan.objective}`,
        plan.contextSignals.length ? `上下文信号：${plan.contextSignals.join('；')}` : '',
        plan.safeActions.length ? `可先做：${plan.safeActions.join('；')}` : '',
        plan.confirmationRequired.length ? `确认边界：${plan.confirmationRequired.join('；')}` : '',
        plan.verificationChecklist.length ? `验收检查：${plan.verificationChecklist.join('；')}` : '',
      ].map(compact).filter(Boolean).join('\n'),
    }];
  }

  if (step.id === 'verify_and_record') {
    return [{
      type: 'checklist',
      label: '任务结果验证清单',
      status: 'needs_review',
      content: plan.verificationChecklist.map(item => `- ${item}`).join('\n'),
    }];
  }

  const labels = step.expectedArtifacts.length ? step.expectedArtifacts : [`${step.title}准备记录`];
  return labels.slice(0, 8).map(label => ({
    type: artifactTypeFromLabel(label, step.id),
    label,
    status: step.confirmationRequired.length ? 'needs_review' : 'prepared',
    content: buildExecutionArtifactContent(task, plan, step, label),
  }));
}

function buildDraftForStep(task: WorkTakeoverTask, plan: WorkTakeoverExecutionPlan, step: WorkTakeoverExecutionStep): string | undefined {
  if (step.id !== 'communication_handoff') return undefined;
  const existing = latestDraft(task)?.text;
  if (existing) return existing;
  const contactPrefix = task.contact ? `${task.contact}，` : '';
  return [
    `${contactPrefix}收到，我先把这件事整理成可推进的工作任务。`,
    plan.nextStep ? `我会先处理：${plan.nextStep.title}。` : '',
    plan.confirmationRequired.length ? '涉及发送、提交、付款、签约、发布或最终承诺的部分，我会先确认后再执行。' : '',
  ].map(compact).filter(Boolean).join('');
}

export function executeWorkTakeoverPlanStep(
  task: WorkTakeoverTask,
  plan: WorkTakeoverExecutionPlan,
  options: { stepId?: string } = {},
): WorkTakeoverStepExecutionResult {
  const step = selectExecutionStep(task, plan, options.stepId);
  const blockers = unique([...plan.blockers, ...(step.status === 'blocked' ? [`步骤被阻塞：${step.title}`] : [])]);
  const stepConfirmationRequired = unique(step.confirmationRequired);
  const confirmationRequired = unique([...step.confirmationRequired, ...plan.confirmationRequired]);
  const status: WorkTakeoverStepExecutionResult['status'] =
    blockers.length ? 'blocked' :
    stepConfirmationRequired.length ? 'waiting_confirmation' :
    'prepared';
  const artifacts = buildStepArtifacts(task, plan, step);
  const draftReply = buildDraftForStep(task, plan, step);
  const suggestedToolCalls = toolReasons(step);
  const summary = status === 'blocked'
    ? `步骤“${step.title}”暂时阻塞：${blockers.join('；')}`
    : status === 'waiting_confirmation'
    ? `步骤“${step.title}”已经准备好，下一步涉及确认边界：${confirmationRequired.slice(0, 4).join('；')}`
    : `步骤“${step.title}”已经完成安全准备。`;

  return {
    executionId: `wt_exec_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    executedAt: new Date().toISOString(),
    taskId: task.id,
    planId: plan.planId,
    step,
    status,
    summary,
    artifacts,
    draftReply,
    suggestedToolCalls,
    confirmationRequired,
    blockers,
    nextInstruction: [
      summary,
      suggestedToolCalls.length ? `建议继续工具：${suggestedToolCalls.map(call => call.name).join(', ')}` : '',
      confirmationRequired.length ? `需要确认：${confirmationRequired.join('；')}` : '',
      '不要把准备记录当成最终交付；真实文件、外部软件操作和对外动作仍按工具执行与确认边界推进。',
    ].map(compact).filter(Boolean).join('\n'),
  };
}

export function planWorkTakeoverExecution(
  task: WorkTakeoverTask,
  options: { mode?: WorkTakeoverExecutionMode } = {},
): WorkTakeoverExecutionPlan {
  const mode = options.mode || 'prepare_work';
  const standard = getIndustryWorkStandard(task.category);
  const capabilities = inferCapabilities(task);
  const blockers = inferBlockers(task);
  const steps = buildSteps(task, capabilities, blockers);
  const nextStep = getWorkTakeoverExecutionProgress(task, { steps }).nextStep || steps[0];
  const safeActions = unique([
    '结构化任务上下文',
    '准备草稿和文件',
    '更新任务中心状态',
    ...standard.safeLoop,
    ...capabilities
      .filter(capability => capability.confirmationRequired.length === 0)
      .flatMap(capability => capability.tools),
  ]);
  const confirmationRequired = unique([
    ...task.confirmationRequired,
    ...standard.confirmationBoundaries.map(item => `${standard.label}边界：${item}`),
    ...capabilities.flatMap(capability => capability.confirmationRequired),
  ]);

  const basePlan: Omit<WorkTakeoverExecutionPlan, 'handoffPrompt'> = {
    planId: `wt_plan_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    generatedAt: new Date().toISOString(),
    taskId: task.id,
    category: task.category,
    mode,
    objective: task.summary || task.sourceMessage || task.title,
    contextSignals: buildContextSignals(task),
    capabilities,
    steps,
    nextStep,
    safeActions,
    confirmationRequired,
    blockers,
    verificationChecklist: buildVerificationChecklist(task, capabilities),
  };

  return {
    ...basePlan,
    handoffPrompt: buildHandoffPrompt(task, basePlan),
  };
}
