import { randomUUID } from "crypto";
import { flushDBOrThrow } from "../../db_layer";
import type { OrganizationMembershipAuthorization } from "../org/membership_authorization";
import type { ToolExecutionRecord } from "../tools/types";
import { toolExecutionInputDigests } from "../tools/execution_engine";
import type { WorkflowRun, WorkflowReceiptSnapshot } from './state/contracts';
import { loadStore, WORKFLOW_RUNTIME_SCHEMA_VERSION, appendEvent, saveStore, mutateRun } from './state/store';
import { WorkflowStateError, WorkflowRevisionConflictError } from './state/contracts';
import { nowIso, clone, redactWorkflowValue } from './state/values';
import { buildWorkflowStepExecution, workflowStepExecutionKey } from './state/execution_identity';
import { getWorkflowRun } from './state/run_control';
import { canonicalReceiptSnapshot } from './state/receipts';

export { hasApprovedWorkflowToolCall } from './state/approval';
export type { WorkflowDefinitionStatus } from './state/contracts';
export type { WorkflowRunStatus } from './state/contracts';
export type { WorkflowScope } from './state/contracts';
export type { WorkflowStepDefinition } from './state/contracts';
export type { WorkflowDefinition } from './state/contracts';
export type { WorkflowRunEvent } from './state/contracts';
export type { WorkflowReceiptSnapshot } from './state/contracts';
export type { WorkflowRun } from './state/contracts';
export { WorkflowRevisionConflictError } from './state/contracts';
export { WorkflowStateError } from './state/contracts';
export { redactWorkflowValue } from './state/values';
export { resolveWorkflowValue } from './state/input_resolution';
export { validateWorkflowSteps } from './state/plan_validation';
export { topologicallyOrderWorkflowSteps } from './state/plan_validation';
export { workflowStepExecutionKey } from './state/execution_identity';
export { workflowReconciliationExecutionKey } from './state/execution_identity';
export { createWorkflowDefinitionDraft } from './state/definitions';
export { publishWorkflowDefinition } from './state/definitions';
export { retireWorkflowDefinition } from './state/definitions';
export { listWorkflowDefinitions } from './state/definitions';
export { getWorkflowDefinition } from './state/definitions';
export { getWorkflowRun } from './state/run_control';
export { stopUnauthorizedWorkflowRun } from './state/run_control';
export { findBlockingWorkflowRun } from './state/run_control';
export { listWorkflowRuns } from './state/run_control';
export { claimWorkflowRun } from './state/run_control';
export { renewWorkflowRunLease } from './state/run_control';
export { requestWorkflowPause } from './state/run_control';
export { resumeWorkflowRun } from './state/run_control';
export { requestWorkflowCancel } from './state/run_control';
export { waitForWorkflowConfirmation } from './state/confirmation';
export { decideWorkflowConfirmation } from './state/confirmation';
export { editWorkflowRunPlan } from './state/plan_edit';
export { blockWorkflowRun } from './state/terminal';
export { completeWorkflowRun } from './state/terminal';
export { recordWorkflowReconciliation } from './state/reconciliation';
export { reconcileExpiredWorkflowRuns } from './state/reconciliation';
export { startWorkflowRuntimeMaintenance } from './state/maintenance';
export { stopWorkflowRuntimeMaintenance } from './state/maintenance';
export { persistWorkflowRuntimeBarrier } from './state/maintenance';
export { resetWorkflowRuntimeForTest } from './state/store';

export function createWorkflowRun(input: {
  workflowId: string;
  version: number;
  userId: string;
  variables?: Record<string, unknown>;
  actor?: string;
  membershipAuthorization?: OrganizationMembershipAuthorization;
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
    membershipAuthorization: input.membershipAuthorization ? clone(input.membershipAuthorization) : undefined,
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
