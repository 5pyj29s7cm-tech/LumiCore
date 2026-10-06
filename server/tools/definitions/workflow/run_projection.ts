import { type getWorkflowRun, persistWorkflowRuntimeBarrier } from "../../../workflows/runtime";
import { requireWorkflowRunForContext, assertWorkflowAuthorization } from './authorization';

function boundedWorkflowOutput(value: unknown, maxChars = 2_000): unknown {
  if (value === undefined) return undefined;
  let serialized = '';
  try { serialized = JSON.stringify(value); } catch { serialized = String(value ?? ''); }
  if (serialized.length <= maxChars) return value;
  return { truncated: true, preview: serialized.slice(0, maxChars) };
}

export function workflowRunSummary(run: NonNullable<ReturnType<typeof getWorkflowRun>>) {
  const visibleReceipts = run.receipts.slice(-20);
  return {
    ok: true,
    status: run.status,
    runId: run.runId,
    revision: run.revision,
    planRevision: run.planRevision,
    workflowId: run.workflowId,
    definitionVersion: run.definitionVersion,
    definitionHash: run.definitionHash,
    currentStepId: run.currentStepId,
    completedSteps: run.receipts.filter(receipt => receipt.status === 'verified').length,
    totalSteps: run.planSnapshot.length,
    reconciliationRequired: Boolean(run.reconciliationRequired),
    blockedKind: run.blockedKind,
    blocker: run.blockedReason,
    confirmation: run.confirmation,
    checkpoint: run.checkpoint,
    outputs: visibleReceipts.map(receipt => ({
      stepId: receipt.stepId,
      capabilityId: receipt.capabilityId,
      status: receipt.status,
      result: boundedWorkflowOutput(receipt.result),
      receipt: boundedWorkflowOutput(receipt.receipt),
      reason: receipt.reason,
      recordedAt: receipt.recordedAt,
    })),
    outputsTruncated: run.receipts.length > visibleReceipts.length,
    pendingExecution: run.pendingExecution
      ? {
          stepId: run.pendingExecution.stepId,
          capabilityId: run.pendingExecution.capabilityId,
          phase: run.pendingExecution.phase,
          startedAt: run.pendingExecution.startedAt,
        }
      : undefined,
  };
}

async function readDurableWorkflowRunForContext(runId: string, context?: any) {
  // Capture one linearizable snapshot before crossing the barrier. A worker
  // may advance the live ledger while the flush is resolving, but this exact
  // revision (or a later one) is durable before it is exposed to the caller.
  const run = requireWorkflowRunForContext(runId, context);
  await persistWorkflowRuntimeBarrier();
  assertWorkflowAuthorization(run);
  return run;
}

export async function handleGetWorkflowRun(args: Record<string, any>, context?: any): Promise<string> {
  const run = await readDurableWorkflowRunForContext(String(args.runId || ''), context);
  return JSON.stringify(workflowRunSummary(run), null, 2);
}
