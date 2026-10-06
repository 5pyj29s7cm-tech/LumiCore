import { randomUUID } from "crypto";
import { flushDBOrThrow } from "../../../db_layer";
import type { WorkflowRun } from './contracts';
import { loadStore, mutateRun } from './store';
import { clone, nowIso } from './values';
import { WorkflowStateError } from './contracts';

export function getWorkflowRun(runId: string, userId: string): WorkflowRun | null {
  const run = loadStore().runs.find(item => item.runId === runId && item.userId === userId);
  return run ? clone(run) : null;
}

/** Authorization loss stops future work without erasing an in-flight outcome. */
export function stopUnauthorizedWorkflowRun(runId: string, userId: string): WorkflowRun | null {
  const current = getWorkflowRun(runId, userId);
  if (!current || current.status === 'cancelled') return current;
  return mutateRun(runId, current.revision, userId, 'authorization', 'authorization_revoked', run => {
    run.cancelRequestedAt ||= nowIso();
    run.blockedReason = 'Original workflow authorization is no longer valid. Remaining work was cancelled.';
    run.confirmation = undefined;
    if (run.pendingExecution?.phase === 'adapter_started' || run.reconciliationRequired) return;
    run.pendingExecution = undefined;
    run.status = 'cancelled';
    run.completedAt = nowIso();
    run.lease = undefined;
  });
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
    run.lastWorkerLeaseId = run.lease.leaseId;
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
