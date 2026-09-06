import './helpers';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
const persistence = vi.hoisted(() => ({ runId: '', waitingUserId: '', gate: null as Promise<void> | null, entered: null as (() => void) | null }));
vi.mock('../db_layer', async original => {
  const actual = await original<typeof import('../db_layer')>();
  return { ...actual, flushDBOrThrow: async () => {
    if (persistence.runId || persistence.waitingUserId) {
      const row = actual.readDB().settings.find(item => item.key === 'lumi.workflow_runtime.v1');
      const run = row && JSON.parse(row.value).runs.find((item: any) => persistence.waitingUserId ? item.userId === persistence.waitingUserId : item.runId === persistence.runId);
      if (run?.status === (persistence.waitingUserId ? 'waiting_confirmation' : 'completed')) {
        persistence.runId = '';
        persistence.waitingUserId = '';
        persistence.entered?.();
        await persistence.gate;
      }
    }
    await actual.flushDBOrThrow();
  } };
});
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import { createOrg, addMember } from '../server/org/db';
import { mountOrgRoutes } from '../server/org/routes';
import { ToolRegistry } from '../server/tools/registry';
import { registerWorkflowTools } from '../server/tools/definitions/workflow_tools';
import { executeToolCall } from '../server/tools/execution_engine';
import { flushDBOrThrow, readDB, writeDB, closeDatabase, initDatabase } from '../db_layer';
import { getWorkflowRun } from '../server/workflows/runtime';

let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); mountOrgRoutes(app.apiRouter); });
afterAll(async () => { await new Promise<void>(resolve => app.server.close(() => resolve())); });

it.each(['normal', 'membership', 'parent', 'waiting-revocation', 'legacy-no-snapshot', 'terminal-save-revocation', 'old-parent-after-resume'])('background workflow lifecycle: %s', async mode => {
  const removed = mode === 'membership' || mode === 'waiting-revocation';
  const stopped = mode !== 'normal';
  const userId = `audit10-workflow-${randomUUID()}`;
  const owner = `owner-${userId}`;
  const orgId = createOrg('Synthetic workflow audit', randomUUID(), owner).id;
  addMember(orgId, owner, 'owner'); addMember(orgId, userId, 'member');
  const registry = new ToolRegistry(); registerWorkflowTools(registry);
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const firstSignals: AbortSignal[] = [];
  const output = JSON.stringify({ status: 'completed', items: [{ title: 'Synthetic public result', url: 'https://example.invalid/fixture' }] });
  const later = vi.fn(async (_args: any, _context: any) => output);
  registry.register({ name: 'web_search', description: 'Synthetic observer; no network', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    handler: async (args, context) => {
      if (args.query === 'first') { firstSignals.push(context!.executionSignal!); enter(); await gate; return output; }
      return later(args, context);
    } });
  const parent = new AbortController();
  let saveEntered!: () => void;
  const saving = new Promise<void>(resolve => { saveEntered = resolve; });
  let releaseSave!: () => void;
  const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
  const context = { userId, domain: 'work' as const, orgId, authenticated: true, orgRole: 'member', authRole: 'user',
    localExecution: true, executionBoundary: 'trusted_local' as const, userConfirmed: true,
    executionSignal: parent.signal, isCancelled: () => parent.signal.aborted,
    requestConfirmation: async () => true, requestId: randomUUID(), currentTurnExecutionRequested: true,
    actionIntent: 'Run the reviewed synthetic workflow.', toolPolicy: { allowedTools: ['*'], forbiddenTools: [], requireConfirmation: [], maxIterations: 10 } };
  const name = `workflow-${randomUUID()}`;
  const saved = JSON.parse(await registry.execute('save_workflow', { name, steps: [
    { description: 'Synthetic first observation', tool: 'web_search', args: { query: 'first' } },
    { description: 'Synthetic later observation', tool: 'web_search', args: { query: 'later' } },
  ] }, context));
  await registry.execute('publish_workflow', { name, expectedHash: saved.hash }, context);
  if (mode === 'old-parent-after-resume') {
    persistence.waitingUserId = userId;
    persistence.gate = saveGate;
    persistence.entered = saveEntered;
  }
  const started = await executeToolCall({ registry, name: 'run_workflow', arguments: { name }, context });
  const runId = JSON.parse(started.result!).runId;
  expect(runId).toBeTruthy();
  try {
    let waiting: any;
    await vi.waitFor(async () => {
      waiting = JSON.parse(await registry.execute('get_workflow_run', { runId }, context));
      expect(waiting.status).toBe('waiting_confirmation');
    });
    if (mode === 'old-parent-after-resume') {
      await saving;
      const oldLeaseId = getWorkflowRun(runId, userId)!.lastWorkerLeaseId;
      const paused = JSON.parse(await registry.execute('pause_workflow_run', { runId, expectedRevision: waiting.revision }, context));
      const resumedContext = { ...context, executionSignal: new AbortController().signal, isCancelled: () => false };
      await registry.execute('resume_workflow_run', { runId, expectedRevision: paused.revision }, resumedContext);
      await vi.waitFor(() => {
        expect(getWorkflowRun(runId, userId)?.status).toBe('waiting_confirmation');
        expect(getWorkflowRun(runId, userId)?.lastWorkerLeaseId).not.toBe(oldLeaseId);
      });
      const newState = getWorkflowRun(runId, userId)!;
      parent.abort(); // The still-pending old worker listener runs synchronously.
      expect(getWorkflowRun(runId, userId)?.status).toBe('waiting_confirmation');
      expect(getWorkflowRun(runId, userId)?.confirmation?.confirmationId).toBe(newState.confirmation?.confirmationId);
      releaseSave();
      await registry.execute('cancel_workflow_run', { runId, expectedRevision: newState.revision }, resumedContext);
      expect(firstSignals).toEqual([]); expect(later).not.toHaveBeenCalled();
      return;
    }
    if (mode === 'legacy-no-snapshot') {
      const db = readDB();
      const row = db.settings.find(item => item.key === 'lumi.workflow_runtime.v1')!;
      const store = JSON.parse(row.value);
      delete store.runs.find((run: any) => run.runId === runId).membershipAuthorization;
      row.value = JSON.stringify(store); writeDB(db); await flushDBOrThrow();
      await closeDatabase(); await initDatabase();
      await expect(registry.execute('decide_workflow_confirmation', { runId, expectedRevision: waiting.revision,
        confirmationId: waiting.confirmation.confirmationId, approved: true }, context)).rejects.toThrow(/authorization/i);
      expect(getWorkflowRun(runId, userId)?.status).toBe('cancelled');
      expect(firstSignals).toEqual([]); expect(later).not.toHaveBeenCalled();
      await flushDBOrThrow();
      return;
    }
    const remove = async () => {
      const response = await fetch(`${app.url}/api/org/org/${orgId}/members/${userId}`, { method: 'DELETE',
        headers: { Authorization: `Bearer ${jwt.sign({ uid: owner, orgId, role: 'user' }, JWT_SECRET)}` } });
      expect(response.status).toBe(200);
    };
    if (mode === 'waiting-revocation') {
      await remove();
      await expect(registry.execute('decide_workflow_confirmation', { runId, expectedRevision: waiting.revision,
        confirmationId: waiting.confirmation.confirmationId, approved: true }, context)).rejects.toThrow(/authorization/i);
      expect(firstSignals).toEqual([]);
      expect(later).not.toHaveBeenCalled();
      expect(getWorkflowRun(runId, userId)?.status).toBe('cancelled');
      await flushDBOrThrow();
      return;
    }
    // The production default requires one approval per step. Explicitly use
    // its public edit tool to authorize these two read-only steps up front.
    const edited = JSON.parse(await registry.execute('edit_workflow_run_plan', {
      runId, expectedRevision: waiting.revision, reason: 'User approves both synthetic read-only steps without an additional per-step prompt.',
      steps: [
        { stepId: 'step_1', capabilityId: 'web_search', arguments: { query: 'first' }, confirmationRequired: false },
        { stepId: 'step_2', capabilityId: 'web_search', arguments: { query: 'later' }, confirmationRequired: false },
      ],
    }, context));
    expect(edited.status).toBe('paused');
    await executeToolCall({ registry, name: 'run_workflow', arguments: { runId, expectedRevision: edited.revision }, context });
    await vi.waitFor(() => expect(firstSignals.length).toBe(1));
    await entered;
    if (removed) {
      await remove();
      await vi.waitFor(() => expect(firstSignals[0].aborted).toBe(true));
      expect(parent.signal.aborted).toBe(false); // Worker owns its own membership watcher.
    }
    if (mode === 'parent') {
      parent.abort();
      await vi.waitFor(() => expect(firstSignals[0].aborted).toBe(true));
    }
    if (mode === 'terminal-save-revocation') {
      persistence.runId = runId;
      persistence.gate = saveGate;
      persistence.entered = saveEntered;
    }
    release();
    if (mode === 'terminal-save-revocation') {
      await saving;
      await remove();
      await vi.waitFor(() => expect(getWorkflowRun(runId, userId)?.status).toBe('cancelled'));
      releaseSave();
      await expect(registry.execute('get_workflow_run', { runId }, context)).rejects.toThrow(/authorization/i);
    }
    let state: any;
    await vi.waitFor(async () => {
      state = getWorkflowRun(runId, userId);
      expect(state.status).toBe(stopped ? 'cancelled' : 'completed');
    });
    await flushDBOrThrow();
    if (removed) {
      expect(later).not.toHaveBeenCalled();
      addMember(orgId, userId, 'member');
      await expect(registry.execute('run_workflow', { runId, expectedRevision: state.revision }, { ...context, executionSignal: new AbortController().signal, isCancelled: () => false })).rejects.toThrow(/authorization/i);
    } else if (!stopped) {
      expect(later).toHaveBeenCalledOnce();
      expect(later.mock.calls[0][1]).toMatchObject({ userId, domain: 'work', orgId });
      const snapshot = getWorkflowRun(runId, userId)?.membershipAuthorization;
      expect(snapshot?.membershipId).toBeTruthy();
      await closeDatabase(); await initDatabase();
      expect(getWorkflowRun(runId, userId)?.membershipAuthorization).toEqual(snapshot);
    }
    if (stopped && mode !== 'terminal-save-revocation') expect(later).not.toHaveBeenCalled();
  } finally { release(); releaseSave(); persistence.runId = ''; persistence.waitingUserId = ''; persistence.gate = null; persistence.entered = null; }
}, 15000);
