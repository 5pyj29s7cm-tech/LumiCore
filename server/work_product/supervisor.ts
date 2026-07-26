import fs from 'fs';
import os from 'os';
import path from 'path';
import { readDB, writeDB } from '../../db_layer';

export type DeliverableType =
  | 'document'
  | 'drawing'
  | 'code'
  | 'design'
  | 'music'
  | 'meeting_report'
  | 'client_action'
  | 'research'
  | 'data'
  | 'general';

export type VerificationStatus = 'pass' | 'partial' | 'fail' | 'blocked';

export interface WorkProductPlan {
  id: string;
  userId: string;
  task: string;
  deliverableType: DeliverableType;
  finalOutput: string;
  acceptanceCriteria: string[];
  checkpoints: string[];
  verificationActions: string[];
  maxRepairCycles: number;
  stopConditions: string[];
  requiresConfirmation: boolean;
  createdAt: string;
}

export interface WorkProductArtifact {
  path?: string;
  label?: string;
  kind?: string;
  expectedExists?: boolean;
  minBytes?: number;
  requiredText?: string[];
}

export interface ArtifactVerification {
  label: string;
  path?: string;
  exists: boolean;
  sizeBytes?: number;
  modifiedAt?: string;
  readable?: boolean;
  issues: string[];
  evidence?: string;
}

export interface WorkProductVerification {
  status: VerificationStatus;
  planId?: string;
  task: string;
  checkedAt: string;
  passedCriteria: string[];
  failedCriteria: string[];
  blockedCriteria: string[];
  artifactChecks: ArtifactVerification[];
  nextRepairActions: string[];
  finalization: string;
}

interface PlanInput {
  userId: string;
  task: string;
  deliverableType?: DeliverableType;
  finalOutput?: string;
  acceptanceCriteria?: string[];
  expectedArtifacts?: WorkProductArtifact[];
  maxRepairCycles?: number;
  persist?: boolean;
}

interface VerifyInput {
  userId: string;
  task?: string;
  planId?: string;
  acceptanceCriteria?: string[];
  artifacts?: WorkProductArtifact[];
  completedCriteria?: string[];
  repairCycle?: number;
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.csv', '.ts', '.tsx', '.js', '.jsx', '.html', '.css', '.xml', '.svg', '.dxf', '.py', '.rs', '.toml', '.yaml', '.yml',
]);

export function createWorkProductPlan(input: PlanInput): WorkProductPlan {
  const task = String(input.task || '').trim();
  if (!task) throw new Error('task is required');
  const deliverableType = input.deliverableType || inferDeliverableType(task);
  const finalOutput = input.finalOutput || inferFinalOutput(task, deliverableType);
  const acceptanceCriteria = normalizeList(input.acceptanceCriteria, buildAcceptanceCriteria(deliverableType, task, input.expectedArtifacts));
  const plan: WorkProductPlan = {
    id: `wp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    userId: input.userId || 'anonymous',
    task,
    deliverableType,
    finalOutput,
    acceptanceCriteria,
    checkpoints: buildCheckpoints(deliverableType),
    verificationActions: buildVerificationActions(deliverableType, input.expectedArtifacts),
    maxRepairCycles: Math.max(1, Math.min(Number(input.maxRepairCycles) || 3, 8)),
    stopConditions: [
      'All acceptance criteria pass.',
      'The user cancels or changes the task.',
      'A required confirmation, credential, external app, or missing input blocks progress.',
      'The maximum repair cycle count is reached; report the remaining blocker clearly.',
    ],
    requiresConfirmation: requiresConfirmation(task, deliverableType),
    createdAt: new Date().toISOString(),
  };
  if (input.persist !== false) persistPlan(plan);
  return plan;
}

export function verifyWorkProduct(input: VerifyInput): WorkProductVerification {
  const plan = input.planId ? getWorkProductPlan(input.userId, input.planId) : null;
  const task = String(input.task || plan?.task || '').trim();
  if (!task) throw new Error('task or planId is required');
  const acceptanceCriteria = normalizeList(input.acceptanceCriteria, plan?.acceptanceCriteria || buildAcceptanceCriteria(inferDeliverableType(task), task));
  const artifactChecks = (input.artifacts || []).map(verifyArtifact);
  const failedCriteria: string[] = [];
  const blockedCriteria: string[] = [];
  const passedCriteria: string[] = [];
  const completedCriteria = normalizeList(input.completedCriteria, []);

  for (const criterion of acceptanceCriteria) {
    if (isCriterionCompleted(criterion, completedCriteria)) {
      passedCriteria.push(criterion);
      continue;
    }
    const result = evaluateCriterion(criterion, artifactChecks);
    if (result === 'pass') passedCriteria.push(criterion);
    else if (result === 'blocked') blockedCriteria.push(criterion);
    else failedCriteria.push(criterion);
  }

  for (const artifact of artifactChecks) {
    for (const issue of artifact.issues) {
      const message = `${artifact.label}: ${issue}`;
      if (!failedCriteria.includes(message)) failedCriteria.push(message);
    }
  }

  const repairCycle = Math.max(0, Number(input.repairCycle) || 0);
  const maxRepairCycles = plan?.maxRepairCycles || 3;
  const status: VerificationStatus = blockedCriteria.length > 0
    ? 'blocked'
    : failedCriteria.length === 0
      ? 'pass'
      : passedCriteria.length > 0 || artifactChecks.some(check => check.exists)
        ? 'partial'
        : 'fail';

  const nextRepairActions = buildRepairActions(status, failedCriteria, blockedCriteria, artifactChecks, repairCycle, maxRepairCycles);

  return {
    status,
    planId: plan?.id || input.planId,
    task,
    checkedAt: new Date().toISOString(),
    passedCriteria,
    failedCriteria,
    blockedCriteria,
    artifactChecks,
    nextRepairActions,
    finalization: status === 'pass'
      ? 'Work product passes the current acceptance criteria and can be summarized to the user.'
      : repairCycle >= maxRepairCycles
        ? 'Stop and report the remaining blocker; maximum repair cycles reached.'
        : 'Do not claim final completion yet. Repair the failed criteria, then run verification again.',
  };
}

export function getWorkProductPlan(userId: string, planId: string): WorkProductPlan | null {
  try {
    const db = readDB();
    return (db.workProductPlans || []).find((plan: WorkProductPlan) => plan.id === planId && (plan.userId === userId || userId === 'anonymous')) || null;
  } catch {
    return null;
  }
}

function persistPlan(plan: WorkProductPlan): void {
  const db = readDB();
  if (!db.workProductPlans) db.workProductPlans = [];
  db.workProductPlans.push(plan);
  db.workProductPlans = db.workProductPlans.slice(-200);
  writeDB(db);
}

function inferDeliverableType(task: string): DeliverableType {
  if (/cad|dxf|dwg|revit|ifc|bim|floor.?plan|drawing|图纸|户型|施工图|装修|建模/i.test(task)) return 'drawing';
  if (/code|bug|typescript|javascript|test|lint|build|api|代码|修复|编译|测试/i.test(task)) return 'code';
  if (/doc|report|proposal|ppt|markdown|word|文档|报告|方案|合同|标书|纪要|总结/i.test(task)) return 'document';
  if (/meeting|transcript|minutes|会议|会谈|纪要/i.test(task)) return 'meeting_report';
  if (/design|logo|poster|ui|ux|brand|image|视觉|设计|海报|图片|品牌/i.test(task)) return 'design';
  if (/music|song|playlist|lyric|音乐|歌曲|歌单|歌词/i.test(task)) return 'music';
  if (/open|switch|mode|client|window|打开|切换|窗口|模式|进入/i.test(task)) return 'client_action';
  if (/research|search|compare|study|查找|调研|搜索|对比/i.test(task)) return 'research';
  if (/data|csv|excel|table|统计|数据|表格|分析/i.test(task)) return 'data';
  return 'general';
}

function inferFinalOutput(task: string, deliverableType: DeliverableType): string {
  const map: Record<DeliverableType, string> = {
    document: 'A readable document/report with a verified path or complete text output.',
    drawing: 'A CAD/BIM/design handoff artifact such as DXF/IFC/SVG/preview plus assumptions and verified path.',
    code: 'A working code change with relevant checks run and failures reported.',
    design: 'A visual/design artifact or structured design brief with verified output.',
    music: 'A confirmed playback/profile/playlist result or an explicit music artifact.',
    meeting_report: 'Meeting notes, summary, action items, and report saved or shown in the meeting surface.',
    client_action: 'The requested client state/window/mode is changed and verified through client state or action result.',
    research: 'A sourced research summary, candidate comparison, and recommended next action.',
    data: 'A data summary/table/export with source and calculation assumptions.',
    general: 'A concrete answer or artifact that satisfies the user request.',
  };
  return map[deliverableType] || `Completed result for: ${task}`;
}

function buildAcceptanceCriteria(deliverableType: DeliverableType, task: string, artifacts: WorkProductArtifact[] = []): string[] {
  const base = [
    'The final answer states what was produced and what was verified.',
    'Known limitations, missing inputs, or assumptions are disclosed.',
  ];
  if (artifacts.length > 0) base.unshift('All expected artifact paths exist and are readable.');
  if (deliverableType === 'code') {
    return [
      'Relevant files were changed intentionally.',
      'Type check, tests, or a narrower verification command was run, or the exact reason it could not run is stated.',
      ...base,
    ];
  }
  if (deliverableType === 'drawing') {
    return [
      'Source inputs were inspected before generating the drawing artifact.',
      'Generated artifact path exists and has non-zero size.',
      'Scale, dimensions, and production-readiness assumptions are stated.',
      ...base,
    ];
  }
  if (deliverableType === 'client_action') {
    return [
      'The requested client action was routed through client_action or an explicit client adapter.',
      'The resulting client state or action result was checked.',
      ...base,
    ];
  }
  if (deliverableType === 'research') {
    return [
      'Claims are grounded in checked sources, files, or tool results.',
      'Recommendation is separated from facts and uncertainty.',
      ...base,
    ];
  }
  if (deliverableType === 'music') {
    return [
      'Playback or playlist/profile action result was checked.',
      'The user-facing state matches the music surface state.',
      ...base,
    ];
  }
  if (/必须|must|required|一定|完整|闭环/i.test(task)) {
    base.unshift('The task-specific must-have requirements are explicitly addressed.');
  }
  return base;
}

function buildCheckpoints(deliverableType: DeliverableType): string[] {
  return [
    'Define deliverable and acceptance criteria.',
    'Inspect required inputs and current client/tool state.',
    'Produce the first artifact or action result.',
    ...(
      deliverableType === 'code'
        ? ['Run type check/tests or explain the exact blocker.']
        : deliverableType === 'drawing'
          ? ['Verify artifact path, file size, assumptions, and preview/handoff details.']
          : deliverableType === 'client_action'
            ? ['Read client state or action result after routing the action.']
            : ['Check result against acceptance criteria.']
    ),
    'Repair failed criteria and verify again until pass or blocked.',
    'Give final summary with paths/results and known limits.',
  ];
}

function buildVerificationActions(deliverableType: DeliverableType, artifacts: WorkProductArtifact[] = []): string[] {
  const actions = artifacts.length ? ['work_product_verify with expected artifact paths'] : ['work_product_verify with acceptance criteria'];
  if (deliverableType === 'code') actions.push('type_check', 'run_tests');
  if (deliverableType === 'drawing') actions.push('desktop_path_info for desktop files', 'read_file for text DXF/SVG/IFC handoff when appropriate');
  if (deliverableType === 'client_action') actions.push('client_get_state', 'client_health_check if state is stale or failed');
  if (deliverableType === 'research') actions.push('web_search/url_fetch/read_file as source checks');
  if (deliverableType === 'music') actions.push('client_get_state for music state and media errors');
  return actions;
}

function requiresConfirmation(task: string, deliverableType: DeliverableType): boolean {
  return ['drawing', 'client_action', 'music'].includes(deliverableType)
    || /desktop|external|send|post|install|repair|delete|system|wechat|feishu|revit|cad|桌面|外部|发送|安装|修复|删除|系统|微信|飞书/i.test(task);
}

function normalizeList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const items = value.map(item => String(item || '').trim()).filter(Boolean);
  return items.length ? items : fallback;
}

function isCriterionCompleted(criterion: string, completedCriteria: string[]): boolean {
  const normalized = normalizeText(criterion);
  return completedCriteria.some(item => {
    const candidate = normalizeText(item);
    return candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate);
  });
}

function normalizeText(value: string): string {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function verifyArtifact(artifact: WorkProductArtifact): ArtifactVerification {
  const rawPath = String(artifact.path || '').trim();
  const label = String(artifact.label || artifact.kind || rawPath || 'artifact');
  const issues: string[] = [];
  if (!rawPath) {
    return { label, exists: false, issues: ['No path was provided for this artifact.'] };
  }
  const resolved = resolvePath(rawPath);
  if (!fs.existsSync(resolved)) {
    return { label, path: resolved, exists: false, issues: ['Path does not exist.'] };
  }
  const stat = fs.statSync(resolved);
  const result: ArtifactVerification = {
    label,
    path: resolved,
    exists: true,
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    readable: true,
    issues,
  };
  const minBytes = Math.max(0, Number(artifact.minBytes || 1));
  if ((artifact.expectedExists !== false) && stat.size < minBytes) {
    issues.push(`File is smaller than expected (${stat.size} bytes < ${minBytes} bytes).`);
  }
  const ext = path.extname(resolved).toLowerCase();
  if (artifact.requiredText?.length && TEXT_EXTENSIONS.has(ext)) {
    try {
      const text = fs.readFileSync(resolved, 'utf-8').slice(0, 200_000);
      for (const needle of artifact.requiredText) {
        if (needle && !text.includes(needle)) issues.push(`Required text not found: ${needle}`);
      }
      result.evidence = text.slice(0, 500);
    } catch (err: any) {
      result.readable = false;
      issues.push(`Could not read text content: ${err.message}`);
    }
  }
  return result;
}

function evaluateCriterion(criterion: string, artifactChecks: ArtifactVerification[]): VerificationStatus {
  const text = criterion.toLowerCase();
  if (/artifact|path|file|exists|readable|路径|文件|存在|可读/.test(text)) {
    if (artifactChecks.length === 0) return 'blocked';
    if (artifactChecks.every(check => check.exists && check.issues.length === 0)) return 'pass';
    return 'fail';
  }
  if (/type check|tests|verification command|测试|编译/.test(text)) return 'blocked';
  if (/client state|action result|客户端状态|动作结果/.test(text)) return 'blocked';
  return 'blocked';
}

function buildRepairActions(
  status: VerificationStatus,
  failedCriteria: string[],
  blockedCriteria: string[],
  artifactChecks: ArtifactVerification[],
  repairCycle: number,
  maxRepairCycles: number,
): string[] {
  if (status === 'pass') return ['Summarize the verified result and stop.'];
  if (repairCycle >= maxRepairCycles) return ['Stop repair loop and report remaining blockers clearly.'];
  const actions: string[] = [];
  if (artifactChecks.some(check => !check.exists)) actions.push('Regenerate or locate the missing artifact path, then verify again.');
  if (artifactChecks.some(check => check.exists && check.issues.length > 0)) actions.push('Repair the artifact content/size/readability issue, then verify again.');
  if (blockedCriteria.length) actions.push('Run the domain-specific verification tool for blocked criteria, then call work_product_verify again with the results/artifacts.');
  if (failedCriteria.length && !actions.length) actions.push('Address failed acceptance criteria and rerun verification.');
  if (!actions.length) actions.push('Continue work, then rerun work_product_verify before finalizing.');
  return actions;
}

function resolvePath(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}
