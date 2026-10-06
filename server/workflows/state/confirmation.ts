import { randomUUID } from "crypto";
import { toolExecutionInputDigests } from "../../tools/execution_engine";
import type { WorkflowRun } from './contracts';
import { mutateRun } from './store';
import { WorkflowStateError } from './contracts';
import { boundedRedactedWorkflowValue, nowIso } from './values';

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
