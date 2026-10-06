import type { ToolContext } from "../../tools/types";
import { toolExecutionInputDigests } from "../../tools/execution_engine";
import type { WorkflowRun } from './contracts';
import { getWorkflowRun } from './run_control';

/** An async workflow retains the exact target the owner reviewed. A background
 * flag or caller-supplied run ID alone never grants this authority. */
export function hasApprovedWorkflowToolCall(
  context: Pick<ToolContext, 'taskId' | 'userId' | 'idempotencyKey'> | undefined,
  capabilityContractId: string,
  args: Record<string, unknown>,
): boolean {
  if (!context?.taskId || !context.userId || !context.idempotencyKey) return false;
  let run: WorkflowRun | null;
  try { run = getWorkflowRun(context.taskId, context.userId); }
  catch { return false; }
  const pending = run?.pendingExecution;
  if (!run || run.status !== 'running' || run.cancelRequestedAt || run.pauseRequestedAt
    || run.reconciliationRequired || !run.lease || !(Date.parse(run.lease.expiresAt) > Date.now())
    || !pending || pending.phase !== 'adapter_started' || pending.executionId !== context.idempotencyKey) return false;
  const step = run.planSnapshot.find(candidate => candidate.stepId === pending.stepId);
  const approval = run.stepApprovals?.[pending.stepId];
  const digests = toolExecutionInputDigests(args);
  return step?.capabilitySnapshot?.capabilityId === capabilityContractId
    && approval?.planRevision === run.planRevision
    && approval.argumentsDigest === digests.argumentsDigest && approval.targetDigest === digests.targetDigest
    && pending.argumentsDigest === digests.argumentsDigest && pending.targetDigest === digests.targetDigest;
}
