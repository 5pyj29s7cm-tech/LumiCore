import { resolveWorkTakeoverIntakeTask } from './intake';
import { boundedWorkTakeoverSteps, runWorkTakeoverPreparation } from './preparation_loop';
import { recordWorkTakeoverPacket } from './packet_recording';
import { getWorkTakeoverExecutionProgress, planWorkTakeoverExecution, normalizeWorkTakeoverExecutionMode, type WorkTakeoverCapabilitySelection, type WorkTakeoverExecutionMode, type WorkTakeoverExecutionPlan, type WorkTakeoverStepExecutionResult } from './execution_planner';
import { type WechatIntakeResult } from './wechat_intake';
import { updateWorkTakeoverTask, type WorkTakeoverStatus, type WorkTakeoverTask } from './tasks';
import { exportWorkTakeoverPacket, type WorkTakeoverPacket } from './task_packet';
import { verifyWorkTakeoverResult, type WorkTakeoverResultVerification } from './result_verifier';
import { buildSelfExtensionPlan, type SelfExtensionPlan } from '../self_extension/pipeline';
import type { CapabilityManifestEntry, ToolDefinition } from '../tools/types';

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
  exportPacket?: boolean;
  outputDirectory?: string;
  record?: boolean;
  tools?: ToolDefinition[];
  capabilityManifest?: CapabilityManifestEntry[];
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
  capabilityManifest?: CapabilityManifestEntry[],
): CapabilityReuseAuditItem {
  const names = toolNames(tools);
  const plan = buildSelfExtensionPlan({
    userId,
    scopeDomain: task.domain === 'work' && task.orgId ? 'work' : 'personal',
    orgId: task.domain === 'work' ? task.orgId : '',
    goal: capabilityGoal(task, capability),
    domain: capabilityDomain(capability),
    tools,
    capabilityManifest,
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
  capabilityManifest?: CapabilityManifestEntry[],
): { items: CapabilityReuseAuditItem[]; summary: CapabilityReuseAuditSummary } {
  const items = plan.capabilities.map(capability => auditCapability(
    userId,
    task,
    capability,
    tools,
    capabilityManifest,
  ));
  return { items, summary: summarizeAudit(items) };
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

function requiredProbeArtifactLabels(): string[] {
  // A capability probe validates coordination only. Domain deliverables must be
  // produced and verified by their real tools, outside this safe local loop.
  return ['工作接管任务包'];
}

function buildHumanReport(input: {
  audit: { items: CapabilityReuseAuditItem[]; summary: CapabilityReuseAuditSummary };
  executions: WorkTakeoverStepExecutionResult[];
  verification: WorkTakeoverResultVerification;
  task: WorkTakeoverTask;
  packet?: WorkTakeoverPacket;
}): CapabilityReuseProbeReport {
  const done = uniqueStrings([
    `审计 ${input.audit.summary.totalCapabilities} 个任务能力`,
    `复用 ${input.audit.summary.reusedCapabilities} 个已有能力路线`,
    input.executions.length ? `安全推进 ${input.executions.length} 步` : '完成计划级压测',
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

export async function runWorkTakeoverCapabilityReuseProbe(
  options: WorkTakeoverCapabilityReuseProbeOptions,
): Promise<WorkTakeoverCapabilityReuseProbeResult> {
  const userId = options.userId || 'anonymous';
  const mode = normalizeWorkTakeoverExecutionMode(options.mode);
  const shouldRecord = options.record !== false;
  const maxSteps = options.runSafeLoop === false ? 0 : boundedWorkTakeoverSteps(options.maxSteps, 2, 5);
  const { task, intake, createdTask } = await resolveWorkTakeoverIntakeTask({ userId, domain: options.domain || 'personal', orgId: options.orgId || '' }, options, options.desktopRelay, 'Capability reuse probe from clipboard');
  const preparation = runWorkTakeoverPreparation(task, { mode, maxSteps, record: shouldRecord, stopOnConfirmation: options.stopOnConfirmation !== false });
  let currentTask = preparation.task;
  let { plan, progress } = preparation;
  const { executions } = preparation;

  let packet: WorkTakeoverPacket | undefined;
  if (shouldRecord && options.exportPacket !== false) {
    packet = exportWorkTakeoverPacket(currentTask, { outputDirectory: options.outputDirectory, plan });
    currentTask = recordWorkTakeoverPacket(userId, currentTask, plan, packet);
    plan = planWorkTakeoverExecution(currentTask, { mode });
    progress = getWorkTakeoverExecutionProgress(currentTask, plan);
  }

  const capabilityReuseAudit = buildCapabilityReuseAudit(
    userId,
    currentTask,
    plan,
    options.tools || [],
    options.capabilityManifest,
  );
  const verification = verifyWorkTakeoverResult(currentTask, {
    filePaths: uniqueStrings([
      packet?.folderPath,
      ...(packet?.files.map(file => file.path) || []),
    ]),
    requiredArtifactLabels: requiredProbeArtifactLabels(),
    expectedContentTerms: expectedContentTerms(currentTask),
    draftRequired: /微信|WeChat|weixin|消息|回复|客服|客户/i.test(`${currentTask.title} ${currentTask.summary} ${currentTask.sourceMessage}`),
    requireScreenEvidence: false,
    requireActiveWindow: false,
    requireExternalOutcome: false,
  });
  const report = buildHumanReport({
    audit: capabilityReuseAudit,
    executions,
    verification,
    task: currentTask,
    packet,
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
    packet,
    verification,
    report,
    note: 'Capability reuse probe finished. It did not generate new capability records; review capabilityReuseAudit before adding tools or core code.',
  };
}