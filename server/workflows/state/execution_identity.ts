import { createHash } from "crypto";
import type { WorkflowStepDefinition, WorkflowRun } from './contracts';
import { stableValue } from './values';

export function workflowStepSemanticHash(step: WorkflowStepDefinition): string {
  return createHash('sha256').update(JSON.stringify(stableValue(step))).digest('hex');
}

export function buildWorkflowStepExecution(runId: string, planRevision: number, step: WorkflowStepDefinition): { semanticHash: string; idempotencyKey: string } {
  const semanticHash = workflowStepSemanticHash(step);
  return {
    semanticHash,
    idempotencyKey: `workflow:${runId}:plan:${planRevision}:step:${step.stepId}:${semanticHash.slice(0, 16)}`,
  };
}

export function workflowStepExecutionKey(
  run: Pick<WorkflowRun, 'runId' | 'planRevision'> & Partial<Pick<WorkflowRun, 'stepExecutions'>>,
  stepId: string,
): string {
  return run.stepExecutions?.[stepId]?.idempotencyKey || `workflow:${run.runId}:plan:${run.planRevision}:step:${stepId}`;
}

export function workflowReconciliationExecutionKey(run: Pick<WorkflowRun, 'runId' | 'planRevision'>, stepId: string): string {
  return `workflow:${run.runId}:plan:${run.planRevision}:reconcile:${stepId}`;
}

export function pendingExecutionMayHaveSideEffects(run: WorkflowRun): boolean {
  if (!run.pendingExecution) return false;
  const step = run.planSnapshot.find(item => item.stepId === run.pendingExecution!.stepId);
  // Legacy/unreviewed contracts fail closed. A reviewed empty side-effect
  // envelope is safe to recompute after lease fencing because it cannot commit.
  if (!step?.capabilitySnapshot) return true;
  return step.capabilitySnapshot.sideEffects.length > 0;
}
