import type { OrganizationMembershipAuthorization } from "../../org/membership_authorization";
import type { WORKFLOW_RUNTIME_SCHEMA_VERSION } from './store';

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
  /** False when persistence redaction/truncation changed the returned value. */
  resultReusable?: boolean;
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
  /** Frozen with the run; never reconstructed from a replacement membership. */
  membershipAuthorization?: OrganizationMembershipAuthorization;
  /** Survives lease release so a finishing old worker cannot stop a new generation. */
  lastWorkerLeaseId?: string;
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

export interface WorkflowRuntimeStore {
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
