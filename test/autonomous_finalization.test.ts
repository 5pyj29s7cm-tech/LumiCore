import './helpers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ model: vi.fn(), finalizationGate: vi.fn() }));
vi.mock('../server/cognition/execution_guard_recovery', async () => {
  const actual = await vi.importActual<typeof import('../server/cognition/execution_guard_recovery')>('../server/cognition/execution_guard_recovery');
  return { ...actual, finalizeExecutionForOutboundDelivery: async (...args: Parameters<typeof actual.finalizeExecutionForOutboundDelivery>) => {
    await mocks.finalizationGate(...args);
    return actual.finalizeExecutionForOutboundDelivery(...args);
  } };
});
vi.mock('../server/llm/providers', async () => ({
  ...await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers'), makeLLMCall: mocks.model,
}));
vi.mock('../server/llm/user_preferences', async () => ({
  ...await vi.importActual<typeof import('../server/llm/user_preferences')>('../server/llm/user_preferences'),
  getUserPreferredLLMConfig: () => ({ provider: 'deepseek', model: 'synthetic-model' }),
}));
import { flushDBOrThrow, initDatabase, querySQL, readDB, runSQL } from '../db_layer';
import { enqueue, getRunningTask, getTaskHistory, getTaskQueue, persistAutonomousTaskQueue, requestPauseAutonomousTask, resetAutonomousTaskQueueForTest } from '../server/autonomy/task_queue';
import * as taskQueue from '../server/autonomy/task_queue';
import { executeNextAutonomousTask, retryAutonomousTaskFinalizations } from '../server/autonomy/task_executor';
import { resetRealtimeUserActivityForTests } from '../server/autonomy/foreground_activity';
import { resetExternalCommitRuntimeCacheForTests, toolRegistry } from '../server/tools/registry';
import { createCommandCenterPlan, runCommandCenterPlan } from '../server/command_center/plans';
import { buildTaskAcceptanceProjections } from '../server/cognition/acceptance_evidence';
import { getDurableTaskHealthSnapshot } from '../server/cognition/durable_task_diagnostics';
import { buildStructuredRuntimeStatus } from '../server/monitor/runtime_status';
import { createPlan, getPlan, getTodayPlanSummary, listPlans, updatePlan, updatePlanStep } from '../server/autonomy/planner';

const userId = 'finalization-synthetic-user';
const getters = { getDeepSeek: () => null, getGemini: () => null };
const handler = vi.fn(async () => JSON.stringify({ status: 'completed', items: [{ url: 'https://example.invalid/source' }] }));
function enqueueTask() {
  return enqueue({ userId, title: 'Research a public standard', description: 'Research the current public standard and summarize the result.', source: 'user_request', priority: 5, mode: 'analysis' })!;
}
function modelResponses(finalize = async () => {}) {
  mocks.model.mockResolvedValueOnce({ text: '', toolCalls: [{ id: 'source', name: 'web_search', arguments: { query: 'current standard' } }] })
    .mockImplementation(async () => { await finalize(); return { text: 'Research completed with a current public source: https://example.invalid/source.', toolCalls: [] }; });
}
beforeEach(async () => {
  await initDatabase();
  mocks.model.mockReset(); mocks.finalizationGate.mockReset(); handler.mockClear();
  resetRealtimeUserActivityForTests();
  resetAutonomousTaskQueueForTest({ clearPersisted: true, markHydrated: true });
  resetExternalCommitRuntimeCacheForTests();
  toolRegistry.register({ name: 'web_search', description: 'Synthetic source; no network.', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, handler });
});
afterEach(async () => {
  await runSQL('PRAGMA query_only=OFF');
  await retryAutonomousTaskFinalizations({ to: () => ({ emit: vi.fn() }) } as any);
  await flushDBOrThrow();
  resetAutonomousTaskQueueForTest({ clearPersisted: true, markHydrated: true });
  toolRegistry.unregister('web_search');
  resetExternalCommitRuntimeCacheForTests();
});

it('publishes completion only after SQLite contains the completed task and keeps the owner until then', async () => {
  const task = enqueueTask();
  modelResponses();
  const reads: Array<Promise<any>> = [];
  const emit = vi.fn((name: string) => {
    if (name === 'autonomous:task_completed') {
      expect(getRunningTask(userId)?.id).toBe(task.id);
      reads.push(querySQL('SELECT status FROM autonomous_tasks WHERE id = ?', [task.id]));
    }
  });
  await executeNextAutonomousTask({ to: () => ({ emit }) } as any, getters, userId);
  expect(await Promise.all(reads)).toEqual([[{ status: 'completed' }]]);
  expect(handler).toHaveBeenCalledOnce();
  expect(getRunningTask(userId)).toBeNull();
});

it('withholds verified completion on final save failure and retries saving without replaying tools or the plan', async () => {
  const plan = createCommandCenterPlan({ userId, domain: 'personal', orgId: '' }, {
    kind: 'daily_task', title: 'Research a public standard', instruction: 'Research the current public standard and summarize the result.', cadence: 'none',
  });
  const task = runCommandCenterPlan({ id: plan.id, userId, domain: 'personal', orgId: '', manual: true })!.task;
  await persistAutonomousTaskQueue();
  modelResponses(async () => { await runSQL('PRAGMA query_only=ON'); });
  const emit = vi.fn();
  const io = { to: () => ({ emit }) } as any;
  await expect(executeNextAutonomousTask(io, getters, userId)).rejects.toThrow(/readonly/i);
  expect(handler).toHaveBeenCalledOnce();
  expect(emit.mock.calls.some(([name]) => name === 'autonomous:task_completed')).toBe(false);
  expect(getTaskHistory(50, 0, userId)[0]).toMatchObject({ status: 'blocked', finalized: false, verified: false, finalizationPending: true });
  expect(buildTaskAcceptanceProjections(readDB(), { userId }).find(item => item.taskId === task.id)).toMatchObject({ status: 'blocked', accepted: false });
  expect(getDurableTaskHealthSnapshot(userId).recent.find(item => item.taskId === task.id)?.status).toBe('blocked');
  expect(buildStructuredRuntimeStatus(readDB(), { userId, domain: 'personal' }).durableWork.find(item => item.taskId === task.id)?.status).toBe('blocked');
  const rows = await querySQL<{ status: string; payload: string }>('SELECT status, payload FROM autonomous_tasks WHERE id = ?', [task.id]);
  expect(rows[0].status).toBe('running');
  expect(JSON.parse(rows[0].payload).actions[0].state).toBe('settled');
  expect(runCommandCenterPlan({ id: plan.id, userId, domain: 'personal', orgId: '', manual: true })).toMatchObject({ reused: true, task: { id: task.id } });
  await runSQL('PRAGMA query_only=OFF');
  await retryAutonomousTaskFinalizations(io);
  await retryAutonomousTaskFinalizations(io);
  expect(await querySQL('SELECT status FROM autonomous_tasks WHERE id = ?', [task.id])).toEqual([{ status: 'completed' }]);
  expect(getTaskHistory(50, 0, userId)[0]).toMatchObject({ status: 'completed', finalized: true, verified: true });
  expect(buildTaskAcceptanceProjections(readDB(), { userId }).find(item => item.taskId === task.id)).toMatchObject({ status: 'completed', accepted: true });
  expect(getDurableTaskHealthSnapshot(userId).recent.find(item => item.taskId === task.id)?.status).toBe('completed');
  expect(buildStructuredRuntimeStatus(readDB(), { userId, domain: 'personal' }).durableWork.find(item => item.taskId === task.id)?.status).toBe('completed');
  expect(emit.mock.calls.filter(([name]) => name === 'autonomous:task_completed')).toHaveLength(1);
  expect(mocks.model).toHaveBeenCalledTimes(2);
  expect(handler).toHaveBeenCalledOnce();
});

it('does not claim a queued task or call the model when the parent is already cancelled', async () => {
  enqueueTask();
  const parent = new AbortController(); parent.abort();
  expect(await executeNextAutonomousTask({} as any, getters, userId, { signal: parent.signal })).toMatchObject({ executed: false });
  expect(mocks.model).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
  expect(getRunningTask(userId)).toBeNull();
});

it.each([false, true])('withholds the linked planner step and summary until save succeeds (later edit: %s)', async laterEdit => {
  const scope = { userId, domain: 'personal' as const, orgId: '' };
  const title = `Research a public standard ${laterEdit}`;
  const plan = createPlan(title, 'Read a synthetic public source.', scope, 'user', 'medium', [{ title: 'Read and summarize the source' }]);
  const task = enqueue({ userId, planId: plan.id, title: plan.title,
    description: 'Research the current public standard and summarize the result.',
    source: 'user_request', priority: 5, mode: 'analysis' })!;
  modelResponses(async () => { await runSQL('PRAGMA query_only=ON'); });
  const emit = vi.fn();
  const io = { to: () => ({ emit }) } as any;
  await expect(executeNextAutonomousTask(io, getters, userId)).rejects.toThrow(/readonly/i);
  expect(getPlan(plan.id, scope)).toMatchObject({ status: 'active', steps: [{ status: 'in_progress' }] });
  expect(getPlan(plan.id, scope)?.completedAt).toBeUndefined();
  expect(listPlans(scope, { status: 'completed' }).some(item => item.id === plan.id)).toBe(false);
  expect(getTodayPlanSummary(scope)).toContain(`- ${title} [medium] (0/1 steps)`);
  expect(getTodayPlanSummary(scope)).not.toContain(`- ${title} ✓`);
  expect(getTaskHistory(50, 0, userId).find(item => item.id === task.id)?.finalizationPending).toBe(true);
  if (laterEdit) {
    updatePlanStep(plan.id, plan.steps[0].id, { title: 'User renamed the step while saving was blocked' }, scope);
    const updated = updatePlan(plan.id, { title: `${title} edited`, status: 'paused', result: 'User postponed this plan' }, scope);
    expect(updated).toMatchObject({ status: 'paused', result: 'User postponed this plan', steps: [{ status: 'in_progress' }] });
  }
  await runSQL('PRAGMA query_only=OFF');
  await retryAutonomousTaskFinalizations(io);
  await retryAutonomousTaskFinalizations(io);
  const savedPlan = getPlan(plan.id, scope)!;
  if (laterEdit) {
    expect(savedPlan).toMatchObject({ title: `${title} edited`, status: 'paused', result: 'User postponed this plan',
      steps: [{ title: 'User renamed the step while saving was blocked', status: 'done' }] });
  } else {
    expect(savedPlan).toMatchObject({ status: 'completed', steps: [{ status: 'done' }] });
    expect(listPlans(scope, { status: 'completed' }).some(item => item.id === plan.id)).toBe(true);
    expect(getTodayPlanSummary(scope)).toContain(`- ${title} ✓`);
  }
  expect(emit.mock.calls.filter(([name]) => name === 'autonomous:task_completed')).toHaveLength(1);
  expect(mocks.model).toHaveBeenCalledTimes(2);
  expect(handler).toHaveBeenCalledOnce();
});

it.each([
  ['parent', false], ['pause', false], ['pause_then_parent', false],
  ['parent', true], ['pause', true], ['pause_then_parent', true],
  ['authorization', false], ['authorization', true],
] as const)('keeps %s authoritative when final delivery is waiting (verified outcome: %s)', async (kind, verified) => {
  const scope = { userId, domain: 'personal' as const, orgId: '' };
  const plan = createPlan('Research a public standard', 'Read a synthetic public source.', scope, 'user', 'medium', [{ title: 'Read and summarize the source' }]);
  const task = enqueue({ userId, planId: plan.id, title: plan.title,
    description: 'Research the current public standard and summarize the result.',
    source: 'user_request', priority: 5, mode: 'analysis' })!;
  if (verified) modelResponses();
  else mocks.model.mockResolvedValue({ text: 'The task is blocked by missing evidence.', toolCalls: [] });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  mocks.finalizationGate.mockImplementation(() => gate);
  const parent = new AbortController();
  let authorized = true;
  const emit = vi.fn();
  const executing = executeNextAutonomousTask({ to: () => ({ emit }) } as any, getters, userId, { signal: parent.signal, isAuthorized: () => authorized });
  try {
    await vi.waitFor(() => expect(mocks.finalizationGate).toHaveBeenCalledOnce());
    expect(mocks.finalizationGate.mock.calls[0][0].finalization.blocked).toBe(!verified);
    expect(getRunningTask(userId)?.id).toBe(task.id);
    if (kind === 'authorization') authorized = false;
    else {
      if (kind !== 'parent') requestPauseAutonomousTask(task.id, userId);
      if (kind !== 'pause') parent.abort(new Error('Synthetic parent stopped during finalization'));
    }
  } finally {
    release();
    await executing;
  }
  const expectedStatus = kind === 'pause' ? 'paused' : 'cancelled';
  const stored = [...getTaskQueue(userId), ...getTaskHistory(50, 0, userId)].find(item => item.id === task.id)!;
  expect(stored.status).toBe(expectedStatus);
  expect(await querySQL('SELECT status FROM autonomous_tasks WHERE id = ?', [task.id])).toEqual([{ status: expectedStatus }]);
  expect(getPlan(plan.id, scope)?.status).toBe(expectedStatus);
  if (kind === 'pause') expect(getPlan(plan.id, scope)?.steps[0].status).toBe('in_progress');
  const terminalNames = emit.mock.calls.map(([name]) => name).filter(name => name !== 'autonomous:task_started');
  expect(terminalNames).toEqual([`autonomous:task_${expectedStatus}`]);
  expect(getRunningTask(userId)).toBeNull();
  expect(handler).toHaveBeenCalledTimes(verified ? 1 : 0);
});

it('rejects revoked authorization before claiming the exact queued task', async () => {
  const task = enqueueTask();
  expect(await executeNextAutonomousTask({} as any, getters, userId, { taskId: task.id, isAuthorized: () => false }))
    .toMatchObject({ executed: false, taskId: task.id });
  expect(getTaskHistory(50, 0, userId)[0].status).toBe('cancelled');
  expect(mocks.model).not.toHaveBeenCalled();
  expect(handler).not.toHaveBeenCalled();
});

it('rechecks authorization after the final SQLite save and persists cancellation before notifying', async () => {
  const scope = { userId, domain: 'personal' as const, orgId: '' };
  const plan = createPlan('Research a public standard', 'Read a synthetic source.', scope, 'user', 'medium', [{ title: 'Summarize the source' }]);
  const task = enqueue({ userId, planId: plan.id, title: plan.title, description: 'Research the current public standard and summarize the result.', source: 'user_request', priority: 5, mode: 'analysis' })!;
  modelResponses();
  let authorized = true;
  const actualPersist = taskQueue.persistAutonomousTaskQueue;
  const persist = vi.spyOn(taskQueue, 'persistAutonomousTaskQueue').mockImplementation(async () => {
    await actualPersist();
    const rows = await querySQL<{ status: string }>('SELECT status FROM autonomous_tasks WHERE id = ?', [task.id]);
    if (rows[0]?.status === 'completed') authorized = false;
  });
  const persistedAtNotification: Array<Promise<any>> = [];
  const emit = vi.fn((name: string) => {
    if (name === 'autonomous:task_cancelled') persistedAtNotification.push(querySQL('SELECT status FROM autonomous_tasks WHERE id = ?', [task.id]));
  });
  try {
    expect(await executeNextAutonomousTask({ to: () => ({ emit }) } as any, getters, userId, { isAuthorized: () => authorized }))
      .toMatchObject({ executed: true, result: 'Cancelled because task authorization was revoked' });
    expect(authorized).toBe(false);
    expect(emit.mock.calls.map(([name]) => name)).toEqual(['autonomous:task_started', 'autonomous:task_cancelled']);
    expect(await Promise.all(persistedAtNotification)).toEqual([[{ status: 'cancelled' }]]);
    expect(getPlan(plan.id, scope)?.status).toBe('cancelled');
    expect(getTaskHistory(50, 0, userId).find(item => item.id === task.id)).toMatchObject({ status: 'cancelled', verified: false });
    expect(handler).toHaveBeenCalledOnce();
    expect(getRunningTask(userId)).toBeNull();
  } finally {
    persist.mockRestore();
  }
});

it.each([false, true])('serializes two finalization callers across a revoked completion (save failure: %s)', async saveFailure => {
  const task = enqueueTask();
  modelResponses();
  let authorized = true;
  let firstSaved = false;
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const actualPersist = taskQueue.persistAutonomousTaskQueue;
  let calls = 0;
  const persist = vi.spyOn(taskQueue, 'persistAutonomousTaskQueue').mockImplementation(async () => {
    const call = ++calls;
    await actualPersist();
    if (call === 1) {
      firstSaved = true;
      await firstGate;
      authorized = false;
    }
  });
  const durableStates: Array<Promise<any>> = [];
  const emit = vi.fn((name: string) => {
    if (name === 'autonomous:task_cancelled') durableStates.push(querySQL('SELECT status FROM autonomous_tasks WHERE id = ?', [task.id]));
  });
  const io = { to: () => ({ emit }) } as any;
  const first = executeNextAutonomousTask(io, getters, userId, { isAuthorized: () => authorized });
  let second: Promise<void> | undefined;
  // Collect rejections immediately; the gates below deliberately block writes.
  const firstOutcome = first.then(value => ({ value }), error => ({ error }));
  let secondOutcome: Promise<{ error?: unknown }> | undefined;
  try {
    await vi.waitFor(() => expect(firstSaved).toBe(true));
    second = retryAutonomousTaskFinalizations(io);
    secondOutcome = second.then(() => ({}), error => ({ error }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(calls).toBe(1); // The second caller cannot reuse an older successful write.
    if (saveFailure) await runSQL('PRAGMA query_only=ON');
    releaseFirst();
    const outcomes = await Promise.all([firstOutcome, secondOutcome]);
    if (saveFailure) {
      expect(outcomes.every(outcome => 'error' in outcome)).toBe(true);
      expect(emit.mock.calls.some(([name]) => name === 'autonomous:task_completed' || name === 'autonomous:task_cancelled')).toBe(false);
      expect(getTaskHistory(50, 0, userId).find(item => item.id === task.id)?.finalizationPending).toBe(true);
      await runSQL('PRAGMA query_only=OFF');
      await retryAutonomousTaskFinalizations(io);
    } else {
      expect(outcomes.every(outcome => !('error' in outcome))).toBe(true);
    }
    expect(await Promise.all(durableStates)).toEqual([[{ status: 'cancelled' }]]);
    expect(emit.mock.calls.filter(([name]) => name === 'autonomous:task_cancelled')).toHaveLength(1);
    expect(emit.mock.calls.some(([name]) => name === 'autonomous:task_completed')).toBe(false);
    expect(getTaskHistory(50, 0, userId).find(item => item.id === task.id)).toMatchObject({ status: 'cancelled', verified: false });
    expect(handler).toHaveBeenCalledOnce();
    expect(mocks.model).toHaveBeenCalledTimes(2);
  } finally {
    releaseFirst();
    await firstOutcome;
    await secondOutcome;
    persist.mockRestore();
    await runSQL('PRAGMA query_only=OFF');
    await retryAutonomousTaskFinalizations(io);
  }
});
