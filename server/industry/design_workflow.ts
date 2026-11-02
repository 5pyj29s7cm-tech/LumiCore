import { readDatabaseTables, commitDatabaseTables } from '../../db_layer';
import { ensureBackgroundConversationActionTask, settleBackgroundConversationActionTask } from '../conversation/ledger/background';
import type { ToolExecutionRecord } from '../tools/types';
import { getScopedWorkTakeoverTask, type WorkTakeoverTask } from '../work_takeover/tasks';
import type { WorkTakeoverResultVerification } from '../work_takeover/result_verifier';
import type { IndustryWorkflowScope, StartIndustryWorkflowInput } from './workflow_service';
import type { IndustryWorkflowContract } from './workflow_contracts';
import { getActiveInteriorProject, getInteriorProject, personalInteriorProjectScope, updateInteriorProject, type InteriorProject } from '../design/projects';
import { formatInteriorProjectWorkflowContext, getInteriorProjectWorkflow, getMissingInteriorProjectPrerequisites, isInteriorDesignStageId, linkInteriorProjectWorkflowStage, settleInteriorProjectWorkflowStage, type InteriorDesignStageId, type InteriorProjectWorkflowState } from '../design/project_workflow';
import { listInteriorProjectAssets } from '../design/project_assets';
import { captureOrganizationMembershipAuthorization } from '../org/membership_authorization';
import { parseStoredObject as parseObject } from '../tools/receipt_payload';

const compact = (value: unknown, limit = 5000): string => String(value || '').trim().slice(0, limit);
const workflowMetadata = (task: WorkTakeoverTask) => parseObject(task.metadata?.industryWorkflow);
const conversationTaskIdFor = (task: WorkTakeoverTask): string => compact(workflowMetadata(task).conversationTaskId, 200);

function designProjectScope(scope: IndustryWorkflowScope): string {
  return scope.domain === 'work' ? String(scope.orgId || '') : personalInteriorProjectScope(scope.userId);
}

const PROJECT_CONTINUITY_STAGE_IDS = new Set<InteriorDesignStageId>([
  'cad',
  'visualization',
  'presentation',
  'handoff',
]);

type DesignWorkflowMode = '' | 'project' | 'standalone';

export class IndustryWorkflowContinuityError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = 'IndustryWorkflowContinuityError';
  }
}

export function designWorkflowMode(
  input: StartIndustryWorkflowInput,
  contract: IndustryWorkflowContract,
): DesignWorkflowMode {
  if (contract.productLine !== 'design') return '';
  const rawMode = compact(input.context?.mode, 40).toLowerCase();
  if (!rawMode) return '';
  if (rawMode !== 'project' && rawMode !== 'standalone') {
    throw new IndustryWorkflowContinuityError('Design workflow mode must be either project or standalone.');
  }
  return rawMode;
}

export function designProjectForInput(
  input: StartIndustryWorkflowInput,
  contract: IndustryWorkflowContract,
): InteriorProject | null {
  if (contract.productLine !== 'design') return null;
  if (!input.userId || input.userId === 'anonymous') throw new Error('Authenticated design identity is required.');
  if (input.domain === 'work') captureOrganizationMembershipAuthorization(input.orgId, input.userId);
  const scopeId = designProjectScope(input);
  if (!scopeId) throw new Error('Organization scope is required for organization design projects.');
  const mode = designWorkflowMode(input, contract);
  const requestedProjectId = compact(input.context?.projectId, 200);
  if (mode === 'standalone') {
    if (requestedProjectId) {
      throw new IndustryWorkflowContinuityError('A standalone design task cannot also bind a project.');
    }
    return null;
  }
  if (requestedProjectId) {
    const requested = getInteriorProject(scopeId, requestedProjectId);
    if (!requested) throw new Error('The requested design project was not found in the active user scope.');
    return requested;
  }
  const activeProject = getActiveInteriorProject(scopeId, input.userId);
  if (!activeProject && mode === 'project') {
    throw new IndustryWorkflowContinuityError('Project mode requires an active or explicitly selected design project.');
  }
  if (
    !activeProject
    && isInteriorDesignStageId(contract.entryId)
    && PROJECT_CONTINUITY_STAGE_IDS.has(contract.entryId)
  ) {
    throw new IndustryWorkflowContinuityError(
      `Design stage ${contract.entryId} requires a bound project. Set context.mode to standalone only for an explicit independent task; standalone work never advances a project stage.`,
    );
  }
  return activeProject;
}

export function designProjectBinding(task: WorkTakeoverTask): {
  scopeId: string;
  projectId: string;
  projectName: string;
  entryId: InteriorDesignStageId;
} | null {
  const metadata = workflowMetadata(task);
  const context = metadata.context && typeof metadata.context === 'object' && !Array.isArray(metadata.context)
    ? metadata.context
    : {};
  const projectId = compact(context.projectId, 200);
  if (metadata.productLine !== 'design' || !projectId || !isInteriorDesignStageId(metadata.entryId)) return null;
  return {
    scopeId: designProjectScope({ userId: task.userId, domain: task.domain === 'work' ? 'work' : 'personal', orgId: task.orgId }),
    projectId,
    projectName: compact(context.projectName, 200),
    entryId: metadata.entryId,
  };
}

export interface IndustryWorkflowPrerequisiteStatus {
  projectId: string;
  projectName: string;
  entryId: InteriorDesignStageId;
  missing: InteriorDesignStageId[];
  blocker: string;
}

export function getIndustryWorkflowPrerequisiteStatus(
  task: WorkTakeoverTask,
): IndustryWorkflowPrerequisiteStatus | null {
  const binding = designProjectBinding(task);
  if (!binding) return null;
  const workflow = getInteriorProjectWorkflow(binding.scopeId, binding.projectId);
  if (!workflow) return { ...binding, missing: [binding.entryId], blocker: 'The bound design project or workflow ledger is unavailable.' };
  if (binding.entryId === 'project') return null;
  const missing = getMissingInteriorProjectPrerequisites(workflow, binding.entryId);
  if (!missing.length) return null;
  const blocker = `Design stage ${binding.entryId} is blocked until verified upstream stages complete: ${missing.join(', ')}.`;
  return { ...binding, missing, blocker };
}

export function ensureDesignProjectRootActionTask(input: {
  db: any;
  project: InteriorProject;
  conversationId: string;
  userId: string;
  domain: 'personal' | 'work';
  orgId: string;
  requestId: string;
}): string {
  const rootTaskId = `design_project_${input.project.id}`;
  const rootTask = ensureBackgroundConversationActionTask(input.db, {
    taskId: rootTaskId,
    conversationId: input.conversationId,
    userId: input.userId,
    domain: input.domain,
    orgId: input.orgId,
    goal: `Complete and verify design project ${input.project.name}`,
    target: `design-project:${input.project.id}`,
    requestId: input.requestId,
    source: 'design_project_workflow',
    context: { designProject: { projectId: input.project.id, projectName: input.project.name } },
  });
  if (rootTask.status !== 'executing') {
    rootTask.status = 'executing';
    rootTask.blocker = '';
    rootTask.completedAt = '';
    rootTask.completionSource = '';
    rootTask.activeRequestId = input.requestId;
    rootTask.updatedAt = new Date().toISOString();
    rootTask.revision = Math.max(1, Number(rootTask.revision) || 0) + 1;
  }
  return rootTaskId;
}

export function enforceDesignProjectPrerequisites(
  task: WorkTakeoverTask,
  verification: WorkTakeoverResultVerification,
): WorkTakeoverResultVerification {
  const binding = designProjectBinding(task);
  if (!binding) return verification;
  const prerequisite = getIndustryWorkflowPrerequisiteStatus(task);
  if (!prerequisite) {
    return {
      ...verification,
      checks: [
        ...verification.checks,
        {
          id: 'design_project_stage_dependencies',
          label: 'Design project upstream stages',
          passed: true,
          detail: `All prerequisites for design stage ${binding.entryId} have verified receipts.`,
        },
      ],
    };
  }
  const blocker = prerequisite.blocker;
  return {
    ...verification,
    passed: false,
    status: 'blocked',
    summary: blocker,
    blockers: Array.from(new Set([...verification.blockers, blocker])),
    checks: [
      ...verification.checks,
      {
        id: 'design_project_stage_dependencies',
        label: 'Design project upstream stages',
        passed: false,
        detail: blocker,
      },
    ],
  };
}

function parseStructuredReceipt(record: ToolExecutionRecord): Record<string, any> | null {
  let value: unknown = String(record.result || '').trim();
  for (let attempt = 0; attempt < 2 && typeof value === 'string'; attempt += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : null;
}

function receiptText(value: unknown): string {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean).join('；');
  return String(value || '').trim();
}

function mergeBriefText(current: string, incoming: string): string {
  const existing = String(current || '').trim();
  const next = String(incoming || '').trim();
  if (!next) return existing;
  if (!existing || existing === next) return next;
  if (existing.includes(next)) return existing;
  if (next.includes(existing)) return next;
  return `${existing}\n${next}`;
}

function syncDesignProjectBriefFromReceipts(
  scopeId: string,
  projectId: string,
  records: ToolExecutionRecord[],
): void {
  const project = getInteriorProject(scopeId, projectId);
  if (!project) return;
  const briefRecord = records.find(record => (
    record.name === 'mcp_design-studio-pack_interior_project_brief'
    && !record.error
    && record.terminalVerification?.status === 'verified'
  ));
  if (!briefRecord) return;
  const receipt = parseStructuredReceipt(briefRecord);
  if (!receipt) return;
  const priorities = receiptText(receipt.priorities);
  const requiredSpaces = receiptText(receipt.requiredSpaces);
  const decisions = receiptText(receipt.decisions);
  updateInteriorProject(scopeId, projectId, {
    brief: {
      area: receiptText(receipt.grossArea) || project.brief.area,
      occupants: receiptText(receipt.occupants) || project.brief.occupants,
      budget: receiptText(receipt.budget) || project.brief.budget,
      style: mergeBriefText(project.brief.style, priorities),
      requirements: mergeBriefText(project.brief.requirements, [requiredSpaces, decisions].filter(Boolean).join('\n')),
      constraints: mergeBriefText(project.brief.constraints, receiptText(receipt.existingConstraints)),
    },
  });
}


export function designHandoffContext(task: WorkTakeoverTask): string {
  const binding = designProjectBinding(task);
  if (!binding) return workflowMetadata(task).context?.mode === 'standalone'
    ? 'Execution mode: explicit standalone independent task. never read, mutate or advance an active project stage.' : '';
  const workflow = getInteriorProjectWorkflow(binding.scopeId, binding.projectId);
  const assets = listInteriorProjectAssets(binding.scopeId, binding.projectId);
  return [
    `Bound design project: ${binding.projectName} (${binding.projectId}).`,
    'Reuse verified upstream receipts; no missing dimensions, source paths or project facts may be guessed.',
    ...assets.map(asset => `Source asset: ${asset.displayName}; fileId=${asset.fileId}; extraction=${asset.extractionStatus || 'unknown'}`),
    workflow ? formatInteriorProjectWorkflowContext(workflow) : 'Project ledger unavailable; stop before executing a stage.',
  ].join('\n');
}

export function linkDesignWorkflowStage(project: InteriorProject, task: WorkTakeoverTask, rootTaskId: string): InteriorProjectWorkflowState | undefined {
  const metadata = workflowMetadata(task);
  if (!isInteriorDesignStageId(metadata.entryId)) return undefined;
  return linkInteriorProjectWorkflowStage({ orgId: project.orgId, projectId: project.id,
    entryId: metadata.entryId, taskId: task.id, conversationTaskId: metadata.conversationTaskId,
    rootConversationId: metadata.conversationId, rootTaskId });
}

export function settleBoundDesignProjectStage(task: WorkTakeoverTask, verification: WorkTakeoverResultVerification,
  records: ToolExecutionRecord[], verificationRecord: ToolExecutionRecord): void {
  const binding = designProjectBinding(task);
  if (!binding) return;
  const current = getInteriorProjectWorkflow(binding.scopeId, binding.projectId)?.stages[binding.entryId];
  if (current?.currentTaskId && current.currentTaskId !== task.id) return;
  if (binding.entryId === 'project' && verification.passed) syncDesignProjectBriefFromReceipts(binding.scopeId, binding.projectId, records);
  const state = settleInteriorProjectWorkflowStage({ orgId: binding.scopeId, projectId: binding.projectId,
    entryId: binding.entryId, taskId: task.id, conversationTaskId: conversationTaskIdFor(task), artifacts: task.artifacts, verification });
  if (!state.rootTaskId) return;
  const db = readDatabaseTables(['conversationActionTasks','conversationActionReceipts','conversationActionTurns','conversations','interactions']);
  const completed = binding.entryId === 'handoff' && verification.passed;
  settleBackgroundConversationActionTask(db, { taskId: state.rootTaskId, userId: task.userId,
    records: [{ ...verificationRecord, id: `${verificationRecord.id}_project_root`, taskId: state.rootTaskId,
      idempotencyKey: `${verificationRecord.idempotencyKey}:project-root` }],
    status: completed ? 'completed' : 'blocked',
    blocker: completed ? undefined : verification.passed ? `Stage ${binding.entryId} is verified. Awaiting an explicit request for the next design stage.` : verification.summary,
    requestId: workflowMetadata(task).requestId });
  commitDatabaseTables(db);
}

/** Recover only genuinely verified, exact-scope stored receipts; never synthesize verification. */
export function reconcileVerifiedDesignProjectBrief(scopeId: string, projectId: string, userId: string): InteriorProject | null {
  const project = getInteriorProject(scopeId, projectId);
  const workflow = getInteriorProjectWorkflow(scopeId, projectId);
  const domain = scopeId === personalInteriorProjectScope(userId) ? 'personal' as const : 'work' as const;
  if (domain === 'work') captureOrganizationMembershipAuthorization(scopeId, userId);
  const task = workflow?.stages.project.currentTaskId
    ? getScopedWorkTakeoverTask({userId, domain, orgId: domain === 'work' ? scopeId : ''}, workflow.stages.project.currentTaskId) : null;
  if (!project || !task || task.metadata?.workTakeoverVerification?.passed !== true || task.status !== 'delivered') return project;
  const binding = designProjectBinding(task);
  if (binding?.projectId !== projectId || binding.scopeId !== scopeId || binding.entryId !== 'project') return project;
  const meta = workflowMetadata(task);
  const records: ToolExecutionRecord[] = (Array.isArray(task.metadata?.workTakeoverToolRuns) ? task.metadata.workTakeoverToolRuns : [])
    .filter((run: any) => run.status === 'completed' && run.terminalVerification?.status === 'verified'
      && run.requestId === meta.requestId && [task.id, meta.conversationTaskId].includes(run.taskId))
    .map((run: any) => ({...run, name: run.toolName, arguments: run.toolArgs || {}}));
  syncDesignProjectBriefFromReceipts(scopeId, projectId, records);
  return getInteriorProject(scopeId, projectId);
}
