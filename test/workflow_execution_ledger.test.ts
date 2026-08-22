import { beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDatabase, flushDB, initDatabase, readDB } from '../db_layer';
import {
  getSavedWorkflowRuntimeDefinition,
  getWorkflow,
  saveWorkflow,
  saveWorkflowDraftCandidate,
} from '../server/agents/workflows';
import { registerWorkflowTools } from '../server/tools/definitions/workflow_tools';
import { ToolRegistry } from '../server/tools/registry';

async function driveWorkflowToTerminal(
  registry: ToolRegistry,
  userId: string,
  runId: string,
  inputs: Record<string, unknown> = {},
  requestConfirmation: (toolName: string, args: Record<string, unknown>) => Promise<boolean> = async () => true,
): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = JSON.parse(await registry.execute('get_workflow_run', { runId }, { userId }));
    if (state.status === 'waiting_confirmation') {
      await registry.execute('decide_workflow_confirmation', {
        runId,
        expectedRevision: state.revision,
        confirmationId: state.confirmation.confirmationId,
        approved: true,
        inputs,
      }, { userId, requestConfirmation });
    } else if (state.status === 'completed' || state.status === 'blocked' || state.status === 'cancelled') {
      return state;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Workflow run '${runId}' did not reach a terminal or blocked state.`);
}

describe('saved workflow execution receipts', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('stops at the real failed step and never appends false completion', async () => {
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    const laterStep = vi.fn(async () => 'should not run');
    registry.register({
      name: 'workflow_test_ok', description: 'test', parameters: {}, permission: 'public', securityLevel: 'safe',
      handler: async () => JSON.stringify({ ok: true, status: 'completed' }),
    });
    registry.register({
      name: 'workflow_test_fail', description: 'test', parameters: {}, permission: 'public', securityLevel: 'safe',
      handler: async () => { throw new Error('real step failure'); },
    });
    registry.register({
      name: 'workflow_test_later', description: 'test', parameters: {}, permission: 'public', securityLevel: 'safe',
      handler: laterStep,
    });
    const userId = `workflow-ledger-${Date.now()}`;
    const name = `failure-${Date.now()}`;
    const saved = JSON.parse(await registry.execute('save_workflow', {
      name,
      steps: [
        { description: 'first', tool: 'workflow_test_ok', args: {} },
        { description: 'second', tool: 'workflow_test_fail', args: {} },
        { description: 'third', tool: 'workflow_test_later', args: {} },
      ],
    }, { userId }));
    expect(saved.status).toBe('draft');
    await registry.execute('publish_workflow', {
      name,
      expectedHash: saved.hash,
    }, {
      userId,
      requestConfirmation: async () => true,
    });

    const started = JSON.parse(await registry.execute('run_workflow', { name }, {
      userId,
      requestConfirmation: async () => true,
    }));
    expect(started).toMatchObject({ ok: true, status: 'started', completed: false });
    const result = await driveWorkflowToTerminal(registry, userId, started.runId);

    expect(result).toMatchObject({
      ok: true,
      status: 'blocked',
      completedSteps: 1,
      totalSteps: 3,
      blocker: 'real step failure',
    });
    expect(laterStep).not.toHaveBeenCalled();
  });

  it('stores captured workflow credentials only as runtime references', async () => {
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    const authenticatedStep = vi.fn(async (args: Record<string, unknown>) => JSON.stringify({
      ok: true,
      status: 'completed',
      authenticated: Boolean(args.apiKey),
    }));
    registry.register({
      name: 'workflow_test_authenticated', description: 'test', parameters: {}, permission: 'public', securityLevel: 'safe',
      handler: authenticatedStep,
    });
    const userId = `workflow-redaction-${Date.now()}`;
    const name = `redacted-${Date.now()}`;
    const saved = JSON.parse(await registry.execute('save_workflow', {
      name,
      steps: [{
        description: 'authenticated step',
        tool: 'workflow_test_authenticated',
        args: { apiKey: 'sk-raw-secret-123456789', subject: 'safe subject' },
      }],
    }, { userId }));

    expect(saved.status).toBe('draft');
    const persisted = (readDB().workflows || []).find((workflow: any) => workflow.userId === userId && workflow.name === name);
    expect(JSON.stringify(persisted)).not.toContain('sk-raw-secret-123456789');
    expect(persisted.steps[0].args).toEqual({
      apiKey: { $secretRef: 'legacy.steps.1.args.apiKey' },
      subject: 'safe subject',
    });
    await registry.execute('publish_workflow', { name, expectedHash: saved.hash }, {
      userId,
      requestConfirmation: async () => true,
    });
    const started = JSON.parse(await registry.execute('run_workflow', {
      name,
      inputs: { apiKey: 'ephemeral-run-secret' },
    }, {
      userId,
      requestConfirmation: async () => true,
    }));
    const result = await driveWorkflowToTerminal(
      registry,
      userId,
      started.runId,
      { apiKey: 'ephemeral-run-secret' },
    );
    expect(result.status).toBe('completed');
    expect(authenticatedStep).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'ephemeral-run-secret', subject: 'safe subject' }),
      expect.anything(),
    );
    expect(JSON.stringify(readDB().settings)).not.toContain('ephemeral-run-secret');
  });

  it('parameterizes personal targets and content in captured drafts without changing explicit user-authored workflows', () => {
    const userId = `workflow-captured-privacy-${Date.now()}`;
    const name = `captured-privacy-${Date.now()}`;
    const captured = saveWorkflowDraftCandidate(
      userId,
      name,
      'captured private messaging flow',
      [{
        description: 'send captured message',
        tool: 'wechat_send_message',
        args: {
          contact: 'Alice Private',
          message: 'The private captured message body',
          filePath: 'C:\\Users\\Alice\\private-plan.txt',
          apiKey: 'sk-captured-secret-123456789',
          mode: 'direct',
        },
      }],
      { source: 'captured_draft', reviewedByUser: false },
    );
    const stored = getWorkflow(userId, name)!;
    const persistedText = JSON.stringify(readDB().settings);
    expect(persistedText).not.toContain('Alice Private');
    expect(persistedText).not.toContain('The private captured message body');
    expect(persistedText).not.toContain('C:\\Users\\Alice\\private-plan.txt');
    expect(persistedText).not.toContain('sk-captured-secret-123456789');
    expect(stored.steps[0].args).toEqual({
      contact: { $inputRef: 'inputs.step_1_contact' },
      message: { $inputRef: 'inputs.step_1_message' },
      filePath: { $inputRef: 'inputs.step_1_filePath' },
      apiKey: { $secretRef: 'legacy.steps.1.args.apiKey' },
      mode: 'direct',
    });
    const definition = getSavedWorkflowRuntimeDefinition(captured)!;
    expect(definition.inputSchema).toMatchObject({
      required: expect.arrayContaining(['step_1_contact', 'step_1_message', 'step_1_filePath', 'apiKey']),
    });
  });

  it('restores the named index and frozen runtime version after SQLite restart', async () => {
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    registry.register({
      name: 'workflow_restart_observe', description: 'observe window', parameters: {}, permission: 'public', securityLevel: 'safe',
      handler: async () => JSON.stringify({ ok: true, status: 'completed' }),
    });
    const userId = `workflow-restart-${Date.now()}`;
    const name = `restart-${Date.now()}`;
    const saved = JSON.parse(await registry.execute('save_workflow', {
      name,
      steps: [{ description: 'observe', tool: 'workflow_restart_observe', args: { target: 'window' } }],
    }, { userId }));
    await registry.execute('publish_workflow', { name, expectedHash: saved.hash }, {
      userId,
      requestConfirmation: async () => true,
    });
    const before = getWorkflow(userId, name)!;

    await flushDB();
    await closeDatabase();
    await initDatabase();

    expect(getWorkflow(userId, name)).toMatchObject({
      id: before.id,
      lifecycleStatus: 'published',
      runtimeWorkflowId: before.runtimeWorkflowId,
      runtimeVersion: 1,
      runtimeHash: expect.any(String),
    });
  });

  it('executes the frozen published plan and asks again for an exact nested confirmation', async () => {
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    const originalStep = vi.fn(async () => JSON.stringify({ ok: true, status: 'completed' }));
    const mutatedLegacyStep = vi.fn(async () => JSON.stringify({ ok: true, status: 'completed' }));
    registry.register({
      name: 'workflow_confirmed_original', description: 'confirmed original', parameters: {}, permission: 'public', securityLevel: 'confirm',
      handler: originalStep,
    });
    registry.register({
      name: 'workflow_mutated_legacy', description: 'must not run', parameters: {}, permission: 'public', securityLevel: 'safe',
      handler: mutatedLegacyStep,
    });
    const userId = `workflow-frozen-${Date.now()}`;
    const name = `frozen-${Date.now()}`;
    const saved = JSON.parse(await registry.execute('save_workflow', {
      name,
      steps: [{ description: 'original', tool: 'workflow_confirmed_original', args: { target: 'reviewed-target' } }],
    }, { userId }));
    await registry.execute('publish_workflow', { name, expectedHash: saved.hash }, {
      userId,
      requestConfirmation: async () => true,
    });
    saveWorkflow(userId, name, 'mutated compatibility projection', [
      { description: 'mutated', tool: 'workflow_mutated_legacy', args: { target: 'wrong-target' } },
    ]);

    const confirmations = vi.fn(async (_toolName: string, _args: Record<string, unknown>) => true);
    const started = JSON.parse(await registry.execute('run_workflow', { name }, {
      userId,
      requestConfirmation: confirmations,
    }));
    const result = await driveWorkflowToTerminal(registry, userId, started.runId, {}, confirmations);

    expect(result.status).toBe('completed');
    expect(originalStep).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'reviewed-target' }),
      expect.anything(),
    );
    expect(mutatedLegacyStep).not.toHaveBeenCalled();
    expect(confirmations.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining([
      'run_workflow',
      'decide_workflow_confirmation',
      'workflow_confirmed_original',
    ]));
    const nestedConfirmation = confirmations.mock.calls.find(call => call[0] === 'workflow_confirmed_original');
    expect(nestedConfirmation?.[1]).toEqual({ target: 'reviewed-target' });
  });
});
