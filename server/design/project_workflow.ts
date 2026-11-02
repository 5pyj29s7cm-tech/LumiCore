import path from 'node:path';
import { readDatabaseTables, commitDatabaseTables } from '../../db_layer';
import type { WorkTakeoverArtifact } from '../work_takeover/tasks';
import type { WorkTakeoverResultVerification } from '../work_takeover/result_verifier';
import type { InteriorProject, InteriorProjectStatus } from './projects';

export const INTERIOR_DESIGN_STAGE_IDS = [
  'project',
  'cad',
  'visualization',
  'presentation',
  'handoff',
] as const;

export type InteriorDesignStageId = typeof INTERIOR_DESIGN_STAGE_IDS[number];
export type InteriorDesignStageStatus =
  | 'not_started'
  | 'in_progress'
  | 'waiting_confirmation'
  | 'blocked'
  | 'completed';

export interface InteriorProjectWorkflowArtifactRef {
  label: string;
  type: string;
  path: string;
  fileName: string;
  status: string;
  taskId: string;
  recordedAt: string;
}

export interface InteriorProjectWorkflowStageState {
  entryId: InteriorDesignStageId;
  status: InteriorDesignStageStatus;
  currentTaskId: string;
  taskIds: string[];
  conversationTaskId: string;
  parentTaskId: string;
  sourceTaskIds: string[];
  receiptIds: string[];
  artifacts: InteriorProjectWorkflowArtifactRef[];
  verificationId: string;
  verificationStatus: string;
  blocker: string;
  attempts: number;
  startedAt: string;
  updatedAt: string;
  completedAt: string;
}

export interface InteriorProjectWorkflowState {
  schemaVersion: 1;
  rootConversationId: string;
  rootTaskId: string;
  activeStage: InteriorDesignStageId | '';
  stages: Record<InteriorDesignStageId, InteriorProjectWorkflowStageState>;
  createdAt: string;
  updatedAt: string;
}

const STAGE_PROJECT_STATUS: Record<InteriorDesignStageId, InteriorProjectStatus> = {
  project: 'planning',
  cad: 'design',
  visualization: 'visualization',
  presentation: 'handoff',
  handoff: 'handoff',
};

const PROJECT_STATUS_ORDER: InteriorProjectStatus[] = [
  'brief',
  'planning',
  'design',
  'visualization',
  'handoff',
  'archived',
];

function mostAdvancedProjectStatus(
  current: InteriorProjectStatus,
  candidate: InteriorProjectStatus,
): InteriorProjectStatus {
  return PROJECT_STATUS_ORDER.indexOf(candidate) > PROJECT_STATUS_ORDER.indexOf(current)
    ? candidate
    : current;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyStage(entryId: InteriorDesignStageId): InteriorProjectWorkflowStageState {
  return {
    entryId,
    status: 'not_started',
    currentTaskId: '',
    taskIds: [],
    conversationTaskId: '',
    parentTaskId: '',
    sourceTaskIds: [],
    receiptIds: [],
    artifacts: [],
    verificationId: '',
    verificationStatus: '',
    blocker: '',
    attempts: 0,
    startedAt: '',
    updatedAt: '',
    completedAt: '',
  };
}

function freshWorkflow(timestamp = nowIso()): InteriorProjectWorkflowState {
  return {
    schemaVersion: 1,
    rootConversationId: '',
    rootTaskId: '',
    activeStage: '',
    stages: Object.fromEntries(
      INTERIOR_DESIGN_STAGE_IDS.map(entryId => [entryId, emptyStage(entryId)]),
    ) as Record<InteriorDesignStageId, InteriorProjectWorkflowStageState>,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function projectRows(db: any): InteriorProject[] {
  if (!Array.isArray(db.interiorProjects)) db.interiorProjects = [];
  return db.interiorProjects as InteriorProject[];
}

function findProject(db: any, orgId: string, projectId: string): InteriorProject | null {
  return projectRows(db).find(project => project.orgId === orgId && project.id === projectId) || null;
}

function normalizeStage(entryId: InteriorDesignStageId, value: any): InteriorProjectWorkflowStageState {
  const empty = emptyStage(entryId);
  return {
    ...empty,
    ...(value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
    entryId,
    taskIds: Array.from(new Set(Array.isArray(value?.taskIds) ? value.taskIds.map(String).filter(Boolean) : [])).slice(-30),
    sourceTaskIds: Array.from(new Set(Array.isArray(value?.sourceTaskIds) ? value.sourceTaskIds.map(String).filter(Boolean) : [])).slice(-30),
    receiptIds: Array.from(new Set(Array.isArray(value?.receiptIds) ? value.receiptIds.map(String).filter(Boolean) : [])).slice(-60),
    artifacts: (Array.isArray(value?.artifacts) ? value.artifacts : []).slice(-60),
  };
}

function normalizeWorkflow(value: unknown): InteriorProjectWorkflowState {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as any : {};
  const timestamp = String(raw.createdAt || nowIso());
  const fresh = freshWorkflow(timestamp);
  return {
    ...fresh,
    ...raw,
    schemaVersion: 1,
    activeStage: INTERIOR_DESIGN_STAGE_IDS.includes(raw.activeStage) ? raw.activeStage : '',
    stages: Object.fromEntries(INTERIOR_DESIGN_STAGE_IDS.map(entryId => [
      entryId,
      normalizeStage(entryId, raw.stages?.[entryId]),
    ])) as Record<InteriorDesignStageId, InteriorProjectWorkflowStageState>,
  };
}

function cloneWorkflow(value: unknown): InteriorProjectWorkflowState {
  return structuredClone(normalizeWorkflow(value));
}

export function isInteriorDesignStageId(value: unknown): value is InteriorDesignStageId {
  return INTERIOR_DESIGN_STAGE_IDS.includes(String(value || '') as InteriorDesignStageId);
}

export function getInteriorProjectWorkflow(
  orgId: string,
  projectId: string,
): InteriorProjectWorkflowState | null {
  const project = findProject(readDatabaseTables(['interiorProjects']), orgId, projectId);
  return project ? cloneWorkflow(project.workflow) : null;
}

export function getCompletedInteriorProjectStageIds(
  workflow: InteriorProjectWorkflowState,
  beforeEntryId?: InteriorDesignStageId,
): InteriorDesignStageId[] {
  const end = beforeEntryId ? INTERIOR_DESIGN_STAGE_IDS.indexOf(beforeEntryId) : INTERIOR_DESIGN_STAGE_IDS.length;
  return INTERIOR_DESIGN_STAGE_IDS
    .slice(0, end < 0 ? INTERIOR_DESIGN_STAGE_IDS.length : end)
    .filter(entryId => hasVerifiedInteriorProjectStage(workflow.stages[entryId]));
}

export function hasVerifiedInteriorProjectStage(stage: InteriorProjectWorkflowStageState): boolean {
  if (stage.status === 'completed') return true;
  if (String(stage.verificationStatus || '').toLowerCase() !== 'passed') return false;
  if (!stage.verificationId || stage.receiptIds.length === 0) return false;
  return stage.artifacts.some(artifact => (
    Boolean(artifact.taskId)
    && artifact.status === 'delivered'
    && /verification receipt/i.test(artifact.label)
  ));
}

function verifiedInteriorProjectStageTaskId(stage: InteriorProjectWorkflowStageState): string {
  if (stage.status === 'completed') return stage.currentTaskId;
  return [...stage.artifacts].reverse().find(artifact => (
    Boolean(artifact.taskId)
    && artifact.status === 'delivered'
    && /verification receipt/i.test(artifact.label)
  ))?.taskId || '';
}

export function getMissingInteriorProjectPrerequisites(
  workflow: InteriorProjectWorkflowState,
  entryId: InteriorDesignStageId,
): InteriorDesignStageId[] {
  const stageIndex = INTERIOR_DESIGN_STAGE_IDS.indexOf(entryId);
  if (stageIndex <= 0) return [];
  return INTERIOR_DESIGN_STAGE_IDS
    .slice(0, stageIndex)
    .filter(stageId => !hasVerifiedInteriorProjectStage(workflow.stages[stageId]));
}

export function linkInteriorProjectWorkflowStage(input: {
  orgId: string;
  projectId: string;
  entryId: InteriorDesignStageId;
  taskId: string;
  conversationTaskId: string;
  rootConversationId: string;
  rootTaskId: string;
}): InteriorProjectWorkflowState {
  const db = readDatabaseTables(['interiorProjects']);
  const project = findProject(db, input.orgId, input.projectId);
  if (!project) throw new Error('Interior project not found in the active workflow scope.');
  const timestamp = nowIso();
  const workflow = normalizeWorkflow(project.workflow);
  const stage = workflow.stages[input.entryId];
  const sourceTaskIds = getCompletedInteriorProjectStageIds(workflow, input.entryId)
    .map(stageId => verifiedInteriorProjectStageTaskId(workflow.stages[stageId]))
    .filter(Boolean);
  workflow.rootConversationId = input.rootConversationId;
  workflow.rootTaskId = input.rootTaskId;
  workflow.activeStage = input.entryId;
  workflow.updatedAt = timestamp;
  workflow.stages[input.entryId] = {
    ...stage,
    status: 'in_progress',
    currentTaskId: input.taskId,
    taskIds: Array.from(new Set([...stage.taskIds, input.taskId])).slice(-30),
    conversationTaskId: input.conversationTaskId,
    parentTaskId: input.rootTaskId,
    sourceTaskIds,
    blocker: '',
    attempts: stage.currentTaskId === input.taskId ? stage.attempts : stage.attempts + 1,
    startedAt: stage.currentTaskId === input.taskId && stage.startedAt ? stage.startedAt : timestamp,
    updatedAt: timestamp,
    completedAt: '',
  };
  project.workflow = workflow;
  project.updatedAt = timestamp;
  commitDatabaseTables(db);
  return cloneWorkflow(workflow);
}

function artifactRefs(
  taskId: string,
  artifacts: WorkTakeoverArtifact[],
  timestamp: string,
): InteriorProjectWorkflowArtifactRef[] {
  return artifacts
    .filter(artifact => artifact.status !== 'planned' && (artifact.path || artifact.content))
    .map(artifact => ({
      label: String(artifact.label || '').slice(0, 160),
      type: String(artifact.type || 'other'),
      path: String(artifact.path || '').slice(0, 2000),
      fileName: artifact.path ? path.basename(artifact.path) : '',
      status: String(artifact.status || ''),
      taskId,
      recordedAt: timestamp,
    }));
}

export function settleInteriorProjectWorkflowStage(input: {
  orgId: string;
  projectId: string;
  entryId: InteriorDesignStageId;
  taskId: string;
  conversationTaskId: string;
  artifacts: WorkTakeoverArtifact[];
  verification: WorkTakeoverResultVerification;
}): InteriorProjectWorkflowState {
  const db = readDatabaseTables(['interiorProjects']);
  const project = findProject(db, input.orgId, input.projectId);
  if (!project) throw new Error('Interior project not found while settling workflow stage.');
  const timestamp = nowIso();
  const workflow = normalizeWorkflow(project.workflow);
  const stage = workflow.stages[input.entryId];
  const nextStatus: InteriorDesignStageStatus = input.verification.passed
    ? 'completed'
    : input.verification.status === 'blocked'
      ? 'blocked'
      : 'waiting_confirmation';
  const nextArtifacts = artifactRefs(input.taskId, input.artifacts, timestamp);
  const artifactKey = (artifact: InteriorProjectWorkflowArtifactRef) => `${artifact.taskId}:${artifact.label}:${artifact.path}`;
  const artifacts = [...stage.artifacts];
  for (const artifact of nextArtifacts) {
    const existingIndex = artifacts.findIndex(candidate => artifactKey(candidate) === artifactKey(artifact));
    if (existingIndex >= 0) artifacts[existingIndex] = artifact;
    else artifacts.push(artifact);
  }
  const receiptId = `industry_receipt_${input.verification.verificationId}`;
  workflow.stages[input.entryId] = {
    ...stage,
    status: nextStatus,
    currentTaskId: input.taskId,
    taskIds: Array.from(new Set([...stage.taskIds, input.taskId])).slice(-30),
    conversationTaskId: input.conversationTaskId || stage.conversationTaskId,
    receiptIds: Array.from(new Set([...stage.receiptIds, receiptId])).slice(-60),
    artifacts: artifacts.slice(-60),
    verificationId: input.verification.verificationId,
    verificationStatus: input.verification.status,
    blocker: input.verification.passed ? '' : input.verification.summary,
    updatedAt: timestamp,
    completedAt: input.verification.passed ? timestamp : '',
  };
  if (!input.verification.passed) {
    workflow.activeStage = input.entryId;
  } else if (input.entryId === 'handoff') {
    workflow.activeStage = '';
  } else {
    workflow.activeStage = [...INTERIOR_DESIGN_STAGE_IDS]
      .reverse()
      .find(entryId => workflow.stages[entryId].status === 'completed') || input.entryId;
  }
  workflow.updatedAt = timestamp;
  project.workflow = workflow;
  if (input.verification.passed) {
    project.status = mostAdvancedProjectStatus(project.status, STAGE_PROJECT_STATUS[input.entryId]);
  }
  project.updatedAt = timestamp;
  commitDatabaseTables(db);
  return cloneWorkflow(workflow);
}

export function formatInteriorProjectWorkflowContext(workflow: InteriorProjectWorkflowState): string {
  return INTERIOR_DESIGN_STAGE_IDS.map(entryId => {
    const stage = workflow.stages[entryId];
    const files = stage.artifacts.map(artifact => artifact.fileName || artifact.label).filter(Boolean);
    return `- ${entryId}: ${stage.status}; task=${stage.currentTaskId || 'none'}; receipts=${stage.receiptIds.join(', ') || 'none'}; artifacts=${files.join(', ') || 'none'}`;
  }).join('\n');
}
