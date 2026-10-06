import type { WorkflowRun } from './contracts';
import { workflowStepSemanticHash } from './execution_identity';

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

export function migrateStoredRun(raw: WorkflowRun): WorkflowRun {
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
