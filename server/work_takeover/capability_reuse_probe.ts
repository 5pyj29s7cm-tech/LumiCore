import {
  executeWorkTakeoverPlanStep,
  getWorkTakeoverExecutionProgress,
  planWorkTakeoverExecution,
  type WorkTakeoverCapabilitySelection,
  type WorkTakeoverExecutionMode,
  type WorkTakeoverExecutionPlan,
  type WorkTakeoverStepExecutionResult,
} from './execution_planner';
import { analyzeWechatIntake, type WechatIntakeResult } from './wechat_intake';
import {
  createWorkTakeoverTaskFromWechatIntake,
  getWorkTakeoverTask,
  listWorkTakeoverTasks,
  updateWorkTakeoverTask,
  type WorkTakeoverStatus,
  type WorkTakeoverTask,
} from './tasks';
import { exportWorkTakeoverPacket, type WorkTakeoverPacket } from './task_packet';
import {
  packageKindForCategory,
  prepareWorkTakeoverIndustryPackage,
  type WorkTakeoverIndustryPackageResult,
} from './industry_packages';
import { verifyWorkTakeoverResult, type WorkTakeoverResultVerification } from './result_verifier';
import { buildSelfExtensionPlan, type SelfExtensionPlan } from '../self_extension/pipeline';
import type { ToolDefinition } from '../tools/types';

export interface WorkTakeoverCapabilityReuseProbeOptions {
  userId: string;
  domain?: string;
  orgId?: string;
  id?: string;
  message?: string;
  fromClipboard?: boolean;
  contact?: string;
  source?: string;
  takeoverMode?: string;
  userRules?: string;
  title?: string;
  maxSteps?: number;
  mode?: WorkTakeoverExecutionMode;
  runSafeLoop?: boolean;
  stopOnConfirmation?: boolean;
  prepareIndustryPackage?: boolean;
  regenerateIndustryPackage?: boolean;
  exportPacket?: boolean;
  outputDirectory?: string;
  record?: boolean;
  tools?: ToolDefinition[];
  desktopRelay?: (name: string, args: Record<string, any>) => Promise<string>;
}

export interface CapabilityReuseAuditItem {
  capabilityId: string;
  label: string;
  kind: WorkTakeoverCapabilitySelection['kind'];
  suggestedTools: string[];
  availableSuggestedTools: string[];
  decision: SelfExtensionPlan['resolution']['decision'];
  primarySource: SelfExtensionPlan['resolution']['primarySource'];
  shouldCreateNewCapability: boolean;
  verdict: 'reuse_learned_route' | 'reuse_existing_coverage' | 'needs_capability_work';
  duplicateRisk: 'low' | 'medium' | 'high';
  reason: string;
  preferredTools: string[];
  coverage: {
    learnedCapabilities: number;
    adapters: number;
    tools: number;
    installedSkills: number;
    marketplaceSkills: number;
  };
}

export interface CapabilityReuseAuditSummary {
  totalCapabilities: number;
  reusedCapabilities: number;
  learnedRouteReuses: number;
  existingCoverageReuses: number;
  needsCapabilityWork: number;
  duplicateRiskCount: number;
  generatedNewCapability: false;
  stableEnoughForTaskRun: boolean;
  recommendation: string;
}

export interface CapabilityReuseProbeReport {
  humanSummary: string;
  done: string[];
  blockers: string[];
  nextConfirmations: string[];
  reuseSummary: CapabilityReuseAuditSummary;
}

export interface WorkTakeoverCapabilityReuseProbeResult {
  intake?: WechatIntakeResult;
  createdTask: boolean;
  task: WorkTakeoverTask;
  plan: WorkTakeoverExecutionPlan;
  progress: ReturnType<typeof getWorkTakeoverExecutionProgress>;
  capabilityReuseAudit: {
    items: CapabilityReuseAuditItem[];
    summary: CapabilityReuseAuditSummary;
  };
  executions: WorkTakeoverStepExecutionResult[];
  industryPackage?: WorkTakeoverIndustryPackageResult;
  packet?: WorkTakeoverPacket;
  verification: WorkTakeoverResultVerification;
  report: CapabilityReuseProbeReport;
  note: string;
}

function compact(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map(compact).filter(Boolean)));
}

function executionMode(value: unknown): WorkTakeoverExecutionMode {
  return ['plan_only', 'prepare_work', 'visible_external_work'].includes(String(value || ''))
    ? String(value) as WorkTakeoverExecutionMode
    : 'prepare_work';
}

function toolNames(tools: ToolDefinition[] = []): string[] {
  return tools.map(tool => tool.name);
}

function capabilityDomain(capability: WorkTakeoverCapabilitySelection): string | undefined {
  const text = `${capability.id} ${capability.label} ${capability.tools.join(' ')}`;
  if (/cad|bim|revit|dxf|图纸|装修/i.test(text)) return 'cad_bim';
  if (/wechat|message|reply|微信|消息|回复|客服/i.test(text)) return 'messaging';
  if (/legal|case|filing|立案|法律|法院/i.test(text)) return 'legal';
  if (/ppt|pdf|doc|document|proposal|文档|方案|汇报|报价/i.test(text)) return 'files';
  return undefined;
}

function capabilityGoal(task: WorkTakeoverTask, capability: WorkTakeoverCapabilitySelection): string {
  return [
    `Capability: ${capability.label} (${capability.id})`,
    `Task category: ${task.category}`,
    `Task title: ${task.title}`,
    task.summary ? `Task summary: ${task.summary}` : '',
    task.sourceMessage ? `Source message: ${task.sourceMessage}` : '',
    capability.tools.length ? `Suggested tools: ${capability.tools.join(', ')}` : '',
    capability.confirmationRequired.length ? `Confirmation boundaries: ${capability.confirmationRequired.join('；')}` : '',
  ].map(compact).filter(Boolean).join('\n').slice(0, 2500);
}

function auditCapability(
  userId: string,
  task: WorkTakeoverTask,
  capability: WorkTakeoverCapabilitySelection,
  tools: ToolDefinition[],
): CapabilityReuseAuditItem {
  const names = toolNames(tools);
  const plan = buildSelfExtensionPlan({
    userId,
    scopeDomain: task.domain === 'work' && task.orgId ? 'work' : 'personal',
    orgId: task.domain === 'work' ? task.orgId : '',
    goal: capabilityGoal(task, capability),
    domain: capabilityDomain(capability),
    tools,
  });
  const availableSuggestedTools = capability.tools.filter(name => names.includes(name));
  const shouldCreateNewCapability = plan.resolution.shouldCreateNewCapability;
  const verdict: CapabilityReuseAuditItem['verdict'] =
    plan.resolution.decision === 'reuse_learned_route' ? 'reuse_learned_route'
      : !shouldCreateNewCapability ? 'reuse_existing_coverage'
      : 'needs_capability_work';
  const duplicateRisk: CapabilityReuseAuditItem['duplicateRisk'] =
    !shouldCreateNewCapability ? 'low'
      : availableSuggestedTools.length ? 'high'
      : plan.existingCoverage.adapters.length || plan.existingCoverage.tools.length || plan.existingCoverage.learnedCapabilities.length ? 'medium'
      : 'low';

  return {
    capabilityId: capability.id,
    label: capability.label,
    kind: capability.kind,
    suggestedTools: capability.tools,
    availableSuggestedTools,
    decision: plan.resolution.decision,
    primarySource: plan.resolution.primarySource,
    shouldCreateNewCapability,
    verdict,
    duplicateRisk,
    reason: plan.resolution.reason,
    preferredTools: plan.resolution.preferredTools,
    coverage: {
      learnedCapabilities: plan.existingCoverage.learnedCapabilities.length,
      adapters: plan.existingCoverage.adapters.length,
      tools: plan.existingCoverage.tools.length,
      installedSkills: plan.existingCoverage.installedSkills.length,
      marketplaceSkills: plan.existingCoverage.marketplaceSkills.length,
    },
  };
}

function summarizeAudit(items: CapabilityReuseAuditItem[]): CapabilityReuseAuditSummary {
  const learnedRouteReuses = items.filter(item => item.verdict === 'reuse_learned_route').length;
  const existingCoverageReuses = items.filter(item => item.verdict === 'reuse_existing_coverage').length;
  const needsCapabilityWork = items.filter(item => item.verdict === 'needs_capability_work').length;
  const duplicateRiskCount = items.filter(item => item.duplicateRisk === 'high' || item.duplicateRisk === 'medium').length;
  const stableEnoughForTaskRun = items.length > 0 && needsCapabilityWork === 0 && duplicateRiskCount === 0;
  return {
    totalCapabilities: items.length,
    reusedCapabilities: learnedRouteReuses + existingCoverageReuses,
    learnedRouteReuses,
    existingCoverageReuses,
    needsCapabilityWork,
    duplicateRiskCount,
    generatedNewCapability: false,
    stableEnoughForTaskRun,
    recommendation: stableEnoughForTaskRun
      ? 'This task can run through existing Lumi capabilities. Do not generate a new tool or core route.'
      : 'Review capability gaps before adding code. Prefer fixing route matching or using existing suggested tools before creating new capability records.',
  };
}

function buildCapabilityReuseAudit(
  userId: string,
  task: WorkTakeoverTask,
  plan: WorkTakeoverExecutionPlan,
  tools: ToolDefinition[],
): { items: CapabilityReuseAuditItem[]; summary: CapabilityReuseAuditSummary } {
  const items = plan.capabilities.map(capability => auditCapability(userId, task, capability, tools));
  return { items, summary: summarizeAudit(items) };
}

function executionHistory(task: WorkTakeoverTask, execution: WorkTakeoverStepExecutionResult): any[] {
  const current = task?.metadata?.workTakeoverExecution?.history;
  return [...(Array.isArray(current) ? current.slice(-20) : []), execution];
}

function recordStepExecution(
  userId: string,
  task: WorkTakeoverTask,
  plan: WorkTakeoverExecutionPlan,
  execution: WorkTakeoverStepExecutionResult,
): WorkTakeoverTask {
  let updatedTask = updateWorkTakeoverTask(userId, task.id, {
    status: execution.status === 'blocked'
      ? 'blocked'
      : execution.status === 'waiting_confirmation'
      ? 'waiting_confirmation'
      : 'in_progress',
    allowedNow: uniqueStrings([...task.allowedNow, ...plan.safeActions]),
    confirmationRequired: uniqueStrings([...task.confirmationRequired, ...execution.confirmationRequired]),
    blockedBy: execution.blockers.length ? uniqueStrings([...task.blockedBy, ...execution.blockers]) : undefined,
    result: execution.nextInstruction,
    metadata: {
      workTakeoverExecution: {
        lastPlan: plan,
        lastExecution: execution,
        history: executionHistory(task, execution),
        updatedAt: execution.executedAt,
      },
    },
    note: execution.summary,
  } as any) || task;

  for (const artifact of execution.artifacts) {
    updatedTask = updateWorkTakeoverTask(userId, updatedTask.id, {
      artifact,
    } as any) || updatedTask;
  }

  if (execution.draftReply && !updatedTask.drafts.some(draft => draft.text === execution.draftReply)) {
    updatedTask = updateWorkTakeoverTask(userId, updatedTask.id, {
      draftReply: execution.draftReply,
    } as any) || updatedTask;
  }

  return updatedTask;
}

function recordPacket(
  userId: string,
  task: WorkTakeoverTask,
  plan: WorkTakeoverExecutionPlan,
  packet: WorkTakeoverPacket,
): WorkTakeoverTask {
  return updateWorkTakeoverTask(userId, task.id, {
    status: task.status === 'queued' ? 'in_progress' : task.status,
    artifact: {
      type: 'file',
      label: '工作接管任务包',
      path: packet.folderPath,
      content: packet.summary,
      status: 'prepared',
    },
    metadata: {
      workTakeoverExecution: {
        ...(task.metadata?.workTakeoverExecution || {}),
        lastPlan: plan,
        updatedAt: packet.createdAt,
      },
      workTakeoverPacket: packet,
    },
    note: packet.summary,
  } as any) || task;
}

function expectedContentTerms(task: WorkTakeoverTask): string[] {
  const params = task.metadata?.industryParameters;
  return uniqueStrings([
    ...(Array.isArray(params?.expectedContentTerms) ? params.expectedContentTerms : []),
    task.contact,
    task.category === 'design_delivery' ? '装修' : undefined,
    ['store', 'account', 'video_publish'].includes(task.category) ? '内容' : undefined,
    ['store', 'account', 'video_publish'].includes(task.category) ? '发布' : undefined,
    task.category === 'legal_case' ? '立案' : undefined,
  ]);
}

function requiredArtifactLabels(task: WorkTakeoverTask): string[] {
  const params = task.metadata?.industryParameters;
  const packageKind = packageKindForCategory(task.category);
  return uniqueStrings([
    ...(Array.isArray(params?.requiredArtifactLabels) ? params.requiredArtifactLabels : []),
    packageKind === 'design_delivery' ? '装修设计交付包' : undefined,
    packageKind === 'ecommerce_growth' ? '电商/短视频接管交付包' : undefined,
    '工作接管任务包',
  ]);
}

function buildHumanReport(input: {
  audit: { items: CapabilityReuseAuditItem[]; summary: CapabilityReuseAuditSummary };
  executions: WorkTakeoverStepExecutionResult[];
  verification: WorkTakeoverResultVerification;
  task: WorkTakeoverTask;
  packet?: WorkTakeoverPacket;
  industryPackage?: WorkTakeoverIndustryPackageResult;
}): CapabilityReuseProbeReport {
  const done = uniqueStrings([
    `审计 ${input.audit.summary.totalCapabilities} 个任务能力`,
    `复用 ${input.audit.summary.reusedCapabilities} 个已有能力路线`,
    input.executions.length ? `安全推进 ${input.executions.length} 步` : '完成计划级压测',
    input.industryPackage ? (input.industryPackage.reused ? '复用已有行业交付包' : '生成本地行业交付包') : undefined,
    input.packet ? '导出本地任务包' : undefined,
    input.verification.passed ? '结果验证通过' : '完成结果验证并标出待复核项',
  ]);
  const blockers = uniqueStrings([
    ...input.verification.blockers,
    ...input.audit.items
      .filter(item => item.verdict === 'needs_capability_work')
      .map(item => `${item.label}：${item.reason}`),
  ]).slice(0, 8);
  const nextConfirmations = uniqueStrings(input.task.confirmationRequired).slice(0, 8);
  const reuseLine = input.audit.summary.stableEnoughForTaskRun
    ? '能力复用稳定：这次没有生成新能力，也没有发现明显重复路线。'
    : `能力复用待复核：${input.audit.summary.needsCapabilityWork} 个能力还需要处理，${input.audit.summary.duplicateRiskCount} 个能力有重复风险。`;
  const humanSummary = [
    `我已经跑完能力复用压测：${reuseLine}`,
    `已完成：${done.slice(0, 5).join('、')}。`,
    blockers.length ? `卡点：${blockers.slice(0, 3).join('；')}。` : '',
    nextConfirmations.length ? `下一步需要你确认：${nextConfirmations.slice(0, 4).join('；')}。` : '下一步没有对外动作确认项。',
  ].map(compact).filter(Boolean).join('\n');

  return {
    humanSummary,
    done,
    blockers,
    nextConfirmations,
    reuseSummary: input.audit.summary,
  };
}

function renderProbeRecord(input: {
  report: CapabilityReuseProbeReport;
  audit: { items: CapabilityReuseAuditItem[]; summary: CapabilityReuseAuditSummary };
  executions: WorkTakeoverStepExecutionResult[];
  verification: WorkTakeoverResultVerification;
}): string {
  return [
    input.report.humanSummary,
    '',
    '## 能力复用审计',
    input.audit.items.map(item => [
      `- ${item.label}：${item.verdict}`,
      `decision=${item.decision}`,
      `source=${item.primarySource}`,
      `duplicateRisk=${item.duplicateRisk}`,
      item.preferredTools.length ? `preferred=${item.preferredTools.slice(0, 6).join(', ')}` : '',
    ].filter(Boolean).join('；')).join('\n') || '- 暂无能力项',
    '',
    '## 安全推进',
    input.executions.map(item => `- ${item.step.title}：${item.status}，${item.summary}`).join('\n') || '- 未推进具体步骤',
    '',
    '## 验证结果',
    `- ${input.verification.summary}`,
    ...input.verification.checks.map(item => `- ${item.passed ? '通过' : '待复核'}：${item.label} - ${item.detail}`),
  ].join('\n').trim();
}

async function resolveTask(options: WorkTakeoverCapabilityReuseProbeOptions): Promise<{
  task: WorkTakeoverTask;
  intake?: WechatIntakeResult;
  createdTask: boolean;
}> {
  const userId = options.userId || 'anonymous';
  const domain = options.domain || 'personal';
  const orgId = options.orgId || '';
  let task = options.id ? getWorkTakeoverTask(userId, String(options.id)) : null;
  let message = compact(options.message);

  if (!task && options.fromClipboard === true) {
    if (!options.desktopRelay) throw new Error('Capability reuse probe from clipboard requires the Lumi desktop client relay.');
    message = compact(await options.desktopRelay('desktop_clipboard_read', {}) || '');
    if (!message) throw new Error('Clipboard is empty. Copy the customer/WeChat message first.');
  }

  if (!task && message) {
    const intake = analyzeWechatIntake({
      message,
      contact: options.contact,
      source: options.source || (options.fromClipboard ? 'clipboard' : 'manual'),
      takeoverMode: options.takeoverMode ? options.takeoverMode as any : 'auto',
      userRules: options.userRules,
    });
    task = createWorkTakeoverTaskFromWechatIntake(userId, intake, {
      domain,
      orgId,
      sourceMessage: message,
      title: options.title,
    });
    return { task, intake, createdTask: true };
  }

  if (!task) {
    task = listWorkTakeoverTasks({ userId, domain, orgId, status: 'active', limit: 1 })[0] || null;
  }
  if (!task) throw new Error('No work takeover task found. Provide id, message, fromClipboard, or create a task first.');
  return { task, createdTask: false };
}

export async function runWorkTakeoverCapabilityReuseProbe(
  options: WorkTakeoverCapabilityReuseProbeOptions,
): Promise<WorkTakeoverCapabilityReuseProbeResult> {
  const userId = options.userId || 'anonymous';
  const mode = executionMode(options.mode);
  const shouldRecord = options.record !== false;
  const runSafeLoop = options.runSafeLoop !== false;
  const stopOnConfirmation = options.stopOnConfirmation !== false;
  const maxSteps = Math.max(0, Math.min(Number(options.maxSteps) || 2, 5));
  const { task, intake, createdTask } = await resolveTask(options);

  let currentTask = task;
  let plan = planWorkTakeoverExecution(currentTask, { mode });
  let progress = getWorkTakeoverExecutionProgress(currentTask, plan);
  const executions: WorkTakeoverStepExecutionResult[] = [];

  if (runSafeLoop) {
    for (let i = 0; i < maxSteps; i++) {
      plan = planWorkTakeoverExecution(currentTask, { mode });
      progress = getWorkTakeoverExecutionProgress(currentTask, plan);
      if (progress.complete) break;
      const execution = executeWorkTakeoverPlanStep(currentTask, plan, {
        stepId: progress.nextStep?.id,
      });
      executions.push(execution);
      if (shouldRecord) currentTask = recordStepExecution(userId, currentTask, plan, execution);
      if (execution.status === 'blocked') break;
      if (stopOnConfirmation && execution.status === 'waiting_confirmation') break;
    }
  }

  let industryPackage: WorkTakeoverIndustryPackageResult | undefined;
  const packageKind = packageKindForCategory(currentTask.category);
  if (shouldRecord && options.prepareIndustryPackage !== false && packageKind) {
    industryPackage = prepareWorkTakeoverIndustryPackage(userId, currentTask, {
      outputDirectory: options.outputDirectory,
      regenerate: options.regenerateIndustryPackage === true,
      kind: packageKind,
    });
    currentTask = industryPackage.task;
  }

  plan = planWorkTakeoverExecution(currentTask, { mode });
  progress = getWorkTakeoverExecutionProgress(currentTask, plan);

  let packet: WorkTakeoverPacket | undefined;
  if (shouldRecord && options.exportPacket !== false) {
    packet = exportWorkTakeoverPacket(currentTask, { outputDirectory: options.outputDirectory, plan });
    currentTask = recordPacket(userId, currentTask, plan, packet);
    plan = planWorkTakeoverExecution(currentTask, { mode });
    progress = getWorkTakeoverExecutionProgress(currentTask, plan);
  }

  const capabilityReuseAudit = buildCapabilityReuseAudit(userId, currentTask, plan, options.tools || []);
  const verification = verifyWorkTakeoverResult(currentTask, {
    filePaths: uniqueStrings([packet?.folderPath, industryPackage?.files?.folder]),
    requiredArtifactLabels: requiredArtifactLabels(currentTask),
    expectedContentTerms: expectedContentTerms(currentTask),
    draftRequired: /微信|WeChat|weixin|消息|回复|客服|客户/i.test(`${currentTask.title} ${currentTask.summary} ${currentTask.sourceMessage}`),
    requireScreenEvidence: false,
    requireActiveWindow: false,
  });
  const report = buildHumanReport({
    audit: capabilityReuseAudit,
    executions,
    verification,
    task: currentTask,
    packet,
    industryPackage,
  });

  if (shouldRecord) {
    const status: WorkTakeoverStatus = verification.status === 'blocked'
      ? 'blocked'
      : verification.status === 'needs_review' || report.nextConfirmations.length > 0
      ? 'waiting_confirmation'
      : currentTask.status === 'queued'
      ? 'in_progress'
      : currentTask.status;
    currentTask = updateWorkTakeoverTask(userId, currentTask.id, {
      status,
      result: report.humanSummary,
      blockedBy: verification.status === 'blocked'
        ? uniqueStrings([...currentTask.blockedBy, ...verification.blockers])
        : undefined,
      artifact: {
        type: 'checklist',
        label: '能力复用压测记录',
        content: renderProbeRecord({
          report,
          audit: capabilityReuseAudit,
          executions,
          verification,
        }),
        status: capabilityReuseAudit.summary.stableEnoughForTaskRun && verification.status !== 'blocked'
          ? 'prepared'
          : 'needs_review',
      },
      metadata: {
        workTakeoverCapabilityReuseProbe: {
          mode,
          executions,
          capabilityReuseAudit,
          industryPackage: industryPackage ? {
            kind: industryPackage.kind,
            reused: industryPackage.reused,
            files: industryPackage.files,
            note: industryPackage.note,
          } : undefined,
          packet,
          verification,
          report,
          updatedAt: new Date().toISOString(),
        },
      },
      note: report.humanSummary,
    } as any) || currentTask;
  }

  return {
    intake,
    createdTask,
    task: currentTask,
    plan,
    progress,
    capabilityReuseAudit,
    executions,
    industryPackage,
    packet,
    verification,
    report,
    note: 'Capability reuse probe finished. It did not generate new capability records; review capabilityReuseAudit before adding tools or core code.',
  };
}
