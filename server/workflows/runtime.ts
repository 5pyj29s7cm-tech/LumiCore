import { createHash, randomUUID } from 'crypto';
import { flushDBOrThrow, readDB, writeDB } from '../../db_layer';
import type { ToolExecutionRecord } from '../tools/types';
import {
  getCanonicalToolExecutionInputDigests,
  isCanonicalExternalCommitReconciliationRecord,
  isCanonicalToolExecutionRecord,
  toolExecutionInputDigests,
} from '../tools/execution_engine';

const WORKFLOW_RUNTIME_SETTING = 'lumi.workflow_runtime.v1';
const WORKFLOW_RUNTIME_SCHEMA_VERSION = 1 as const;
const SECRET_KEY_RE = /password|passphrase|passkey|secret|token|api.?key|credential|authorization|cookie|otp|captcha|verification.?code|pin/i;
const SECRET_VALUE_RE = /(?:bearer\s+[a-z0-9._~+/=-]{8,}|\bsk-[a-z0-9_-]{12,}\b)/i;

export type WorkflowDefinitionStatus = 'draft' | 'published' | 'retired';
export type WorkflowRunStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'waiting_confirmation'
  | 'blocked'
  | 'completed'
  | 'cancelled';

export interface WorkflowScope {
  domain: 'personal' | 'work';
  orgId: string;
}

export interface WorkflowStepDefinition {
  stepId: string;
  capabilityId: string;
  /** Stable manifest capability id frozen at publication for semantic verification. */
  capabilityContractId?: string;
  /** Publication-time capability contract. Compatible adapters may evolve, but
   * an old reviewed workflow can never silently acquire new semantics. */
  capabilitySnapshot?: {
    capabilityId: string;
    operation: string;
    risk: string;
    sideEffects: Array<{ type: string; scope?: string; reversible?: boolean }>;
    configuredSecurityLevel: string;
    parameterNames: string[];
    prerequisites: string[];
    parameterSchemaHash: string;
    verificationHash: string;
    provider?: string;
    trust: string;
    deprecated: boolean;
    replacedBy?: string;
    adapter?: {
      id: string;
      operations: string[];
      version?: string;
    };
    contractHash: string;
  };
  description?: string;
  dependsOn?: string[];
  argumentsTemplate?: Record<string, unknown>;
  preconditions?: Array<Record<string, unknown>>;
  retry?: {
    maxAttempts: number;
    backoffMs?: number;
    retryableOutcomes?: string[];
  };
  idempotency?: {
    strategy: 'none' | 'run_step' | 'external_key';
    keyTemplate?: string;
  };
  confirmation?: {
    required: boolean;
    reason?: string;
  };
  verification?: {
    required: boolean;
    strategy?: string;
  };
  onFailure?: {
    action: 'pause' | 'replan' | 'block';
    fallbackCapabilityIds?: string[];
  };
  attachedReconciliation?: {
    kind: 'tool_definition_hook';
    toolName: string;
    capabilityId: string;
    hookVersion: 1;
    implementationFingerprint: string;
  };
}

export interface WorkflowDefinition {
  schemaVersion: typeof WORKFLOW_RUNTIME_SCHEMA_VERSION;
  workflowId: string;
  version: number;
  hash: string;
  userId: string;
  scope: WorkflowScope;
  status: WorkflowDefinitionStatus;
  title: string;
  description: string;
  triggerPolicy: {
    mode: 'explicit_only' | 'model_selected' | 'scheduled';
    schedule?: string;
  };
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  steps: WorkflowStepDefinition[];
  provenance: {
    source: 'user_authored' | 'captured_draft' | 'learned_draft' | 'legacy_import' | 'system_bundle';
    sourceRefs?: string[];
    reviewedByUser: boolean;
  };
  createdAt: string;
  publishedAt?: string;
  retiredAt?: string;
}

export interface WorkflowRunEvent {
  sequence: number;
  eventId: string;
  type: string;
  at: string;
  actor: string;
  revision: number;
  detail?: Record<string, unknown>;
}

export interface WorkflowReceiptSnapshot {
  stepId: string;
  capabilityId: string;
  planRevision: number;
  executionId: string;
  idempotencyKey: string;
  recordId?: string;
  status: 'verified' | 'unverified' | 'failed' | 'unknown_outcome';
  result?: unknown;
  receipt?: unknown;
  reason?: string;
  argumentsDigest?: string;
  targetDigest?: string;
  recordedAt: string;
}

export interface WorkflowRun {
  schemaVersion: typeof WORKFLOW_RUNTIME_SCHEMA_VERSION;
  runId: string;
  workflowId: string;
  definitionVersion: number;
  definitionHash: string;
  userId: string;
  scope: WorkflowScope;
  status: WorkflowRunStatus;
  revision: number;
  planRevision: number;
  planSnapshot: WorkflowStepDefinition[];
  stepExecutions: Record<string, { semanticHash: string; idempotencyKey: string }>;
  variables: Record<string, unknown>;
  currentStepId?: string;
  receipts: WorkflowReceiptSnapshot[];
  events: WorkflowRunEvent[];
  createdAt: string;
  updatedAt: string;
  lease?: {
    leaseId: string;
    owner: string;
    expiresAt: string;
  };
  checkpoint?: {
    stepId?: string;
    detail?: Record<string, unknown>;
    updatedAt: string;
  };
  pendingExecution?: {
    stepId: string;
    capabilityId: string;
    executionId: string;
    idempotencyKey: string;
    argumentsDigest: string;
    targetDigest: string;
    phase: 'prepared' | 'adapter_started';
    startedAt: string;
    adapterStartedAt?: string;
    originContext?: {
      conversationId?: string;
      source?: string;
    };
  };
  pauseRequestedAt?: string;
  cancelRequestedAt?: string;
  confirmation?: {
    confirmationId: string;
    stepId: string;
    capabilityId: string;
    reason: string;
    argumentsDigest: string;
    targetDigest: string;
    /** Redacted, bounded preview shown to the user before exact-step approval. */
    argumentPreview?: unknown;
    requestedAt: string;
  };
  /** Approvals are bound to one frozen plan revision and exact step. */
  stepApprovals?: Record<string, {
    planRevision: number;
    argumentsDigest: string;
    targetDigest: string;
    approvedAt: string;
  }>;
  completedAt?: string;
  blockedReason?: string;
  blockedKind?: 'verification_failed' | 'unknown_outcome' | 'expired_lease' | 'policy' | 'execution_error' | 'legacy_review_required' | 'capability_contract_changed';
  reconciliationRequired?: boolean;
}

interface WorkflowRuntimeStore {
  schemaVersion: typeof WORKFLOW_RUNTIME_SCHEMA_VERSION;
  definitions: WorkflowDefinition[];
  runs: WorkflowRun[];
}

export class WorkflowRevisionConflictError extends Error {
  constructor(runId: string, expected: number, actual: number) {
    super(`Workflow run ${runId} revision conflict: expected ${expected}, actual ${actual}.`);
    this.name = 'WorkflowRevisionConflictError';
  }
}

export class WorkflowStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowStateError';
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeScope(scope?: Partial<WorkflowScope>): WorkflowScope {
  const domain = scope?.domain === 'work' ? 'work' : 'personal';
  return { domain, orgId: domain === 'work' ? String(scope?.orgId || '') : '' };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

function definitionHash(input: Omit<WorkflowDefinition, 'hash' | 'status' | 'createdAt' | 'publishedAt' | 'retiredAt'>): string {
  const hashable = clone(input) as Omit<WorkflowDefinition, 'hash' | 'status' | 'createdAt' | 'publishedAt' | 'retiredAt'>;
  // Review/publish is an attestation over semantic content, not a content mutation.
  delete (hashable.provenance as Partial<WorkflowDefinition['provenance']>).reviewedByUser;
  return createHash('sha256').update(JSON.stringify(stableValue(hashable))).digest('hex');
}

function secretReference(path: string): Record<string, string> {
  return { $secretRef: path || 'runtime_input' };
}

/** Values written to the workflow ledger never contain credentials or raw provider secrets. */
export function redactWorkflowValue(value: unknown, path = 'value', depth = 0): unknown {
  if (depth > 8) return '[nested data omitted]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item, index) => redactWorkflowValue(item, `${path}.${index}`, depth + 1));
  if (typeof value === 'string') {
    if (SECRET_VALUE_RE.test(value)) return secretReference(path);
    const trimmed = value.trim();
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length <= 100_000) {
      try { return redactWorkflowValue(JSON.parse(trimmed), path, depth + 1); } catch { /* Preserve non-JSON text below. */ }
    }
    const scrubbed = value.replace(
      /((?:password|passphrase|passkey|secret|token|api.?key|credential|authorization|cookie|otp|captcha|verification.?code|pin)\s*["']?\s*[:=]\s*["']?)([^,\s"'\\}]+)/gi,
      '$1[redacted]',
    );
    return scrubbed.length > 8_000 ? `${scrubbed.slice(0, 8_000)}...` : scrubbed;
  }
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 120)
      .map(([key, item]) => [
        key,
        SECRET_KEY_RE.test(key)
          ? secretReference(`${path}.${key}`)
          : redactWorkflowValue(item, `${path}.${key}`, depth + 1),
      ]),
  );
}

function boundedRedactedWorkflowValue(value: unknown, path: string, maxChars = 4_000): unknown {
  const redacted = redactWorkflowValue(value, path);
  let serialized = '';
  try { serialized = JSON.stringify(redacted); } catch { serialized = String(redacted ?? ''); }
  if (serialized.length <= maxChars) return redacted;
  return {
    truncated: true,
    preview: serialized.slice(0, maxChars),
  };
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

/** Resolve persisted references from ephemeral run inputs without writing the secret back to the ledger. */
export function resolveWorkflowValue(template: unknown, ephemeralInputs: Record<string, unknown>, depth = 0): unknown {
  if (depth > 8) throw new WorkflowStateError('Workflow argument template is nested too deeply.');
  if (Array.isArray(template)) return template.map(item => resolveWorkflowValue(item, ephemeralInputs, depth + 1));
  if (!template || typeof template !== 'object') return template;
  const record = template as Record<string, unknown>;
  const reference = typeof record.$secretRef === 'string'
    ? record.$secretRef
    : typeof record.$inputRef === 'string'
      ? record.$inputRef
      : '';
  if (reference && Object.keys(record).length === 1) {
    const direct = valueAtPath(ephemeralInputs, reference.replace(/^inputs\./, ''));
    const fallbackKey = reference.split('.').filter(Boolean).pop() || '';
    const fallback = fallbackKey ? ephemeralInputs[fallbackKey] : undefined;
    const resolved = direct === undefined ? fallback : direct;
    if (resolved === undefined) throw new WorkflowStateError(`Workflow input '${fallbackKey || reference}' must be supplied at run time.`);
    return resolved;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, resolveWorkflowValue(item, ephemeralInputs, depth + 1)]),
  );
}

function normalizeStep(step: WorkflowStepDefinition, index: number): WorkflowStepDefinition {
  const stepId = String(step.stepId || `step_${index + 1}`).trim();
  const capabilityId = String(step.capabilityId || '').trim();
  if (!stepId) throw new WorkflowStateError(`Workflow step ${index + 1} is missing stepId.`);
  if (!capabilityId) throw new WorkflowStateError(`Workflow step ${stepId} is missing capabilityId.`);
  return {
    ...clone(step),
    stepId,
    capabilityId,
    dependsOn: [...new Set((step.dependsOn || []).map(String))],
    argumentsTemplate: redactWorkflowValue(step.argumentsTemplate || {}, `definition.steps.${stepId}.arguments`) as Record<string, unknown>,
  };
}

function validateSteps(steps: WorkflowStepDefinition[]): WorkflowStepDefinition[] {
  if (!Array.isArray(steps) || steps.length === 0) throw new WorkflowStateError('A workflow requires at least one step.');
  const normalized = steps.map(normalizeStep);
  const ids = new Set<string>();
  for (const step of normalized) {
    if (ids.has(step.stepId)) throw new WorkflowStateError(`Duplicate workflow stepId '${step.stepId}'.`);
    ids.add(step.stepId);
  }
  for (const step of normalized) {
    for (const dependency of step.dependsOn || []) {
      if (!ids.has(dependency)) throw new WorkflowStateError(`Workflow step '${step.stepId}' depends on missing step '${dependency}'.`);
      if (dependency === step.stepId) throw new WorkflowStateError(`Workflow step '${step.stepId}' cannot depend on itself.`);
    }
  }
  topologicallyOrderWorkflowSteps(normalized);
  return normalized;
}

export function topologicallyOrderWorkflowSteps(steps: WorkflowStepDefinition[]): WorkflowStepDefinition[] {
  const byId = new Map(steps.map(step => [step.stepId, step]));
  const pending = new Map(steps.map((step, index) => [step.stepId, {
    step,
    index,
    dependencies: new Set(step.dependsOn || []),
  }]));
  const completed = new Set<string>();
  const ordered: WorkflowStepDefinition[] = [];
  while (pending.size > 0) {
    const ready = Array.from(pending.values())
      .filter(item => Array.from(item.dependencies).every(dependency => completed.has(dependency)))
      .sort((left, right) => left.index - right.index);
    if (ready.length === 0) {
      const unresolved = Array.from(pending.keys()).join(', ');
      throw new WorkflowStateError(`Workflow dependency cycle detected among: ${unresolved}.`);
    }
    for (const item of ready) {
      if (!byId.has(item.step.stepId)) continue;
      pending.delete(item.step.stepId);
      completed.add(item.step.stepId);
      ordered.push(clone(item.step));
    }
  }
  return ordered;
}

function workflowStepSemanticHash(step: WorkflowStepDefinition): string {
  return createHash('sha256').update(JSON.stringify(stableValue(step))).digest('hex');
}

function buildWorkflowStepExecution(runId: string, planRevision: number, step: WorkflowStepDefinition): { semanticHash: string; idempotencyKey: string } {
  const semanticHash = workflowStepSemanticHash(step);
  return {
    semanticHash,
    idempotencyKey: `workflow:${runId}:plan:${planRevision}:step:${step.stepId}:${semanticHash.slice(0, 16)}`,
  };
}

export function workflowStepExecutionKey(
  run: Pick<WorkflowRun, 'runId' | 'planRevision'> & Partial<Pick<WorkflowRun, 'stepExecutions'>>,
  stepId: string,
): string {
  return run.stepExecutions?.[stepId]?.idempotencyKey || `workflow:${run.runId}:plan:${run.planRevision}:step:${stepId}`;
}

export function workflowReconciliationExecutionKey(run: Pick<WorkflowRun, 'runId' | 'planRevision'>, stepId: string): string {
  return `workflow:${run.runId}:plan:${run.planRevision}:reconcile:${stepId}`;
}

function pendingExecutionMayHaveSideEffects(run: WorkflowRun): boolean {
  if (!run.pendingExecution) return false;
  const step = run.planSnapshot.find(item => item.stepId === run.pendingExecution!.stepId);
  // Legacy/unreviewed contracts fail closed. A reviewed empty side-effect
  // envelope is safe to recompute after lease fencing because it cannot commit.
  if (!step?.capabilitySnapshot) return true;
  return step.capabilitySnapshot.sideEffects.length > 0;
}

function migratedStepExecutions(run: Partial<WorkflowRun>): WorkflowRun['stepExecutions'] {
  const existing = run.stepExecutions || {};
  const receipts = Array.isArray(run.receipts) ? run.receipts : [];
  return Object.fromEntries((run.planSnapshot || []).map(step => {
    const current = existing[step.stepId];
    if (current?.idempotencyKey) return [step.stepId, current];
    const historical = [...receipts].reverse().find(receipt => (
      receipt.stepId === step.stepId
      && receipt.capabilityId === step.capabilityId
      && receipt.planRevision === run.planRevision
      && (receipt.status === 'verified' || receipt.status === 'unknown_outcome')
      && Boolean(receipt.idempotencyKey)
    ));
    return [
      step.stepId,
      {
        semanticHash: workflowStepSemanticHash(step),
        idempotencyKey: historical?.idempotencyKey
          || `workflow:${String(run.runId || '')}:plan:${Number(run.planRevision) || 1}:step:${step.stepId}`,
      },
    ];
  }));
}

function migrateStoredRun(raw: WorkflowRun): WorkflowRun {
  const hadExecutionIdentities = Boolean(raw.stepExecutions && Object.keys(raw.stepExecutions).length > 0);
  const run = {
    ...raw,
    stepExecutions: migratedStepExecutions(raw),
    stepApprovals: raw.stepApprovals || {},
    pendingExecution: raw.pendingExecution
      ? {
          ...raw.pendingExecution,
          // Old ledgers could not durably distinguish pre-handler from
          // post-handler state. Treat them as possibly committed.
          phase: raw.pendingExecution.phase || 'adapter_started',
        }
      : undefined,
  } as WorkflowRun;
  if (raw.pendingExecution && !raw.pendingExecution.phase) {
    run.status = 'blocked';
    run.lease = undefined;
    run.blockedKind = 'unknown_outcome';
    run.reconciliationRequired = true;
    run.blockedReason = 'This run predates durable adapter-start phases. Its pending side effect is treated as possibly committed and requires read-only reconciliation.';
  }
  if (hadExecutionIdentities || run.status === 'completed'
    || (run.status === 'cancelled' && !run.pendingExecution && !run.reconciliationRequired)) return run;
  const ambiguous = run.planSnapshot.find(step => run.receipts.some(receipt => (
    receipt.stepId === step.stepId
    && receipt.capabilityId === step.capabilityId
    && receipt.planRevision !== run.planRevision
    && (receipt.status === 'verified' || receipt.status === 'unknown_outcome')
  )));
  if (!ambiguous) return run;
  const historical = [...run.receipts].reverse().find(receipt => (
    receipt.stepId === ambiguous.stepId
    && receipt.capabilityId === ambiguous.capabilityId
    && receipt.planRevision !== run.planRevision
    && (receipt.status === 'verified' || receipt.status === 'unknown_outcome')
  ));
  run.status = 'blocked';
  const canReconcileExactTarget = historical?.argumentsDigest !== undefined
    && historical.targetDigest !== undefined;
  run.blockedKind = canReconcileExactTarget ? 'unknown_outcome' : 'legacy_review_required';
  run.reconciliationRequired = canReconcileExactTarget;
  run.blockedReason = canReconcileExactTarget
    ? 'A legacy workflow receipt belongs to an older plan revision and cannot prove the current step semantics. Reconcile before any replay.'
    : 'A legacy receipt lacks the exact target evidence required for safe reconciliation. Review and explicitly cancel this old run before starting a replacement; it cannot be resumed or replayed automatically.';
  if (!run.pendingExecution && canReconcileExactTarget && historical) {
    const execution = run.stepExecutions[ambiguous.stepId];
    run.pendingExecution = {
      stepId: ambiguous.stepId,
      capabilityId: ambiguous.capabilityId,
      executionId: execution.idempotencyKey,
      idempotencyKey: execution.idempotencyKey,
      argumentsDigest: historical.argumentsDigest,
      targetDigest: historical.targetDigest,
      phase: 'adapter_started',
      startedAt: historical.recordedAt,
    };
  }
  return run;
}

function loadStore(): WorkflowRuntimeStore {
  const db = readDB();
  const settings = Array.isArray(db.settings) ? db.settings : [];
  const row = settings.find((item: any) => item?.key === WORKFLOW_RUNTIME_SETTING);
  if (!row?.value) return { schemaVersion: WORKFLOW_RUNTIME_SCHEMA_VERSION, definitions: [], runs: [] };
  try {
    const parsed = JSON.parse(row.value) as Partial<WorkflowRuntimeStore>;
    return {
      schemaVersion: WORKFLOW_RUNTIME_SCHEMA_VERSION,
      definitions: Array.isArray(parsed.definitions) ? parsed.definitions : [],
      runs: Array.isArray(parsed.runs)
        ? parsed.runs.map(run => migrateStoredRun(run as WorkflowRun))
        : [],
    };
  } catch (error) {
    throw new WorkflowStateError(`Workflow runtime store is unreadable and was left untouched: ${String((error as Error)?.message || error)}`);
  }
}

function saveStore(store: WorkflowRuntimeStore): void {
  const db = readDB();
  if (!Array.isArray(db.settings)) db.settings = [];
  const row = { key: WORKFLOW_RUNTIME_SETTING, value: JSON.stringify(store) };
  const index = db.settings.findIndex((item: any) => item?.key === WORKFLOW_RUNTIME_SETTING);
  if (index >= 0) db.settings[index] = row;
  else db.settings.push(row);
  writeDB(db);
}

function getMutableRun(store: WorkflowRuntimeStore, runId: string): WorkflowRun {
  const run = store.runs.find(item => item.runId === runId);
  if (!run) throw new WorkflowStateError(`Workflow run '${runId}' was not found.`);
  return run;
}

function assertRevision(run: WorkflowRun, expectedRevision: number): void {
  if (run.revision !== expectedRevision) throw new WorkflowRevisionConflictError(run.runId, expectedRevision, run.revision);
}

function appendEvent(
  run: WorkflowRun,
  type: string,
  actor: string,
  detail?: Record<string, unknown>,
): void {
  run.events.push({
    sequence: run.events.length + 1,
    eventId: randomUUID(),
    type,
    at: nowIso(),
    actor,
    revision: run.revision,
    detail: detail ? redactWorkflowValue(detail, `events.${run.events.length + 1}`) as Record<string, unknown> : undefined,
  });
}

function canonicalReceiptSnapshot(
  run: WorkflowRun,
  stepId: string,
  capabilityId: string,
  record: ToolExecutionRecord,
): Omit<WorkflowReceiptSnapshot, 'recordedAt'> {
  const expectedKey = workflowStepExecutionKey(run, stepId);
  if (!isCanonicalToolExecutionRecord(record)) throw new WorkflowStateError('Workflow receipts must originate from the canonical tool executor.');
  if (!record.envelope) throw new WorkflowStateError('Workflow receipts must come from the canonical tool executor.');
  if (record.id !== expectedKey) throw new WorkflowStateError(`Workflow receipt record identity mismatch for step '${stepId}'.`);
  if (record.name !== capabilityId || record.envelope.toolName !== capabilityId) {
    throw new WorkflowStateError(`Workflow receipt capability mismatch for step '${stepId}'.`);
  }
  if (record.taskId !== run.runId || record.envelope.taskId !== run.runId) {
    throw new WorkflowStateError(`Workflow receipt task identity mismatch for step '${stepId}'.`);
  }
  if (record.idempotencyKey !== expectedKey || record.envelope.idempotencyKey !== expectedKey) {
    throw new WorkflowStateError(`Workflow receipt execution identity mismatch for step '${stepId}'.`);
  }
  const pending = run.pendingExecution;
  const inputDigests = getCanonicalToolExecutionInputDigests(record);
  if (!pending
    || pending.stepId !== stepId
    || pending.capabilityId !== capabilityId
    || pending.executionId !== expectedKey
    || pending.idempotencyKey !== expectedKey
    || !inputDigests
    || pending.argumentsDigest !== inputDigests.argumentsDigest
    || pending.targetDigest !== inputDigests.targetDigest) {
    throw new WorkflowStateError(`Workflow receipt input identity mismatch for step '${stepId}'.`);
  }
  const verified = record.terminalVerification?.status === 'verified'
    && record.envelope.status === 'verified_success'
    && record.envelope.verification.status === 'verified';
  const hasSideEffects = (record.capability?.sideEffects || []).length > 0;
  const definitelyNotStarted = record.envelope.status === 'waiting_confirmation'
    || record.envelope.status === 'forbidden'
    || record.envelope.status === 'target_mismatch';
  const unknownOutcome = record.envelope.status === 'unknown_outcome'
    || (hasSideEffects && record.adapterStarted === true && !verified && !definitelyNotStarted);
  let parsedResult: unknown = record.receipt;
  if (parsedResult === undefined) {
    try { parsedResult = JSON.parse(record.result || 'null'); } catch { parsedResult = record.result; }
  }
  return {
    stepId,
    capabilityId,
    planRevision: run.planRevision,
    executionId: String(record.id || expectedKey),
    idempotencyKey: expectedKey,
    recordId: record.id,
    status: verified ? 'verified' : unknownOutcome ? 'unknown_outcome' : record.error ? 'failed' : 'unverified',
    result: parsedResult,
    receipt: record.receipt,
    reason: record.error || record.terminalVerification?.reason || record.envelope.verification.reason,
    argumentsDigest: inputDigests.argumentsDigest,
    targetDigest: inputDigests.targetDigest,
  };
}

function mutateRun(
  runId: string,
  expectedRevision: number,
  userId: string,
  actor: string,
  eventType: string,
  mutation: (run: WorkflowRun) => Record<string, unknown> | void,
): WorkflowRun {
  const store = loadStore();
  const run = getMutableRun(store, runId);
  if (run.userId !== userId) throw new WorkflowStateError(`Workflow run '${runId}' was not found for this user.`);
  assertRevision(run, expectedRevision);
  const detail = mutation(run);
  run.revision += 1;
  run.updatedAt = nowIso();
  appendEvent(run, eventType, actor, detail || undefined);
  saveStore(store);
  return clone(run);
}

export function createWorkflowDefinitionDraft(input: {
  workflowId?: string;
  userId: string;
  scope?: Partial<WorkflowScope>;
  title: string;
  description?: string;
  triggerPolicy?: WorkflowDefinition['triggerPolicy'];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  steps: WorkflowStepDefinition[];
  provenance: WorkflowDefinition['provenance'];
}): WorkflowDefinition {
  const store = loadStore();
  const workflowId = String(input.workflowId || `workflow_${randomUUID()}`);
  const prior = store.definitions.filter(item => item.workflowId === workflowId);
  if (prior.some(item => item.userId !== input.userId)) throw new WorkflowStateError('Workflow ownership cannot change between versions.');
  const version = prior.reduce((max, item) => Math.max(max, item.version), 0) + 1;
  const triggerPolicy: WorkflowDefinition['triggerPolicy'] = input.triggerPolicy
    ? clone(input.triggerPolicy)
    : { mode: 'explicit_only' };
  const semantic: Omit<WorkflowDefinition, 'hash' | 'status' | 'createdAt' | 'publishedAt' | 'retiredAt'> = {
    schemaVersion: WORKFLOW_RUNTIME_SCHEMA_VERSION,
    workflowId,
    version,
    userId: String(input.userId),
    scope: normalizeScope(input.scope),
    title: String(input.title || 'Untitled workflow').slice(0, 160),
    description: String(input.description || '').slice(0, 2_000),
    triggerPolicy,
    inputSchema: redactWorkflowValue(input.inputSchema || {}, 'definition.inputSchema') as Record<string, unknown>,
    outputSchema: redactWorkflowValue(input.outputSchema || {}, 'definition.outputSchema') as Record<string, unknown>,
    steps: validateSteps(input.steps),
    provenance: {
      ...clone(input.provenance),
      sourceRefs: [...new Set((input.provenance.sourceRefs || []).map(String))].slice(0, 40),
      reviewedByUser: Boolean(input.provenance.reviewedByUser),
    },
  };
  const definition: WorkflowDefinition = {
    ...semantic,
    hash: definitionHash(semantic),
    status: 'draft',
    createdAt: nowIso(),
  };
  store.definitions.push(definition);
  saveStore(store);
  return clone(definition);
}

export function publishWorkflowDefinition(input: {
  workflowId: string;
  version: number;
  expectedHash: string;
  userId: string;
}): WorkflowDefinition {
  const store = loadStore();
  const definition = store.definitions.find(item => item.workflowId === input.workflowId && item.version === input.version);
  if (!definition || definition.userId !== input.userId) throw new WorkflowStateError('Workflow draft was not found.');
  if (definition.hash !== input.expectedHash) throw new WorkflowStateError('Workflow draft changed before publication. Review the latest version.');
  if (definition.status !== 'draft') throw new WorkflowStateError(`Only draft workflows can be published; current status is '${definition.status}'.`);
  definition.status = 'published';
  definition.publishedAt = nowIso();
  definition.provenance.reviewedByUser = true;
  const semantic = clone(definition) as Partial<WorkflowDefinition>;
  delete semantic.hash;
  delete semantic.status;
  delete semantic.createdAt;
  delete semantic.publishedAt;
  delete semantic.retiredAt;
  definition.hash = definitionHash(semantic as Omit<WorkflowDefinition, 'hash' | 'status' | 'createdAt' | 'publishedAt' | 'retiredAt'>);
  saveStore(store);
  return clone(definition);
}

export function retireWorkflowDefinition(input: {
  workflowId: string;
  version: number;
  expectedHash: string;
  userId: string;
}): WorkflowDefinition {
  const store = loadStore();
  const definition = store.definitions.find(item => item.workflowId === input.workflowId && item.version === input.version);
  if (!definition || definition.userId !== input.userId) throw new WorkflowStateError('Published workflow was not found.');
  if (definition.hash !== input.expectedHash) throw new WorkflowStateError('Workflow definition hash mismatch.');
  if (definition.status !== 'published') throw new WorkflowStateError('Only a published workflow can be retired.');
  definition.status = 'retired';
  definition.retiredAt = nowIso();
  saveStore(store);
  return clone(definition);
}

export function listWorkflowDefinitions(userId: string, workflowId?: string): WorkflowDefinition[] {
  return loadStore().definitions
    .filter(item => item.userId === userId && (!workflowId || item.workflowId === workflowId))
    .sort((left, right) => left.workflowId.localeCompare(right.workflowId) || left.version - right.version)
    .map(clone);
}

export function getWorkflowDefinition(workflowId: string, version: number, userId: string): WorkflowDefinition | null {
  const definition = loadStore().definitions.find(item => (
    item.workflowId === workflowId && item.version === version && item.userId === userId
  ));
  return definition ? clone(definition) : null;
}

export function createWorkflowRun(input: {
  workflowId: string;
  version: number;
  userId: string;
  variables?: Record<string, unknown>;
  actor?: string;
}): WorkflowRun {
  const store = loadStore();
  const definition = store.definitions.find(item => (
    item.workflowId === input.workflowId && item.version === input.version && item.userId === input.userId
  ));
  if (!definition) throw new WorkflowStateError('Workflow definition was not found.');
  if (definition.status !== 'published') throw new WorkflowStateError('Only a published workflow version can start a run.');
  const createdAt = nowIso();
  const planSnapshot = clone(definition.steps);
  const runId = `wrun_${randomUUID()}`;
  const run: WorkflowRun = {
    schemaVersion: WORKFLOW_RUNTIME_SCHEMA_VERSION,
    runId,
    workflowId: definition.workflowId,
    definitionVersion: definition.version,
    definitionHash: definition.hash,
    userId: definition.userId,
    scope: clone(definition.scope),
    status: 'queued',
    revision: 0,
    planRevision: 1,
    planSnapshot,
    stepExecutions: Object.fromEntries(planSnapshot.map(step => [
      step.stepId,
      buildWorkflowStepExecution(runId, 1, step),
    ])),
    variables: redactWorkflowValue(input.variables || {}, 'run.variables') as Record<string, unknown>,
    currentStepId: definition.steps[0]?.stepId,
    receipts: [],
    events: [],
    stepApprovals: {},
    createdAt,
    updatedAt: createdAt,
  };
  appendEvent(run, 'run_created', input.actor || 'user', {
    definitionVersion: definition.version,
    definitionHash: definition.hash,
  });
  store.runs.push(run);
  saveStore(store);
  return clone(run);
}

export function getWorkflowRun(runId: string, userId: string): WorkflowRun | null {
  const run = loadStore().runs.find(item => item.runId === runId && item.userId === userId);
  return run ? clone(run) : null;
}

/** Prevent a replacement invocation from bypassing unfinished or unknown work. */
export function findBlockingWorkflowRun(workflowId: string, userId: string): WorkflowRun | null {
  const candidates = loadStore().runs
    .filter(run => run.workflowId === workflowId && run.userId === userId)
    .filter(run => run.status !== 'completed' && run.status !== 'cancelled')
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return candidates[0] ? clone(candidates[0]) : null;
}

export function listWorkflowRuns(userId: string, workflowId?: string): WorkflowRun[] {
  return loadStore().runs
    .filter(item => item.userId === userId && (!workflowId || item.workflowId === workflowId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .map(clone);
}

export function claimWorkflowRun(input: {
  runId: string;
  expectedRevision: number;
  userId: string;
  owner: string;
  leaseMs?: number;
}): WorkflowRun {
  return mutateRun(input.runId, input.expectedRevision, input.userId, input.owner, 'run_claimed', run => {
    if (run.status !== 'queued') throw new WorkflowStateError(`Cannot claim a workflow run in '${run.status}' state.`);
    const leaseMs = Math.max(5_000, Math.min(input.leaseMs || 60_000, 10 * 60_000));
    run.status = 'running';
    run.lease = { leaseId: randomUUID(), owner: input.owner, expiresAt: new Date(Date.now() + leaseMs).toISOString() };
    return { leaseId: run.lease.leaseId, expiresAt: run.lease.expiresAt };
  });
}

/** Keep a live worker lease durable while a long adapter is running. */
export async function renewWorkflowRunLease(input: {
  runId: string;
  userId: string;
  leaseId: string;
  owner: string;
  leaseMs?: number;
}): Promise<WorkflowRun> {
  const current = getWorkflowRun(input.runId, input.userId);
  if (!current || current.status !== 'running' || current.lease?.leaseId !== input.leaseId) {
    throw new WorkflowStateError('The workflow worker lease is no longer active.');
  }
  if (current.pauseRequestedAt || current.cancelRequestedAt) {
    throw new WorkflowStateError('Workflow control changed while the worker was running.');
  }
  const renewed = mutateRun(current.runId, current.revision, current.userId, input.owner, 'lease_renewed', run => {
    if (run.status !== 'running' || run.lease?.leaseId !== input.leaseId) {
      throw new WorkflowStateError('The workflow worker lease changed before renewal.');
    }
    const leaseMs = Math.max(30_000, Math.min(input.leaseMs || 120_000, 10 * 60_000));
    run.lease.expiresAt = new Date(Date.now() + leaseMs).toISOString();
    return { leaseId: run.lease.leaseId, expiresAt: run.lease.expiresAt };
  });
  await flushDBOrThrow();
  return renewed;
}

export function requestWorkflowPause(input: {
  runId: string;
  expectedRevision: number;
  userId: string;
  actor: string;
}): WorkflowRun {
  return mutateRun(input.runId, input.expectedRevision, input.userId, input.actor, 'pause_requested', run => {
    if (run.status === 'waiting_confirmation') {
      run.status = 'paused';
      run.confirmation = undefined;
      return { immediate: true, confirmationDismissed: true };
    }
    if (run.status === 'queued') {
      run.status = 'paused';
      run.pauseRequestedAt = undefined;
      return { immediate: true };
    }
    if (run.status !== 'running') throw new WorkflowStateError(`Cannot pause a workflow run in '${run.status}' state.`);
    if (run.pendingExecution?.phase === 'prepared') {
      run.pendingExecution = undefined;
      run.status = 'paused';
      run.lease = undefined;
      return { immediate: true, adapterStarted: false };
    }
    run.pauseRequestedAt = nowIso();
    return { immediate: false, checkpointRequired: true };
  });
}

export function resumeWorkflowRun(input: {
  runId: string;
  expectedRevision: number;
  userId: string;
  actor: string;
}): WorkflowRun {
  return mutateRun(input.runId, input.expectedRevision, input.userId, input.actor, 'run_resumed', run => {
    if (run.status !== 'paused' && run.status !== 'blocked') {
      throw new WorkflowStateError(`Cannot resume a workflow run in '${run.status}' state.`);
    }
    if (run.reconciliationRequired) {
      throw new WorkflowStateError('This workflow has an unknown side-effect outcome. A verified read-only reconciliation is required before resume.');
    }
    if (run.blockedKind === 'legacy_review_required' || run.blockedKind === 'capability_contract_changed') {
      throw new WorkflowStateError('This workflow run requires explicit review and cannot be resumed automatically.');
    }
    if (run.pendingExecution) {
      throw new WorkflowStateError('This workflow still has an unresolved prepared execution and cannot resume.');
    }
    run.status = 'queued';
    run.pauseRequestedAt = undefined;
    run.blockedReason = undefined;
    run.blockedKind = undefined;
    run.reconciliationRequired = false;
    run.lease = undefined;
  });
}

export function requestWorkflowCancel(input: {
  runId: string;
  expectedRevision: number;
  userId: string;
  actor: string;
}): WorkflowRun {
  return mutateRun(input.runId, input.expectedRevision, input.userId, input.actor, 'cancel_requested', run => {
    if (run.status === 'completed' || run.status === 'cancelled') {
      throw new WorkflowStateError(`Cannot cancel a workflow run in '${run.status}' state.`);
    }
    if (run.pendingExecution || run.reconciliationRequired) {
      if (run.pendingExecution?.phase === 'prepared' && !run.reconciliationRequired) {
        run.pendingExecution = undefined;
        run.status = 'cancelled';
        run.completedAt = nowIso();
        run.lease = undefined;
        return { immediate: true, adapterStarted: false };
      }
      run.cancelRequestedAt = nowIso();
      return {
        immediate: false,
        reconciliationRequired: true,
        reason: 'Cancelling remaining work cannot erase a possibly committed side effect.',
      };
    }
    if (run.status === 'running') {
      run.cancelRequestedAt = nowIso();
      return { immediate: false, checkpointRequired: true };
    }
    run.status = 'cancelled';
    run.completedAt = nowIso();
    run.lease = undefined;
    return { immediate: true };
  });
}

/** Persist a redacted execution identity before a side-effecting adapter starts. */
export async function prepareWorkflowStepExecution(input: {
  runId: string;
  expectedRevision: number;
  userId: string;
  leaseId: string;
  actor: string;
  stepId: string;
  capabilityId: string;
  arguments: Record<string, unknown>;
  originContext?: {
    conversationId?: string;
    source?: string;
  };
}): Promise<WorkflowRun> {
  const prepared = mutateRun(input.runId, input.expectedRevision, input.userId, input.actor, 'step_execution_prepared', run => {
    if (run.status !== 'running' || run.lease?.leaseId !== input.leaseId) {
      throw new WorkflowStateError('A live workflow lease is required to prepare a workflow step.');
    }
    if (new Date(run.lease.expiresAt).getTime() <= Date.now()) throw new WorkflowStateError('Workflow run lease expired before step preparation.');
    const step = run.planSnapshot.find(item => item.stepId === input.stepId);
    if (!step || step.capabilityId !== input.capabilityId) throw new WorkflowStateError('Workflow step identity changed before execution.');
    for (const dependency of step.dependsOn || []) {
      const dependencyKey = workflowStepExecutionKey(run, dependency);
      if (!run.receipts.some(receipt => receipt.stepId === dependency && receipt.idempotencyKey === dependencyKey && receipt.status === 'verified')) {
        throw new WorkflowStateError(`Workflow step '${step.stepId}' cannot start before dependency '${dependency}' is verified.`);
      }
    }
    if (run.pendingExecution) {
      throw new WorkflowStateError(`Workflow step '${run.pendingExecution.stepId}' has an unresolved execution outcome.`);
    }
    const idempotencyKey = workflowStepExecutionKey(run, step.stepId);
    const inputDigests = toolExecutionInputDigests(input.arguments);
    run.pendingExecution = {
      stepId: step.stepId,
      capabilityId: step.capabilityId,
      executionId: idempotencyKey,
      idempotencyKey,
      argumentsDigest: inputDigests.argumentsDigest,
      targetDigest: inputDigests.targetDigest,
      phase: 'prepared',
      startedAt: nowIso(),
      originContext: input.originContext
        ? {
            conversationId: String(input.originContext.conversationId || '').slice(0, 200) || undefined,
            source: String(input.originContext.source || '').slice(0, 100) || undefined,
          }
        : undefined,
    };
    return {
      stepId: step.stepId,
      capabilityId: step.capabilityId,
      executionId: idempotencyKey,
      argumentsDigest: run.pendingExecution.argumentsDigest,
      targetDigest: run.pendingExecution.targetDigest,
    };
  });
  // This is the durable execution-intent barrier. No adapter may start until
  // SQLite has committed the pending identity and stable idempotency key.
  await flushDBOrThrow();
  const current = getWorkflowRun(prepared.runId, prepared.userId);
  const samePreparedExecution = current?.pendingExecution?.executionId === prepared.pendingExecution?.executionId
    && current?.pendingExecution?.argumentsDigest === prepared.pendingExecution?.argumentsDigest;
  const leaseAlive = Boolean(current?.lease && new Date(current.lease.expiresAt).getTime() > Date.now());
  const stillAuthorized = Boolean(
    current
    && current.status === 'running'
    && current.lease?.leaseId === input.leaseId
    && leaseAlive
    && !current.pauseRequestedAt
    && !current.cancelRequestedAt
    && samePreparedExecution,
  );
  if (stillAuthorized) return current!;

  // A pause/cancel that wins while the durable barrier is flushing must stop
  // the adapter before it starts. This pending intent is safe to clear because
  // executeToolCall has not yet been entered.
  if (current && samePreparedExecution && (current.pauseRequestedAt || current.cancelRequestedAt || !leaseAlive)) {
    mutateRun(current.runId, current.revision, current.userId, 'runtime', 'prepared_execution_stopped', run => {
      run.pendingExecution = undefined;
      if (run.cancelRequestedAt) {
        run.status = 'cancelled';
        run.completedAt = nowIso();
        run.cancelRequestedAt = undefined;
      } else {
        run.status = 'paused';
        run.pauseRequestedAt = undefined;
      }
      run.lease = undefined;
      return {
        stepId: input.stepId,
        adapterStarted: false,
        reason: leaseAlive ? 'user_control_won_before_adapter_start' : 'lease_expired_before_adapter_start',
      };
    });
    await flushDBOrThrow();
  }
  throw new WorkflowStateError('Workflow execution authorization changed while the durable start barrier was flushing; the adapter was not started.');
}

/** Revalidate live control state after confirmation and immediately before handler entry. */
export async function authorizeWorkflowAdapterStart(input: {
  runId: string;
  expectedRevision: number;
  userId: string;
  leaseId: string;
  executionId: string;
  actor: string;
}): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = getWorkflowRun(input.runId, input.userId);
    const samePreparedExecution = current?.pendingExecution?.executionId === input.executionId;
    const leaseAlive = Boolean(current?.lease && new Date(current.lease.expiresAt).getTime() > Date.now());
    if (current
      && current.status === 'running'
      && current.lease?.leaseId === input.leaseId
      && leaseAlive
      && !current.pauseRequestedAt
      && !current.cancelRequestedAt
      && samePreparedExecution) {
      if (current.pendingExecution?.phase === 'adapter_started') return;
      try {
        mutateRun(current.runId, current.revision, current.userId, input.actor, 'adapter_start_committed', run => {
          if (run.status !== 'running' || run.lease?.leaseId !== input.leaseId
            || run.pendingExecution?.executionId !== input.executionId
            || run.pauseRequestedAt || run.cancelRequestedAt
            || new Date(run.lease.expiresAt).getTime() <= Date.now()) {
            throw new WorkflowStateError('Workflow control changed while committing adapter start.');
          }
          run.pendingExecution.phase = 'adapter_started';
          run.pendingExecution.adapterStartedAt = nowIso();
          return { executionId: input.executionId, adapterStarted: true };
        });
        await flushDBOrThrow();
        return;
      } catch (error) {
        if (error instanceof WorkflowRevisionConflictError) continue;
        throw error;
      }
    }
    if (current && samePreparedExecution && (current.pauseRequestedAt || current.cancelRequestedAt || !leaseAlive)) {
      try {
        mutateRun(current.runId, current.revision, current.userId, input.actor, 'adapter_start_stopped', run => {
          run.pendingExecution = undefined;
          if (run.cancelRequestedAt) {
            run.status = 'cancelled';
            run.completedAt = nowIso();
            run.cancelRequestedAt = undefined;
          } else {
            run.status = 'paused';
            run.pauseRequestedAt = undefined;
          }
          run.lease = undefined;
          return {
            executionId: input.executionId,
            adapterStarted: false,
            reason: leaseAlive ? 'user_control_won_during_confirmation' : 'lease_expired_before_adapter_start',
          };
        });
        await flushDBOrThrow();
        throw new WorkflowStateError('Workflow control state changed before adapter start; the adapter was not started.');
      } catch (error) {
        if (error instanceof WorkflowRevisionConflictError) continue;
        throw error;
      }
    }
    throw new WorkflowStateError('Workflow control state changed before adapter start; the adapter was not started.');
  }
  throw new WorkflowStateError('Workflow adapter start could not acquire a stable control revision.');
}

export function checkpointWorkflowRun(input: {
  runId: string;
  expectedRevision: number;
  userId: string;
  leaseId: string;
  actor: string;
  stepId?: string;
  nextStepId?: string;
  detail?: Record<string, unknown>;
  toolRecord?: ToolExecutionRecord;
}): WorkflowRun {
  return mutateRun(input.runId, input.expectedRevision, input.userId, input.actor, 'checkpoint_recorded', run => {
    if (run.status !== 'running' || run.lease?.leaseId !== input.leaseId) {
      throw new WorkflowStateError('A live workflow lease is required to checkpoint a run.');
    }
    if (new Date(run.lease.expiresAt).getTime() <= Date.now()) throw new WorkflowStateError('Workflow run lease expired before checkpoint.');
    let receiptStatus: WorkflowReceiptSnapshot['status'] | undefined;
    if (input.toolRecord) {
      if (!input.stepId) throw new WorkflowStateError('A workflow tool receipt requires an exact stepId.');
      const step = run.planSnapshot.find(item => item.stepId === input.stepId);
      if (!step) throw new WorkflowStateError(`Workflow step '${input.stepId}' is not in plan revision ${run.planRevision}.`);
      for (const dependency of step.dependsOn || []) {
        const dependencyExecutionKey = workflowStepExecutionKey(run, dependency);
        const satisfied = run.receipts.some(receipt => (
          receipt.stepId === dependency
          && receipt.idempotencyKey === dependencyExecutionKey
          && receipt.status === 'verified'
        ));
        if (!satisfied) throw new WorkflowStateError(`Workflow step '${input.stepId}' cannot checkpoint before dependency '${dependency}' is verified.`);
      }
      const snapshot = canonicalReceiptSnapshot(run, step.stepId, step.capabilityId, input.toolRecord);
      receiptStatus = snapshot.status;
      if (snapshot.status !== 'verified') {
        throw new WorkflowStateError(`Workflow step '${step.stepId}' cannot checkpoint an unverified terminal record.`);
      }
      if (!run.receipts.some(receipt => receipt.executionId === snapshot.executionId && receipt.planRevision === snapshot.planRevision)) {
        run.receipts.push({
          ...snapshot,
          result: redactWorkflowValue(snapshot.result, `run.receipts.${run.receipts.length}.result`),
          receipt: redactWorkflowValue(snapshot.receipt, `run.receipts.${run.receipts.length}.receipt`),
          reason: snapshot.reason ? String(snapshot.reason).slice(0, 2_000) : undefined,
          recordedAt: nowIso(),
        });
      }
      run.pendingExecution = undefined;
    }
    run.checkpoint = {
      stepId: input.stepId,
      detail: input.detail ? redactWorkflowValue(input.detail, 'run.checkpoint') as Record<string, unknown> : undefined,
      updatedAt: nowIso(),
    };
    run.currentStepId = input.nextStepId;
    if (run.cancelRequestedAt) {
      run.status = 'cancelled';
      run.completedAt = nowIso();
      run.lease = undefined;
    } else if (run.pauseRequestedAt) {
      run.status = 'paused';
      run.pauseRequestedAt = undefined;
      run.lease = undefined;
    }
    return { stepId: input.stepId, nextStepId: input.nextStepId, receiptStatus };
  });
}

export function waitForWorkflowConfirmation(input: {
  runId: string;
  expectedRevision: number;
  userId: string;
  leaseId: string;
  actor: string;
  stepId: string;
  capabilityId: string;
  reason: string;
  arguments?: Record<string, unknown>;
}): WorkflowRun {
  return mutateRun(input.runId, input.expectedRevision, input.userId, input.actor, 'confirmation_requested', run => {
    if (run.status !== 'running' || run.lease?.leaseId !== input.leaseId) {
      throw new WorkflowStateError('A live workflow lease is required before requesting confirmation.');
    }
    if (new Date(run.lease.expiresAt).getTime() <= Date.now()) throw new WorkflowStateError('Workflow run lease expired before confirmation.');
    run.status = 'waiting_confirmation';
    run.lease = undefined;
    run.confirmation = {
      confirmationId: randomUUID(),
      stepId: input.stepId,
      capabilityId: input.capabilityId,
      reason: String(input.reason).slice(0, 1_000),
      ...toolExecutionInputDigests(input.arguments || {}),
      argumentPreview: boundedRedactedWorkflowValue(
        input.arguments || {},
        `run.confirmation.${input.stepId}.arguments`,
      ),
      requestedAt: nowIso(),
    };
    return { confirmationId: run.confirmation.confirmationId, stepId: input.stepId, capabilityId: input.capabilityId };
  });
}

export function decideWorkflowConfirmation(input: {
  runId: string;
  expectedRevision: number;
  userId: string;
  confirmationId: string;
  actor: string;
  approved: boolean;
}): WorkflowRun {
  return mutateRun(input.runId, input.expectedRevision, input.userId, input.actor, input.approved ? 'confirmation_approved' : 'confirmation_rejected', run => {
    if (run.status !== 'waiting_confirmation' || run.confirmation?.confirmationId !== input.confirmationId) {
      throw new WorkflowStateError('The workflow confirmation is stale or no longer active.');
    }
    const confirmation = run.confirmation;
    run.status = input.approved ? 'queued' : 'paused';
    if (input.approved && confirmation) {
      run.stepApprovals = {
        ...(run.stepApprovals || {}),
        [confirmation.stepId]: {
          planRevision: run.planRevision,
          argumentsDigest: confirmation.argumentsDigest,
          targetDigest: confirmation.targetDigest,
          approvedAt: nowIso(),
        },
      };
    }
    run.confirmation = undefined;
    return { approved: input.approved };
  });
}

export function editWorkflowRunPlan(input: {
  runId: string;
  expectedRevision: number;
  userId: string;
  actor: string;
  steps: WorkflowStepDefinition[];
  reason: string;
}): WorkflowRun {
  return mutateRun(input.runId, input.expectedRevision, input.userId, input.actor, 'plan_revised', run => {
    if (run.status !== 'paused' && run.status !== 'blocked' && run.status !== 'waiting_confirmation') {
      throw new WorkflowStateError('A workflow must be paused, blocked, or awaiting confirmation before its run plan can be edited.');
    }
    if (run.reconciliationRequired) {
      throw new WorkflowStateError('Resolve the unknown side-effect outcome before editing this workflow run plan.');
    }
    if (run.blockedKind === 'legacy_review_required' || run.blockedKind === 'capability_contract_changed') {
      throw new WorkflowStateError('Review and cancel this incompatible workflow run before creating a new reviewed version.');
    }
    const nextPlan = validateSteps(input.steps);
    const previousById = new Map(run.planSnapshot.map(step => [step.stepId, step]));
    const nextById = new Map(nextPlan.map(step => [step.stepId, step]));
    const verifiedStepIds = new Set(run.receipts.filter(receipt => receipt.status === 'verified').map(receipt => receipt.stepId));
    for (const stepId of verifiedStepIds) {
      const previous = previousById.get(stepId);
      const next = nextById.get(stepId);
      if (!previous || !next || workflowStepSemanticHash(previous) !== workflowStepSemanticHash(next)) {
        throw new WorkflowStateError(`Executed workflow step '${stepId}' is immutable; only future unexecuted steps can be replanned.`);
      }
    }
    const nextPlanRevision = run.planRevision + 1;
    const previousExecutions = run.stepExecutions || {};
    run.stepExecutions = Object.fromEntries(nextPlan.map(step => {
      const previous = previousById.get(step.stepId);
      const priorExecution = previousExecutions[step.stepId]
        || (() => {
          const historical = [...run.receipts].reverse().find(receipt => (
            receipt.stepId === step.stepId
            && receipt.capabilityId === step.capabilityId
            && receipt.planRevision === run.planRevision
            && (receipt.status === 'verified' || receipt.status === 'unknown_outcome')
            && Boolean(receipt.idempotencyKey)
          ));
          return historical
            ? { semanticHash: workflowStepSemanticHash(step), idempotencyKey: historical.idempotencyKey }
            : undefined;
        })();
      const unchanged = previous && workflowStepSemanticHash(previous) === workflowStepSemanticHash(step);
      return [
        step.stepId,
        unchanged && priorExecution ? priorExecution : buildWorkflowStepExecution(run.runId, nextPlanRevision, step),
      ];
    }));
    run.planSnapshot = nextPlan;
    run.planRevision = nextPlanRevision;
    // Every edited plan receives fresh, exact approvals. Even unchanged future
    // steps may have a different surrounding dependency graph.
    run.stepApprovals = {};
    run.status = 'paused';
    run.confirmation = undefined;
    run.blockedReason = undefined;
    run.blockedKind = undefined;
    run.reconciliationRequired = false;
    if (!run.planSnapshot.some(step => step.stepId === run.currentStepId)) run.currentStepId = run.planSnapshot[0]?.stepId;
    return {
      planRevision: run.planRevision,
      preservedExecutedSteps: Array.from(verifiedStepIds),
      reason: String(input.reason).slice(0, 1_000),
    };
  });
}

export function blockWorkflowRun(input: {
  runId: string;
  expectedRevision: number;
  userId: string;
  actor: string;
  reason: string;
  stepId?: string;
  capabilityId?: string;
  toolRecord?: ToolExecutionRecord;
  kind?: WorkflowRun['blockedKind'];
}): WorkflowRun {
  return mutateRun(input.runId, input.expectedRevision, input.userId, input.actor, 'run_blocked', run => {
    if (run.status !== 'running' && run.status !== 'queued') {
      throw new WorkflowStateError(`Cannot block a workflow run in '${run.status}' state.`);
    }
    let snapshot: Omit<WorkflowReceiptSnapshot, 'recordedAt'> | undefined;
    if (input.toolRecord) {
      if (!input.stepId || !input.capabilityId) throw new WorkflowStateError('Blocked workflow receipts require exact step and capability identities.');
      snapshot = canonicalReceiptSnapshot(run, input.stepId, input.capabilityId, input.toolRecord);
      run.receipts.push({
        ...snapshot,
        result: redactWorkflowValue(snapshot.result, `run.receipts.${run.receipts.length}.result`),
        receipt: redactWorkflowValue(snapshot.receipt, `run.receipts.${run.receipts.length}.receipt`),
        reason: snapshot.reason ? String(snapshot.reason).slice(0, 2_000) : undefined,
        recordedAt: nowIso(),
      });
      if (snapshot.status !== 'unknown_outcome') run.pendingExecution = undefined;
    }
    const preparedButNotStarted = !snapshot && run.pendingExecution?.phase === 'prepared';
    const startedWithoutRecordMayCommit = !snapshot
      && run.pendingExecution?.phase === 'adapter_started'
      && pendingExecutionMayHaveSideEffects(run);
    if (preparedButNotStarted || (!snapshot && run.pendingExecution && !startedWithoutRecordMayCommit)) {
      run.pendingExecution = undefined;
    }
    run.status = 'blocked';
    run.blockedReason = String(input.reason).slice(0, 2_000);
    run.blockedKind = snapshot?.status === 'unknown_outcome' || startedWithoutRecordMayCommit
      ? 'unknown_outcome'
      : input.kind || (snapshot ? 'verification_failed' : 'execution_error');
    run.reconciliationRequired = run.blockedKind === 'unknown_outcome' || run.blockedKind === 'expired_lease';
    run.lease = undefined;
    return { reason: run.blockedReason, blockedKind: run.blockedKind, reconciliationRequired: run.reconciliationRequired };
  });
}

export function completeWorkflowRun(input: {
  runId: string;
  expectedRevision: number;
  userId: string;
  leaseId: string;
  actor: string;
}): WorkflowRun {
  return mutateRun(input.runId, input.expectedRevision, input.userId, input.actor, 'run_completed', run => {
    if (run.status !== 'running' || run.lease?.leaseId !== input.leaseId) {
      throw new WorkflowStateError('A live workflow lease is required to complete a run.');
    }
    if (new Date(run.lease.expiresAt).getTime() <= Date.now()) throw new WorkflowStateError('Workflow run lease expired before completion.');
    if (run.pauseRequestedAt || run.cancelRequestedAt || run.reconciliationRequired || run.pendingExecution) {
      throw new WorkflowStateError('Workflow completion is blocked by a pending control or reconciliation request.');
    }
    const missing = run.planSnapshot.filter(step => {
      const executionKey = workflowStepExecutionKey(run, step.stepId);
      return !run.receipts.some(receipt => (
        receipt.stepId === step.stepId && receipt.idempotencyKey === executionKey && receipt.status === 'verified'
      ));
    });
    if (missing.length > 0) {
      throw new WorkflowStateError(`Workflow run cannot complete before these plan steps are verified: ${missing.map(step => step.stepId).join(', ')}.`);
    }
    run.status = 'completed';
    run.completedAt = nowIso();
    run.currentStepId = undefined;
    run.lease = undefined;
    return { terminalEvidence: 'all_plan_steps_verified', planRevision: run.planRevision };
  });
}

function reconciliationPayload(record: ToolExecutionRecord): Record<string, unknown> {
  if (record.receipt && typeof record.receipt === 'object' && !Array.isArray(record.receipt)) {
    return record.receipt as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(record.result || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function recordWorkflowReconciliation(input: {
  runId: string;
  expectedRevision: number;
  userId: string;
  actor: string;
  stepId: string;
  toolRecord: ToolExecutionRecord;
}): WorkflowRun {
  return mutateRun(input.runId, input.expectedRevision, input.userId, input.actor, 'reconciliation_recorded', run => {
    if (run.status !== 'blocked' || !run.reconciliationRequired) {
      throw new WorkflowStateError('This workflow run is not waiting for reconciliation.');
    }
    const expectedKey = workflowReconciliationExecutionKey(run, input.stepId);
    const record = input.toolRecord;
    const step = run.planSnapshot.find(item => item.stepId === input.stepId);
    const pending = run.pendingExecution;
    if (!step || !pending
      || pending.stepId !== step.stepId
      || pending.capabilityId !== step.capabilityId
      || pending.phase !== 'adapter_started'
      || pending.idempotencyKey !== workflowStepExecutionKey(run, step.stepId)) {
      throw new WorkflowStateError('The prepared workflow execution could not be identified for reconciliation.');
    }
    const attachedRecord = Boolean(step.attachedReconciliation)
      && isCanonicalExternalCommitReconciliationRecord(record)
      && record.name === `reconcile_external_commit:${step.attachedReconciliation!.toolName}`;
    if (!attachedRecord && !(step.onFailure?.fallbackCapabilityIds || []).includes(record.name)) {
      throw new WorkflowStateError(`Capability '${record.name}' is not a declared reconciliation adapter for step '${step.stepId}'.`);
    }
    if (!isCanonicalToolExecutionRecord(record) || record.id !== expectedKey) {
      throw new WorkflowStateError('Workflow reconciliation must originate from the canonical tool executor with the expected execution id.');
    }
    const operation = record.capability?.operation;
    const readOnly = operation === 'observe' || operation === 'test';
    const verified = record.terminalVerification?.status === 'verified'
      && record.envelope?.status === 'verified_success'
      && record.envelope.verification.status === 'verified';
    if (!readOnly || !verified || record.taskId !== run.runId || record.envelope?.taskId !== run.runId) {
      throw new WorkflowStateError('Workflow reconciliation requires a verified read-only canonical tool record for this run.');
    }
    if (record.idempotencyKey !== expectedKey || record.envelope.idempotencyKey !== expectedKey) {
      throw new WorkflowStateError('Workflow reconciliation execution identity mismatch.');
    }
    const reconciliationInput = getCanonicalToolExecutionInputDigests(record);
    if (!reconciliationInput
      || reconciliationInput.argumentsDigest !== pending.argumentsDigest
      || reconciliationInput.targetDigest !== pending.targetDigest) {
      throw new WorkflowStateError('Workflow reconciliation did not observe the exact original arguments and target.');
    }
    const payload = reconciliationPayload(record);
    const reconciliationContract = record.capability?.reconciliation;
    const originalCapabilityId = step.capabilityContractId || step.capabilityId;
    if (!reconciliationContract
      || !reconciliationContract.reconcilesCapabilityIds.includes(originalCapabilityId)
      || reconciliationContract.outcomeField !== 'reconciliationStatus') {
      throw new WorkflowStateError(`Capability '${record.name}' is not semantically authorized to reconcile '${originalCapabilityId}'.`);
    }
    const rawOutcome = String(payload.reconciliationStatus || '').toLowerCase();
    const committed = reconciliationContract.committedValues.map(value => value.toLowerCase()).includes(rawOutcome);
    const notCommitted = reconciliationContract.notCommittedValues.map(value => value.toLowerCase()).includes(rawOutcome);
    if (!committed && !notCommitted) {
      throw new WorkflowStateError('Read-only reconciliation did not prove whether the prior side effect committed.');
    }
    const uncertain = [...run.receipts].reverse().find(receipt => (
      receipt.stepId === input.stepId
      && receipt.idempotencyKey === pending.idempotencyKey
      && receipt.status === 'unknown_outcome'
    ));
    if (committed) {
      run.receipts.push({
        stepId: step.stepId,
        capabilityId: step.capabilityId,
        planRevision: run.planRevision,
        executionId: pending.executionId,
        idempotencyKey: pending.idempotencyKey,
        recordId: record.id,
        status: 'verified',
        receipt: redactWorkflowValue({ reconciliation: payload, observationCapability: record.name }, 'run.reconciliation'),
        reason: 'A verified read-only reconciliation observed that the original side effect committed.',
        argumentsDigest: pending.argumentsDigest,
        targetDigest: pending.targetDigest,
        recordedAt: nowIso(),
      });
    } else {
      run.receipts = run.receipts.filter(receipt => !(
        receipt.stepId === input.stepId
        && receipt.idempotencyKey === pending.idempotencyKey
        && receipt.status === 'unknown_outcome'
      ));
    }
    run.pendingExecution = undefined;
    const cancellationRequested = Boolean(run.cancelRequestedAt);
    run.status = cancellationRequested ? 'cancelled' : 'paused';
    run.completedAt = cancellationRequested ? nowIso() : undefined;
    run.cancelRequestedAt = undefined;
    run.pauseRequestedAt = undefined;
    run.blockedReason = undefined;
    run.blockedKind = undefined;
    run.reconciliationRequired = false;
    run.lease = undefined;
    return {
      stepId: input.stepId,
      outcome: committed ? 'committed' : 'not_committed',
      replayAllowed: notCommitted && !cancellationRequested,
      cancelled: cancellationRequested,
    };
  });
}

/**
 * Recover abandoned workers without replaying a possibly committed side effect.
 * At process bootstrap every persisted running lease belongs to the previous
 * process, even when its wall-clock expiry is still in the future.
 */
export function reconcileExpiredWorkflowRuns(
  at = new Date(),
  options: { recoverAllRunning?: boolean } = {},
): number {
  const store = loadStore();
  let changed = 0;
  for (const run of store.runs) {
    if (run.status !== 'running') continue;
    const leaseExpired = !run.lease || new Date(run.lease.expiresAt).getTime() <= at.getTime();
    if (!options.recoverAllRunning && !leaseExpired) continue;
    const unresolvedExecution = run.pendingExecution?.phase === 'adapter_started'
      && pendingExecutionMayHaveSideEffects(run);
    if (run.pendingExecution && !unresolvedExecution) run.pendingExecution = undefined;
    run.status = unresolvedExecution ? 'blocked' : 'paused';
    run.blockedReason = unresolvedExecution
      ? 'The workflow worker stopped after its adapter may have started. Verify the original target before resuming; do not replay the side effect blindly.'
      : undefined;
    run.blockedKind = unresolvedExecution ? 'expired_lease' : undefined;
    run.reconciliationRequired = unresolvedExecution;
    run.lease = undefined;
    run.revision += 1;
    run.updatedAt = at.toISOString();
    appendEvent(
      run,
      options.recoverAllRunning ? 'worker_interrupted_on_restart' : 'lease_expired',
      'runtime',
      { replayAllowed: !unresolvedExecution, reconciliationRequired: unresolvedExecution },
    );
    changed += 1;
  }
  if (changed > 0) saveStore(store);
  return changed;
}

let workflowMaintenanceTimer: ReturnType<typeof setInterval> | null = null;
let workflowMaintenanceRunning = false;

/** Sweep crashed/expired workers during normal uptime, not only on restart. */
export function startWorkflowRuntimeMaintenance(intervalMs = 15_000): void {
  if (workflowMaintenanceTimer) return;
  workflowMaintenanceTimer = setInterval(() => {
    if (workflowMaintenanceRunning) return;
    workflowMaintenanceRunning = true;
    void (async () => {
    try {
      const changed = reconcileExpiredWorkflowRuns();
      if (changed > 0) await persistWorkflowRuntimeBarrier();
    } catch (error) {
      console.warn('[WorkflowRuntime] lease maintenance failed:', error);
    } finally {
      workflowMaintenanceRunning = false;
    }
    })();
  }, Math.max(5_000, intervalMs));
  workflowMaintenanceTimer.unref?.();
}

export function stopWorkflowRuntimeMaintenanceForTest(): void {
  if (!workflowMaintenanceTimer) return;
  clearInterval(workflowMaintenanceTimer);
  workflowMaintenanceTimer = null;
  workflowMaintenanceRunning = false;
}

/** Await SQLite durability before exposing a workflow state transition. */
export async function persistWorkflowRuntimeBarrier(): Promise<void> {
  await flushDBOrThrow();
}

export function resetWorkflowRuntimeForTest(): void {
  const db = readDB();
  if (!Array.isArray(db.settings)) db.settings = [];
  db.settings = db.settings.filter((item: any) => item?.key !== WORKFLOW_RUNTIME_SETTING);
  writeDB(db);
}
