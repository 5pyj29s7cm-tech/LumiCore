import './helpers';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, flushDB, getDatabasePersistenceStatus, initDatabase } from '../db_layer';
import type { ToolExecutionRecord } from '../server/tools/types';
import { ToolRegistry } from '../server/tools/registry';
import { executeToolCall, toolExecutionInputDigests } from '../server/tools/execution_engine';
import { capabilityContract } from '../server/tools/capability_contracts';
import {
  WorkflowRevisionConflictError,
  WorkflowStateError,
  authorizeWorkflowAdapterStart,
  blockWorkflowRun,
  checkpointWorkflowRun,
  claimWorkflowRun,
  completeWorkflowRun,
  createWorkflowDefinitionDraft,
  createWorkflowRun,
  decideWorkflowConfirmation,
  editWorkflowRunPlan,
  getWorkflowDefinition,
  getWorkflowRun,
  listWorkflowDefinitions,
  publishWorkflowDefinition,
  prepareWorkflowStepExecution,
  recordWorkflowReconciliation,
  reconcileExpiredWorkflowRuns,
  requestWorkflowPause,
  resetWorkflowRuntimeForTest,
  resumeWorkflowRun,
  waitForWorkflowConfirmation,
  workflowReconciliationExecutionKey,
  workflowStepExecutionKey,
} from '../server/workflows/runtime';

const baseStep = {
  stepId: 'observe',
  capabilityId: 'desktop.active_window.observe',
  argumentsTemplate: { apiKey: 'sk-secret-value-123456', target: 'active window' },
  verification: { required: true, strategy: 'terminal_receipt' },
};

async function canonicalRecord(
  run: {
    runId: string;
    planRevision: number;
    stepExecutions?: Record<string, { semanticHash: string; idempotencyKey: string }>;
  },
  stepId: string,
  capabilityId: string,
  receipt: Record<string, unknown> = { ok: true },
  executionArguments: Record<string, unknown> = {},
  executionId = workflowStepExecutionKey(run, stepId),
  reconcilesCapabilityIds: string[] = [],
): Promise<ToolExecutionRecord> {
  const idempotencyKey = executionId;
  const registry = new ToolRegistry();
  registry.register({
    name: capabilityId,
    description: 'workflow runtime canonical receipt test',
    parameters: {},
    permission: 'public',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: capabilityId,
      family: 'workflow',
      lane: 'agents',
      operation: 'observe',
      risk: 'low',
      sideEffects: [],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['status', 'verified'],
        requiredValues: { status: 'completed', verified: true },
        successStatuses: ['completed'],
        successSignals: ['the observation returned a verified terminal receipt'],
        limitations: [],
      },
      ...(reconcilesCapabilityIds.length > 0 ? {
        reconciliation: {
          reconcilesCapabilityIds,
          outcomeField: 'reconciliationStatus' as const,
          committedValues: ['committed'],
          notCommittedValues: ['not_committed'],
        },
      } : {}),
    }),
    handler: async () => JSON.stringify({
      ok: true,
      status: 'completed',
      verified: true,
      verificationStatus: 'verified',
      ...receipt,
    }),
  });
  return executeToolCall({
    registry,
    id: executionId,
    name: capabilityId,
    arguments: executionArguments,
    context: { taskId: run.runId, idempotencyKey },
  });
}

async function failedSideEffectRecord(
  run: {
    runId: string;
    planRevision: number;
    stepExecutions?: Record<string, { semanticHash: string; idempotencyKey: string }>;
  },
  stepId: string,
  capabilityId: string,
  executionArguments: Record<string, unknown>,
): Promise<ToolExecutionRecord> {
  const executionId = workflowStepExecutionKey(run, stepId);
  const registry = new ToolRegistry();
  registry.register({
    name: capabilityId,
    description: 'side-effecting workflow failure test',
    parameters: {},
    permission: 'public',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: capabilityId,
      family: 'workflow',
      lane: 'agents',
      operation: 'mutate',
      risk: 'medium',
      sideEffects: [{ type: 'local_state_change', scope: 'test target', reversible: true }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['status'],
        successStatuses: ['completed'],
        successSignals: ['verified state change'],
        limitations: [],
      },
    }),
    handler: async () => { throw new Error('adapter failed after it started'); },
  });
  return executeToolCall({
    registry,
    id: executionId,
    name: capabilityId,
    arguments: executionArguments,
    context: { taskId: run.runId, idempotencyKey: executionId },
  });
}

describe('versioned intervention workflow runtime', () => {
  beforeEach(async () => {
    await initDatabase();
    resetWorkflowRuntimeForTest();
    await flushDB();
  });

  afterEach(async () => {
    resetWorkflowRuntimeForTest();
    await flushDB();
  });

  it('uses installation-keyed digests instead of enumerable hashes for low-entropy secrets', () => {
    const args = { pin: '1234', target: '13800138000' };
    const publicArgumentsHash = createHash('sha256').update(JSON.stringify(args)).digest('hex');
    const publicTargetHash = createHash('sha256').update(args.target).digest('hex');
    const digests = toolExecutionInputDigests(args);
    expect(digests.argumentsDigest).not.toBe(publicArgumentsHash);
    expect(digests.targetDigest).not.toBe(publicTargetHash);
  });

  it('keeps captured behavior as a redacted non-executable draft until reviewed and published', () => {
    const draft = createWorkflowDefinitionDraft({
      userId: 'workflow-owner',
      title: 'Captured desktop check',
      steps: [baseStep],
      provenance: {
        source: 'captured_draft',
        sourceRefs: ['tool-trace-1'],
        reviewedByUser: false,
      },
    });

    expect(draft.status).toBe('draft');
    expect(JSON.stringify(draft)).not.toContain('sk-secret-value-123456');
    expect(draft.steps[0].argumentsTemplate?.apiKey).toEqual({
      $secretRef: 'definition.steps.observe.arguments.apiKey',
    });
    expect(() => createWorkflowRun({
      workflowId: draft.workflowId,
      version: draft.version,
      userId: draft.userId,
    })).toThrow(WorkflowStateError);

    const published = publishWorkflowDefinition({
      workflowId: draft.workflowId,
      version: draft.version,
      expectedHash: draft.hash,
      userId: draft.userId,
    });
    expect(published).toMatchObject({ status: 'published', provenance: { reviewedByUser: true } });
    expect(published.hash).toBe(draft.hash);
    expect(createWorkflowRun({
      workflowId: published.workflowId,
      version: published.version,
      userId: published.userId,
      variables: { password: 'never-persist-this', subject: 'demo' },
    }).variables).toEqual({
      password: { $secretRef: 'run.variables.password' },
      subject: 'demo',
    });
  });

  it('freezes published versions and starts later edits as a new version', () => {
    const first = createWorkflowDefinitionDraft({
      workflowId: 'stable-workflow',
      userId: 'workflow-owner',
      title: 'Version one',
      steps: [baseStep],
      provenance: { source: 'user_authored', reviewedByUser: true },
    });
    const published = publishWorkflowDefinition({
      workflowId: first.workflowId,
      version: first.version,
      expectedHash: first.hash,
      userId: first.userId,
    });
    const second = createWorkflowDefinitionDraft({
      workflowId: first.workflowId,
      userId: first.userId,
      title: 'Version two',
      steps: [{ ...baseStep, stepId: 'observe_v2' }],
      provenance: { source: 'user_authored', reviewedByUser: true },
    });

    expect(second.version).toBe(2);
    expect(second.hash).not.toBe(published.hash);
    expect(getWorkflowDefinition(first.workflowId, 1, first.userId)?.steps[0].stepId).toBe('observe');
    expect(listWorkflowDefinitions(first.userId, first.workflowId)).toHaveLength(2);
    expect(() => createWorkflowDefinitionDraft({
      userId: 'workflow-owner',
      title: 'Cyclic draft',
      steps: [
        { stepId: 'a', capabilityId: 'observe.a', dependsOn: ['b'] },
        { stepId: 'b', capabilityId: 'observe.b', dependsOn: ['a'] },
      ],
      provenance: { source: 'user_authored', reviewedByUser: true },
    })).toThrow(/cycle/i);
  });

  it('uses optimistic revisions for pause, live plan edits, confirmation, and verified completion', async () => {
    const draft = createWorkflowDefinitionDraft({
      userId: 'workflow-owner',
      title: 'Intervenable workflow',
      steps: [baseStep],
      provenance: { source: 'user_authored', reviewedByUser: true },
    });
    const definition = publishWorkflowDefinition({
      workflowId: draft.workflowId,
      version: draft.version,
      expectedHash: draft.hash,
      userId: draft.userId,
    });
    let run = createWorkflowRun({ workflowId: definition.workflowId, version: 1, userId: definition.userId });
    run = claimWorkflowRun({ runId: run.runId, expectedRevision: run.revision, userId: run.userId, owner: 'worker-a' });
    const staleRevision = run.revision;
    run = await prepareWorkflowStepExecution({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      leaseId: run.lease!.leaseId,
      actor: 'worker-a',
      stepId: 'observe',
      capabilityId: baseStep.capabilityId,
      arguments: {},
    });
    await authorizeWorkflowAdapterStart({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      leaseId: run.lease!.leaseId,
      executionId: workflowStepExecutionKey(run, 'observe'),
      actor: 'worker-a',
    });
    run = getWorkflowRun(run.runId, run.userId)!;
    run = requestWorkflowPause({ runId: run.runId, expectedRevision: run.revision, userId: run.userId, actor: 'user' });
    expect(run).toMatchObject({ status: 'running', pauseRequestedAt: expect.any(String) });
    expect(() => requestWorkflowPause({
      runId: run.runId,
      expectedRevision: staleRevision,
      userId: run.userId,
      actor: 'stale-client',
    })).toThrow(WorkflowRevisionConflictError);

    run = checkpointWorkflowRun({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      leaseId: run.lease!.leaseId,
      actor: 'worker-a',
      stepId: 'observe',
      nextStepId: 'observe',
      toolRecord: await canonicalRecord(run, 'observe', baseStep.capabilityId, {
        accessToken: 'must-not-persist',
        visible: true,
      }),
    });
    expect(run.status).toBe('paused');
    expect(run.lease).toBeUndefined();
    expect(JSON.stringify(run.receipts)).not.toContain('must-not-persist');
    const completedPrefixExecutionKey = workflowStepExecutionKey(run, 'observe');

    run = editWorkflowRunPlan({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      actor: 'user',
      reason: 'Insert a user-reviewed verification step',
      steps: [
        baseStep,
        {
          stepId: 'verify',
          capabilityId: 'desktop.ui_snapshot.observe',
          dependsOn: ['observe'],
          verification: { required: true, strategy: 'terminal_receipt' },
        },
      ],
    });
    expect(run.planRevision).toBe(2);
    expect(workflowStepExecutionKey(run, 'observe')).toBe(completedPrefixExecutionKey);
    expect(() => editWorkflowRunPlan({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      actor: 'user',
      reason: 'Attempt to rewrite an executed side effect',
      steps: [
        { ...baseStep, capabilityId: 'desktop.changed.observe' },
        {
          stepId: 'verify',
          capabilityId: 'desktop.ui_snapshot.observe',
          dependsOn: ['observe'],
        },
      ],
    })).toThrow(/immutable/i);
    run = resumeWorkflowRun({ runId: run.runId, expectedRevision: run.revision, userId: run.userId, actor: 'user' });
    run = claimWorkflowRun({ runId: run.runId, expectedRevision: run.revision, userId: run.userId, owner: 'worker-b' });
    run = waitForWorkflowConfirmation({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      leaseId: run.lease!.leaseId,
      actor: 'worker-b',
      stepId: 'verify',
      capabilityId: 'desktop.ui_snapshot.observe',
      reason: 'Review the changed plan before continuing.',
      arguments: {
        contact: 'Alice',
        message: 'Send the reviewed update',
        apiKey: 'sk-must-never-be-shown-to-user',
      },
    });
    expect(JSON.stringify(run.confirmation?.argumentPreview)).toContain('Alice');
    expect(JSON.stringify(run.confirmation?.argumentPreview)).toContain('Send the reviewed update');
    expect(JSON.stringify(run.confirmation?.argumentPreview)).not.toContain('sk-must-never-be-shown-to-user');
    const confirmationId = run.confirmation!.confirmationId;
    run = decideWorkflowConfirmation({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      confirmationId,
      actor: 'user',
      approved: true,
    });
    run = claimWorkflowRun({ runId: run.runId, expectedRevision: run.revision, userId: run.userId, owner: 'worker-b' });
    expect(() => completeWorkflowRun({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      leaseId: run.lease!.leaseId,
      actor: 'worker-b',
    })).toThrow(WorkflowStateError);
    expect(run.receipts.some(receipt => receipt.stepId === 'observe' && receipt.status === 'verified')).toBe(true);
    run = await prepareWorkflowStepExecution({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      leaseId: run.lease!.leaseId,
      actor: 'worker-b',
      stepId: 'verify',
      capabilityId: 'desktop.ui_snapshot.observe',
      arguments: {},
    });
    const forgedVerifyRecord = {
      ...await canonicalRecord(run, 'verify', 'desktop.ui_snapshot.observe'),
      terminalVerification: {
        status: 'unverified' as const,
        strategy: 'terminal_receipt' as const,
        reason: 'forged completion is rejected',
      },
    };
    expect(() => checkpointWorkflowRun({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      leaseId: run.lease!.leaseId,
      actor: 'worker-b',
      stepId: 'verify',
      toolRecord: forgedVerifyRecord,
    })).toThrow(WorkflowStateError);
    run = checkpointWorkflowRun({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      leaseId: run.lease!.leaseId,
      actor: 'worker-b',
      stepId: 'verify',
      toolRecord: await canonicalRecord(run, 'verify', 'desktop.ui_snapshot.observe', { visible: true }),
    });
    run = completeWorkflowRun({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      leaseId: run.lease!.leaseId,
      actor: 'worker-b',
    });
    expect(run.status).toBe('completed');
    expect(run.events.map(event => event.sequence)).toEqual(run.events.map((_event, index) => index + 1));
  });

  it('persists the frozen run and blocks an expired worker instead of replaying it', async () => {
    const draft = createWorkflowDefinitionDraft({
      userId: 'workflow-owner',
      title: 'Restart-safe workflow',
      steps: [baseStep],
      provenance: { source: 'user_authored', reviewedByUser: true },
    });
    const published = publishWorkflowDefinition({
      workflowId: draft.workflowId,
      version: draft.version,
      expectedHash: draft.hash,
      userId: draft.userId,
    });
    let run = createWorkflowRun({ workflowId: published.workflowId, version: 1, userId: published.userId });
    run = claimWorkflowRun({ runId: run.runId, expectedRevision: run.revision, userId: run.userId, owner: 'stale-worker', leaseMs: 120_000 });
    run = await prepareWorkflowStepExecution({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      leaseId: run.lease!.leaseId,
      actor: 'stale-worker',
      stepId: 'observe',
      capabilityId: baseStep.capabilityId,
      arguments: {},
    });
    await authorizeWorkflowAdapterStart({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      leaseId: run.lease!.leaseId,
      executionId: workflowStepExecutionKey(run, 'observe'),
      actor: 'stale-worker',
    });
    run = getWorkflowRun(run.runId, run.userId)!;
    expect(getDatabasePersistenceStatus().pending).toBe(false);
    await closeDatabase();
    await initDatabase();

    expect(getWorkflowRun(run.runId, run.userId)?.definitionHash).toBe(published.hash);
    // Bootstrap knows every persisted running lease belongs to the previous
    // process, even when the lease has not reached its wall-clock expiry.
    expect(reconcileExpiredWorkflowRuns(new Date(), { recoverAllRunning: true })).toBe(1);
    const recovered = getWorkflowRun(run.runId, run.userId);
    expect(recovered).toMatchObject({
      status: 'blocked',
      blockedKind: 'expired_lease',
      reconciliationRequired: true,
      blockedReason: expect.stringContaining('do not replay'),
    });
    expect(recovered?.lease).toBeUndefined();
    expect(() => resumeWorkflowRun({
      runId: run.runId,
      expectedRevision: recovered!.revision,
      userId: run.userId,
      actor: 'user',
    })).toThrow(/reconciliation/i);
  });

  it('treats a started side-effect failure as unknown and forbids blind resume', async () => {
    const step = {
      stepId: 'mutate',
      capabilityId: 'workflow_mutate_target',
      argumentsTemplate: { target: 'document-a' },
      verification: { required: true, strategy: 'terminal_receipt' },
    };
    const draft = createWorkflowDefinitionDraft({
      userId: 'workflow-owner',
      title: 'Unknown side effect',
      steps: [step],
      provenance: { source: 'user_authored', reviewedByUser: true },
    });
    const published = publishWorkflowDefinition({
      workflowId: draft.workflowId,
      version: draft.version,
      expectedHash: draft.hash,
      userId: draft.userId,
    });
    let run = createWorkflowRun({ workflowId: published.workflowId, version: 1, userId: published.userId });
    run = claimWorkflowRun({ runId: run.runId, expectedRevision: run.revision, userId: run.userId, owner: 'worker' });
    const executionArguments = { target: 'document-a' };
    run = await prepareWorkflowStepExecution({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      leaseId: run.lease!.leaseId,
      actor: 'worker',
      stepId: step.stepId,
      capabilityId: step.capabilityId,
      arguments: executionArguments,
    });
    const record = await failedSideEffectRecord(run, step.stepId, step.capabilityId, executionArguments);
    expect(record.adapterStarted).toBe(true);
    run = blockWorkflowRun({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      actor: 'worker',
      reason: record.error || 'failed',
      stepId: step.stepId,
      capabilityId: step.capabilityId,
      toolRecord: record,
    });
    expect(run).toMatchObject({
      status: 'blocked',
      blockedKind: 'unknown_outcome',
      reconciliationRequired: true,
      pendingExecution: { stepId: step.stepId },
    });
    expect(() => resumeWorkflowRun({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      actor: 'user',
    })).toThrow(/reconciliation/i);
  });

  it('fences and safely recomputes a reviewed read-only step after lease expiry', async () => {
    const readOnlyStep = {
      ...baseStep,
      capabilitySnapshot: {
        capabilityId: baseStep.capabilityId,
        operation: 'observe',
        risk: 'low',
        sideEffects: [],
        configuredSecurityLevel: 'safe',
        parameterNames: [],
        prerequisites: [],
        parameterSchemaHash: 'schema-hash',
        verificationHash: 'verification-hash',
        trust: 'builtin',
        deprecated: false,
        contractHash: 'read-only-contract',
      },
    };
    const draft = createWorkflowDefinitionDraft({
      userId: 'workflow-read-only-owner',
      title: 'Restartable read-only workflow',
      steps: [readOnlyStep],
      provenance: { source: 'user_authored', reviewedByUser: true },
    });
    const published = publishWorkflowDefinition({
      workflowId: draft.workflowId,
      version: draft.version,
      expectedHash: draft.hash,
      userId: draft.userId,
    });
    let run = createWorkflowRun({ workflowId: published.workflowId, version: 1, userId: published.userId });
    run = claimWorkflowRun({ runId: run.runId, expectedRevision: run.revision, userId: run.userId, owner: 'read-worker', leaseMs: 5_000 });
    run = await prepareWorkflowStepExecution({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      leaseId: run.lease!.leaseId,
      actor: 'read-worker',
      stepId: readOnlyStep.stepId,
      capabilityId: readOnlyStep.capabilityId,
      arguments: {},
    });
    await authorizeWorkflowAdapterStart({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      leaseId: run.lease!.leaseId,
      executionId: workflowStepExecutionKey(run, readOnlyStep.stepId),
      actor: 'read-worker',
    });
    expect(reconcileExpiredWorkflowRuns(new Date(Date.now() + 10_000))).toBe(1);
    run = getWorkflowRun(run.runId, run.userId)!;
    expect(run).toMatchObject({ status: 'paused', reconciliationRequired: false });
    expect(run.pendingExecution).toBeUndefined();
    expect(resumeWorkflowRun({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      actor: 'user',
    }).status).toBe('queued');
  });

  it('honors pause that wins during the durable pre-adapter barrier', async () => {
    const draft = createWorkflowDefinitionDraft({
      userId: 'workflow-owner',
      title: 'Pause before adapter start',
      steps: [baseStep],
      provenance: { source: 'user_authored', reviewedByUser: true },
    });
    const published = publishWorkflowDefinition({
      workflowId: draft.workflowId,
      version: draft.version,
      expectedHash: draft.hash,
      userId: draft.userId,
    });
    let run = createWorkflowRun({ workflowId: published.workflowId, version: 1, userId: published.userId });
    run = claimWorkflowRun({ runId: run.runId, expectedRevision: run.revision, userId: run.userId, owner: 'worker' });
    const preparation = prepareWorkflowStepExecution({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      leaseId: run.lease!.leaseId,
      actor: 'worker',
      stepId: baseStep.stepId,
      capabilityId: baseStep.capabilityId,
      arguments: {},
    });
    const prepared = getWorkflowRun(run.runId, run.userId)!;
    expect(prepared.pendingExecution?.stepId).toBe(baseStep.stepId);
    requestWorkflowPause({
      runId: prepared.runId,
      expectedRevision: prepared.revision,
      userId: prepared.userId,
      actor: 'user',
    });
    await expect(preparation).rejects.toThrow(/adapter was not started/i);
    const stopped = getWorkflowRun(run.runId, run.userId)!;
    expect(stopped.status).toBe('paused');
    expect(stopped.pauseRequestedAt).toBeUndefined();
    expect(stopped.pendingExecution).toBeUndefined();
    expect(stopped.lease).toBeUndefined();
  });

  it('reconciles an expired prepared execution against the exact target without requiring a fabricated failure receipt', async () => {
    const step = {
      stepId: 'commit',
      capabilityId: 'workflow_commit_target',
      argumentsTemplate: { target: 'document-a' },
      verification: { required: true, strategy: 'terminal_receipt' },
      onFailure: {
        action: 'block' as const,
        fallbackCapabilityIds: ['workflow_observe_commit'],
      },
    };
    const draft = createWorkflowDefinitionDraft({
      userId: 'workflow-owner',
      title: 'Reconcile committed target',
      steps: [step],
      provenance: { source: 'user_authored', reviewedByUser: true },
    });
    const published = publishWorkflowDefinition({
      workflowId: draft.workflowId,
      version: draft.version,
      expectedHash: draft.hash,
      userId: draft.userId,
    });
    let run = createWorkflowRun({ workflowId: published.workflowId, version: 1, userId: published.userId });
    run = claimWorkflowRun({ runId: run.runId, expectedRevision: run.revision, userId: run.userId, owner: 'stale-worker', leaseMs: 5_000 });
    run = await prepareWorkflowStepExecution({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      leaseId: run.lease!.leaseId,
      actor: 'stale-worker',
      stepId: step.stepId,
      capabilityId: step.capabilityId,
      arguments: { target: 'document-a' },
    });
    await authorizeWorkflowAdapterStart({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      leaseId: run.lease!.leaseId,
      executionId: workflowStepExecutionKey(run, step.stepId),
      actor: 'stale-worker',
    });
    run = getWorkflowRun(run.runId, run.userId)!;
    expect(reconcileExpiredWorkflowRuns(new Date(Date.now() + 10_000))).toBe(1);
    run = getWorkflowRun(run.runId, run.userId)!;
    expect(run.receipts).toHaveLength(0);
    const reconciliationId = workflowReconciliationExecutionKey(run, step.stepId);
    const unrelatedReadTool = await canonicalRecord(
      run,
      step.stepId,
      'workflow_observe_commit',
      { reconciliationStatus: 'not_committed' },
      { target: 'document-a' },
      reconciliationId,
    );
    expect(() => recordWorkflowReconciliation({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      actor: 'reconciler',
      stepId: step.stepId,
      toolRecord: unrelatedReadTool,
    })).toThrow(/not semantically authorized/i);
    const mismatchedTarget = await canonicalRecord(
      run,
      step.stepId,
      'workflow_observe_commit',
      { reconciliationStatus: 'committed' },
      { target: 'document-b' },
      reconciliationId,
      [step.capabilityId],
    );
    expect(() => recordWorkflowReconciliation({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      actor: 'reconciler',
      stepId: step.stepId,
      toolRecord: mismatchedTarget,
    })).toThrow(/exact original arguments and target/i);
    const proof = await canonicalRecord(
      run,
      step.stepId,
      'workflow_observe_commit',
      { reconciliationStatus: 'committed' },
      { target: 'document-a' },
      reconciliationId,
      [step.capabilityId],
    );
    run = recordWorkflowReconciliation({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      actor: 'reconciler',
      stepId: step.stepId,
      toolRecord: proof,
    });
    expect(run).toMatchObject({ status: 'paused', reconciliationRequired: false });
    expect(run.pendingExecution).toBeUndefined();
    expect(run.receipts.some(receipt => (
      receipt.stepId === step.stepId
      && receipt.idempotencyKey === workflowStepExecutionKey(run, step.stepId)
      && receipt.status === 'verified'
    ))).toBe(true);
    run = resumeWorkflowRun({ runId: run.runId, expectedRevision: run.revision, userId: run.userId, actor: 'user' });
    run = claimWorkflowRun({ runId: run.runId, expectedRevision: run.revision, userId: run.userId, owner: 'worker' });
    run = completeWorkflowRun({
      runId: run.runId,
      expectedRevision: run.revision,
      userId: run.userId,
      leaseId: run.lease!.leaseId,
      actor: 'worker',
    });
    expect(run.status).toBe('completed');
  });
});
