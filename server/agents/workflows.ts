/**
 * Named Workflow Persistence — user-named, recallable multi-step workflow definitions.
 *
 * Unlike the worklog (which auto-records tool traces for pattern detection),
 * named workflows are explicitly saved by the user or the system when a useful
 * pattern is discovered. They can be run by name: "run my morning routine".
 */
import { readDB, writeDB } from '../../db_layer';
import { SubTask } from './orchestrator';
import {
  createWorkflowDefinitionDraft,
  getWorkflowDefinition as getVersionedWorkflowDefinition,
  publishWorkflowDefinition,
  redactWorkflowValue,
  retireWorkflowDefinition,
  type WorkflowDefinition as VersionedWorkflowDefinition,
  type WorkflowStepDefinition,
} from '../workflows/runtime';

export interface WorkflowDefinition {
  id: string;
  userId: string;
  name: string;
  description: string;
  steps: Array<{
    description: string;
    tool?: string;
    args?: Record<string, any>;
    requiredSkill?: string;
    executionMode?: string;
    /** Stable primary manifest id, populated by the save tool. */
    capabilityContractId?: string;
    /** Publication-time semantic contract; prevents silent capability drift. */
    capabilitySnapshot?: WorkflowStepDefinition['capabilitySnapshot'];
    /** Explicit read-only capability used only to reconcile an interrupted side effect. */
    reconciliationCapabilityId?: string;
    attachedReconciliation?: WorkflowStepDefinition['attachedReconciliation'];
  }>;
  agentAssignments?: Record<string, string>; // subTaskId -> agentId
  category?: string;
  createdAt: string;
  lastRunAt?: string;
  runCount: number;
  domain?: string;
  orgId?: string;
  /** Compatibility projection for the versioned, immutable workflow store. */
  lifecycleStatus?: 'draft' | 'published' | 'retired';
  runtimeWorkflowId?: string;
  runtimeVersion?: number;
  runtimeHash?: string;
}

export type WorkflowScope = { domain?: string; orgId?: string };

const NAMED_WORKFLOW_SETTING = 'lumi.named_workflows.v2';
const INFERRED_DRAFT_DYNAMIC_KEY_RE = /^(?:recipient|recipients|contact|contacts|message|body|content|text|prompt|query|question|target|destination|file|filename|filePath|path|url|email|phone|address|subject)$/i;
const INFERRED_DRAFT_SECRET_KEY_RE = /password|passphrase|passkey|secret|token|api.?key|credential|authorization|cookie|otp|captcha|verification.?code|pin/i;
const INFERRED_DRAFT_PII_VALUE_RE = /(?:\b[A-Z]:\\|(?:^|\s)\/(?:Users|home|var|tmp)\/|https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:\+?\d[\d\s()-]{6,}\d))/i;

function inferredDraftInputRef(stepIndex: number, path: string[]): { $inputRef: string } {
  const suffix = path
    .map(item => item.replace(/[^a-zA-Z0-9_]+/g, '_'))
    .filter(Boolean)
    .join('_') || 'value';
  return { $inputRef: `inputs.step_${stepIndex + 1}_${suffix}` };
}

function parameterizeInferredDraftValue(value: unknown, stepIndex: number, path: string[] = []): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => parameterizeInferredDraftValue(item, stepIndex, [...path, String(index)]));
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && INFERRED_DRAFT_PII_VALUE_RE.test(value)) {
      return inferredDraftInputRef(stepIndex, path);
    }
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    if (INFERRED_DRAFT_SECRET_KEY_RE.test(key)) return [key, item];
    if (INFERRED_DRAFT_DYNAMIC_KEY_RE.test(key)) {
      return [key, inferredDraftInputRef(stepIndex, [...path, key])];
    }
    return [key, parameterizeInferredDraftValue(item, stepIndex, [...path, key])];
  }));
}

function workflowDraftInputSchema(steps: WorkflowDefinition['steps']): Record<string, unknown> {
  const refs = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const ref = typeof record.$inputRef === 'string'
      ? record.$inputRef.replace(/^inputs\./, '')
      : typeof record.$secretRef === 'string'
        ? record.$secretRef.split('.').filter(Boolean).pop() || ''
        : '';
    if (ref) refs.add(ref);
    Object.values(record).forEach(visit);
  };
  steps.forEach(step => visit(step.args || {}));
  const names = Array.from(refs).sort();
  return {
    type: 'object',
    properties: Object.fromEntries(names.map(name => [name, { type: 'string' }])),
    required: names,
    additionalProperties: true,
  };
}

function storedWorkflows(db: any): WorkflowDefinition[] {
  const settings = Array.isArray(db.settings) ? db.settings : [];
  const row = settings.find((item: any) => item?.key === NAMED_WORKFLOW_SETTING);
  if (row?.value) {
    try {
      const parsed = JSON.parse(row.value);
      if (Array.isArray(parsed)) {
        db.workflows = parsed;
        return parsed;
      }
    } catch {
      // Rewrite the in-memory legacy projection on the next mutation.
    }
  }
  if (!Array.isArray(db.workflows)) db.workflows = [];
  return db.workflows;
}

function persistWorkflows(db: any, workflows: WorkflowDefinition[]): void {
  db.workflows = workflows;
  if (!Array.isArray(db.settings)) db.settings = [];
  const row = { key: NAMED_WORKFLOW_SETTING, value: JSON.stringify(workflows) };
  const index = db.settings.findIndex((item: any) => item?.key === NAMED_WORKFLOW_SETTING);
  if (index >= 0) db.settings[index] = row;
  else db.settings.push(row);
  writeDB(db);
}

function normalizedWorkflowScope(scope: WorkflowScope = {}): { domain: 'personal' | 'work'; orgId: string } {
  const domain = scope.domain === 'work' ? 'work' : 'personal';
  return { domain, orgId: domain === 'work' ? (scope.orgId || '') : '' };
}

function workflowMatchesScope(workflow: WorkflowDefinition, scope: WorkflowScope = {}): boolean {
  const normalized = normalizedWorkflowScope(scope);
  return (workflow.domain || 'personal') === normalized.domain && (workflow.orgId || '') === normalized.orgId;
}

function genId(): string {
  return 'wflow_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
}

export function saveWorkflow(
  userId: string,
  name: string,
  description: string,
  steps: WorkflowDefinition['steps'],
  agentAssignments?: Record<string, string>,
  category?: string,
  scope: WorkflowScope = {},
): WorkflowDefinition {
  const db = readDB();
  const workflows = storedWorkflows(db);

  // Upsert: if a workflow with same name exists for this user, update it
  const normalized = normalizedWorkflowScope(scope);
  const existing = workflows.find((w: WorkflowDefinition) =>
    w.userId === userId && w.name === name && workflowMatchesScope(w, normalized)
  );
  if (existing) {
    existing.description = description;
    existing.steps = steps;
    existing.agentAssignments = agentAssignments || existing.agentAssignments;
    existing.category = category || existing.category;
    persistWorkflows(db, workflows);
    return existing;
  }

  const wf: WorkflowDefinition = {
    id: genId(),
    userId,
    name,
    description,
    steps,
    agentAssignments,
    category,
    createdAt: new Date().toISOString(),
    runCount: 0,
    domain: normalized.domain,
    orgId: normalized.orgId,
  };
  workflows.push(wf);
  persistWorkflows(db, workflows);
  return wf;
}

export function listWorkflows(userId: string, category?: string, scope: WorkflowScope = {}): WorkflowDefinition[] {
  const db = readDB();
  return storedWorkflows(db)
    .filter((w: WorkflowDefinition) => w.userId === userId && workflowMatchesScope(w, scope) && (!category || w.category === category))
    .sort((a: WorkflowDefinition, b: WorkflowDefinition) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function getWorkflow(userId: string, name: string, scope: WorkflowScope = {}): WorkflowDefinition | null {
  const db = readDB();
  return storedWorkflows(db).find((w: WorkflowDefinition) => w.userId === userId && w.name === name && workflowMatchesScope(w, scope)) || null;
}

function runtimeSteps(steps: WorkflowDefinition['steps']): WorkflowStepDefinition[] {
  return steps.map((step, index) => ({
    stepId: `step_${index + 1}`,
    capabilityId: String(step.tool || (step.requiredSkill ? `skill:${step.requiredSkill}` : `unresolved:step_${index + 1}`)),
    capabilityContractId: step.capabilityContractId,
    capabilitySnapshot: step.capabilitySnapshot,
    description: step.description,
    dependsOn: index > 0 ? [`step_${index}`] : [],
    argumentsTemplate: step.args || {},
    retry: { maxAttempts: 1 },
    idempotency: { strategy: 'run_step' },
    confirmation: { required: true, reason: 'Published semi-automatic workflows remain user-intervenable.' },
    verification: { required: true, strategy: 'terminal_receipt' },
    onFailure: {
      action: 'pause',
      ...(step.reconciliationCapabilityId
        ? { fallbackCapabilityIds: [step.reconciliationCapabilityId] }
        : {}),
    },
    attachedReconciliation: step.attachedReconciliation,
  }));
}

/**
 * Captured and inferred behavior is never promoted directly into executable core logic.
 * It becomes a redacted, versioned workflow draft that must be reviewed and published.
 */
export function saveWorkflowDraftCandidate(
  userId: string,
  name: string,
  description: string,
  steps: WorkflowDefinition['steps'],
  provenance: VersionedWorkflowDefinition['provenance'],
  agentAssignments?: Record<string, string>,
  category?: string,
  scope: WorkflowScope = {},
): WorkflowDefinition {
  if (!steps.length) throw new Error('A workflow draft requires at least one step.');
  const inferredDraft = provenance.source === 'captured_draft' || provenance.source === 'learned_draft';
  const redactedSteps = steps.map((step, index) => {
    const redactedArgs = redactWorkflowValue(
      step.args || {},
      `legacy.steps.${index + 1}.args`,
    ) as Record<string, any>;
    return {
      ...step,
      args: (inferredDraft
        ? parameterizeInferredDraftValue(redactedArgs, index)
        : redactedArgs) as Record<string, any>,
    };
  });
  const legacy = saveWorkflow(userId, name, description, redactedSteps, agentAssignments, category, scope);
  const draft = createWorkflowDefinitionDraft({
    workflowId: legacy.runtimeWorkflowId || legacy.id,
    userId,
    scope: normalizedWorkflowScope(scope),
    title: name,
    description,
    triggerPolicy: { mode: 'explicit_only' },
    inputSchema: workflowDraftInputSchema(redactedSteps),
    outputSchema: {},
    steps: runtimeSteps(redactedSteps),
    provenance,
  });
  const db = readDB();
  const workflows = storedWorkflows(db);
  const stored = workflows.find((item: WorkflowDefinition) => item.id === legacy.id);
  if (stored) {
    stored.lifecycleStatus = 'draft';
    stored.runtimeWorkflowId = draft.workflowId;
    stored.runtimeVersion = draft.version;
    stored.runtimeHash = draft.hash;
    persistWorkflows(db, workflows);
    return stored;
  }
  return {
    ...legacy,
    lifecycleStatus: 'draft',
    runtimeWorkflowId: draft.workflowId,
    runtimeVersion: draft.version,
    runtimeHash: draft.hash,
  };
}

export function publishSavedWorkflow(
  userId: string,
  name: string,
  expectedHash: string,
  scope: WorkflowScope = {},
): WorkflowDefinition | null {
  const workflow = getWorkflow(userId, name, scope);
  if (!workflow?.runtimeWorkflowId || !workflow.runtimeVersion || !workflow.runtimeHash) return null;
  if (workflow.runtimeHash !== expectedHash) throw new Error('Workflow draft changed before publication. Review the latest version.');
  const published = publishWorkflowDefinition({
    workflowId: workflow.runtimeWorkflowId,
    version: workflow.runtimeVersion,
    expectedHash,
    userId,
  });
  const db = readDB();
  const workflows = storedWorkflows(db);
  const stored = workflows.find((item: WorkflowDefinition) => item.id === workflow.id);
  if (!stored) return null;
  stored.lifecycleStatus = 'published';
  stored.runtimeHash = published.hash;
  persistWorkflows(db, workflows);
  return stored;
}

/** Create a new reviewable draft when capability contracts need to be frozen or refreshed. */
export function refreshSavedWorkflowRuntimeDraft(
  userId: string,
  name: string,
  expectedHash: string,
  steps: WorkflowStepDefinition[],
  scope: WorkflowScope = {},
): WorkflowDefinition | null {
  const workflow = getWorkflow(userId, name, scope);
  if (!workflow?.runtimeWorkflowId || !workflow.runtimeVersion || !workflow.runtimeHash) return null;
  if (workflow.runtimeHash !== expectedHash) throw new Error('Workflow changed before capability review. Review the latest version.');
  const current = getVersionedWorkflowDefinition(
    workflow.runtimeWorkflowId,
    workflow.runtimeVersion,
    userId,
  );
  if (!current) return null;
  const draft = createWorkflowDefinitionDraft({
    workflowId: current.workflowId,
    userId,
    scope: current.scope,
    title: current.title,
    description: current.description,
    triggerPolicy: current.triggerPolicy,
    inputSchema: current.inputSchema,
    outputSchema: current.outputSchema,
    steps,
    provenance: {
      ...current.provenance,
      reviewedByUser: false,
      sourceRefs: Array.from(new Set([
        ...(current.provenance.sourceRefs || []),
        `capability-contract-refresh:${current.version}:${current.hash}`,
      ])),
    },
  });
  const db = readDB();
  const workflows = storedWorkflows(db);
  const stored = workflows.find((item: WorkflowDefinition) => item.id === workflow.id);
  if (!stored) return null;
  stored.steps = stored.steps.map((legacyStep, index) => ({
    ...legacyStep,
    capabilityContractId: steps[index]?.capabilityContractId,
    capabilitySnapshot: steps[index]?.capabilitySnapshot,
    attachedReconciliation: steps[index]?.attachedReconciliation,
  }));
  stored.lifecycleStatus = 'draft';
  stored.runtimeVersion = draft.version;
  stored.runtimeHash = draft.hash;
  persistWorkflows(db, workflows);
  return stored;
}

export function getSavedWorkflowRuntimeDefinition(workflow: WorkflowDefinition): VersionedWorkflowDefinition | null {
  if (!workflow.runtimeWorkflowId || !workflow.runtimeVersion) return null;
  return getVersionedWorkflowDefinition(workflow.runtimeWorkflowId, workflow.runtimeVersion, workflow.userId);
}

export function deleteWorkflow(userId: string, name: string, scope: WorkflowScope = {}): boolean {
  const db = readDB();
  const workflows = storedWorkflows(db);
  const idx = workflows.findIndex((w: WorkflowDefinition) => w.userId === userId && w.name === name && workflowMatchesScope(w, scope));
  if (idx < 0) return false;
  const workflow = workflows[idx] as WorkflowDefinition;
  if (workflow.lifecycleStatus === 'published' && workflow.runtimeWorkflowId && workflow.runtimeVersion && workflow.runtimeHash) {
    retireWorkflowDefinition({
      workflowId: workflow.runtimeWorkflowId,
      version: workflow.runtimeVersion,
      expectedHash: workflow.runtimeHash,
      userId,
    });
  }
  workflows.splice(idx, 1);
  persistWorkflows(db, workflows);
  return true;
}

export function recordWorkflowRun(userId: string, name: string, scope: WorkflowScope = {}): void {
  const db = readDB();
  const workflows = storedWorkflows(db);
  const wf = workflows.find((w: WorkflowDefinition) => w.userId === userId && w.name === name && workflowMatchesScope(w, scope));
  if (wf) {
    wf.lastRunAt = new Date().toISOString();
    wf.runCount++;
    persistWorkflows(db, workflows);
  }
}

/**
 * Convert an orchestrator task decomposition into a named workflow.
 * Called when the user says "remember this" after a successful orchestration run.
 */
export function captureFromOrchestration(
  userId: string,
  name: string,
  taskDescription: string,
  subTasks: SubTask[],
  agentAssignments: Record<string, string>,
  scope: WorkflowScope = {},
): WorkflowDefinition {
  const steps = subTasks.map(st => ({
    description: st.description,
    requiredSkill: st.requiredSkill,
    executionMode: st.executionMode,
  }));
  return saveWorkflowDraftCandidate(
    userId,
    name,
    taskDescription,
    steps,
    { source: 'captured_draft', sourceRefs: subTasks.map(task => task.id), reviewedByUser: false },
    agentAssignments,
    'captured',
    scope,
  );
}

/**
 * Auto-detect repeated behavior patterns from the worklog and create named workflows.
 * Called periodically by the scheduler. When Lumi notices the user doing the same
 * thing 3+ times, she auto-creates a workflow so the user can say "run my X routine".
 *
 * Returns the number of new workflows created.
 */
export async function autoGenerateWorkflows(userId: string, scope: WorkflowScope = {}): Promise<number> {
  try {
    const { findWorkflowClusters, getRecentWorkflows } = await import('../skills/worklog');

    const normalized = normalizedWorkflowScope(scope);
    const all = getRecentWorkflows(userId, normalized.domain, normalized.orgId);
    if (all.length < 3) return 0;

    const clusters = findWorkflowClusters(3, userId, normalized.domain, normalized.orgId);
    if (clusters.length === 0) return 0;

    let created = 0;

    for (const cluster of clusters) {
      // Only auto-create if similarity is high enough (confident pattern)
      if (cluster.avgSimilarity < 0.55) continue;

      const wf = cluster.workflows[0];
      const workflowUserId = wf.userId || userId;

      // Check if a workflow with a similar name already exists
      const existing = listWorkflows(workflowUserId, undefined, normalized);
      // Learned draft names are derived from capability names, not raw user
      // utterances, so contacts, messages and local paths cannot leak into UI.
      const nameBase = generateWorkflowName(wf.toolSequence.map(step => step.name).join(' '));
      if (existing.some(e => e.name === nameBase)) continue;

      const steps = wf.toolSequence.map(s => ({
        description: s.name,
        tool: s.name,
        args: s.args,
      }));

      const autoDesc = `Auto-generated from ${cluster.workflows.length} similar sessions. Average similarity: ${(cluster.avgSimilarity * 100).toFixed(0)}%`;

      saveWorkflowDraftCandidate(
        workflowUserId,
        nameBase,
        autoDesc,
        steps,
        {
          source: 'learned_draft',
          sourceRefs: cluster.workflows.map(item => item.id),
          reviewedByUser: false,
        },
        undefined,
        'auto',
        normalized,
      );
      console.log(`[WorkflowGen] Prepared workflow draft "${nameBase}" from ${cluster.workflows.length} sessions (similarity: ${cluster.avgSimilarity.toFixed(2)})`);
      created++;
    }

    return created;
  } catch (err) {
    console.error('[WorkflowGen] Auto-generation failed:', err);
    return 0;
  }
}

/** Generate a short, memorable name from the user's intent text */
function generateWorkflowName(intent: string): string {
  // Take first 4 meaningful words, max 40 chars
  const cleaned = intent
    .replace(/[，,。.！!？?、；;：:（）()【】\[\]「」『』""'']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter(w => w.length >= 2);
  if (words.length <= 3) return cleaned.slice(0, 40);

  // Use first 2 + last 2 words to form a descriptive name
  const first = words.slice(0, 2).join('');
  const last = words.slice(-2).join('');
  const name = (first + last).slice(0, 40);
  return name || cleaned.slice(0, 40);
}

/**
 * Capture the most recent tool execution trace as a named workflow.
 * Called when the user says "remember this" or "记下这个流程".
 */
export function captureRecentAsWorkflow(
  userId: string,
  name: string,
  toolTrace: Array<{ name: string; args: Record<string, any>; resultSummary: string }>,
  scope: WorkflowScope = {},
): WorkflowDefinition | null {
  if (toolTrace.length === 0) return null;

  const steps = toolTrace.map(t => ({
    description: t.name,
    tool: t.name,
    args: t.args,
  }));

  const description = `Captured workflow: ${name} (${steps.length} steps). Created from recent tool execution.`;
  return saveWorkflowDraftCandidate(
    userId,
    name,
    description,
    steps,
    { source: 'captured_draft', reviewedByUser: false },
    undefined,
    'manual',
    scope,
  );
}
