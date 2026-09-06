import './helpers';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
const mocks = vi.hoisted(() => ({ model: vi.fn() }));
vi.mock('../server/llm/providers', async () => ({
  ...await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers'), makeLLMCall: mocks.model,
}));
vi.mock('../server/llm/user_preferences', async () => ({
  ...await vi.importActual<typeof import('../server/llm/user_preferences')>('../server/llm/user_preferences'),
  getUserPreferredLLMConfig: () => ({ provider: 'deepseek', model: 'synthetic-model' }),
}));
import { JWT_SECRET, makeApp } from './helpers';
import { querySQL } from '../db_layer';
import { addMember, createOrg, getMember, setMemberStatus, updateMemberRole } from '../server/org/db';
import { mountOrgRoutes } from '../server/org/routes';
import { mountCommandCenterPlanRoutes } from '../server/routes/command_center_plan_routes';
import { dispatchManualCommandCenterPlanTasks } from '../server/command_center/runtime';
import { runtimeBackgroundWork } from '../server/runtime/shutdown_work';
import { cancelAutonomousTaskFinalization, enqueue, getTaskHistory, getTaskQueue, resetAutonomousTaskQueueForTest } from '../server/autonomy/task_queue';
import { executeNextAutonomousTask } from '../server/autonomy/task_executor';
import { resetRealtimeUserActivityForTests, setRealtimeVoiceSessionActive } from '../server/autonomy/foreground_activity';
import { resetExternalCommitRuntimeCacheForTests, toolRegistry } from '../server/tools/registry';
import type { ToolContext } from '../server/tools/types';

const userId = 'synthetic-authorized-plan-user';
const ownerId = 'synthetic-authorized-plan-owner';
const getters = { getDeepSeek: () => null, getGemini: () => null };
const emit = vi.fn();
const io = { to: () => ({ emit }) } as any;
const result = JSON.stringify({ status: 'completed', items: [{ url: 'https://example.invalid/synthetic' }] });
const handler = vi.fn(async (_args: Record<string, unknown>, _context?: ToolContext) => result);
let url: string;
let cleanup: () => void;
let orgId: string;
let sequence = 0;
const headers = (uid: string) => ({ 'Content-Type': 'application/json',
  Authorization: `Bearer ${jwt.sign({ uid, username: uid, role: 'user', orgId }, JWT_SECRET)}` });

beforeAll(async () => {
  const fixture = await makeApp();
  url = fixture.url;
  cleanup = fixture.cleanup;
  mountCommandCenterPlanRoutes(fixture.apiRouter, { io, getters });
  mountOrgRoutes(fixture.apiRouter);
});
afterAll(() => cleanup());
beforeEach(() => {
  sequence++;
  orgId = createOrg('Synthetic member plan guard', `synthetic-member-plan-${sequence}`, ownerId).id;
  addMember(orgId, ownerId, 'owner');
  addMember(orgId, userId, 'member');
  resetAutonomousTaskQueueForTest({ clearPersisted: true, markHydrated: true });
  resetRealtimeUserActivityForTests();
  resetExternalCommitRuntimeCacheForTests();
  emit.mockClear(); handler.mockReset().mockResolvedValue(result); mocks.model.mockReset();
  mocks.model.mockResolvedValueOnce({ text: '', toolCalls: [{ id: 'synthetic-search', name: 'web_search', arguments: { query: 'public standard' } }] })
    .mockResolvedValue({ text: 'Research completed with a synthetic source: https://example.invalid/synthetic.', toolCalls: [] });
  toolRegistry.register({ name: 'web_search', description: 'Synthetic search only; no network', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, handler });
});
afterEach(async () => {
  vi.useRealTimers();
  await runtimeBackgroundWork.waitForIdle();
  toolRegistry.unregister('web_search');
  resetRealtimeUserActivityForTests();
  resetExternalCommitRuntimeCacheForTests();
  resetAutonomousTaskQueueForTest({ clearPersisted: true, markHydrated: true });
});

async function createPlan() {
  const created = await fetch(`${url}/api/command-center/plans`, { method: 'POST', headers: headers(userId),
    body: JSON.stringify({ title: 'Research public standards', instruction: 'Research a public standard using synthetic organization context and summarize the source.', kind: 'daily_task', cadence: 'none' }) });
  expect(created.status).toBe(201);
  return (await created.json()).plan;
}
async function requestPlan() {
  const plan = await createPlan();
  const run = await fetch(`${url}/api/command-center/plans/${plan.id}/run`, { method: 'POST', headers: headers(userId) });
  expect(run.status).toBe(202);
  return (await run.json()).task;
}
async function removeMember() {
  const removed = await fetch(`${url}/api/org/org/${orgId}/members/${userId}`, { method: 'DELETE', headers: headers(ownerId) });
  expect(removed.status).toBe(200);
}
function releaseVoiceGate() {
  setRealtimeVoiceSessionActive(userId, 'synthetic-defer', false);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 16_000);
}

it('executes a normal work manual plan with the exact durable member snapshot', async () => {
  const task = await requestPlan();
  await runtimeBackgroundWork.waitForIdle();
  expect(handler).toHaveBeenCalledOnce();
  expect(handler.mock.calls[0][1]).toMatchObject({ userId, domain: 'work', orgId });
  const completed = getTaskHistory(50, 0, userId).find(entry => entry.id === task.id)!;
  expect(completed).toMatchObject({ status: 'completed', verified: true, membershipAuthorization: {
    orgId, userId, membershipId: getMember(orgId, userId)!.id, role: 'member',
  } });
  const [row] = await querySQL<{ payload: string }>('SELECT payload FROM autonomous_tasks WHERE id = ?', [task.id]);
  expect(JSON.parse(row.payload).membershipAuthorization).toEqual(completed.membershipAuthorization);
  expect(cancelAutonomousTaskFinalization(task.id, 'Must not rewrite a saved terminal task')).toBeNull();
  expect(getTaskHistory(50, 0, userId).find(entry => entry.id === task.id)?.status).toBe('completed');
});

it.each(['removed', 'viewer', 'suspended', 'removed-and-rejoined'])('cancels a queued work request after its member is %s without calling a model', async change => {
  setRealtimeVoiceSessionActive(userId, 'synthetic-defer', true);
  const task = await requestPlan();
  await runtimeBackgroundWork.waitForIdle();
  expect(getTaskQueue(userId)[0].status).toBe('pending');
  const acceptedId = task.membershipAuthorization.membershipId;
  if (change === 'viewer') updateMemberRole(orgId, userId, 'viewer');
  else if (change === 'suspended') setMemberStatus(orgId, userId, 'suspended');
  else {
    await removeMember();
    if (change === 'removed-and-rejoined') expect(addMember(orgId, userId, 'member').id).not.toBe(acceptedId);
    else expect((await fetch(`${url}/api/command-center/plans`, { headers: headers(userId) })).status).toBe(403);
  }
  releaseVoiceGate();
  await dispatchManualCommandCenterPlanTasks(io, getters, { userId });
  expect(mocks.model).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
  expect(getTaskQueue(userId)).toEqual([]);
  expect(getTaskHistory(50, 0, userId).find(entry => entry.id === task.id)).toMatchObject({ status: 'cancelled', verified: false });
  expect(await querySQL('SELECT status FROM autonomous_tasks WHERE id = ?', [task.id])).toEqual([{ status: 'cancelled' }]);
});

it.each([false, true])('aborts a running work task and waits for the started tool receipt after member removal (rejoin=%s)', async rejoin => {
  let release!: () => void;
  handler.mockImplementation((_args, _context) => new Promise<string>(resolve => { release = () => resolve(result); }));
  const task = await requestPlan();
  try {
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    const context = handler.mock.calls[0][1]!;
    await removeMember();
    if (rejoin) addMember(orgId, userId, 'member');
    await vi.waitFor(() => expect(context.executionSignal?.aborted).toBe(true));
    expect(context.isCancelled?.()).toBe(true);
    let idle = false;
    const drain = runtimeBackgroundWork.waitForIdle().then(() => { idle = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(idle).toBe(false);
    release(); await drain;
    const cancelled = getTaskHistory(50, 0, userId).find(entry => entry.id === task.id)!;
    expect(cancelled).toMatchObject({ status: 'cancelled', finalized: false, verified: false, actions: [{ state: 'settled' }] });
    expect(handler).toHaveBeenCalledOnce();
    expect(emit.mock.calls.some(([name]) => name === 'autonomous:task_completed')).toBe(false);
    expect(await querySQL('SELECT status FROM autonomous_tasks WHERE id = ?', [task.id])).toEqual([{ status: 'cancelled' }]);
  } finally { release?.(); await runtimeBackgroundWork.waitForIdle(); }
});

it('cancels legacy work requests without assigning the current member authorization to them', async () => {
  const plan = await createPlan();
  const task = enqueue({ userId, planId: plan.id, domain: 'work', orgId, title: plan.title, description: plan.instruction,
    priority: 5, source: 'user_request', mode: 'analysis', idempotencyKey: `command-center-plan:${plan.id}:legacy` })!;
  await dispatchManualCommandCenterPlanTasks(io, getters, { userId });
  expect(mocks.model).not.toHaveBeenCalled();
  expect(getTaskHistory(50, 0, userId).find(entry => entry.id === task.id)).toMatchObject({ status: 'cancelled' });
  expect(getTaskHistory(50, 0, userId).find(entry => entry.id === task.id)?.membershipAuthorization).toBeUndefined();
});

it.each(['removed', 'removed-and-rejoined'])('also rejects a revoked work plan through the original executor with no options (%s)', async change => {
  setRealtimeVoiceSessionActive(userId, 'synthetic-defer', true);
  const task = await requestPlan();
  await runtimeBackgroundWork.waitForIdle();
  await removeMember();
  if (change === 'removed-and-rejoined') addMember(orgId, userId, 'member');
  releaseVoiceGate();
  await executeNextAutonomousTask(io, getters, userId);
  expect(mocks.model).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled();
  expect(getTaskHistory(50, 0, userId).find(entry => entry.id === task.id)).toMatchObject({ status: 'cancelled', verified: false });
  expect(await querySQL('SELECT status FROM autonomous_tasks WHERE id = ?', [task.id])).toEqual([{ status: 'cancelled' }]);
});

it('cancels a running manual work request even when the automatic executor received no authority callback', async () => {
  setRealtimeVoiceSessionActive(userId, 'synthetic-defer', true);
  const task = await requestPlan();
  await runtimeBackgroundWork.waitForIdle();
  releaseVoiceGate();
  let release!: () => void;
  handler.mockImplementation(() => new Promise<string>(resolve => { release = () => resolve(result); }));
  const running = executeNextAutonomousTask(io, getters, userId);
  try {
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    const context = handler.mock.calls[0][1]!;
    await removeMember();
    await vi.waitFor(() => expect(context.executionSignal?.aborted).toBe(true));
    release(); await running;
    expect(getTaskHistory(50, 0, userId).find(entry => entry.id === task.id)).toMatchObject({ status: 'cancelled', verified: false, actions: [{ state: 'settled' }] });
    expect(emit.mock.calls.some(([name]) => name === 'autonomous:task_completed')).toBe(false);
  } finally { release?.(); await running; }
});
