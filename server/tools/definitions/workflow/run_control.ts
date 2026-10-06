import type { ToolRegistry } from "../../registry";
import { claimWorkflowRun, persistWorkflowRuntimeBarrier, requestWorkflowCancel, requestWorkflowPause, decideWorkflowConfirmation, editWorkflowRunPlan, resumeWorkflowRun } from "../../../workflows/runtime";
import { requireWorkflowRunForContext } from './authorization';
import { workflowRunSummary } from './run_projection';
import { scheduleWorkflowWorker } from './run_execution';
import { frozenCapabilitySnapshot } from './capability_snapshot';

export async function handlePauseWorkflowRun(args: Record<string, any>, context?: any): Promise<string> {
  requireWorkflowRunForContext(String(args.runId || ''), context);
  const run = requestWorkflowPause({
    runId: String(args.runId || ''),
    expectedRevision: Number(args.expectedRevision),
    userId: context?.userId || 'system',
    actor: 'user',
  });
  await persistWorkflowRuntimeBarrier();
  return JSON.stringify(workflowRunSummary(run), null, 2);
}

export async function handleCancelWorkflowRun(args: Record<string, any>, context?: any): Promise<string> {
  requireWorkflowRunForContext(String(args.runId || ''), context);
  const run = requestWorkflowCancel({
    runId: String(args.runId || ''),
    expectedRevision: Number(args.expectedRevision),
    userId: context?.userId || 'system',
    actor: 'user',
  });
  await persistWorkflowRuntimeBarrier();
  return JSON.stringify(workflowRunSummary(run), null, 2);
}

export async function handleResumeWorkflowRun(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  requireWorkflowRunForContext(String(args.runId || ''), context);
  let run = resumeWorkflowRun({
    runId: String(args.runId || ''),
    expectedRevision: Number(args.expectedRevision),
    userId,
    actor: 'user',
  });
  run = claimWorkflowRun({
    runId: run.runId,
    expectedRevision: run.revision,
    userId,
    owner: `workflow-worker:${context?.requestId || 'interactive'}`,
    leaseMs: 120_000,
  });
  await persistWorkflowRuntimeBarrier();
  scheduleWorkflowWorker({
    runId: run.runId,
    expectedRevision: run.revision,
    inputs: args.inputs || {},
  }, context, run.runId);
  return JSON.stringify({ ...workflowRunSummary(run), status: 'started', runStatus: run.status }, null, 2);
}

export async function handleDecideWorkflowConfirmation(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  requireWorkflowRunForContext(String(args.runId || ''), context);
  let run = decideWorkflowConfirmation({
    runId: String(args.runId || ''),
    expectedRevision: Number(args.expectedRevision),
    userId,
    confirmationId: String(args.confirmationId || ''),
    actor: 'user',
    approved: Boolean(args.approved),
  });
  if (args.approved) {
    run = claimWorkflowRun({
      runId: run.runId,
      expectedRevision: run.revision,
      userId,
      owner: `workflow-worker:${context?.requestId || 'interactive'}`,
      leaseMs: 120_000,
    });
    await persistWorkflowRuntimeBarrier();
    scheduleWorkflowWorker({
      runId: run.runId,
      expectedRevision: run.revision,
      inputs: args.inputs || {},
    }, context, run.runId);
  }
  if (!args.approved) await persistWorkflowRuntimeBarrier();
  return JSON.stringify({
    ...workflowRunSummary(run),
    status: args.approved ? 'started' : run.status,
    runStatus: run.status,
    approved: Boolean(args.approved),
  }, null, 2);
}

export async function handleEditWorkflowRun(args: Record<string, any>, context?: any): Promise<string> {
  const registry: ToolRegistry | undefined = context?.toolRegistry;
  if (!registry) throw new Error('Capability registry is unavailable; the workflow plan cannot be reviewed safely.');
  requireWorkflowRunForContext(String(args.runId || ''), context);
  const steps = (args.steps || []).map((step: Record<string, any>, index: number) => {
    const capabilityId = String(step.capabilityId || step.tool || '').trim();
    const manifest = registry.getCapabilityManifestEntry(capabilityId, context?.toolPolicy, context);
    const definition = registry.get(capabilityId);
    if (!capabilityId || !manifest || !definition) throw new Error(`Workflow capability '${capabilityId || `step_${index + 1}`}' is unavailable.`);
    return {
      stepId: String(step.stepId || `step_${index + 1}`),
      capabilityId,
      capabilityContractId: manifest.capabilityId,
      capabilitySnapshot: frozenCapabilitySnapshot(manifest, definition.parameters || {}),
      description: String(step.description || ''),
      dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn.map(String) : (index > 0 ? [String(args.steps[index - 1]?.stepId || `step_${index}`)] : []),
      argumentsTemplate: step.arguments || step.args || {},
      retry: { maxAttempts: 1 },
      idempotency: { strategy: 'run_step' as const },
      confirmation: { required: step.confirmationRequired !== false, reason: String(step.confirmationReason || 'This semi-automatic workflow step is awaiting explicit approval.') },
      verification: { required: true, strategy: 'terminal_receipt' },
      onFailure: { action: 'pause' as const },
    };
  });
  if (!steps.length) throw new Error('A workflow plan requires at least one step.');
  const run = editWorkflowRunPlan({
    runId: String(args.runId || ''),
    expectedRevision: Number(args.expectedRevision),
    userId: context?.userId || 'system',
    actor: 'user',
    steps,
    reason: String(args.reason || 'User revised future workflow steps.'),
  });
  await persistWorkflowRuntimeBarrier();
  return JSON.stringify(workflowRunSummary(run), null, 2);
}
