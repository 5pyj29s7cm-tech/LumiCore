import './helpers';
import { describe, expect, it, vi } from 'vitest';
import { initDatabase } from '../db_layer';
import { ToolRegistry } from '../server/tools/registry';
import { registerWorkflowTools } from '../server/tools/definitions/workflow_tools';
import { runtimeBackgroundWork, runtimeShutdownCancellation } from '../server/runtime/shutdown_work';
import { getWorkflowRun } from '../server/workflows/runtime';

describe('workflow workers join common shutdown', () => {
  it('cancels the actual worker and waits for its final state save', async () => {
    await initDatabase();
    const registry = new ToolRegistry();
    registerWorkflowTools(registry);
    let entered!: () => void;
    const startedAdapter = new Promise<void>(resolve => { entered = resolve; });
    let signal: AbortSignal | undefined;
    const handler = vi.fn(async (_args, context) => {
      signal = context.executionSignal;
      entered();
      await new Promise<void>((resolve, reject) => {
        if (signal!.aborted) reject(signal!.reason);
        else signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      });
      return '{"ok":true}';
    });
    registry.register({ name: 'synthetic_wait_read', description: 'test observation', parameters: {}, permission: 'public', securityLevel: 'safe', handler });
    const context = { userId: 'shutdown-workflow-user', requestConfirmation: async () => true };
    const draft = JSON.parse(await registry.execute('save_workflow', { name: 'Controlled fixture', steps: [{ description: 'read', tool: 'synthetic_wait_read', args: {} }] }, context));
    await registry.execute('publish_workflow', { name: 'Controlled fixture', expectedHash: draft.hash }, context);
    const started = JSON.parse(await registry.execute('run_workflow', { name: 'Controlled fixture' }, context));
    for (let attempt = 0; attempt < 100; attempt++) {
      const run = getWorkflowRun(started.runId, context.userId)!;
      if (run.confirmation) {
        await registry.execute('decide_workflow_confirmation', { runId: run.runId, expectedRevision: run.revision, confirmationId: run.confirmation.confirmationId, approved: true }, context);
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await startedAdapter;
    let idle = false;
    const drain = runtimeBackgroundWork.waitForIdle().then(() => { idle = true; });
    await Promise.resolve();
    expect(idle).toBe(false);
    runtimeShutdownCancellation.request();
    await drain;
    expect(signal?.aborted).toBe(true);
    expect(getWorkflowRun(started.runId, context.userId)?.status).not.toBe('running');
    expect(handler).toHaveBeenCalledOnce();
  });
});
