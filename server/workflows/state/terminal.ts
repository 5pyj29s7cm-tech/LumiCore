import type { ToolExecutionRecord } from "../../tools/types";
import type { WorkflowRun, WorkflowReceiptSnapshot } from './contracts';
import { mutateRun } from './store';
import { WorkflowStateError } from './contracts';
import { canonicalReceiptSnapshot } from './receipts';
import { redactWorkflowValue, nowIso } from './values';
import { pendingExecutionMayHaveSideEffects, workflowStepExecutionKey } from './execution_identity';

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
