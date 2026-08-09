import {
  createEvidenceWorkflow,
  getEvidenceWorkflowCompletion,
  normalizeEvidenceWorkflow,
  promoteEvidenceWorkflowStages,
  recalculateEvidenceWorkflow,
  transitionEvidenceWorkflowStep,
  type EvidenceWorkflow,
  type EvidenceWorkflowStepBlueprint,
  type EvidenceWorkflowStepStatus,
  type EvidenceWorkflowVerificationStatus,
} from '../../shared/evidence_workflow';
import { readDB } from '../../db_layer';
import type { ConversationActionReceiptRow, ConversationActionTaskRow } from '../conversation/action_ledger';
import { getWorkTakeoverTask, updateWorkTakeoverTask, type WorkTakeoverTask } from './tasks';

export const EVIDENCE_WORKFLOW_METADATA_KEY = 'evidenceWorkflow';
const TERMINAL_TASK_STATUSES = new Set<WorkTakeoverTask['status']>(['delivered', 'cancelled']);

function requireTask(userId: string, taskId: string): WorkTakeoverTask {
  const task = getWorkTakeoverTask(userId, taskId);
  if (!task) throw new Error(`Work takeover task not found: ${taskId}`);
  return task;
}

function requireMutableTask(task: WorkTakeoverTask): void {
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    throw new Error(`Evidence workflow cannot modify terminal task ${task.id} with status ${task.status}.`);
  }
}

function verifiedReceiptRowsForStep(
  task: WorkTakeoverTask,
  workflow: EvidenceWorkflow,
  stepId: string,
): ConversationActionReceiptRow[] {
  const step = workflow.steps.find(candidate => candidate.id === stepId);
  if (!step) throw new Error(`Evidence workflow step not found: ${stepId}`);
  const usedReceiptIds = new Set(
    workflow.steps
      .filter(candidate => candidate.id !== stepId)
      .flatMap(candidate => candidate.receiptIds),
  );
  const db = readDB();
  const actionTasks = Array.isArray(db.conversationActionTasks)
    ? db.conversationActionTasks as ConversationActionTaskRow[]
    : [];
  const scopedTaskIds = new Set(actionTasks
    .filter(candidate => (
      candidate.userId === task.userId
      && String(candidate.domain || 'personal') === String(task.domain || 'personal')
      && String(candidate.orgId || '') === String(task.orgId || '')
    ))
    .map(candidate => candidate.id));
  const workflowStartedAt = Date.parse(workflow.createdAt);
  return (Array.isArray(db.conversationActionReceipts)
    ? db.conversationActionReceipts as ConversationActionReceiptRow[]
    : [])
    .filter(receipt => !usedReceiptIds.has(receipt.id))
    .filter(receipt => scopedTaskIds.has(receipt.taskId))
    .filter(receipt => !step.tool || receipt.toolName === step.tool)
    .filter(receipt => receipt.outcome === 'verified_success')
    .filter(receipt => {
      const createdAt = Date.parse(receipt.createdAt);
      return Number.isFinite(createdAt)
        && (!Number.isFinite(workflowStartedAt) || createdAt >= workflowStartedAt);
    })
    .filter(receipt => {
      try {
        const envelope = typeof receipt.envelope === 'string'
          ? JSON.parse(receipt.envelope)
          : receipt.envelope;
        return envelope?.status === 'verified_success'
          && (!envelope?.taskId || envelope.taskId === receipt.taskId);
      } catch {
        return false;
      }
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function listTaskEvidenceWorkflowEligibleReceipts(input: {
  userId: string;
  taskId: string;
  stepId: string;
}): ConversationActionReceiptRow[] {
  const task = requireTask(input.userId, input.taskId);
  const workflow = getAuditedTaskEvidenceWorkflow(task);
  if (!workflow) throw new Error(`Task ${task.id} has no evidence workflow.`);
  return verifiedReceiptRowsForStep(task, workflow, input.stepId);
}

function resolveVerifiedReceiptIds(input: {
  task: WorkTakeoverTask;
  workflow: EvidenceWorkflow;
  stepId: string;
  requested?: string[];
}): string[] {
  const eligible = verifiedReceiptRowsForStep(input.task, input.workflow, input.stepId);
  const requested = Array.from(new Set((input.requested || []).map(String).map(value => value.trim()).filter(Boolean)));
  if (requested.length === 0) {
    const latest = eligible.at(-1);
    if (!latest) throw new Error(`Evidence workflow step ${input.stepId} has no matching verified action receipt.`);
    return [latest.id];
  }
  const eligibleIds = new Set(eligible.map(receipt => receipt.id));
  const invalid = requested.filter(receiptId => !eligibleIds.has(receiptId));
  if (invalid.length > 0) {
    throw new Error(`Evidence workflow rejected unverified or out-of-scope receipt(s): ${invalid.join(', ')}`);
  }
  return requested;
}

function auditRecoveredWorkflowReceipts(
  task: WorkTakeoverTask,
  workflow: EvidenceWorkflow,
): EvidenceWorkflow {
  let changed = false;
  const steps = workflow.steps.map(step => {
    if (step.status !== 'completed' || !step.verificationRequired) return step;
    const eligibleIds = new Set(
      verifiedReceiptRowsForStep(task, workflow, step.id).map(receipt => receipt.id),
    );
    if (step.receiptIds.length > 0 && step.receiptIds.every(receiptId => eligibleIds.has(receiptId))) {
      return step;
    }
    changed = true;
    return {
      ...step,
      status: 'failed' as const,
      verificationStatus: 'rejected' as const,
      receiptIds: [],
      blocker: 'Persisted completion receipt was missing, unverified, out of scope, or no longer matched the required tool.',
    };
  });
  return changed ? recalculateEvidenceWorkflow({ ...workflow, steps }) : workflow;
}

export function getAuditedTaskEvidenceWorkflow(task: WorkTakeoverTask): EvidenceWorkflow | null {
  const workflow = getTaskEvidenceWorkflow(task);
  return workflow ? auditRecoveredWorkflowReceipts(task, workflow) : null;
}

function taskStatusForWorkflow(task: WorkTakeoverTask, workflow: EvidenceWorkflow): WorkTakeoverTask['status'] {
  if (workflow.status === 'waiting_confirmation') return 'waiting_confirmation';
  if (workflow.status === 'waiting_human' || workflow.status === 'blocked') return 'blocked';
  if (task.status === 'queued') return 'in_progress';
  if (task.status === 'waiting_confirmation' || task.status === 'blocked') return 'in_progress';
  return task.status;
}

function persistWorkflow(
  task: WorkTakeoverTask,
  workflow: EvidenceWorkflow,
  note: string,
): WorkTakeoverTask {
  const completion = getEvidenceWorkflowCompletion(workflow);
  const updated = updateWorkTakeoverTask(task.userId, task.id, {
    status: taskStatusForWorkflow(task, workflow),
    metadata: { [EVIDENCE_WORKFLOW_METADATA_KEY]: workflow },
    note: `${note} Evidence workflow: ${completion.done}/${completion.total}, status=${workflow.status}.`,
  });
  if (!updated) throw new Error(`Failed to persist evidence workflow for task: ${task.id}`);
  return updated;
}

export function getTaskEvidenceWorkflow(task: WorkTakeoverTask): EvidenceWorkflow | null {
  const value = task.metadata?.[EVIDENCE_WORKFLOW_METADATA_KEY];
  return value && typeof value === 'object' ? value as EvidenceWorkflow : null;
}

export function startTaskEvidenceWorkflow(input: {
  userId: string;
  taskId: string;
  definitionId: string;
  blueprints: EvidenceWorkflowStepBlueprint[];
  stagesInScope?: string[];
  workflowId?: string;
  now?: string;
}): { task: WorkTakeoverTask; workflow: EvidenceWorkflow } {
  const task = requireTask(input.userId, input.taskId);
  requireMutableTask(task);
  if (getTaskEvidenceWorkflow(task)) throw new Error(`Task ${task.id} already has an evidence workflow.`);
  const workflow = createEvidenceWorkflow({
    definitionId: input.definitionId,
    taskId: task.id,
    blueprints: input.blueprints,
    stagesInScope: input.stagesInScope,
    id: input.workflowId,
    now: input.now,
  });
  return { task: persistWorkflow(task, workflow, 'Evidence workflow started.'), workflow };
}

export function recoverTaskEvidenceWorkflow(input: {
  userId: string;
  taskId: string;
  blueprints: EvidenceWorkflowStepBlueprint[];
  now?: string;
}): { task: WorkTakeoverTask; workflow: EvidenceWorkflow } {
  const task = requireTask(input.userId, input.taskId);
  requireMutableTask(task);
  const current = getAuditedTaskEvidenceWorkflow(task);
  if (!current) throw new Error(`Task ${task.id} has no evidence workflow.`);
  const normalized = normalizeEvidenceWorkflow(current, input.blueprints, input.now);
  if (!normalized) throw new Error(`Task ${task.id} has an invalid evidence workflow.`);
  const workflow = auditRecoveredWorkflowReceipts(task, normalized);
  return { task: persistWorkflow(task, workflow, 'Evidence workflow recovered and receipt-audited.'), workflow };
}

export function transitionTaskEvidenceWorkflowStep(input: {
  userId: string;
  taskId: string;
  stepId: string;
  status: EvidenceWorkflowStepStatus;
  verificationStatus?: EvidenceWorkflowVerificationStatus;
  receiptIds?: string[];
  outputSummary?: string;
  blocker?: string;
  now?: string;
}): { task: WorkTakeoverTask; workflow: EvidenceWorkflow } {
  const task = requireTask(input.userId, input.taskId);
  requireMutableTask(task);
  const current = getAuditedTaskEvidenceWorkflow(task);
  if (!current) throw new Error(`Task ${task.id} has no evidence workflow.`);
  const currentStep = current.steps.find(step => step.id === input.stepId);
  if (!currentStep) throw new Error(`Evidence workflow step not found: ${input.stepId}`);
  const validatingEvidence = currentStep.verificationRequired && (
    input.status === 'completed'
    || input.verificationStatus === 'verified'
    || Boolean(input.receiptIds?.length)
  );
  const receiptIds = validatingEvidence
    ? resolveVerifiedReceiptIds({
        task,
        workflow: current,
        stepId: input.stepId,
        requested: input.receiptIds,
      })
    : input.receiptIds;
  const workflow = transitionEvidenceWorkflowStep(current, input.stepId, {
    status: input.status,
    verificationStatus: validatingEvidence ? 'verified' : input.verificationStatus,
    receiptIds,
    outputSummary: input.outputSummary,
    blocker: input.blocker,
  }, input.now);
  return { task: persistWorkflow(task, workflow, `Evidence step ${input.stepId} changed to ${input.status}.`), workflow };
}

export function promoteTaskEvidenceWorkflow(input: {
  userId: string;
  taskId: string;
  stages: string[];
  now?: string;
}): { task: WorkTakeoverTask; workflow: EvidenceWorkflow } {
  const task = requireTask(input.userId, input.taskId);
  requireMutableTask(task);
  const current = getAuditedTaskEvidenceWorkflow(task);
  if (!current) throw new Error(`Task ${task.id} has no evidence workflow.`);
  const workflow = promoteEvidenceWorkflowStages(current, input.stages, input.now);
  return { task: persistWorkflow(task, workflow, 'Evidence workflow scope expanded.'), workflow };
}
