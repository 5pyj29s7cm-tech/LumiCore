import { isOrganizationMembershipAuthorizationCurrent } from "../../../org/membership_authorization";
import { getWorkflowRun, stopUnauthorizedWorkflowRun } from "../../../workflows/runtime";

export function workflowScope(context?: any): { domain: 'personal' | 'work'; orgId: string } {
  if (context?.domain === 'work' && context?.orgId) {
    return { domain: 'work', orgId: String(context.orgId) };
  }
  return { domain: 'personal', orgId: '' };
}

export function requireWorkflowRunForContext(runId: string, context?: any) {
  const userId = context?.userId || 'system';
  const run = getWorkflowRun(runId, userId);
  if (!run) throw new Error(`Workflow run '${runId}' was not found for this user.`);
  const scope = workflowScope(context);
  if (run.scope.domain !== scope.domain || run.scope.orgId !== scope.orgId) {
    throw new Error(`Workflow run '${runId}' was not found in this scope.`);
  }
  assertWorkflowAuthorization(run);
  return run;
}

export function workflowAuthorizationCurrent(run: NonNullable<ReturnType<typeof getWorkflowRun>>): boolean {
  return run.scope.domain !== 'work' || isOrganizationMembershipAuthorizationCurrent(run.membershipAuthorization, run.scope.orgId, run.userId);
}

export function assertWorkflowAuthorization(run: NonNullable<ReturnType<typeof getWorkflowRun>>): void {
  if (workflowAuthorizationCurrent(run)) return;
  stopUnauthorizedWorkflowRun(run.runId, run.userId);
  throw new Error('Original workflow organization authorization is unavailable. Review the cancelled run before creating new work.');
}
