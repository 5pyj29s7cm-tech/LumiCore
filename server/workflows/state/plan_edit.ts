import type { WorkflowStepDefinition, WorkflowRun } from './contracts';
import { mutateRun } from './store';
import { WorkflowStateError } from './contracts';
import { validateWorkflowSteps } from './plan_validation';
import { workflowStepSemanticHash, buildWorkflowStepExecution } from './execution_identity';

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
    const nextPlan = validateWorkflowSteps(input.steps);
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
