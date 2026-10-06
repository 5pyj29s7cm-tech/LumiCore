import { boundCapturedWorkflowSteps, workflowCaptureBlocker, workflowTransformationBlocker } from "../../../skills/worklog";
import { classifySkillAuthoringIntent } from "../../../skills/authoring_intent";
import { saveWorkflowDraftCandidate, listWorkflows, getWorkflow, deleteWorkflow, captureRecentAsWorkflow, getSavedWorkflowRuntimeDefinition, publishSavedWorkflow, refreshSavedWorkflowRuntimeDraft } from "../../../agents/workflows";
import { getRecentWorkflows } from "../../../skills/worklog";
import { persistWorkflowRuntimeBarrier } from "../../../workflows/runtime";
import { frozenCapabilitySnapshot, attachedReconciliationContract } from './capability_snapshot';
import { workflowScope } from './authorization';

export async function handleSaveWorkflow(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const name: string = args.name || '';
  const description: string = args.description || '';
  const steps = (args.steps || []).map((step: Record<string, any>) => {
    const primaryToolName = String(step.tool || '').trim();
    const primaryManifest = primaryToolName
      ? context?.toolRegistry?.getCapabilityManifestEntry(primaryToolName, context?.toolPolicy, context)
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
      context,
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

  const saveIntent = String(context?.actionIntent || '');
  const sameConversationTrace = context?.conversationId && classifySkillAuthoringIntent(saveIntent) === 'save'
    ? getRecentWorkflows(userId, workflowScope(context).domain, workflowScope(context).orgId, context.conversationId).at(-1)
    : undefined;
  const transformationIntent = [description, saveIntent, sameConversationTrace?.userIntent || ''].join(' ');
  const transformationBlocker = workflowTransformationBlocker(transformationIntent, steps.map((step: any) => ({
    operation: context?.toolRegistry?.getCapabilityManifestEntry(step.tool, context?.toolPolicy, context)?.operation,
    name: step.tool, args: step.args,
  })), true);
  if (transformationBlocker) throw new Error(transformationBlocker);

  const wf = saveWorkflowDraftCandidate(
    userId,
    name,
    description,
    steps,
    { source: 'user_authored', reviewedByUser: false },
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

export async function handleListWorkflows(_args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const workflows = listWorkflows(userId, undefined, workflowScope(context));
  if (!workflows.length) return 'No saved workflows.';
  return workflows.map(w =>
    `- **${w.name}**: ${w.description || 'No description'} (${w.steps.length} steps, ${w.lifecycleStatus || 'legacy'}, run ${w.runCount} times)`
  ).join('\n');
}

export async function handleGetWorkflow(args: Record<string, any>, context?: any): Promise<string> {
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

export async function handlePublishWorkflow(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const name = String(args.name || '');
  const expectedHash = String(args.expectedHash || '');
  if (!name || !expectedHash) throw new Error('Workflow name and reviewed draft hash are required.');
  const scope = workflowScope(context);
  const currentNamed = getWorkflow(userId, name, scope);
  const currentDefinition = currentNamed ? getSavedWorkflowRuntimeDefinition(currentNamed) : null;
  if (!currentNamed || !currentDefinition) throw new Error(`Workflow draft "${name}" was not found.`);
  const transformationBlocker = workflowTransformationBlocker(currentDefinition.description, currentDefinition.steps.map(step => ({
    operation: step.capabilitySnapshot?.operation, name: step.capabilityId, args: step.argumentsTemplate,
  })), true);
  if (transformationBlocker) throw new Error(transformationBlocker);
  if (currentNamed.runtimeHash !== expectedHash) throw new Error('Workflow changed before publication. Review the latest version.');
  if (!context?.toolRegistry) throw new Error('Capability registry is unavailable; the workflow cannot be reviewed safely.');
  const refreshedSteps = currentDefinition.steps.map(step => {
    const manifest = context.toolRegistry.getCapabilityManifestEntry(step.capabilityId, context.toolPolicy, context);
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

export async function handleDeleteWorkflow(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const name: string = args.name || '';
  const ok = deleteWorkflow(userId, name, workflowScope(context));
  await persistWorkflowRuntimeBarrier();
  return JSON.stringify({ ok, status: ok ? 'deleted' : 'not_found', name }, null, 2);
}

export async function handleCaptureRecentWorkflow(args: Record<string, any>, context?: any): Promise<string> {
  const userId = context?.userId || 'system';
  const name: string = args.name || '';
  if (!name) throw new Error('Workflow name is required. Ask the user what to call this workflow.');

  const scope = workflowScope(context);
  const conversationId = String(context?.conversationId || '').trim();
  if (!conversationId) throw new Error('Capture requires the current conversation identity. Use save_workflow for an explicitly authored definition.');
  const scopedRecent = getRecentWorkflows(userId, scope.domain, scope.orgId, conversationId);
  const requestedTaskId = String(args.sourceTaskId || '').trim();
  const recent = requestedTaskId ? scopedRecent.filter(record => record.taskId === requestedTaskId) : scopedRecent;
  if (recent.length === 0) {
    const availableSources = [...new Map([...scopedRecent].reverse()
      .filter(record => record.taskId)
      .map(record => [record.taskId, record])).values()].slice(0, 5).map(record => ({
      sourceTaskId: record.taskId,
      sourceConversationId: conversationId,
      sourceIntent: record.userIntent,
      observedTools: record.toolSequence.map(step => step.name),
      needsAuthoring: Boolean(workflowCaptureBlocker(record)),
    }));
    return JSON.stringify({
      ok: false, status: 'failed', name,
      code: requestedTaskId ? 'source_task_not_found' : 'no_recent_activity',
      error: requestedTaskId
        ? 'The requested sourceTaskId is not a recorded task in this conversation. A file name, label, or workflow name is not a task ID.'
        : 'No recent activity is recorded in this conversation. No workflow draft was saved.',
      requestedSourceTaskId: requestedTaskId || undefined,
      availableSources,
      nextAction: availableSources.length
        ? 'Use one exact sourceTaskId listed here, or omit sourceTaskId to capture this conversation\'s latest trace. Do not substitute a different task silently. If capture is incomplete, use save_workflow to author the requested input-dependent steps; do not generate or install a skill package unless the user asks for one.'
        : 'Use save_workflow to author the user-requested steps with typed input/output references. Do not claim a past trace was captured or search another conversation. Creating a skill package is a separate user request.',
    }, null, 2);
  }

  const last = recent[recent.length - 1];
  const blocker = workflowCaptureBlocker(last);
  if (blocker) return JSON.stringify({ ok: false, status: 'needs_authoring', name, sourceConversationId: conversationId, sourceTaskId: last.taskId, sourceIntent: last.userIntent, observedTools: last.toolSequence.map(step => step.name), reason: blocker, nextAction: 'Use save_workflow to author the missing executable transformation. For code_execution, args.code is JavaScript (not Python), args.input is a typed reference such as {"$stepOutputRef":"step_1"}, and the writer binds to {"$stepOutputRef":"step_2.output"}. Do not repeat completed actions or create, install, publish, or run a skill package without a separate request. No draft was saved by capture.' });
  const toolTrace = (boundCapturedWorkflowSteps(last) || last.toolSequence).map(s => {
    const manifest = context?.toolRegistry?.getCapabilityManifestEntry(s.name, context?.toolPolicy, context);
    const definition = context?.toolRegistry?.get(s.name);
    const snapshot = manifest ? frozenCapabilitySnapshot(manifest, definition?.parameters || {}) : undefined;
    return {
      name: s.name, args: s.args, resultSummary: s.resultSummary,
      ...(manifest && snapshot ? { capabilityContractId: manifest.capabilityId, capabilitySnapshot: snapshot,
        attachedReconciliation: attachedReconciliationContract(definition, manifest, snapshot) } : {}),
    };
  });

  const wf = captureRecentAsWorkflow(userId, name, toolTrace, scope);
  if (!wf) return JSON.stringify({ ok: false, status: 'failed', name, code: 'empty_trace', error: 'No tool calls found in recent activity. No draft was saved.' });
  await persistWorkflowRuntimeBarrier();

  return JSON.stringify({
    ok: true,
    status: 'draft',
    workflowId: wf.id,
    version: wf.runtimeVersion,
    hash: wf.runtimeHash,
    name,
    stepCount: wf.steps.length,
    sourceConversationId: conversationId,
    sourceTaskId: last.taskId,
    nextAction: 'Review and publish the captured draft before execution.',
  }, null, 2);
}
