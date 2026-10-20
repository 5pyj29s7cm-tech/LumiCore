import { cloneDatabaseValue } from "../../../db/snapshot_changes";
import { runtimeBackgroundWork, runtimeShutdownCancellation } from "../../../runtime/shutdown_work";
import { captureOrganizationMembershipAuthorization } from "../../../org/membership_authorization";
import { executeToolCall, toolExecutionInputDigests } from "../../execution_engine";
import { listWorkflows, getWorkflow, getSavedWorkflowRuntimeDefinition, recordWorkflowRun } from "../../../agents/workflows";
import { authorizeWorkflowAdapterStart, checkpointWorkflowRun, claimWorkflowRun, completeWorkflowRun, createWorkflowRun, findBlockingWorkflowRun, getWorkflowRun, prepareWorkflowStepExecution, persistWorkflowRuntimeBarrier, renewWorkflowRunLease, requestWorkflowCancel, stopUnauthorizedWorkflowRun, resolveWorkflowValue, resumeWorkflowRun, waitForWorkflowConfirmation, topologicallyOrderWorkflowSteps, workflowStepExecutionKey } from "../../../workflows/runtime";
import { workflowAuthorizationCurrent, workflowScope, assertWorkflowAuthorization } from './authorization';
import { durablyBlockWorkflowRun } from './run_barrier';
import { workflowRunSummary } from './run_projection';
import { capabilityContractStillCompatible } from './capability_snapshot';

const activeWorkflowWorkers = new Map<string, Promise<void>>();

// Approval pauses must not discard this run's inputs. Keep them only in
// bounded, expiring process memory; never persist secret values in the ledger.
const workflowEphemeralInputs = new Map<string, { userId: string; expires: number; inputs: Record<string, any> }>();

export function scheduleWorkflowWorker(args: Record<string, any>, context: any, runId: string): void {
  const userId = context?.userId || 'system';
  const scheduledRun = getWorkflowRun(runId, userId);
  const leaseId = scheduledRun?.lease?.leaseId;
  if (!scheduledRun || scheduledRun.status !== 'running' || !leaseId) return;
  for (const [key, value] of workflowEphemeralInputs) {
    const current = getWorkflowRun(key, value.userId);
    if (value.expires <= Date.now() || !current || ['completed', 'cancelled'].includes(current.status)) workflowEphemeralInputs.delete(key);
  }
  const retained = workflowEphemeralInputs.get(runId);
  const inputs = { ...(retained?.userId === userId ? retained.inputs : {}), ...(args.inputs || {}) };
  args = { ...args, inputs };
  if (JSON.stringify(inputs).length <= 1_000_000) {
    if (workflowEphemeralInputs.size >= 100 && !workflowEphemeralInputs.has(runId)) workflowEphemeralInputs.delete(workflowEphemeralInputs.keys().next().value!);
    workflowEphemeralInputs.set(runId, { userId, expires: Date.now() + 30 * 60_000, inputs: cloneDatabaseValue(inputs) });
  }
  const generationKey = `${runId}:${leaseId}`;
  if (activeWorkflowWorkers.has(generationKey)) return;
  const controller = new AbortController();
  const onStopped = () => {
    const current = getWorkflowRun(runId, userId);
    if (current?.status === 'running' && current.lease?.leaseId === leaseId
      && !current.cancelRequestedAt && !current.pauseRequestedAt) {
      requestWorkflowCancel({ runId, userId, expectedRevision: current.revision, actor: 'runtime-shutdown' });
    }
  };
  controller.signal.addEventListener('abort', onStopped, { once: true });
  const unregisterShutdown = runtimeShutdownCancellation.register(controller);
  let authorityStopped = false;
  const stop = () => {
    if (!controller.signal.aborted) controller.abort(new DOMException('Workflow execution stopped.', 'AbortError'));
  };
  const check = () => {
    const current = getWorkflowRun(runId, userId);
    if (!current) { stop(); return true; }
    if (!workflowAuthorizationCurrent(scheduledRun) || context?.isCancelled?.() === true || context?.executionSignal?.aborted) {
      // A late watcher for one lease must never stop a newer resumed worker.
      if (!authorityStopped && current.lastWorkerLeaseId === leaseId) {
        authorityStopped = true;
        stopUnauthorizedWorkflowRun(runId, userId);
      }
      stop();
    }
    if (current.cancelRequestedAt || current.pauseRequestedAt || current.status !== 'running' || current.lease?.leaseId !== leaseId) stop();
    return controller.signal.aborted;
  };
  const authorizationTimer = setInterval(check, 100);
  authorizationTimer.unref?.();
  const parentAbort = () => { check(); };
  context?.executionSignal?.addEventListener('abort', parentAbort);
  const workerContext = {
    ...context,
    autonomous: true,
    source: 'workflow-runtime',
    executionSignal: controller.signal,
    isCancelled: check,
  };
  const promise = runtimeBackgroundWork.track(Promise.resolve().then(async () => {
    let renewing = false;
    const heartbeatMs = Math.max(10, Number(context?.workflowHeartbeatMs) || 20_000);
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      const current = getWorkflowRun(runId, userId);
      if (!current || current.status !== 'running' || current.lease?.leaseId !== leaseId) {
        clearInterval(heartbeat);
        activeWorkflowWorkers.delete(generationKey);
        renewing = false;
        return;
      }
      void renewWorkflowRunLease({
        runId,
        userId: current.userId,
        leaseId: current.lease.leaseId,
        owner: current.lease.owner,
        leaseMs: 120_000,
      }).catch(() => undefined).finally(() => { renewing = false; });
    }, heartbeatMs);
    heartbeat.unref?.();
    try {
      await handleRunWorkflow({ ...args, runId, __workflowWorker: true }, workerContext);
    } catch (error) {
      const current = getWorkflowRun(runId, userId);
      if (current?.status === 'running' && current.lease?.leaseId === leaseId) {
        try {
          await durablyBlockWorkflowRun({
            runId,
            expectedRevision: current.revision,
            userId: current.userId,
            actor: 'workflow-worker',
            reason: error instanceof Error ? error.message : String(error),
            kind: 'execution_error',
          });
        } catch {
          // A concurrent pause/cancel/reconciliation state is authoritative.
        }
      }
    } finally {
      clearInterval(heartbeat);
      clearInterval(authorizationTimer);
      context?.executionSignal?.removeEventListener('abort', parentAbort);
      await persistWorkflowRuntimeBarrier();
    }
  }).finally(() => {
    const current = getWorkflowRun(runId, userId);
    if (!current || ['completed', 'cancelled'].includes(current.status)) workflowEphemeralInputs.delete(runId);
    unregisterShutdown();
    controller.signal.removeEventListener('abort', onStopped);
    activeWorkflowWorkers.delete(generationKey);
  }));
  activeWorkflowWorkers.set(generationKey, promise);
  // Failed persistence remains dirty and observable through the run reader's
  // strict barrier; a detached worker must not create an unhandled rejection.
  void promise.catch(() => {});
}

export async function handleRunWorkflow(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const name: string = args.name || '';
  let run = args.runId ? getWorkflowRun(String(args.runId), userId) : null;
  if (args.runId && !run) throw new Error(`Workflow run '${String(args.runId)}' was not found for this user.`);
  const requestedScope = workflowScope(context);
  if (run && (run.scope.domain !== requestedScope.domain || run.scope.orgId !== requestedScope.orgId)) {
    throw new Error(`Workflow run '${run.runId}' was not found in this scope.`);
  }
  if (run) assertWorkflowAuthorization(run);
  const wf = run
    ? listWorkflows(userId, undefined, requestedScope).find(item => item.runtimeWorkflowId === run!.workflowId) || null
    : (name ? getWorkflow(userId, name, requestedScope) : null);
  if (run && name && wf && name !== wf.name) {
    throw new Error(`Workflow run '${run.runId}' belongs to '${wf.name}', not '${name}'.`);
  }
  let definition = wf ? getSavedWorkflowRuntimeDefinition(wf) : null;
  if (!run) {
    if (!name) throw new Error('Workflow name is required when starting a new run.');
    if (!wf) throw new Error(`Workflow "${name}" not found. Use list_workflows to see available workflows.`);
    if (!definition || definition.status !== 'published') {
      return JSON.stringify({
        ok: false,
        status: 'waiting_publication',
        workflowId: wf.id,
        name: wf.name,
        version: wf.runtimeVersion,
        hash: wf.runtimeHash,
        blocker: 'This workflow is a draft. Review and publish its exact version before execution.',
      }, null, 2);
    }
  }
  if (run && !args.__workflowWorker && Number(args.expectedRevision) !== run.revision) {
    throw new Error(`Workflow run revision conflict: expected ${Number(args.expectedRevision)}, actual ${run.revision}.`);
  }
  const workflowId = run?.workflowId || definition!.workflowId;
  const workflowName = wf?.name || name || `Workflow ${workflowId}`;
  if (!run) {
    const blockingRun = findBlockingWorkflowRun(definition!.workflowId, userId);
    if (blockingRun) {
      return JSON.stringify({
        ok: false,
        status: 'blocked',
        runId: blockingRun.runId,
        revision: blockingRun.revision,
        workflowId: definition!.workflowId,
        name: workflowName,
        reconciliationRequired: Boolean(blockingRun.reconciliationRequired),
        blocker: blockingRun.blockedReason || 'Continue or resolve the existing run; a replacement run was not created.',
        completedSteps: blockingRun.receipts.filter(receipt => receipt.status === 'verified').length,
        totalSteps: blockingRun.planSnapshot.length,
        steps: [],
      }, null, 2);
    }
    run = createWorkflowRun({
      workflowId: definition!.workflowId,
      version: definition!.version,
      userId,
      variables: args.inputs || {},
      actor: 'user',
      membershipAuthorization: requestedScope.domain === 'work'
        ? captureOrganizationMembershipAuthorization(requestedScope.orgId, userId) : undefined,
    });
  } else if (run.status === 'completed') {
    return JSON.stringify({
      ok: true,
      status: 'completed',
      runId: run.runId,
      revision: run.revision,
      workflowId,
      name: workflowName,
      deduplicated: true,
      completedSteps: run.planSnapshot.length,
      totalSteps: run.planSnapshot.length,
      steps: run.receipts.filter(receipt => receipt.status === 'verified'),
    }, null, 2);
  } else if (run.status === 'paused' || run.status === 'blocked') {
    run = resumeWorkflowRun({
      runId: run.runId,
      expectedRevision: run.revision,
      userId,
      actor: 'workflow-tool',
    });
  } else if (run.status === 'running' && args.__workflowWorker) {
    // The fast foreground call already claimed this durable run.
  } else if (run.status !== 'queued') {
    throw new Error(`Workflow run '${run.runId}' cannot be continued from state '${run.status}'.`);
  }
  if (!args.__workflowWorker) {
    run = claimWorkflowRun({
      runId: run.runId,
      expectedRevision: run.revision,
      userId,
      owner: `workflow-worker:${context?.requestId || 'interactive'}`,
      leaseMs: 120_000,
    });
    await persistWorkflowRuntimeBarrier();
    assertWorkflowAuthorization(run);
    scheduleWorkflowWorker({ ...args, expectedRevision: run.revision }, context, run.runId);
    return JSON.stringify({
      ok: true,
      status: 'started',
      runStatus: run.status,
      runId: run.runId,
      revision: run.revision,
      workflowId,
      name: workflowName,
      completed: false,
      completedSteps: run.receipts.filter(receipt => receipt.status === 'verified').length,
      totalSteps: run.planSnapshot.length,
      nextAction: 'Use get_workflow_run to observe progress or the workflow control tools to pause, cancel, approve, or revise it.',
      steps: [],
    }, null, 2);
  }

  const stepReceipts: Array<Record<string, unknown>> = [];
  const orderedSteps = topologicallyOrderWorkflowSteps(run.planSnapshot);
  const workerResponse = (extra: Record<string, unknown>) => JSON.stringify({
    ok: false, status: run!.status, runId: run!.runId, revision: run!.revision,
    workflowId, name: workflowName, completedSteps: stepReceipts.length,
    totalSteps: orderedSteps.length, steps: stepReceipts, ...extra,
  }, null, 2);

  if (!context?.toolRegistry) {
    run = await durablyBlockWorkflowRun({
      runId: run.runId,
      expectedRevision: run.revision,
      userId,
      actor: 'workflow-tool',
      reason: 'The tool registry is unavailable.',
      kind: 'policy',
    });
    return workerResponse({
      status: 'blocked',
      completedSteps: 0,
      blocker: 'The tool registry is unavailable.',
      steps: [],
    });
  }
  const blockChangedContract = async (stepId: string, blocker: string) => {
    run = await durablyBlockWorkflowRun({ runId: run!.runId, expectedRevision: run!.revision,
      userId, actor: 'workflow-tool', reason: blocker, kind: 'capability_contract_changed' });
    return workerResponse({
      status: 'blocked',
      failedStepId: stepId,
      blocker,
    });
  };
  const workerLeaseId = run.lease?.leaseId;
  if (!workerLeaseId) throw new Error(`Workflow run '${run.runId}' has no live worker lease.`);

  for (let i = 0; i < orderedSteps.length; i++) {
    context?.isCancelled?.();
    const currentBeforeStep = getWorkflowRun(run.runId, userId);
    if (!currentBeforeStep
      || currentBeforeStep.status !== 'running'
      || currentBeforeStep.lease?.leaseId !== workerLeaseId) {
      return JSON.stringify({
        ...(currentBeforeStep ? workflowRunSummary(currentBeforeStep) : { runId: run.runId, status: 'stopped' }),
        ok: false,
      }, null, 2);
    }
    // Heartbeats and durable barriers may advance the ledger revision without
    // changing worker ownership. Always use the latest same-lease revision.
    run = currentBeforeStep;
    assertWorkflowAuthorization(run);
    const step = orderedSteps[i];
    const capabilityId = step.capabilityId;
    if (!capabilityId || capabilityId.startsWith('unresolved:') || capabilityId.startsWith('skill:')) {
      const blocker = `Workflow step '${step.stepId}' has no directly executable capability.`;
      run = await durablyBlockWorkflowRun({
        runId: run.runId,
        expectedRevision: run.revision,
        userId,
        actor: 'workflow-tool',
        reason: blocker,
        kind: 'policy',
      });
      return workerResponse({
        status: 'blocked',
        failedStep: i + 1,
        failedStepId: step.stepId,
        blocker,
      });
    }
    const existingExecutionKey = workflowStepExecutionKey(run, step.stepId);
    if (run.receipts.some(receipt => (
      receipt.stepId === step.stepId
      && receipt.idempotencyKey === existingExecutionKey
      && receipt.status === 'verified'
    ))) {
      stepReceipts.push({
        index: i + 1,
        stepId: step.stepId,
        capability: capabilityId,
        status: 'completed',
        deduplicated: true,
      });
      continue;
    }
    const currentDefinition = context.toolRegistry.get(capabilityId);
    const currentHandler = currentDefinition?.handler;
    const capabilityContractBlocker = `Workflow step '${step.stepId}' no longer matches its reviewed capability contract. Publish a reviewed workflow version before execution.`;
    const capabilityContractMatchesReviewedDefinition = () => {
      const latestManifest = context.toolRegistry.getCapabilityManifestEntry(capabilityId, context.toolPolicy, context);
      const latestDefinition = context.toolRegistry.get(capabilityId);
      return latestDefinition === currentDefinition
        && latestDefinition?.handler === currentHandler
        && capabilityContractStillCompatible(step, latestManifest, latestDefinition?.parameters || {});
    };
    if (!capabilityContractMatchesReviewedDefinition()) {
      return blockChangedContract(step.stepId, capabilityContractBlocker);
    }
    const resolvedArguments = resolveWorkflowValue(
      step.argumentsTemplate || {},
      args.inputs || {},
      0, run,
    ) as Record<string, any>;
    const approval = run.stepApprovals?.[step.stepId];
    const inputDigests = toolExecutionInputDigests(resolvedArguments);
    const approved = step.confirmation?.required && approval?.planRevision === run.planRevision
      && approval.argumentsDigest === inputDigests.argumentsDigest
      && approval.targetDigest === inputDigests.targetDigest;
    if (step.confirmation?.required) {
      if (!approved) {
        run = waitForWorkflowConfirmation({
          runId: run.runId,
          expectedRevision: run.revision,
          userId,
          leaseId: run.lease!.leaseId,
          actor: 'workflow-worker',
          stepId: step.stepId,
          capabilityId,
          reason: step.confirmation.reason || `Approve the frozen workflow step '${step.description || step.stepId}' before execution.`,
          arguments: resolvedArguments,
        });
        await persistWorkflowRuntimeBarrier();
        return workerResponse({
          ok: true,
          status: 'waiting_confirmation',
          confirmationId: run.confirmation?.confirmationId,
          stepId: step.stepId,
          capabilityId,
        });
      }
    }
    run = await prepareWorkflowStepExecution({
      runId: run.runId,
      expectedRevision: run.revision,
      userId,
      leaseId: run.lease!.leaseId,
      actor: 'workflow-tool',
      stepId: step.stepId,
      capabilityId,
      arguments: resolvedArguments,
      originContext: {
        conversationId: context?.conversationId,
        source: context?.source,
      },
    });
    if (!capabilityContractMatchesReviewedDefinition()) {
      return blockChangedContract(step.stepId, capabilityContractBlocker);
    }
    const executionKey = workflowStepExecutionKey(run, step.stepId);
    const upstreamAdapterStart = context?.onAdapterStart;
    const capabilityContractAdapterError = `${capabilityContractBlocker} The adapter was not started.`;
    const record = await executeToolCall({
      registry: context.toolRegistry,
      id: executionKey,
      name: capabilityId,
      arguments: resolvedArguments,
      context: {
        ...context,
        conversationId: run.pendingExecution?.originContext?.conversationId || context?.conversationId,
        source: run.pendingExecution?.originContext?.source || context?.source,
        autonomous: approved ? false : context?.autonomous,
        userConfirmed: false,
        taskId: run.runId,
        idempotencyKey: executionKey,
        onAdapterStart: async (call: { name: string; attempt: number }) => {
          assertWorkflowAuthorization(run!);
          if (context?.isCancelled?.()) throw new Error('Workflow execution stopped before adapter start.');
          if (!capabilityContractMatchesReviewedDefinition()) {
            throw new Error(capabilityContractAdapterError);
          }
          await authorizeWorkflowAdapterStart({
            runId: run!.runId,
            expectedRevision: run!.revision,
            userId,
            leaseId: run!.lease!.leaseId,
            executionId: executionKey,
            actor: 'workflow-tool',
          });
          await upstreamAdapterStart?.(call);
          assertWorkflowAuthorization(run!);
          if (context?.isCancelled?.()) throw new Error('Workflow execution stopped before adapter start.');
          if (!capabilityContractMatchesReviewedDefinition()) {
            throw new Error(capabilityContractAdapterError);
          }
        },
      },
    });
    const verified = record.terminalVerification?.status === 'verified'
      && record.envelope?.status === 'verified_success'
      && record.envelope.verification.status === 'verified';
    context?.isCancelled?.();
    const latestRun = getWorkflowRun(run.runId, userId);
    if (!latestRun || latestRun.status !== 'running' || !latestRun.lease
      || latestRun.lease.leaseId !== run.lease?.leaseId) {
      if (record.adapterStarted !== true && latestRun && (latestRun.status === 'paused' || latestRun.status === 'cancelled')) {
        return JSON.stringify({ ...workflowRunSummary(latestRun), ok: false }, null, 2);
      }
      throw new Error('Workflow control or lease ownership changed while the adapter was running; its outcome requires ledger reconciliation.');
    }
    run = latestRun;
    if (!verified) {
      const controlledRun = getWorkflowRun(run.runId, userId);
      if (record.adapterStarted !== true && controlledRun && (controlledRun.status === 'paused' || controlledRun.status === 'cancelled')) {
        return workerResponse({
          status: controlledRun.status,
          runId: controlledRun.runId,
          revision: controlledRun.revision,
        });
      }
      const blocker = record.error || record.terminalVerification?.reason || record.envelope?.verification.reason || 'The workflow step did not produce verified terminal evidence.';
      run = await durablyBlockWorkflowRun({
        runId: run.runId,
        expectedRevision: run.revision,
        userId,
        actor: 'workflow-tool',
        reason: blocker,
        stepId: step.stepId,
        capabilityId,
        toolRecord: record,
        kind: record.adapterStarted !== true && record.error === capabilityContractAdapterError
          ? 'capability_contract_changed'
          : undefined,
      });
      return workerResponse({
        status: run.reconciliationRequired ? 'blocked' : 'failed',
        failedStep: i + 1,
        failedStepId: step.stepId,
        blocker,
        reconciliationRequired: run.reconciliationRequired,
        steps: [...stepReceipts, { index: i + 1, stepId: step.stepId, capability: capabilityId, status: 'failed', error: blocker }],
      });
    }
    stepReceipts.push({ index: i + 1, stepId: step.stepId, capability: capabilityId, status: 'completed', result: record.result });
    run = checkpointWorkflowRun({
      runId: run.runId,
      expectedRevision: run.revision,
      userId,
      leaseId: run.lease!.leaseId,
      actor: 'workflow-tool',
      stepId: step.stepId,
      nextStepId: orderedSteps[i + 1]?.stepId,
      toolRecord: record,
    });
    await persistWorkflowRuntimeBarrier();
    if (run.status !== 'running') {
      return workerResponse({

      });
    }
  }

  const latestForCompletion = getWorkflowRun(run.runId, userId);
  if (!latestForCompletion || latestForCompletion.status !== 'running' || !latestForCompletion.lease
    || latestForCompletion.lease.leaseId !== run.lease?.leaseId) {
    throw new Error('Workflow lease changed before terminal completion could be recorded.');
  }
  run = latestForCompletion;
  assertWorkflowAuthorization(run);
  run = completeWorkflowRun({
    runId: run.runId,
    expectedRevision: run.revision,
    userId,
    leaseId: run.lease!.leaseId,
    actor: 'workflow-tool',
  });
  if (wf) recordWorkflowRun(userId, wf.name, requestedScope);
  await persistWorkflowRuntimeBarrier();
  assertWorkflowAuthorization(run);

  return workerResponse({
    ok: true,
    status: 'completed',
  });
}
