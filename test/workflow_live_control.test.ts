import { beforeAll, describe, expect, it, vi } from 'vitest';
import { initDatabase, querySQL } from '../db_layer';
import { saveWorkflowDraftCandidate } from '../server/agents/workflows';
import { registerWorkflowTools } from '../server/tools/definitions/workflow_tools';
import { ToolRegistry } from '../server/tools/registry';

async function waitForRun(
  registry: ToolRegistry,
  userId: string,
  runId: string,
  expected: string[],
  context: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const state = JSON.parse(await registry.execute('get_workflow_run', { runId }, { userId, ...context }));
    if (expected.includes(state.status)) return state;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Workflow run '${runId}' never reached ${expected.join('/')}.`);
}

async function durableWorkflowRun(runId: string): Promise<Record<string, any> | undefined> {
  const rows = await querySQL<{ value: string }>(
    'SELECT value FROM settings WHERE key = ? LIMIT 1',
    ['lumi.workflow_runtime.v1'],
  );
  const store = rows[0]?.value ? JSON.parse(rows[0].value) : { runs: [] };
  return store.runs?.find((run: Record<string, any>) => run.runId === runId);
}

async function saveAndPublish(
  registry: ToolRegistry,
  userId: string,
  name: string,
  tool: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  const saved = JSON.parse(await registry.execute('save_workflow', {
    name,
    steps: [{ description: 'controlled step', tool, args: { target: 'reviewed-target' } }],
  }, { userId, ...context }));
  const published = JSON.parse(await registry.execute('publish_workflow', {
    name,
    expectedHash: saved.hash,
  }, { userId, ...context, requestConfirmation: async () => true }));
  expect(published.status).toBe('published');
}

describe('live versioned workflow control', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('returns a durable run id immediately and deduplicates a second start while confirmation is pending', async () => {
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    const handler = vi.fn(async () => JSON.stringify({ ok: true, status: 'completed' }));
    registry.register({ name: 'workflow_live_dedup', description: 'test', parameters: {}, permission: 'public', securityLevel: 'safe', handler });
    const userId = `workflow-live-dedup-${Date.now()}`;
    const name = `dedup-${Date.now()}`;
    await saveAndPublish(registry, userId, name, 'workflow_live_dedup');

    const started = JSON.parse(await registry.execute('run_workflow', { name }, {
      userId,
      requestConfirmation: async () => true,
    }));
    expect(started).toMatchObject({ ok: true, status: 'started', completed: false, runId: expect.any(String) });
    expect((await durableWorkflowRun(started.runId))?.status).toMatch(/running|waiting_confirmation/);
    const waiting = await waitForRun(registry, userId, started.runId, ['waiting_confirmation']);

    const duplicate = JSON.parse(await registry.execute('run_workflow', { name }, {
      userId,
      requestConfirmation: async () => true,
    }));
    expect(duplicate).toMatchObject({ ok: false, status: 'blocked', runId: started.runId });
    expect(handler).not.toHaveBeenCalled();

    const cancelled = JSON.parse(await registry.execute('cancel_workflow_run', {
      runId: started.runId,
      expectedRevision: waiting.revision,
    }, { userId, requestConfirmation: async () => true }));
    expect(cancelled.status).toBe('cancelled');
    expect((await durableWorkflowRun(started.runId))?.status).toBe('cancelled');
  });

  it('checkpoints a verified long step after several lease heartbeats', async () => {
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    const handler = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 90));
      return JSON.stringify({
        ok: true,
        status: 'completed',
        artifactPath: 'D:\\LumiOutputs\\long-task-result.txt',
        summary: 'The long-running step produced a real observable result.',
      });
    });
    registry.register({ name: 'workflow_live_heartbeat', description: 'test', parameters: {}, permission: 'public', securityLevel: 'safe', handler });
    const userId = `workflow-live-heartbeat-${Date.now()}`;
    const name = `heartbeat-${Date.now()}`;
    await saveAndPublish(registry, userId, name, 'workflow_live_heartbeat');
    const context = { workflowHeartbeatMs: 10, requestConfirmation: async () => true };
    const started = JSON.parse(await registry.execute('run_workflow', { name }, { userId, ...context }));
    const waiting = await waitForRun(registry, userId, started.runId, ['waiting_confirmation']);
    await registry.execute('decide_workflow_confirmation', {
      runId: started.runId,
      expectedRevision: waiting.revision,
      confirmationId: waiting.confirmation.confirmationId,
      approved: true,
    }, { userId, ...context });
    const completed = await waitForRun(registry, userId, started.runId, ['completed']);
    expect(completed.completedSteps).toBe(1);
    expect(await durableWorkflowRun(started.runId)).toMatchObject({
      status: 'completed',
      receipts: [expect.objectContaining({ stepId: 'step_1', status: 'verified' })],
    });
    expect(completed.outputs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stepId: 'step_1',
        status: 'verified',
        result: expect.objectContaining({
          artifactPath: 'D:\\LumiOutputs\\long-task-result.txt',
          summary: 'The long-running step produced a real observable result.',
        }),
      }),
    ]));
    expect(completed.revision).toBeGreaterThan(waiting.revision + 2);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('uses the latest same-lease revision across a multi-step heartbeat and durability barrier', async () => {
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    const firstHandler = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 90));
      return JSON.stringify({ ok: true, status: 'completed' });
    });
    const secondHandler = vi.fn(async () => JSON.stringify({ ok: true, status: 'completed' }));
    registry.register({ name: 'workflow_live_heartbeat_first', description: 'test', parameters: {}, permission: 'public', securityLevel: 'safe', handler: firstHandler });
    registry.register({ name: 'workflow_live_heartbeat_second', description: 'test', parameters: {}, permission: 'public', securityLevel: 'safe', handler: secondHandler });
    const userId = `workflow-live-heartbeat-multi-${Date.now()}`;
    const name = `heartbeat-multi-${Date.now()}`;
    const saved = JSON.parse(await registry.execute('save_workflow', {
      name,
      steps: [
        { description: 'first controlled step', tool: 'workflow_live_heartbeat_first', args: { target: 'reviewed-target' } },
        { description: 'second controlled step', tool: 'workflow_live_heartbeat_second', args: { target: 'reviewed-target' } },
      ],
    }, { userId }));
    const published = JSON.parse(await registry.execute('publish_workflow', {
      name,
      expectedHash: saved.hash,
    }, { userId, requestConfirmation: async () => true }));
    expect(published.status).toBe('published');
    const context = { workflowHeartbeatMs: 10, requestConfirmation: async () => true };
    const started = JSON.parse(await registry.execute('run_workflow', { name }, { userId, ...context }));
    const firstWaiting = await waitForRun(registry, userId, started.runId, ['waiting_confirmation']);
    await registry.execute('decide_workflow_confirmation', {
      runId: started.runId,
      expectedRevision: firstWaiting.revision,
      confirmationId: firstWaiting.confirmation.confirmationId,
      approved: true,
    }, { userId, ...context });
    const secondWaiting = await waitForRun(registry, userId, started.runId, ['waiting_confirmation']);
    expect(secondWaiting.confirmation.stepId).toBe('step_2');
    await registry.execute('decide_workflow_confirmation', {
      runId: started.runId,
      expectedRevision: secondWaiting.revision,
      confirmationId: secondWaiting.confirmation.confirmationId,
      approved: true,
    }, { userId, ...context });
    const completed = await waitForRun(registry, userId, started.runId, ['completed']);
    expect(completed.completedSteps).toBe(2);
    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(secondHandler).toHaveBeenCalledTimes(1);
  });

  it('stops before handler entry when pause wins during nested confirmation', async () => {
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    const handler = vi.fn(async () => JSON.stringify({ ok: true, status: 'completed' }));
    registry.register({ name: 'workflow_live_confirm_race', description: 'test', parameters: {}, permission: 'public', securityLevel: 'confirm', handler });
    const userId = `workflow-live-race-${Date.now()}`;
    const name = `race-${Date.now()}`;
    await saveAndPublish(registry, userId, name, 'workflow_live_confirm_race');
    const started = JSON.parse(await registry.execute('run_workflow', { name }, { userId, requestConfirmation: async () => true }));
    const waiting = await waitForRun(registry, userId, started.runId, ['waiting_confirmation']);

    let releaseNested!: (approved: boolean) => void;
    let signalNested!: () => void;
    const nestedRequested = new Promise<void>(resolve => { signalNested = resolve; });
    const nestedDecision = new Promise<boolean>(resolve => { releaseNested = resolve; });
    await registry.execute('decide_workflow_confirmation', {
      runId: started.runId,
      expectedRevision: waiting.revision,
      confirmationId: waiting.confirmation.confirmationId,
      approved: true,
    }, {
      userId,
      requestConfirmation: async toolName => {
        if (toolName === 'workflow_live_confirm_race') {
          signalNested();
          return nestedDecision;
        }
        return true;
      },
    });
    await nestedRequested;
    const running = await waitForRun(registry, userId, started.runId, ['running']);
    await registry.execute('pause_workflow_run', {
      runId: started.runId,
      expectedRevision: running.revision,
    }, { userId });
    releaseNested(true);
    const paused = await waitForRun(registry, userId, started.runId, ['paused']);
    expect(paused.pendingExecution).toBeUndefined();
    expect(paused.reconciliationRequired).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('starts a new fenced worker generation after pausing an old confirmation that never resolves', async () => {
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    const handler = vi.fn(async () => JSON.stringify({ ok: true, status: 'completed' }));
    registry.register({ name: 'workflow_live_stuck_confirm', description: 'test', parameters: {}, permission: 'public', securityLevel: 'confirm', handler });
    const userId = `workflow-live-stuck-${Date.now()}`;
    const name = `stuck-${Date.now()}`;
    await saveAndPublish(registry, userId, name, 'workflow_live_stuck_confirm');
    const started = JSON.parse(await registry.execute('run_workflow', { name }, { userId, requestConfirmation: async () => true }));
    const waiting = await waitForRun(registry, userId, started.runId, ['waiting_confirmation']);
    let signalNested!: () => void;
    const nestedRequested = new Promise<void>(resolve => { signalNested = resolve; });
    const never = new Promise<boolean>(() => undefined);
    await registry.execute('decide_workflow_confirmation', {
      runId: started.runId,
      expectedRevision: waiting.revision,
      confirmationId: waiting.confirmation.confirmationId,
      approved: true,
    }, {
      userId,
      requestConfirmation: async toolName => {
        if (toolName === 'workflow_live_stuck_confirm') {
          signalNested();
          return never;
        }
        return true;
      },
    });
    await nestedRequested;
    const running = await waitForRun(registry, userId, started.runId, ['running']);
    const paused = JSON.parse(await registry.execute('pause_workflow_run', {
      runId: started.runId,
      expectedRevision: running.revision,
    }, { userId }));
    expect(paused.status).toBe('paused');
    const resumed = JSON.parse(await registry.execute('resume_workflow_run', {
      runId: started.runId,
      expectedRevision: paused.revision,
    }, { userId, requestConfirmation: async () => true }));
    expect(resumed.status).toBe('started');
    const completed = await waitForRun(registry, userId, started.runId, ['completed']);
    expect(completed.completedSteps).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores a late old-generation confirmation failure while the resumed lease is running', async () => {
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    let signalNewHandler!: () => void;
    const newHandlerStarted = new Promise<void>(resolve => { signalNewHandler = resolve; });
    let releaseNewHandler!: () => void;
    const newHandlerGate = new Promise<void>(resolve => { releaseNewHandler = resolve; });
    const handler = vi.fn(async () => {
      signalNewHandler();
      await newHandlerGate;
      return JSON.stringify({ ok: true, status: 'completed' });
    });
    const capabilityId = 'workflow_live_old_generation_failure';
    registry.register({ name: capabilityId, description: 'test', parameters: {}, permission: 'public', securityLevel: 'confirm', handler });
    const userId = `workflow-live-old-generation-${Date.now()}`;
    const name = `old-generation-${Date.now()}`;
    await saveAndPublish(registry, userId, name, capabilityId);
    const started = JSON.parse(await registry.execute('run_workflow', { name }, { userId, requestConfirmation: async () => true }));
    const waiting = await waitForRun(registry, userId, started.runId, ['waiting_confirmation']);

    let signalOldConfirmation!: () => void;
    const oldConfirmationRequested = new Promise<void>(resolve => { signalOldConfirmation = resolve; });
    let rejectOldConfirmation!: (error: Error) => void;
    const oldConfirmation = new Promise<boolean>((_, reject) => { rejectOldConfirmation = reject; });
    await registry.execute('decide_workflow_confirmation', {
      runId: started.runId,
      expectedRevision: waiting.revision,
      confirmationId: waiting.confirmation.confirmationId,
      approved: true,
    }, {
      userId,
      requestConfirmation: async toolName => {
        if (toolName === capabilityId) {
          signalOldConfirmation();
          return oldConfirmation;
        }
        return true;
      },
    });
    await oldConfirmationRequested;
    const oldRunning = await waitForRun(registry, userId, started.runId, ['running']);
    const paused = JSON.parse(await registry.execute('pause_workflow_run', {
      runId: started.runId,
      expectedRevision: oldRunning.revision,
    }, { userId }));
    const resumed = JSON.parse(await registry.execute('resume_workflow_run', {
      runId: started.runId,
      expectedRevision: paused.revision,
    }, { userId, requestConfirmation: async () => true }));
    expect(resumed.status).toBe('started');
    await newHandlerStarted;

    rejectOldConfirmation(new Error('late failure from the retired worker lease'));
    await new Promise(resolve => setTimeout(resolve, 30));
    const whileNewGenerationRuns = JSON.parse(await registry.execute('get_workflow_run', {
      runId: started.runId,
    }, { userId }));
    releaseNewHandler();

    expect(whileNewGenerationRuns.status).toBe('running');
    const completed = await waitForRun(registry, userId, started.runId, ['completed']);
    expect(completed.completedSteps).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('revalidates the frozen capability after the durable prepare barrier before handler entry', async () => {
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    const originalHandler = vi.fn(async () => JSON.stringify({ ok: true, status: 'completed' }));
    const replacementHandler = vi.fn(async () => JSON.stringify({ ok: true, status: 'completed' }));
    const capabilityId = 'workflow_live_prepare_contract_race';
    const originalParameters = {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
    };
    registry.register({
      name: capabilityId,
      description: 'reviewed capability',
      parameters: originalParameters,
      permission: 'public',
      securityLevel: 'safe',
      capability: { prerequisites: ['reviewed-runtime'] },
      handler: originalHandler,
    });
    const userId = `workflow-live-prepare-contract-${Date.now()}`;
    const name = `prepare-contract-${Date.now()}`;
    await saveAndPublish(registry, userId, name, capabilityId);
    const started = JSON.parse(await registry.execute('run_workflow', { name }, { userId, requestConfirmation: async () => true }));
    const waiting = await waitForRun(registry, userId, started.runId, ['waiting_confirmation']);

    const originalGetManifest = registry.getCapabilityManifestEntry.bind(registry);
    let armReplacement = true;
    let replacementScheduled = false;
    const manifestSpy = vi.spyOn(registry, 'getCapabilityManifestEntry').mockImplementation((toolName, policy) => {
      const manifest = originalGetManifest(toolName, policy);
      if (armReplacement && !replacementScheduled && toolName === capabilityId) {
        replacementScheduled = true;
        queueMicrotask(() => {
          registry.unregister(capabilityId);
          registry.register({
            name: capabilityId,
            description: 'replacement capability',
            parameters: {
              type: 'object',
              properties: { target: { type: 'string', enum: ['unreviewed-target'] } },
              required: ['target'],
            },
            permission: 'public',
            securityLevel: 'safe',
            capability: { prerequisites: ['different-runtime'] },
            handler: replacementHandler,
          });
        });
      }
      return manifest;
    });
    await registry.execute('decide_workflow_confirmation', {
      runId: started.runId,
      expectedRevision: waiting.revision,
      confirmationId: waiting.confirmation.confirmationId,
      approved: true,
    }, { userId, requestConfirmation: async () => true });
    const blocked = await waitForRun(registry, userId, started.runId, ['blocked']);
    armReplacement = false;
    manifestSpy.mockRestore();

    expect(replacementScheduled).toBe(true);
    expect(blocked.blockedKind).toBe('capability_contract_changed');
    expect(blocked.pendingExecution).toBeUndefined();
    expect(blocked.reconciliationRequired).toBe(false);
    expect(originalHandler).not.toHaveBeenCalled();
    expect(replacementHandler).not.toHaveBeenCalled();
  });

  it('pins the reviewed handler across the final manifest-check microtask boundary', async () => {
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    const capabilityId = 'workflow_live_handler_pin_race';
    let handlerVisibleAtReviewedEntry: unknown;
    const reviewedHandler = vi.fn(async () => {
      handlerVisibleAtReviewedEntry = registry.get(capabilityId)?.handler;
      return JSON.stringify({ ok: true, status: 'completed' });
    });
    const replacementHandler = vi.fn(async () => JSON.stringify({ ok: true, status: 'completed' }));
    registry.register({
      name: capabilityId,
      description: 'reviewed capability',
      parameters: { type: 'object', properties: { target: { type: 'string' } } },
      permission: 'public',
      securityLevel: 'safe',
      handler: reviewedHandler,
    });
    const userId = `workflow-live-handler-pin-${Date.now()}`;
    const name = `handler-pin-${Date.now()}`;
    await saveAndPublish(registry, userId, name, capabilityId);
    const started = JSON.parse(await registry.execute('run_workflow', { name }, { userId, requestConfirmation: async () => true }));
    const waiting = await waitForRun(registry, userId, started.runId, ['waiting_confirmation']);

    const reviewedDefinition = registry.get(capabilityId)!;
    const originalGetManifest = registry.getCapabilityManifestEntry.bind(registry);
    let mutateOnFinalManifestRead = false;
    let mutationScheduled = false;
    const manifestSpy = vi.spyOn(registry, 'getCapabilityManifestEntry').mockImplementation((toolName, policy) => {
      const manifest = originalGetManifest(toolName, policy);
      if (toolName === capabilityId && mutateOnFinalManifestRead && !mutationScheduled) {
        mutationScheduled = true;
        queueMicrotask(() => {
          reviewedDefinition.handler = replacementHandler;
        });
      }
      return manifest;
    });
    await registry.execute('decide_workflow_confirmation', {
      runId: started.runId,
      expectedRevision: waiting.revision,
      confirmationId: waiting.confirmation.confirmationId,
      approved: true,
    }, {
      userId,
      requestConfirmation: async () => true,
      onAdapterStart: async call => {
        if (call.name === capabilityId) mutateOnFinalManifestRead = true;
      },
    });
    const completed = await waitForRun(registry, userId, started.runId, ['completed']);
    manifestSpy.mockRestore();

    expect(mutationScheduled).toBe(true);
    expect(completed.completedSteps).toBe(1);
    expect(handlerVisibleAtReviewedEntry).toBe(replacementHandler);
    expect(reviewedHandler).toHaveBeenCalledTimes(1);
    expect(replacementHandler).not.toHaveBeenCalled();
  });

  it('blocks a published workflow when the registered capability contract drifts', async () => {
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    const handler = vi.fn(async () => JSON.stringify({ ok: true, status: 'completed' }));
    registry.register({ name: 'workflow_live_contract', description: 'test', parameters: { type: 'object', properties: { target: { type: 'string' } } }, permission: 'public', securityLevel: 'safe', handler });
    const userId = `workflow-live-contract-${Date.now()}`;
    const name = `contract-${Date.now()}`;
    await saveAndPublish(registry, userId, name, 'workflow_live_contract');
    registry.get('workflow_live_contract')!.parameters = {
      type: 'object',
      properties: { target: { type: 'string', enum: ['different-semantic-target'] } },
      required: ['target'],
    };
    const started = JSON.parse(await registry.execute('run_workflow', { name }, { userId, requestConfirmation: async () => true }));
    const blocked = await waitForRun(registry, userId, started.runId, ['blocked']);
    expect(blocked.blockedKind).toBe('capability_contract_changed');
    expect(handler).not.toHaveBeenCalled();
  });

  it('turns a captured draft without a capability snapshot into a new review hash before publication', async () => {
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    registry.register({ name: 'workflow_live_captured', description: 'test', parameters: {}, permission: 'public', securityLevel: 'safe', handler: async () => '{}' });
    const userId = `workflow-live-captured-${Date.now()}`;
    const name = `captured-${Date.now()}`;
    const legacy = saveWorkflowDraftCandidate(userId, name, 'captured draft', [
      { description: 'captured', tool: 'workflow_live_captured', args: {} },
    ], { source: 'captured_draft', reviewedByUser: false });
    const refreshed = JSON.parse(await registry.execute('publish_workflow', {
      name,
      expectedHash: legacy.runtimeHash,
    }, { userId, requestConfirmation: async () => true }));
    expect(refreshed).toMatchObject({ status: 'draft_refreshed', hash: expect.any(String) });
    expect(refreshed.hash).not.toBe(legacy.runtimeHash);
    const published = JSON.parse(await registry.execute('publish_workflow', {
      name,
      expectedHash: refreshed.hash,
    }, { userId, requestConfirmation: async () => true }));
    expect(published.status).toBe('published');
  });

  it('rejects workflow controls from the wrong domain scope', async () => {
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    registry.register({ name: 'workflow_live_scoped', description: 'test', parameters: {}, permission: 'public', securityLevel: 'safe', handler: async () => '{}' });
    const userId = `workflow-live-scope-${Date.now()}`;
    const name = `scope-${Date.now()}`;
    const workContext = { domain: 'work', orgId: 'org-a' };
    await saveAndPublish(registry, userId, name, 'workflow_live_scoped', workContext);
    const started = JSON.parse(await registry.execute('run_workflow', { name }, { userId, ...workContext, requestConfirmation: async () => true }));
    const waiting = await waitForRun(registry, userId, started.runId, ['waiting_confirmation'], workContext);
    await expect(registry.execute('pause_workflow_run', {
      runId: started.runId,
      expectedRevision: waiting.revision,
    }, { userId })).rejects.toThrow('not found in this scope');
    await registry.execute('cancel_workflow_run', {
      runId: started.runId,
      expectedRevision: waiting.revision,
    }, { userId, ...workContext, requestConfirmation: async () => true });
  });
});
