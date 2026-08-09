export type EvidenceWorkflowExecutionMode = 'automatic' | 'assisted' | 'manual';
export type EvidenceWorkflowStepStatus =
  | 'pending'
  | 'running'
  | 'waiting_confirmation'
  | 'waiting_human'
  | 'completed'
  | 'skipped'
  | 'failed';
export type EvidenceWorkflowVerificationStatus = 'pending' | 'not_required' | 'verified' | 'rejected';
export type EvidenceWorkflowStatus =
  | 'ready'
  | 'running'
  | 'waiting_confirmation'
  | 'waiting_human'
  | 'blocked'
  | 'completed';

export interface EvidenceWorkflowStepBlueprint {
  id: string;
  label: string;
  stage: string;
  order: number;
  executionMode: EvidenceWorkflowExecutionMode;
  tool?: string;
  verificationRequired?: boolean;
  requiredEvidence?: string[];
  confirmationRequired?: string[];
}

export interface EvidenceWorkflowStep extends EvidenceWorkflowStepBlueprint {
  status: EvidenceWorkflowStepStatus;
  verificationStatus: EvidenceWorkflowVerificationStatus;
  receiptIds: string[];
  outputSummary?: string;
  blocker?: string;
  updatedAt?: string;
}

export interface EvidenceWorkflow {
  version: 1;
  id: string;
  definitionId: string;
  taskId: string;
  stagesInScope: string[];
  status: EvidenceWorkflowStatus;
  steps: EvidenceWorkflowStep[];
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceWorkflowCompletion {
  done: number;
  total: number;
  percent: number;
  verified: number;
}

const STEP_STATUSES = new Set<EvidenceWorkflowStepStatus>([
  'pending',
  'running',
  'waiting_confirmation',
  'waiting_human',
  'completed',
  'skipped',
  'failed',
]);
const VERIFICATION_STATUSES = new Set<EvidenceWorkflowVerificationStatus>([
  'pending',
  'not_required',
  'verified',
  'rejected',
]);

function compact(value: unknown, limit: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizedList(value: unknown, limit = 24): string[] {
  const input = Array.isArray(value) ? value : [];
  return Array.from(new Set(input.map(item => compact(item, 240)).filter(Boolean))).slice(0, limit);
}

function normalizeBlueprints(blueprints: EvidenceWorkflowStepBlueprint[]): EvidenceWorkflowStepBlueprint[] {
  const ids = new Set<string>();
  const normalized = blueprints.map((blueprint, index) => {
    const id = compact(blueprint.id, 160);
    const label = compact(blueprint.label, 240);
    const stage = compact(blueprint.stage, 120);
    if (!id || !label || !stage) throw new Error(`Evidence workflow step ${index + 1} requires id, label, and stage.`);
    if (ids.has(id)) throw new Error(`Duplicate evidence workflow step id: ${id}`);
    ids.add(id);
    if (!['automatic', 'assisted', 'manual'].includes(blueprint.executionMode)) {
      throw new Error(`Unsupported evidence workflow execution mode for step ${id}.`);
    }
    const tool = compact(blueprint.tool, 180) || undefined;
    return {
      id,
      label,
      stage,
      order: Number.isFinite(Number(blueprint.order)) ? Number(blueprint.order) : index,
      executionMode: blueprint.executionMode,
      tool,
      // Any tool-backed step is evidence-bearing by definition. Callers may
      // require verification for additional manual/assisted steps, but cannot
      // disable receipt verification for an actual tool execution.
      verificationRequired: Boolean(tool) || blueprint.verificationRequired === true,
      requiredEvidence: normalizedList(blueprint.requiredEvidence),
      confirmationRequired: normalizedList(blueprint.confirmationRequired),
    };
  });
  return normalized.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

function generatedId(): string {
  return `evidence_workflow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function initialVerificationStatus(step: EvidenceWorkflowStepBlueprint): EvidenceWorkflowVerificationStatus {
  return step.verificationRequired ? 'pending' : 'not_required';
}

export function createEvidenceWorkflow(input: {
  definitionId: string;
  taskId: string;
  blueprints: EvidenceWorkflowStepBlueprint[];
  stagesInScope?: string[];
  id?: string;
  now?: string;
}): EvidenceWorkflow {
  const definitionId = compact(input.definitionId, 160);
  const taskId = compact(input.taskId, 180);
  if (!definitionId || !taskId) throw new Error('Evidence workflow requires definitionId and taskId.');
  const blueprints = normalizeBlueprints(input.blueprints);
  if (blueprints.length === 0) throw new Error('Evidence workflow requires at least one step.');
  const availableStages = Array.from(new Set(blueprints.map(step => step.stage)));
  const requestedStages = normalizedList(input.stagesInScope, availableStages.length);
  const stagesInScope = (requestedStages.length ? requestedStages : [availableStages[0]])
    .filter(stage => availableStages.includes(stage));
  if (stagesInScope.length === 0) throw new Error('Evidence workflow has no valid stage in scope.');
  const timestamp = input.now || new Date().toISOString();
  const workflow: EvidenceWorkflow = {
    version: 1,
    id: compact(input.id, 180) || generatedId(),
    definitionId,
    taskId,
    stagesInScope,
    status: 'ready',
    steps: blueprints.map(step => ({
      ...step,
      status: 'pending',
      verificationStatus: initialVerificationStatus(step),
      receiptIds: [],
    })),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return recalculateEvidenceWorkflow(workflow);
}

export function getEvidenceWorkflowStepsInScope(workflow: EvidenceWorkflow): EvidenceWorkflowStep[] {
  const stages = new Set(workflow.stagesInScope);
  return workflow.steps.filter(step => stages.has(step.stage));
}

export function getEvidenceWorkflowCompletion(workflow: EvidenceWorkflow): EvidenceWorkflowCompletion {
  const steps = getEvidenceWorkflowStepsInScope(workflow);
  const done = steps.filter(step => step.status === 'completed' || step.status === 'skipped').length;
  const verified = steps.filter(step => step.status === 'completed' && step.verificationStatus === 'verified').length;
  return {
    done,
    total: steps.length,
    percent: steps.length ? Math.round((done / steps.length) * 100) : 0,
    verified,
  };
}

export function recalculateEvidenceWorkflow(workflow: EvidenceWorkflow): EvidenceWorkflow {
  const steps = getEvidenceWorkflowStepsInScope(workflow);
  let status: EvidenceWorkflowStatus = 'ready';
  if (steps.some(step => step.status === 'running')) status = 'running';
  else if (steps.some(step => step.status === 'waiting_confirmation')) status = 'waiting_confirmation';
  else if (steps.some(step => step.status === 'waiting_human')) status = 'waiting_human';
  else if (steps.some(step => step.status === 'failed')) status = 'blocked';
  else if (steps.length > 0 && steps.every(step => step.status === 'completed' || step.status === 'skipped')) status = 'completed';
  return { ...workflow, status };
}

export function getNextEvidenceWorkflowStep(workflow: EvidenceWorkflow): EvidenceWorkflowStep | null {
  const steps = getEvidenceWorkflowStepsInScope(workflow);
  if (steps.some(step => ['running', 'waiting_confirmation', 'waiting_human', 'failed'].includes(step.status))) return null;
  return steps.find(step => step.status === 'pending') || null;
}

function assertCompletionEvidence(step: EvidenceWorkflowStep): void {
  if (!step.verificationRequired) return;
  if (step.verificationStatus !== 'verified' || step.receiptIds.length === 0) {
    throw new Error(`Evidence workflow step ${step.id} requires a verified receipt before completion.`);
  }
}

const ALLOWED_TRANSITIONS: Record<EvidenceWorkflowStepStatus, EvidenceWorkflowStepStatus[]> = {
  pending: ['running', 'waiting_confirmation', 'waiting_human', 'skipped', 'failed'],
  running: ['pending', 'waiting_confirmation', 'waiting_human', 'completed', 'skipped', 'failed'],
  waiting_confirmation: ['pending', 'running', 'completed', 'skipped', 'failed'],
  waiting_human: ['pending', 'running', 'completed', 'skipped', 'failed'],
  completed: [],
  skipped: [],
  failed: ['pending', 'running', 'skipped'],
};

export function transitionEvidenceWorkflowStep(
  workflow: EvidenceWorkflow,
  stepId: string,
  patch: {
    status: EvidenceWorkflowStepStatus;
    verificationStatus?: EvidenceWorkflowVerificationStatus;
    receiptIds?: string[];
    outputSummary?: string;
    blocker?: string;
  },
  now = new Date().toISOString(),
): EvidenceWorkflow {
  const current = workflow.steps.find(step => step.id === stepId);
  if (!current) throw new Error(`Evidence workflow step not found: ${stepId}`);
  if (!ALLOWED_TRANSITIONS[current.status].includes(patch.status)) {
    throw new Error(`Invalid evidence workflow transition: ${current.status} -> ${patch.status}`);
  }
  const verificationStatus = patch.verificationStatus ?? current.verificationStatus;
  if (!VERIFICATION_STATUSES.has(verificationStatus)) throw new Error('Invalid evidence verification status.');
  const next: EvidenceWorkflowStep = {
    ...current,
    status: patch.status,
    verificationStatus,
    receiptIds: patch.receiptIds === undefined ? current.receiptIds : normalizedList(patch.receiptIds, 40),
    outputSummary: patch.outputSummary === undefined ? current.outputSummary : compact(patch.outputSummary, 4000) || undefined,
    blocker: patch.blocker === undefined ? current.blocker : compact(patch.blocker, 1000) || undefined,
    updatedAt: now,
  };
  if (next.status === 'completed') assertCompletionEvidence(next);
  if (next.status === 'failed' && !next.blocker) throw new Error(`Failed evidence workflow step ${stepId} requires a blocker.`);
  const updated = {
    ...workflow,
    steps: workflow.steps.map(step => step.id === stepId ? next : step),
    updatedAt: now,
  };
  return recalculateEvidenceWorkflow(updated);
}

export function reopenEvidenceWorkflowStep(
  workflow: EvidenceWorkflow,
  stepId: string,
  reason: string,
  now = new Date().toISOString(),
): EvidenceWorkflow {
  const cleanReason = compact(reason, 1000);
  if (!cleanReason) throw new Error('Reopening an evidence workflow step requires a reason.');
  const current = workflow.steps.find(step => step.id === stepId);
  if (!current) throw new Error(`Evidence workflow step not found: ${stepId}`);
  const updated: EvidenceWorkflowStep = {
    ...current,
    status: 'pending',
    verificationStatus: initialVerificationStatus(current),
    receiptIds: [],
    outputSummary: undefined,
    blocker: cleanReason,
    updatedAt: now,
  };
  return recalculateEvidenceWorkflow({
    ...workflow,
    steps: workflow.steps.map(step => step.id === stepId ? updated : step),
    updatedAt: now,
  });
}

export function promoteEvidenceWorkflowStages(
  workflow: EvidenceWorkflow,
  stages: string[],
  now = new Date().toISOString(),
): EvidenceWorkflow {
  const available = new Set(workflow.steps.map(step => step.stage));
  const requested = normalizedList(stages).filter(stage => available.has(stage));
  const stagesInScope = Array.from(new Set([...workflow.stagesInScope, ...requested]));
  if (stagesInScope.length === workflow.stagesInScope.length) return workflow;
  return recalculateEvidenceWorkflow({ ...workflow, stagesInScope, updatedAt: now });
}

export function normalizeEvidenceWorkflow(
  value: unknown,
  blueprints: EvidenceWorkflowStepBlueprint[],
  now = new Date().toISOString(),
): EvidenceWorkflow | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Partial<EvidenceWorkflow>;
  const definitionId = compact(input.definitionId, 160);
  const taskId = compact(input.taskId, 180);
  const id = compact(input.id, 180);
  if (input.version !== 1 || !definitionId || !taskId || !id) return null;
  const normalizedBlueprints = normalizeBlueprints(blueprints);
  const savedById = new Map((Array.isArray(input.steps) ? input.steps : []).map(step => [step?.id, step]));
  const steps = normalizedBlueprints.map(blueprint => {
    const saved = savedById.get(blueprint.id) as Partial<EvidenceWorkflowStep> | undefined;
    let status = saved?.status && STEP_STATUSES.has(saved.status) ? saved.status : 'pending';
    const verificationStatus = saved?.verificationStatus && VERIFICATION_STATUSES.has(saved.verificationStatus)
      ? saved.verificationStatus
      : initialVerificationStatus(blueprint);
    const receiptIds = normalizedList(saved?.receiptIds, 40);
    let blocker = compact(saved?.blocker, 1000) || undefined;
    if (status === 'running') {
      status = 'pending';
      blocker = blocker || 'Interrupted running step was reset for safe retry.';
    }
    if (status === 'completed' && blueprint.verificationRequired && (verificationStatus !== 'verified' || receiptIds.length === 0)) {
      status = 'failed';
      blocker = 'Persisted completion lacked a verified receipt and was downgraded.';
    }
    return {
      ...blueprint,
      status,
      verificationStatus,
      receiptIds,
      outputSummary: compact(saved?.outputSummary, 4000) || undefined,
      blocker,
      updatedAt: compact(saved?.updatedAt, 80) || undefined,
    } as EvidenceWorkflowStep;
  });
  const availableStages = new Set(steps.map(step => step.stage));
  const stagesInScope = normalizedList(input.stagesInScope).filter(stage => availableStages.has(stage));
  const workflow: EvidenceWorkflow = {
    version: 1,
    id,
    definitionId,
    taskId,
    stagesInScope: stagesInScope.length ? stagesInScope : [steps[0].stage],
    status: 'ready',
    steps,
    createdAt: compact(input.createdAt, 80) || now,
    updatedAt: now,
  };
  return recalculateEvidenceWorkflow(workflow);
}

export function combineVerifiedEvidenceWorkflowOutputs(workflow: EvidenceWorkflow): string {
  return getEvidenceWorkflowStepsInScope(workflow)
    .filter(step => step.status === 'completed' && (!step.verificationRequired || step.verificationStatus === 'verified'))
    .map(step => [
      `## ${step.label}`,
      step.outputSummary || '',
      step.receiptIds.length ? `Receipts: ${step.receiptIds.join(', ')}` : '',
    ].filter(Boolean).join('\n'))
    .join('\n\n---\n\n');
}
