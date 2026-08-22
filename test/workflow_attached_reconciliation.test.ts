import './helpers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushDB, initDatabase } from '../db_layer';
import { capabilityContract } from '../server/tools/capability_contracts';
import { registerWorkflowTools } from '../server/tools/definitions/workflow_tools';
import {
  configureExternalCommitJournal,
  resetVolatileExternalCommitJournalForTests,
  type ExternalCommitJournalAdapter,
  type ExternalCommitJournalEntry,
} from '../server/tools/external_commit_journal';
import {
  externalCommitInputDigest,
  resetExternalCommitRuntimeCacheForTests,
  ToolRegistry,
} from '../server/tools/registry';
import type { ToolDefinition } from '../server/tools/types';
import {
  getWorkflowRun,
  resetWorkflowRuntimeForTest,
} from '../server/workflows/runtime';

interface DurableJournalFixture {
  adapter: ExternalCommitJournalAdapter;
  rows: Map<string, ExternalCommitJournalEntry>;
}

function durableJournal(options: { failFirstRunningArm?: boolean } = {}): DurableJournalFixture {
  const rows = new Map<string, ExternalCommitJournalEntry>();
  let failRunningArm = options.failFirstRunningArm === true;
  return {
    rows,
    adapter: {
      async lookup(idempotencyKey) {
        const existing = rows.get(idempotencyKey);
        return existing ? { ...existing } : null;
      },
      async claim(entry) {
        const existing = rows.get(entry.idempotencyKey);
        if (existing) return { claimed: false, entry: { ...existing } };
        rows.set(entry.idempotencyKey, { ...entry });
        return { claimed: true, entry: { ...entry } };
      },
      async settle(input) {
        const existing = rows.get(input.idempotencyKey);
        if (!existing) return false;
        if (!input.recoverExisting && existing.claimToken !== input.claimToken) return false;
        if (input.state === 'running' && failRunningArm) {
          failRunningArm = false;
          return false;
        }
        rows.set(input.idempotencyKey, {
          ...existing,
          state: input.state,
          replayResult: input.replayResult,
          updatedAt: input.updatedAt,
        });
        return true;
      },
    },
  };
}

function registerExternalMutation(
  registry: ToolRegistry,
  name: string,
  handler: ToolDefinition['handler'],
  reconcileExternalCommit: NonNullable<ToolDefinition['reconcileExternalCommit']>,
): void {
  const registered = registry.register({
    name,
    description: 'Instrumented external commit used by the attached workflow reconciliation end-to-end test.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        payload: { type: 'string' },
      },
      required: ['target', 'payload'],
    },
    permission: 'public',
    securityLevel: 'safe',
    capability: capabilityContract({
      id: `${name}.execute`,
      family: 'messaging',
      lane: 'messaging',
      operation: 'communicate',
      risk: 'high',
      sideEffects: [{
        type: 'external_communication',
        scope: 'one exact test target and payload',
        reversible: false,
      }],
      verification: {
        strategy: 'provider_ack',
        required: true,
        requiredFields: ['sent', 'verificationStatus'],
        requiredValues: { sent: true, verificationStatus: 'verified' },
        successStatuses: ['sent'],
        successSignals: ['the external target returned a commit acknowledgement'],
        limitations: ['A handler return without an acknowledgement remains an unknown outcome.'],
      },
    }),
    handler,
    reconcileExternalCommit,
  });
  expect(registered).toBe(true);
}

async function saveAndPublish(
  registry: ToolRegistry,
  context: Record<string, any>,
  name: string,
  toolName: string,
  args: Record<string, any>,
): Promise<void> {
  const saved = JSON.parse(await registry.execute('save_workflow', {
    name,
    steps: [{ description: 'commit exactly once', tool: toolName, args }],
  }, context));
  expect(saved).toMatchObject({ ok: true, status: 'draft', hash: expect.any(String) });
  const published = JSON.parse(await registry.execute('publish_workflow', {
    name,
    expectedHash: saved.hash,
  }, context));
  expect(published).toMatchObject({ ok: true, status: 'published' });
}

async function waitForRun(
  registry: ToolRegistry,
  context: Record<string, any>,
  runId: string,
  expectedStatuses: string[],
): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const state = JSON.parse(await registry.execute('get_workflow_run', { runId }, context));
    if (expectedStatuses.includes(state.status)) return state;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Workflow run '${runId}' never reached ${expectedStatuses.join('/')}.`);
}

async function runUntilBlocked(
  registry: ToolRegistry,
  context: Record<string, any>,
  name: string,
): Promise<Record<string, any>> {
  const started = JSON.parse(await registry.execute('run_workflow', { name }, context));
  expect(started).toMatchObject({ ok: true, status: 'started', runId: expect.any(String) });
  const firstState = await waitForRun(
    registry,
    context,
    started.runId,
    ['waiting_confirmation', 'blocked'],
  );
  if (firstState.status === 'blocked') return firstState;
  await registry.execute('decide_workflow_confirmation', {
    runId: started.runId,
    expectedRevision: firstState.revision,
    confirmationId: firstState.confirmation.confirmationId,
    approved: true,
  }, context);
  return waitForRun(registry, context, started.runId, ['blocked']);
}

async function reconcileBlockedRun(
  registry: ToolRegistry,
  context: Record<string, any>,
  blocked: Record<string, any>,
): Promise<Record<string, any>> {
  const run = getWorkflowRun(blocked.runId, context.userId);
  expect(run?.pendingExecution).toBeDefined();
  return JSON.parse(await registry.execute('reconcile_workflow_run', {
    runId: blocked.runId,
    expectedRevision: blocked.revision,
    stepId: run!.pendingExecution!.stepId,
  }, context));
}

describe('attached external-commit workflow reconciliation', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  beforeEach(async () => {
    configureExternalCommitJournal(null);
    resetVolatileExternalCommitJournalForTests();
    resetExternalCommitRuntimeCacheForTests();
    resetWorkflowRuntimeForTest();
    await flushDB();
  });

  afterEach(async () => {
    configureExternalCommitJournal(null);
    resetVolatileExternalCommitJournalForTests();
    resetExternalCommitRuntimeCacheForTests();
    resetWorkflowRuntimeForTest();
    await flushDB();
  });

  it('uses the original key to verify an unknown entered handler, never replays it, and completes after resume', async () => {
    const journal = durableJournal();
    configureExternalCommitJournal(journal.adapter);
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const toolName = `workflow_attached_unknown_${suffix}`;
    const workflowName = `attached-unknown-${suffix}`;
    const userId = `attached-user-${suffix}`;
    const args = { target: 'provider-recipient', payload: 'commit exactly once' };
    const committedKeys = new Set<string>();
    let providerEvidenceVisible = false;
    const handler = vi.fn<ToolDefinition['handler']>(async (_args, context) => {
      committedKeys.add(String(context?.idempotencyKey || ''));
      throw new Error('provider acknowledgement was lost after commit');
    });
    const hookKeys: string[] = [];
    const hookContextKeys: string[] = [];
    const hookConversationIds: string[] = [];
    const reconcile = vi.fn<NonNullable<ToolDefinition['reconcileExternalCommit']>>(
      async (_args, context, idempotencyKey) => {
        hookKeys.push(idempotencyKey);
        hookContextKeys.push(String(context?.idempotencyKey || ''));
        hookConversationIds.push(String(context?.conversationId || ''));
        if (!providerEvidenceVisible || !committedKeys.has(idempotencyKey)) return null;
        return JSON.stringify({
          sent: true,
          verified: true,
          verificationStatus: 'verified',
          status: 'sent',
          providerReceipt: 'provider-commit-1',
          reconciled: true,
        });
      },
    );
    registerExternalMutation(registry, toolName, handler, reconcile);
    const context = {
      userId,
      requestId: `request-${suffix}`,
      conversationId: `origin-conversation-${suffix}`,
      requestConfirmation: async () => true,
    };
    await saveAndPublish(registry, context, workflowName, toolName, args);

    const blocked = await runUntilBlocked(registry, context, workflowName);
    const blockedRun = getWorkflowRun(blocked.runId, userId)!;
    const originalKey = blockedRun.pendingExecution!.idempotencyKey;
    expect(blocked).toMatchObject({ status: 'blocked', reconciliationRequired: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(committedKeys).toEqual(new Set([originalKey]));
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(hookKeys).toEqual([originalKey]);
    expect(journal.rows.get(originalKey)).toMatchObject({
      idempotencyKey: originalKey,
      taskId: blocked.runId,
      userId,
      toolName,
      inputDigest: externalCommitInputDigest(toolName, args),
      state: 'unknown',
    });

    providerEvidenceVisible = true;
    const reconciled = await reconcileBlockedRun(registry, {
      ...context,
      conversationId: `different-conversation-${suffix}`,
    }, blocked);
    expect(reconciled).toMatchObject({
      ok: true,
      status: 'paused',
      runId: blocked.runId,
      reconciliationRequired: false,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(hookKeys).toEqual([originalKey, originalKey]);
    expect(hookContextKeys).toEqual([originalKey, originalKey]);
    expect(hookConversationIds).toEqual([
      `origin-conversation-${suffix}`,
      `origin-conversation-${suffix}`,
    ]);
    expect(journal.rows.get(originalKey)?.state).toBe('verified');

    const resumed = JSON.parse(await registry.execute('resume_workflow_run', {
      runId: blocked.runId,
      expectedRevision: reconciled.revision,
    }, context));
    expect(resumed).toMatchObject({ ok: true, status: 'started' });
    const completed = await waitForRun(registry, context, blocked.runId, ['completed']);
    expect(completed).toMatchObject({ status: 'completed', completedSteps: 1, totalSteps: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('fails closed when the durable row has the same key and identity but a different input digest', async () => {
    const journal = durableJournal();
    configureExternalCommitJournal(journal.adapter);
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const toolName = `workflow_attached_digest_${suffix}`;
    const workflowName = `attached-digest-${suffix}`;
    const userId = `attached-user-${suffix}`;
    const args = { target: 'digest-target', payload: 'original payload' };
    const handler = vi.fn<ToolDefinition['handler']>(async () => {
      throw new Error('provider acknowledgement was lost after commit');
    });
    const reconcile = vi.fn<NonNullable<ToolDefinition['reconcileExternalCommit']>>(
      async () => JSON.stringify({
        sent: true,
        verified: true,
        verificationStatus: 'verified',
        status: 'sent',
        reconciled: true,
      }),
    );
    // The registry's immediate recovery must leave the first outcome unknown;
    // the bridge call below is the first time positive observer evidence appears.
    reconcile.mockResolvedValueOnce(null);
    const context = {
      userId,
      requestId: `request-${suffix}`,
      requestConfirmation: async () => true,
    };
    registerExternalMutation(registry, toolName, handler, reconcile);
    await saveAndPublish(registry, context, workflowName, toolName, args);

    const blocked = await runUntilBlocked(registry, context, workflowName);
    const blockedRun = getWorkflowRun(blocked.runId, userId)!;
    const originalKey = blockedRun.pendingExecution!.idempotencyKey;
    const row = journal.rows.get(originalKey)!;
    expect(row).toMatchObject({
      idempotencyKey: originalKey,
      taskId: blocked.runId,
      userId,
      toolName,
      state: 'unknown',
    });
    journal.rows.set(originalKey, {
      ...row,
      inputDigest: externalCommitInputDigest(toolName, {
        target: 'different-target',
        payload: args.payload,
      }),
    });
    expect(journal.rows.get(originalKey)?.inputDigest).not.toBe(externalCommitInputDigest(toolName, args));

    const result = await reconcileBlockedRun(registry, context, blocked);
    expect(result).toMatchObject({
      ok: false,
      status: 'blocked',
      runId: blocked.runId,
      reconciliationRequired: true,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    const stillBlocked = getWorkflowRun(blocked.runId, userId)!;
    expect(stillBlocked).toMatchObject({
      status: 'blocked',
      revision: blocked.revision,
      reconciliationRequired: true,
      pendingExecution: { idempotencyKey: originalKey },
    });
    await expect(registry.execute('resume_workflow_run', {
      runId: blocked.runId,
      expectedRevision: stillBlocked.revision,
    }, context)).rejects.toThrow(/reconciliation/i);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('treats a durable not_started barrier as replay-safe and executes the mutation handler exactly once after resume', async () => {
    const journal = durableJournal({ failFirstRunningArm: true });
    configureExternalCommitJournal(journal.adapter);
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const toolName = `workflow_attached_not_started_${suffix}`;
    const workflowName = `attached-not-started-${suffix}`;
    const userId = `attached-user-${suffix}`;
    const args = { target: 'safe-resume-target', payload: 'run once after durable barrier' };
    const handler = vi.fn<ToolDefinition['handler']>(async () => JSON.stringify({
      sent: true,
      verified: true,
      verificationStatus: 'verified',
      status: 'sent',
      providerReceipt: 'provider-safe-resume-1',
    }));
    const reconcile = vi.fn<NonNullable<ToolDefinition['reconcileExternalCommit']>>(async () => {
      throw new Error('not_started must be decided from the durable journal without invoking the observer');
    });
    const context = {
      userId,
      requestId: `request-${suffix}`,
      requestConfirmation: async () => true,
    };
    registerExternalMutation(registry, toolName, handler, reconcile);
    await saveAndPublish(registry, context, workflowName, toolName, args);

    const blocked = await runUntilBlocked(registry, context, workflowName);
    const blockedRun = getWorkflowRun(blocked.runId, userId)!;
    const originalKey = blockedRun.pendingExecution!.idempotencyKey;
    expect(blocked).toMatchObject({ status: 'blocked', reconciliationRequired: true });
    expect(handler).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(journal.rows.get(originalKey)).toMatchObject({
      idempotencyKey: originalKey,
      taskId: blocked.runId,
      userId,
      toolName,
      inputDigest: externalCommitInputDigest(toolName, args),
      state: 'not_started',
    });

    const reconciled = await reconcileBlockedRun(registry, context, blocked);
    expect(reconciled).toMatchObject({
      ok: true,
      status: 'paused',
      runId: blocked.runId,
      reconciliationRequired: false,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();

    const resumed = JSON.parse(await registry.execute('resume_workflow_run', {
      runId: blocked.runId,
      expectedRevision: reconciled.revision,
    }, context));
    expect(resumed).toMatchObject({ ok: true, status: 'started' });
    const completed = await waitForRun(registry, context, blocked.runId, ['completed']);
    expect(completed).toMatchObject({ status: 'completed', completedSteps: 1, totalSteps: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
    expect(journal.rows.get(originalKey)?.state).toBe('verified');
  });
});
