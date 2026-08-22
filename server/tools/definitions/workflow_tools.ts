import { ToolRegistry } from '../registry';
import { createHash } from 'crypto';
import type { CapabilityManifestEntry } from '../types';
import {
  attachedExternalCommitReconciliationFingerprint,
  executeAttachedExternalCommitReconciliation,
  executeToolCall,
  toolExecutionInputDigests,
} from '../execution_engine';
import {
  saveWorkflowDraftCandidate,
  listWorkflows,
  getWorkflow,
  deleteWorkflow,
  captureRecentAsWorkflow,
  getSavedWorkflowRuntimeDefinition,
  publishSavedWorkflow,
  refreshSavedWorkflowRuntimeDraft,
  recordWorkflowRun,
} from '../../agents/workflows';
import { getRecentWorkflows } from '../../skills/worklog';
import { capabilityContract, capabilityEvidence } from '../capability_contracts';
import {
  blockWorkflowRun,
  authorizeWorkflowAdapterStart,
  checkpointWorkflowRun,
  claimWorkflowRun,
  completeWorkflowRun,
  createWorkflowRun,
  findBlockingWorkflowRun,
  getWorkflowRun,
  prepareWorkflowStepExecution,
  persistWorkflowRuntimeBarrier,
  renewWorkflowRunLease,
  recordWorkflowReconciliation,
  requestWorkflowCancel,
  requestWorkflowPause,
  decideWorkflowConfirmation,
  editWorkflowRunPlan,
  resolveWorkflowValue,
  resumeWorkflowRun,
  waitForWorkflowConfirmation,
  topologicallyOrderWorkflowSteps,
  workflowReconciliationExecutionKey,
  workflowStepExecutionKey,
} from '../../workflows/runtime';

function canonicalContractJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalContractJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalContractJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function frozenCapabilitySnapshot(manifest: CapabilityManifestEntry, parameterSchema: Record<string, unknown> = {}) {
  const contract = {
    capabilityId: manifest.capabilityId,
    operation: manifest.operation,
    risk: manifest.risk,
    sideEffects: [...manifest.sideEffects]
      .map(effect => ({ type: effect.type, scope: effect.scope, reversible: effect.reversible }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    configuredSecurityLevel: manifest.configuredSecurityLevel,
    parameterNames: [...manifest.parameterNames].sort(),
    prerequisites: [...manifest.prerequisites].sort(),
    parameterSchemaHash: createHash('sha256').update(canonicalContractJson(parameterSchema)).digest('hex'),
    verificationHash: createHash('sha256').update(canonicalContractJson(manifest.verification)).digest('hex'),
    provider: manifest.provider,
    trust: manifest.trust,
    deprecated: manifest.deprecated,
    replacedBy: manifest.replacedBy,
    adapter: manifest.adapter
      ? { id: manifest.adapter.id, operations: [...manifest.adapter.operations].sort() }
      : undefined,
  };
  return {
    ...contract,
    contractHash: createHash('sha256').update(canonicalContractJson(contract)).digest('hex'),
  };
}

function capabilityContractStillCompatible(
  step: { capabilitySnapshot?: { contractHash: string } },
  manifest?: CapabilityManifestEntry,
  parameterSchema: Record<string, unknown> = {},
): boolean {
  if (!step.capabilitySnapshot || !manifest) return false;
  return frozenCapabilitySnapshot(manifest, parameterSchema).contractHash === step.capabilitySnapshot.contractHash;
}

function attachedReconciliationContract(
  definition: ReturnType<ToolRegistry['get']>,
  manifest: CapabilityManifestEntry,
  capabilitySnapshot: ReturnType<typeof frozenCapabilitySnapshot>,
) {
  if (!definition?.reconcileExternalCommit) return undefined;
  return {
    kind: 'tool_definition_hook' as const,
    toolName: definition.name,
    capabilityId: manifest.capabilityId,
    hookVersion: 1 as const,
    implementationFingerprint: attachedExternalCommitReconciliationFingerprint({
      toolName: definition.name,
      capabilityId: manifest.capabilityId,
      capabilityContractHash: capabilitySnapshot.contractHash,
      hook: definition.reconcileExternalCommit,
    }),
  };
}

function workflowScope(context?: any): { domain: 'personal' | 'work'; orgId: string } {
  if (context?.domain === 'work' && context?.orgId) {
    return { domain: 'work', orgId: String(context.orgId) };
  }
  return { domain: 'personal', orgId: '' };
}

function requireWorkflowRunForContext(runId: string, context?: any) {
  const userId = context?.userId || 'system';
  const run = getWorkflowRun(runId, userId);
  if (!run) throw new Error(`Workflow run '${runId}' was not found for this user.`);
  const scope = workflowScope(context);
  if (run.scope.domain !== scope.domain || run.scope.orgId !== scope.orgId) {
    throw new Error(`Workflow run '${runId}' was not found in this scope.`);
  }
  return run;
}

async function durablyBlockWorkflowRun(input: Parameters<typeof blockWorkflowRun>[0]) {
  const run = blockWorkflowRun(input);
  await persistWorkflowRuntimeBarrier();
  return run;
}

async function handleSaveWorkflow(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const name: string = args.name || '';
  const description: string = args.description || '';
  const steps = (args.steps || []).map((step: Record<string, any>) => {
    const primaryToolName = String(step.tool || '').trim();
    const primaryManifest = primaryToolName
      ? context?.toolRegistry?.getCapabilityManifestEntry(primaryToolName, context?.toolPolicy)
      : undefined;
    const primaryDefinition = primaryToolName ? context?.toolRegistry?.get(primaryToolName) : undefined;
    const reconciliationCapabilityId = String(step.reconciliationCapabilityId || '').trim();
    if (!reconciliationCapabilityId) {
      const capabilitySnapshot = primaryManifest
        ? frozenCapabilitySnapshot(primaryManifest, primaryDefinition?.parameters || {})
        : undefined;
      return primaryManifest ? {
        ...step,
        capabilityContractId: primaryManifest.capabilityId,
        capabilitySnapshot,
        attachedReconciliation: attachedReconciliationContract(primaryDefinition, primaryManifest, capabilitySnapshot!),
      } : step;
    }
    const manifest = context?.toolRegistry?.getCapabilityManifestEntry(
      reconciliationCapabilityId,
      context?.toolPolicy,
    );
    if (!manifest
      || (manifest.operation !== 'observe' && manifest.operation !== 'test')
      || manifest.sideEffects.length > 0
      || !primaryManifest
      || !manifest.reconciliation?.reconcilesCapabilityIds.includes(primaryManifest.capabilityId)
      || manifest.reconciliation.outcomeField !== 'reconciliationStatus') {
      throw new Error(`Workflow reconciliation capability '${reconciliationCapabilityId}' must explicitly declare that it reconciles '${primaryManifest?.capabilityId || primaryToolName}'.`);
    }
    return {
      ...step,
      capabilityContractId: primaryManifest.capabilityId,
      capabilitySnapshot: frozenCapabilitySnapshot(primaryManifest, primaryDefinition?.parameters || {}),
      reconciliationCapabilityId,
    };
  });

  if (!name) throw new Error('Workflow name is required');
  if (!steps.length) throw new Error('At least one step is required');

  const wf = saveWorkflowDraftCandidate(
    userId,
    name,
    description,
    steps,
    { source: 'user_authored', reviewedByUser: false },
    undefined,
    args.category,
    workflowScope(context),
  );
  await persistWorkflowRuntimeBarrier();
  return JSON.stringify({
    ok: true,
    status: 'draft',
    workflowId: wf.id,
    version: wf.runtimeVersion,
    hash: wf.runtimeHash,
    name: wf.name,
    stepCount: wf.steps.length,
    nextAction: 'Review the draft, then publish this exact hash before it can run.',
  }, null, 2);
}

async function handleListWorkflows(_args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const workflows = listWorkflows(userId, undefined, workflowScope(context));
  if (!workflows.length) return 'No saved workflows.';
  return workflows.map(w =>
    `- **${w.name}**: ${w.description || 'No description'} (${w.steps.length} steps, ${w.lifecycleStatus || 'legacy'}, run ${w.runCount} times)`
  ).join('\n');
}

async function handleGetWorkflow(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const name: string = args.name || '';
  const wf = getWorkflow(userId, name, workflowScope(context));
  if (!wf) throw new Error(`Workflow "${name}" not found`);
  const definition = getSavedWorkflowRuntimeDefinition(wf);
  if (definition) {
    return JSON.stringify({
      ok: true,
      status: definition.status,
      workflowId: definition.workflowId,
      version: definition.version,
      hash: definition.hash,
      name: wf.name,
      description: wf.description,
      triggerPolicy: definition.triggerPolicy,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      steps: definition.steps,
      runCount: wf.runCount,
    }, null, 2);
  }
  const steps = wf.steps.map((s, i) => `  ${i + 1}. ${s.description}`).join('\n');
  return `**${wf.name}** — ${wf.description}\n\nSteps:\n${steps}\n\nRun count: ${wf.runCount}`;
}

async function handlePublishWorkflow(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const name = String(args.name || '');
  const expectedHash = String(args.expectedHash || '');
  if (!name || !expectedHash) throw new Error('Workflow name and reviewed draft hash are required.');
  const scope = workflowScope(context);
  const currentNamed = getWorkflow(userId, name, scope);
  const currentDefinition = currentNamed ? getSavedWorkflowRuntimeDefinition(currentNamed) : null;
  if (!currentNamed || !currentDefinition) throw new Error(`Workflow draft "${name}" was not found.`);
  if (currentNamed.runtimeHash !== expectedHash) throw new Error('Workflow changed before publication. Review the latest version.');
  if (!context?.toolRegistry) throw new Error('Capability registry is unavailable; the workflow cannot be reviewed safely.');
  const refreshedSteps = currentDefinition.steps.map(step => {
    const manifest = context.toolRegistry.getCapabilityManifestEntry(step.capabilityId, context.toolPolicy);
    const definition = context.toolRegistry.get(step.capabilityId);
    if (!manifest || !definition) {
      throw new Error(`Workflow capability '${step.capabilityId}' is unavailable and cannot be published.`);
    }
    const capabilitySnapshot = frozenCapabilitySnapshot(manifest, definition.parameters || {});
    return {
      ...step,
      capabilityContractId: manifest.capabilityId,
      capabilitySnapshot,
      attachedReconciliation: attachedReconciliationContract(definition, manifest, capabilitySnapshot),
    };
  });
  const capabilityContractsChanged = refreshedSteps.some((step, index) => (
    step.capabilitySnapshot?.contractHash !== currentDefinition.steps[index]?.capabilitySnapshot?.contractHash
    || step.attachedReconciliation?.implementationFingerprint !== currentDefinition.steps[index]?.attachedReconciliation?.implementationFingerprint
  ));
  if (capabilityContractsChanged) {
    const refreshed = refreshSavedWorkflowRuntimeDraft(userId, name, expectedHash, refreshedSteps, scope);
    if (!refreshed) throw new Error(`Workflow draft "${name}" was not found.`);
    await persistWorkflowRuntimeBarrier();
    return JSON.stringify({
      ok: true,
      status: 'draft_refreshed',
      workflowId: refreshed.id,
      version: refreshed.runtimeVersion,
      hash: refreshed.runtimeHash,
      name: refreshed.name,
      nextAction: 'Review the refreshed capability contract and call publish_workflow again with this exact hash.',
    }, null, 2);
  }
  const workflow = publishSavedWorkflow(userId, name, expectedHash, scope);
  if (!workflow) throw new Error(`Workflow draft "${name}" was not found.`);
  await persistWorkflowRuntimeBarrier();
  return JSON.stringify({
    ok: true,
    status: 'published',
    workflowId: workflow.id,
    version: workflow.runtimeVersion,
    hash: workflow.runtimeHash,
    name: workflow.name,
  }, null, 2);
}

async function handleDeleteWorkflow(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const name: string = args.name || '';
  const ok = deleteWorkflow(userId, name, workflowScope(context));
  await persistWorkflowRuntimeBarrier();
  return JSON.stringify({ ok, status: ok ? 'deleted' : 'not_found', name }, null, 2);
}

async function handleCaptureRecentWorkflow(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const name: string = args.name || '';
  if (!name) throw new Error('Workflow name is required. Ask the user what to call this workflow.');

  const scope = workflowScope(context);
  const recent = getRecentWorkflows(userId, scope.domain, scope.orgId);
  if (recent.length === 0) return 'No recent activity to capture. Try doing something first.';

  const last = recent[recent.length - 1];
  const toolTrace = last.toolSequence.map(s => ({
    name: s.name,
    args: s.args,
    resultSummary: s.resultSummary,
  }));

  const wf = captureRecentAsWorkflow(userId, name, toolTrace, scope);
  if (!wf) return 'No tool calls found in recent activity.';
  await persistWorkflowRuntimeBarrier();

  return JSON.stringify({
    ok: true,
    status: 'draft',
    workflowId: wf.id,
    version: wf.runtimeVersion,
    hash: wf.runtimeHash,
    name,
    stepCount: wf.steps.length,
    nextAction: 'Review and publish the captured draft before execution.',
  }, null, 2);
}

const activeWorkflowWorkers = new Map<string, Promise<void>>();

function scheduleWorkflowWorker(args: Record<string, any>, context: any, runId: string): void {
  const userId = context?.userId || 'system';
  const scheduledRun = getWorkflowRun(runId, userId);
  const leaseId = scheduledRun?.lease?.leaseId;
  if (!scheduledRun || scheduledRun.status !== 'running' || !leaseId) return;
  const generationKey = `${runId}:${leaseId}`;
  if (activeWorkflowWorkers.has(generationKey)) return;
  const workerContext = {
    ...context,
    autonomous: true,
    source: 'workflow-runtime',
    isCancelled: () => false,
  };
  const promise = Promise.resolve().then(async () => {
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
    }
  }).finally(() => {
    activeWorkflowWorkers.delete(generationKey);
  });
  activeWorkflowWorkers.set(generationKey, promise);
}

async function handleRunWorkflow(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const name: string = args.name || '';
  let run = args.runId ? getWorkflowRun(String(args.runId), userId) : null;
  if (args.runId && !run) throw new Error(`Workflow run '${String(args.runId)}' was not found for this user.`);
  const requestedScope = workflowScope(context);
  if (run && (run.scope.domain !== requestedScope.domain || run.scope.orgId !== requestedScope.orgId)) {
    throw new Error(`Workflow run '${run.runId}' was not found in this scope.`);
  }
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
  if (!context?.toolRegistry) {
    run = await durablyBlockWorkflowRun({
      runId: run.runId,
      expectedRevision: run.revision,
      userId,
      actor: 'workflow-tool',
      reason: 'The tool registry is unavailable.',
      kind: 'policy',
    });
    return JSON.stringify({
      ok: false,
      status: 'blocked',
      runId: run.runId,
      revision: run.revision,
      workflowId,
      name: workflowName,
      completedSteps: 0,
      totalSteps: orderedSteps.length,
      blocker: 'The tool registry is unavailable.',
      steps: [],
    }, null, 2);
  }
  const workerLeaseId = run.lease?.leaseId;
  if (!workerLeaseId) throw new Error(`Workflow run '${run.runId}' has no live worker lease.`);

  for (let i = 0; i < orderedSteps.length; i++) {
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
      return JSON.stringify({
        ok: false,
        status: 'blocked',
        runId: run.runId,
        revision: run.revision,
        workflowId,
        name: workflowName,
        completedSteps: stepReceipts.length,
        totalSteps: orderedSteps.length,
        failedStep: i + 1,
        failedStepId: step.stepId,
        blocker,
        steps: stepReceipts,
      }, null, 2);
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
    const currentManifest = context.toolRegistry.getCapabilityManifestEntry(capabilityId, context.toolPolicy);
    const currentDefinition = context.toolRegistry.get(capabilityId);
    const currentHandler = currentDefinition?.handler;
    const capabilityContractBlocker = `Workflow step '${step.stepId}' no longer matches its reviewed capability contract. Publish a reviewed workflow version before execution.`;
    const capabilityContractMatchesReviewedDefinition = () => {
      const latestManifest = context.toolRegistry.getCapabilityManifestEntry(capabilityId, context.toolPolicy);
      const latestDefinition = context.toolRegistry.get(capabilityId);
      return latestDefinition === currentDefinition
        && latestDefinition?.handler === currentHandler
        && capabilityContractStillCompatible(step, latestManifest, latestDefinition?.parameters || {});
    };
    if (!capabilityContractMatchesReviewedDefinition()) {
      const blocker = capabilityContractBlocker;
      run = await durablyBlockWorkflowRun({
        runId: run.runId,
        expectedRevision: run.revision,
        userId,
        actor: 'workflow-tool',
        reason: blocker,
        kind: 'capability_contract_changed',
      });
      return JSON.stringify({
        ok: false,
        status: 'blocked',
        runId: run.runId,
        revision: run.revision,
        workflowId,
        name: workflowName,
        completedSteps: stepReceipts.length,
        totalSteps: orderedSteps.length,
        failedStepId: step.stepId,
        blocker,
        steps: stepReceipts,
      }, null, 2);
    }
    const resolvedArguments = resolveWorkflowValue(
      step.argumentsTemplate || {},
      args.inputs || {},
    ) as Record<string, any>;
    if (step.confirmation?.required) {
      const approval = run.stepApprovals?.[step.stepId];
      const inputDigests = toolExecutionInputDigests(resolvedArguments);
      const approved = approval?.planRevision === run.planRevision
        && approval.argumentsDigest === inputDigests.argumentsDigest
        && approval.targetDigest === inputDigests.targetDigest;
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
        return JSON.stringify({
          ok: true,
          status: 'waiting_confirmation',
          runId: run.runId,
          revision: run.revision,
          workflowId,
          name: workflowName,
          confirmationId: run.confirmation?.confirmationId,
          stepId: step.stepId,
          capabilityId,
          completedSteps: stepReceipts.length,
          totalSteps: orderedSteps.length,
          steps: stepReceipts,
        }, null, 2);
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
      const blocker = capabilityContractBlocker;
      run = await durablyBlockWorkflowRun({
        runId: run.runId,
        expectedRevision: run.revision,
        userId,
        actor: 'workflow-tool',
        reason: blocker,
        kind: 'capability_contract_changed',
      });
      return JSON.stringify({
        ok: false,
        status: 'blocked',
        runId: run.runId,
        revision: run.revision,
        workflowId,
        name: workflowName,
        completedSteps: stepReceipts.length,
        totalSteps: orderedSteps.length,
        failedStepId: step.stepId,
        blocker,
        steps: stepReceipts,
      }, null, 2);
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
        userConfirmed: false,
        taskId: run.runId,
        idempotencyKey: executionKey,
        onAdapterStart: async (call: { name: string; attempt: number }) => {
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
          if (!capabilityContractMatchesReviewedDefinition()) {
            throw new Error(capabilityContractAdapterError);
          }
        },
      },
    });
    const verified = record.terminalVerification?.status === 'verified'
      && record.envelope?.status === 'verified_success'
      && record.envelope.verification.status === 'verified';
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
        return JSON.stringify({
          ok: false,
          status: controlledRun.status,
          runId: controlledRun.runId,
          revision: controlledRun.revision,
          workflowId,
          name: workflowName,
          completedSteps: stepReceipts.length,
          totalSteps: orderedSteps.length,
          steps: stepReceipts,
        }, null, 2);
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
      return JSON.stringify({
        ok: false,
        status: run.reconciliationRequired ? 'blocked' : 'failed',
        runId: run.runId,
        revision: run.revision,
        workflowId,
        name: workflowName,
        completedSteps: stepReceipts.length,
        totalSteps: orderedSteps.length,
        failedStep: i + 1,
        failedStepId: step.stepId,
        blocker,
        reconciliationRequired: run.reconciliationRequired,
        steps: [...stepReceipts, { index: i + 1, stepId: step.stepId, capability: capabilityId, status: 'failed', error: blocker }],
      }, null, 2);
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
      return JSON.stringify({
        ok: false,
        status: run.status,
        runId: run.runId,
        revision: run.revision,
        workflowId,
        name: workflowName,
        completedSteps: stepReceipts.length,
        totalSteps: orderedSteps.length,
        steps: stepReceipts,
      }, null, 2);
    }
  }

  const latestForCompletion = getWorkflowRun(run.runId, userId);
  if (!latestForCompletion || latestForCompletion.status !== 'running' || !latestForCompletion.lease
    || latestForCompletion.lease.leaseId !== run.lease?.leaseId) {
    throw new Error('Workflow lease changed before terminal completion could be recorded.');
  }
  run = latestForCompletion;
  run = completeWorkflowRun({
    runId: run.runId,
    expectedRevision: run.revision,
    userId,
    leaseId: run.lease!.leaseId,
    actor: 'workflow-tool',
  });
  if (wf) recordWorkflowRun(userId, wf.name, requestedScope);
  await persistWorkflowRuntimeBarrier();

  return JSON.stringify({
    ok: true,
    status: 'completed',
    runId: run.runId,
    revision: run.revision,
    workflowId,
    name: workflowName,
    completedSteps: stepReceipts.length,
    totalSteps: orderedSteps.length,
    steps: stepReceipts,
  }, null, 2);
}

function boundedWorkflowOutput(value: unknown, maxChars = 2_000): unknown {
  if (value === undefined) return undefined;
  let serialized = '';
  try { serialized = JSON.stringify(value); } catch { serialized = String(value ?? ''); }
  if (serialized.length <= maxChars) return value;
  return { truncated: true, preview: serialized.slice(0, maxChars) };
}

function workflowRunSummary(run: NonNullable<ReturnType<typeof getWorkflowRun>>) {
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
  return run;
}

async function handleGetWorkflowRun(args: Record<string, any>, context?: any): Promise<string> {
  const run = await readDurableWorkflowRunForContext(String(args.runId || ''), context);
  return JSON.stringify(workflowRunSummary(run), null, 2);
}

async function handlePauseWorkflowRun(args: Record<string, any>, context?: any): Promise<string> {
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

async function handleCancelWorkflowRun(args: Record<string, any>, context?: any): Promise<string> {
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

async function handleResumeWorkflowRun(args: Record<string, any>, context?: any): Promise<string> {
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

async function handleDecideWorkflowConfirmation(args: Record<string, any>, context?: any): Promise<string> {
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

async function handleEditWorkflowRun(args: Record<string, any>, context?: any): Promise<string> {
  const registry: ToolRegistry | undefined = context?.toolRegistry;
  if (!registry) throw new Error('Capability registry is unavailable; the workflow plan cannot be reviewed safely.');
  requireWorkflowRunForContext(String(args.runId || ''), context);
  const steps = (args.steps || []).map((step: Record<string, any>, index: number) => {
    const capabilityId = String(step.capabilityId || step.tool || '').trim();
    const manifest = registry.getCapabilityManifestEntry(capabilityId, context?.toolPolicy);
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

async function handleReconcileWorkflowRun(args: Record<string, any>, context?: any): Promise<string> {
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
    const manifest = context.toolRegistry.getCapabilityManifestEntry(capabilityId, context.toolPolicy);
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

export function registerWorkflowTools(registry: ToolRegistry): void {
  registry.register({
    name: 'save_workflow',
    description: 'Save a named multi-step workflow that can be recalled and run later. Use this when the user says "remember this workflow" or wants to save a useful process pattern.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Unique name for this workflow (e.g., "morning routine")' },
        description: { type: 'string', description: 'Short description of what this workflow does' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              tool: { type: 'string' },
              args: { type: 'object' },
              reconciliationCapabilityId: {
                type: 'string',
                description: 'Optional read-only observe/test capability that can verify this exact target after an interrupted side effect. It is frozen into the published version.',
              },
            },
          },
          description: 'Ordered list of workflow steps',
        },
        category: { type: 'string', description: 'Optional category for grouping' },
      },
      required: ['name', 'steps'],
    },
    handler: handleSaveWorkflow,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'workflow.definition.save', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'named workflow definition', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'workflowId', 'version', 'hash', 'name', 'stepCount'],
        requiredValues: { ok: true, status: 'draft' }, successStatuses: ['draft'],
        successSignals: ['the workflow store returned a versioned, redacted draft and exact step count'],
        limitations: ['Saving a draft does not publish, execute, or validate workflow steps.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'workflow.definition.save', operation: 'mutate', subjectArgument: 'name' }),
  });

  registry.register({
    name: 'list_workflows',
    description: 'List all saved named workflows for the current user.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    handler: handleListWorkflows,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'get_workflow',
    description: 'Get the full details of a saved workflow by name.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name' },
      },
      required: ['name'],
    },
    handler: handleGetWorkflow,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'publish_workflow',
    description: 'Publish one exact reviewed workflow draft version. If its capability contracts are missing or changed, this creates a new reviewable draft hash instead of silently publishing changed semantics.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name' },
        expectedHash: { type: 'string', description: 'Exact hash shown by save_workflow or get_workflow after review' },
      },
      required: ['name', 'expectedHash'],
    },
    handler: handlePublishWorkflow,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'workflow.definition.publish', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'high',
      sideEffects: [{ type: 'local_state_change', scope: 'immutable workflow definition version', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'workflowId', 'version', 'hash', 'name'],
        requiredValues: { ok: true }, successStatuses: ['published', 'draft_refreshed'],
        successSignals: ['the reviewed workflow hash was frozen, or a changed capability contract was returned as a new draft for review'],
        limitations: ['Publication does not execute the workflow; a refreshed draft requires another explicit review and publish call.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'workflow.definition.publish', operation: 'mutate', subjectArgument: 'name' }),
  });

  registry.register({
    name: 'delete_workflow',
    description: 'Delete a saved workflow by name.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name to delete' },
      },
      required: ['name'],
    },
    handler: handleDeleteWorkflow,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'workflow.definition.delete', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'high',
      sideEffects: [{ type: 'local_state_change', scope: 'named workflow definition', reversible: false }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'name'], requiredValues: { ok: true, status: 'deleted' },
        successStatuses: ['deleted'], successSignals: ['the workflow store acknowledged deletion'],
        limitations: ['Deleted workflow definitions are not automatically recoverable.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'workflow.definition.delete', operation: 'mutate', subjectArgument: 'name' }),
  });

  registry.register({
    name: 'capture_recent_workflow',
    description: 'Capture the most recent tool execution as a named workflow. Use this when the user says "remember this", "记下这个流程", "保存这个流程", or wants to save what they just did as a reusable workflow.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A descriptive name for this workflow (e.g., "morning briefing", "daily report")' },
      },
      required: ['name'],
    },
    handler: handleCaptureRecentWorkflow,
    permission: 'user',
    securityLevel: 'safe',
  });

  registry.register({
    name: 'run_workflow',
    description: 'Durably start a published workflow and return its runId immediately. Execution continues in the workflow worker and remains observable and interruptible through workflow control tools.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the workflow to run' },
        inputs: { type: 'object', description: 'Ephemeral run-time inputs. Secret values are resolved in memory and never written to the workflow ledger.' },
        runId: { type: 'string', description: 'Existing paused run to continue. Omit only when starting a new run.' },
        expectedRevision: { type: 'number', description: 'Required optimistic revision when continuing an existing run.' },
      },
      required: [],
      anyOf: [
        { required: ['name'] },
        { required: ['runId', 'expectedRevision'] },
      ],
    },
    handler: handleRunWorkflow,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'workflow.execution.run', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'durable workflow job start', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'runId', 'revision', 'workflowId', 'completedSteps', 'totalSteps'],
        requiredValues: { ok: true }, successStatuses: ['started', 'completed'],
        successSignals: ['the workflow ledger durably returned a run id before long-running execution began'],
        limitations: ['This receipt proves durable start, not completion. Completion is proven only by get_workflow_run and verified nested step receipts.'],
      },
    }),
    evidence: capabilityEvidence({
      id: 'workflow.execution.run', operation: 'mutate', subjectArgument: 'name',
      limitations: ['Starting is not completion; failed or unknown nested steps remain visible in the durable run ledger.'],
    }),
  });

  registry.register({
    name: 'get_workflow_run',
    description: 'Read the durable state, progress, checkpoint, blocker, or pending confirmation for one workflow run.',
    parameters: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
    },
    handler: handleGetWorkflowRun,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'workflow.execution.observe', family: 'workflow', lane: 'agents', operation: 'observe', risk: 'low',
      sideEffects: [],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'runId', 'revision', 'workflowId', 'completedSteps', 'totalSteps'],
        requiredValues: { ok: true }, successStatuses: ['queued', 'running', 'paused', 'waiting_confirmation', 'blocked', 'completed', 'cancelled'],
        successSignals: ['the durable workflow ledger returned the current revision and progress'],
        limitations: ['Observation never advances or repeats a workflow step.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'workflow.execution.observe', operation: 'observe', subjectArgument: 'runId' }),
  });

  registry.register({
    name: 'pause_workflow_run',
    description: 'Request a CAS-protected pause. A running adapter is allowed to reach its safe checkpoint; no new adapter starts after the request.',
    parameters: {
      type: 'object',
      properties: { runId: { type: 'string' }, expectedRevision: { type: 'number' } },
      required: ['runId', 'expectedRevision'],
    },
    handler: handlePauseWorkflowRun,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'workflow.execution.pause', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'workflow run control', reversible: true }],
      verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'status', 'runId', 'revision'], requiredValues: { ok: true }, successSignals: ['the durable run ledger recorded the pause request'], limitations: ['An adapter already started may finish before the safe pause checkpoint.'] },
    }),
    evidence: capabilityEvidence({ id: 'workflow.execution.pause', operation: 'mutate', subjectArgument: 'runId' }),
  });

  registry.register({
    name: 'cancel_workflow_run',
    description: 'Cancel remaining workflow work using runId and expectedRevision. A possibly committed unknown side effect remains locked for reconciliation.',
    parameters: {
      type: 'object',
      properties: { runId: { type: 'string' }, expectedRevision: { type: 'number' } },
      required: ['runId', 'expectedRevision'],
    },
    handler: handleCancelWorkflowRun,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'workflow.execution.cancel', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'workflow run control', reversible: false }],
      verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'status', 'runId', 'revision'], requiredValues: { ok: true }, successSignals: ['the durable run ledger recorded cancellation or a cancellation pending reconciliation'], limitations: ['Cancellation cannot erase a side effect that may already have committed.'] },
    }),
    evidence: capabilityEvidence({ id: 'workflow.execution.cancel', operation: 'mutate', subjectArgument: 'runId' }),
  });

  registry.register({
    name: 'resume_workflow_run',
    description: 'Resume a paused reviewed workflow run and dispatch its durable background worker. Unknown or incompatible runs cannot resume.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string' }, expectedRevision: { type: 'number' },
        inputs: { type: 'object', description: 'Ephemeral inputs or secret references needed by remaining steps.' },
      },
      required: ['runId', 'expectedRevision'],
    },
    handler: handleResumeWorkflowRun,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'workflow.execution.resume', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'high',
      sideEffects: [{ type: 'local_state_change', scope: 'workflow worker lease', reversible: true }],
      verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'status', 'runId', 'revision', 'runStatus'], requiredValues: { ok: true, status: 'started' }, successStatuses: ['started'], successSignals: ['a durable worker lease was created and the run id returned before any long step'], limitations: ['This proves resumption, not completion of remaining steps.'] },
    }),
    evidence: capabilityEvidence({ id: 'workflow.execution.resume', operation: 'mutate', subjectArgument: 'runId' }),
  });

  registry.register({
    name: 'decide_workflow_confirmation',
    description: 'Approve or reject one exact pending workflow step confirmation using its run revision and confirmation id.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string' }, expectedRevision: { type: 'number' }, confirmationId: { type: 'string' },
        approved: { type: 'boolean' }, inputs: { type: 'object', description: 'Ephemeral inputs used by the approved step.' },
      },
      required: ['runId', 'expectedRevision', 'confirmationId', 'approved'],
    },
    handler: handleDecideWorkflowConfirmation,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'workflow.execution.confirm', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'high',
      sideEffects: [{ type: 'local_state_change', scope: 'exact workflow step approval', reversible: true }],
      verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'status', 'runId', 'revision', 'approved'], requiredValues: { ok: true }, successSignals: ['the exact pending confirmation was consumed once'], limitations: ['Approval is bound to one plan revision and exact argument/target digest.'] },
    }),
    evidence: capabilityEvidence({ id: 'workflow.execution.confirm', operation: 'mutate', subjectArgument: 'runId' }),
  });

  registry.register({
    name: 'edit_workflow_run_plan',
    description: 'Replace only future, unexecuted steps of a paused workflow run. Executed receipts remain immutable and every capability contract is re-frozen.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string' }, expectedRevision: { type: 'number' }, reason: { type: 'string' },
        steps: { type: 'array', items: { type: 'object', properties: {
          stepId: { type: 'string' }, description: { type: 'string' }, capabilityId: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } }, arguments: { type: 'object' },
          confirmationRequired: { type: 'boolean' }, confirmationReason: { type: 'string' },
        }, required: ['stepId', 'capabilityId'] } },
      },
      required: ['runId', 'expectedRevision', 'steps', 'reason'],
    },
    handler: handleEditWorkflowRun,
    permission: 'user',
    securityLevel: 'confirm',
    capability: capabilityContract({
      id: 'workflow.execution.edit', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'high',
      sideEffects: [{ type: 'local_state_change', scope: 'future workflow plan revision', reversible: true }],
      verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'status', 'runId', 'revision', 'planRevision'], requiredValues: { ok: true, status: 'paused' }, successStatuses: ['paused'], successSignals: ['the future plan changed under CAS while executed steps remained immutable'], limitations: ['Executed steps and unresolved unknown outcomes cannot be edited away.'] },
    }),
    evidence: capabilityEvidence({ id: 'workflow.execution.edit', operation: 'mutate', subjectArgument: 'runId' }),
  });

  registry.register({
    name: 'reconcile_workflow_run',
    description: 'Use a frozen workflow step\'s declared read-only adapter to determine whether an interrupted side effect committed. It never repeats the mutation.',
    parameters: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        expectedRevision: { type: 'number' },
        stepId: { type: 'string' },
        capabilityId: { type: 'string', description: 'Optional explicit read-only adapter. Omit when the frozen original capability provides its own attached reconciliation hook.' },
        inputs: { type: 'object', description: 'Ephemeral inputs needed to address the exact original target.' },
      },
      required: ['runId', 'expectedRevision', 'stepId'],
    },
    handler: handleReconcileWorkflowRun,
    permission: 'user',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: 'workflow.execution.reconcile', family: 'workflow', lane: 'agents', operation: 'mutate', risk: 'low',
      sideEffects: [{ type: 'local_state_change', scope: 'workflow reconciliation ledger', reversible: true }],
      verification: {
        strategy: 'terminal_receipt', required: true,
        requiredFields: ['ok', 'status', 'runId', 'revision', 'stepId', 'reconciliationRequired'],
        requiredValues: { ok: true, reconciliationRequired: false },
        successStatuses: ['paused'],
        successSignals: ['a declared read-only adapter verified the exact prepared target and arguments'],
        limitations: ['This control never repeats the original mutation.'],
      },
    }),
    evidence: capabilityEvidence({ id: 'workflow.execution.reconcile', operation: 'mutate', subjectArgument: 'runId' }),
  });
}
