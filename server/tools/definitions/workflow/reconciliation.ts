import { executeAttachedExternalCommitReconciliation, executeToolCall } from "../../execution_engine";
import { persistWorkflowRuntimeBarrier, recordWorkflowReconciliation, resolveWorkflowValue, workflowReconciliationExecutionKey } from "../../../workflows/runtime";
import { requireWorkflowRunForContext } from './authorization';
import { capabilityContractStillCompatible } from './capability_snapshot';

export async function handleReconcileWorkflowRun(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const runId = String(args.runId || '');
  const run = requireWorkflowRunForContext(runId, context);
  if (run.revision !== Number(args.expectedRevision)) {
    throw new Error(`Workflow run revision conflict: expected ${Number(args.expectedRevision)}, actual ${run.revision}.`);
  }
  if (run.status !== 'blocked' || !run.reconciliationRequired || !run.pendingExecution) {
    throw new Error('This workflow run has no unresolved execution to reconcile.');
  }
  const stepId = String(args.stepId || '');
  const step = run.planSnapshot.find(item => item.stepId === stepId);
  if (!step || step.stepId !== run.pendingExecution.stepId) {
    throw new Error('The reconciliation step does not match the unresolved execution.');
  }
  const capabilityId = String(args.capabilityId || '');
  if (!context?.toolRegistry) throw new Error('The tool registry is unavailable.');
  const originalCapabilityId = step.capabilityContractId || step.capabilityId;
  const resolvedArguments = resolveWorkflowValue(
    step.argumentsTemplate || {},
    args.inputs || {},
    0, run,
  ) as Record<string, any>;
  const executionKey = workflowReconciliationExecutionKey(run, step.stepId);
  let record;
  if (step.attachedReconciliation) {
    if (capabilityId && capabilityId !== step.attachedReconciliation.toolName && capabilityId !== 'attached') {
      throw new Error(`This workflow step is bound to the attached reconciliation hook on '${step.attachedReconciliation.toolName}'.`);
    }
    if (!step.capabilitySnapshot) throw new Error('The workflow lacks a frozen capability contract for attached reconciliation.');
    const currentOriginalManifest = context.toolRegistry.getCapabilityManifestEntry(
      step.attachedReconciliation.toolName,
      context.toolPolicy,
      context,
    );
    const currentOriginalDefinition = context.toolRegistry.get(step.attachedReconciliation.toolName);
    if (!capabilityContractStillCompatible(
      step,
      currentOriginalManifest,
      currentOriginalDefinition?.parameters || {},
    )) {
      throw new Error(`Capability '${step.attachedReconciliation.toolName}' changed after workflow publication; its attached reconciliation hook cannot be trusted for this frozen run.`);
    }
    record = await executeAttachedExternalCommitReconciliation({
      registry: context.toolRegistry,
      originalToolName: step.attachedReconciliation.toolName,
      originalCapabilityId,
      capabilityContractHash: step.capabilitySnapshot.contractHash,
      expectedImplementationFingerprint: step.attachedReconciliation.implementationFingerprint,
      originalArguments: resolvedArguments,
      expectedInputDigests: {
        argumentsDigest: run.pendingExecution.argumentsDigest,
        targetDigest: run.pendingExecution.targetDigest,
      },
      originalIdempotencyKey: run.pendingExecution.idempotencyKey,
      reconciliationRecordId: executionKey,
      context: {
        ...context,
        conversationId: run.pendingExecution.originContext?.conversationId || context?.conversationId,
        source: run.pendingExecution.originContext?.source || context?.source,
        userConfirmed: false,
        taskId: run.runId,
        idempotencyKey: run.pendingExecution.idempotencyKey,
      },
    });
  } else {
    if (!(step.onFailure?.fallbackCapabilityIds || []).includes(capabilityId)) {
      throw new Error(`Capability '${capabilityId}' is not declared as a reconciliation adapter for this workflow step.`);
    }
    const manifest = context.toolRegistry.getCapabilityManifestEntry(capabilityId, context.toolPolicy, context);
    if (!manifest
      || (manifest.operation !== 'observe' && manifest.operation !== 'test')
      || manifest.sideEffects.length > 0
      || !manifest.reconciliation?.reconcilesCapabilityIds.includes(originalCapabilityId)
      || manifest.reconciliation.outcomeField !== 'reconciliationStatus') {
      throw new Error(`Capability '${capabilityId}' is not a read-only reconciliation adapter.`);
    }
    record = await executeToolCall({
      registry: context.toolRegistry,
      id: executionKey,
      name: capabilityId,
      arguments: resolvedArguments,
      context: {
        ...context,
        userConfirmed: false,
        taskId: run.runId,
        idempotencyKey: executionKey,
      },
    });
  }
  if (record.terminalVerification?.status !== 'verified') {
    return JSON.stringify({
      ok: false,
      status: 'blocked',
      runId: run.runId,
      revision: run.revision,
      stepId: step.stepId,
      reconciliationRequired: true,
      blocker: record.error || record.terminalVerification?.reason || 'Read-only reconciliation remained inconclusive.',
    }, null, 2);
  }
  const reconciled = recordWorkflowReconciliation({
    runId: run.runId,
    expectedRevision: run.revision,
    userId,
    actor: 'workflow-reconciliation',
    stepId: step.stepId,
    toolRecord: record,
  });
  await persistWorkflowRuntimeBarrier();
  return JSON.stringify({
    ok: true,
    status: reconciled.status,
    runId: reconciled.runId,
    revision: reconciled.revision,
    stepId: step.stepId,
    reconciliationRequired: Boolean(reconciled.reconciliationRequired),
    nextAction: 'Continue this exact runId and revision; do not create a replacement run.',
  }, null, 2);
}
