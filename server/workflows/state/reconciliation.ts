import type { ToolExecutionRecord } from "../../tools/types";
import { getCanonicalToolExecutionInputDigests, isCanonicalExternalCommitReconciliationRecord, isCanonicalToolExecutionRecord } from "../../tools/execution_engine";
import type { WorkflowRun } from './contracts';
import { mutateRun, loadStore, appendEvent, saveStore } from './store';
import { WorkflowStateError } from './contracts';
import { workflowReconciliationExecutionKey, workflowStepExecutionKey, pendingExecutionMayHaveSideEffects } from './execution_identity';
import { redactWorkflowValue, nowIso } from './values';

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
