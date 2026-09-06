import './helpers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
const mocks = vi.hoisted(() => ({ model: vi.fn(), generate: vi.fn() }));
vi.mock('../server/llm/providers', async () => ({
  ...await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers'), makeLLMCall: mocks.model,
}));
vi.mock('../server/llm/user_preferences', async () => ({
  ...await vi.importActual<typeof import('../server/llm/user_preferences')>('../server/llm/user_preferences'),
  getUserPreferredLLMConfig: () => ({ provider: 'deepseek', model: 'synthetic-model' }),
}));
vi.mock('../server/autonomy/task_generator', () => ({ generateAutonomousTasks: mocks.generate }));
import { initDatabase, readDB, writeDB } from '../db_layer';
import { enqueue, getTaskHistory, getTaskQueue, resetAutonomousTaskQueueForTest } from '../server/autonomy/task_queue';
import { toolRegistry, resetExternalCommitRuntimeCacheForTests } from '../server/tools/registry';
import { mountCommandCenterPlanRoutes } from '../server/routes/command_center_plan_routes';
import { createCommandCenterPlan, runCommandCenterPlan } from '../server/command_center/plans';
import { dispatchManualCommandCenterPlanTasks } from '../server/command_center/runtime';
import { runtimeBackgroundWork } from '../server/runtime/shutdown_work';
import { isRealtimeUserActive, resetRealtimeUserActivityForTests, setRealtimeVoiceSessionActive } from '../server/autonomy/foreground_activity';
import { registerScheduledTasks, scheduler, type ScheduledTask } from '../server/scheduler';
import { JWT_SECRET, makeApp } from './helpers';

const userId = 'manual-plan-synthetic-user';
const getters = { getDeepSeek: () => null, getGemini: () => null };
const io = { to: () => ({ emit: vi.fn() }) } as any;
const handler = vi.fn(async () => JSON.stringify({ status: 'completed', items: [{ url: 'https://example.invalid/source' }] }));
function plan(instruction = 'Research the current public standard and summarize the result.') {
  return createCommandCenterPlan({ userId, domain: 'personal', orgId: '' }, { title: 'Research public sources', instruction, kind: 'daily_task', cadence: 'none' });
}
async function httpFixture() {
  const fixture = await makeApp();
  mountCommandCenterPlanRoutes(fixture.apiRouter, { io, getters });
  const token = jwt.sign({ uid: userId, username: userId, role: 'user' }, JWT_SECRET);
  return { ...fixture, run: async (id: string) => {
    const response = await fetch(`${fixture.url}/api/command-center/plans/${id}/run`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, payload: await response.json() as any };
  } };
}
beforeEach(async () => {
  await initDatabase();
  resetRealtimeUserActivityForTests();
  resetAutonomousTaskQueueForTest({ clearPersisted: true, markHydrated: true });
  resetExternalCommitRuntimeCacheForTests();
  const db = readDB(); db.commandCenterPlans = [];
  db.settings = [{ key: `op_mode_${userId}`, value: JSON.stringify('assistant') }]; writeDB(db);
  mocks.generate.mockReset(); mocks.model.mockReset(); handler.mockReset().mockResolvedValue(JSON.stringify({ status: 'completed', items: [{ url: 'https://example.invalid/source' }] }));
  mocks.model.mockResolvedValueOnce({ text: '', toolCalls: [{ id: 'source', name: 'web_search', arguments: { query: 'current public standard' } }] })
    .mockResolvedValue({ text: 'Research completed with a current public source: https://example.invalid/source.', toolCalls: [] });
  toolRegistry.register({ name: 'web_search', description: 'Synthetic source; no network.', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, handler });
});
afterEach(async () => {
  await runtimeBackgroundWork.waitForIdle();
  scheduler.stop(); toolRegistry.unregister('web_search');
  resetExternalCommitRuntimeCacheForTests(); resetRealtimeUserActivityForTests();
  resetAutonomousTaskQueueForTest({ clearPersisted: true, markHydrated: true });
});

it('runs an authenticated manual plan in assistant mode without consuming unrelated queued work or generating tasks', async () => {
  const unrelated = enqueue({ userId, title: 'Unattended background work', description: 'Unattended task', priority: 10, source: 'curiosity', mode: 'analysis' })!;
  const requested = plan();
  const fixture = await httpFixture();
  try {
    expect(isRealtimeUserActive(userId)).toBe(false);
    const response = await fixture.run(requested.id);
    expect(response.status).toBe(202);
    await runtimeBackgroundWork.waitForIdle();
    expect(getTaskHistory(50, 0, userId).find(task => task.id === response.payload.task.id)).toMatchObject({ status: 'completed', verified: true });
    expect(getTaskQueue(userId).find(task => task.id === unrelated.id)?.status).toBe('pending');
    expect(handler).toHaveBeenCalledOnce(); expect(mocks.generate).not.toHaveBeenCalled();
    expect(readDB().settings.find((setting: any) => setting.key === `op_mode_${userId}`)?.value).toBe(JSON.stringify('assistant'));
  } finally { await new Promise<void>(resolve => fixture.server.close(() => resolve())); }
});

it('retries a temporarily voice-blocked manual plan on the real plan-dispatch tick in assistant mode', async () => {
  setRealtimeVoiceSessionActive(userId, 'synthetic-session', true);
  const requested = plan(); const fixture = await httpFixture();
  try {
    const response = await fixture.run(requested.id);
    await runtimeBackgroundWork.waitForIdle();
    expect(response.status).toBe(202); expect(mocks.model).not.toHaveBeenCalled();
    expect(getTaskQueue(userId)[0].status).toBe('pending');
    setRealtimeVoiceSessionActive(userId, 'synthetic-session', false);
    // The existing 15-second voice grace remains in force; advance only Date.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 16_000);
    const definitions: ScheduledTask[] = [];
    const spy = vi.spyOn(scheduler, 'register').mockImplementation(task => { definitions.push(task); });
    try { registerScheduledTasks(getters.getDeepSeek, getters.getGemini); } finally { spy.mockRestore(); }
    scheduler.setIO(io);
    await definitions.find(task => task.id === 'command_center_plan_dispatch')!.handler();
    expect(getTaskHistory(50, 0, userId)[0].status).toBe('completed');
    expect(handler).toHaveBeenCalledOnce(); expect(mocks.generate).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); await new Promise<void>(resolve => fixture.server.close(() => resolve())); }
});

it('does not turn explicit plan admission into external-commit authorization', async () => {
  const requested = plan('Send an email to outside@example.invalid saying hello now.');
  const fixture = await httpFixture();
  try {
    await fixture.run(requested.id); await runtimeBackgroundWork.waitForIdle();
    expect(handler).not.toHaveBeenCalled(); expect(mocks.model).not.toHaveBeenCalled();
    expect(getTaskHistory(50, 0, userId)[0].status).not.toBe('completed');
  } finally { await new Promise<void>(resolve => fixture.server.close(() => resolve())); }
});

it('does not consume a forged or differently scoped plan task', async () => {
  const requested = plan();
  enqueue({ userId, planId: requested.id, domain: 'work', orgId: 'other', title: requested.title, description: requested.instruction,
    priority: 5, source: 'user_request', mode: 'analysis', idempotencyKey: `command-center-plan:${requested.id}:synthetic` });
  await dispatchManualCommandCenterPlanTasks(io, getters, { userId });
  expect(mocks.model).not.toHaveBeenCalled(); expect(getTaskQueue(userId)[0].status).toBe('pending');
});

it('deduplicates repeated HTTP requests while the real manual executor owns an in-flight tool', async () => {
  let release!: () => void;
  handler.mockImplementation(() => new Promise<string>(resolve => {
    release = () => resolve(JSON.stringify({ status: 'completed', items: [{ url: 'https://example.invalid/source' }] }));
  }));
  const requested = plan(); const fixture = await httpFixture();
  try {
    const first = await fixture.run(requested.id);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    const second = await fixture.run(requested.id);
    expect(second.status).toBe(200);
    expect(second.payload).toMatchObject({ reused: true, task: { id: first.payload.task.id } });
    release(); await runtimeBackgroundWork.waitForIdle();
    expect(handler).toHaveBeenCalledOnce(); expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(getTaskHistory(50, 0, userId).filter(task => task.planId === requested.id)).toHaveLength(1);
  } finally {
    release?.(); await runtimeBackgroundWork.waitForIdle();
    await new Promise<void>(resolve => fixture.server.close(() => resolve()));
  }
});

it('keeps shutdown background drain pending until a cancelled manual tool really settles', async () => {
  let release!: () => void;
  handler.mockImplementation(() => new Promise<string>(resolve => {
    release = () => resolve(JSON.stringify({ status: 'completed', items: [{ url: 'https://example.invalid/source' }] }));
  }));
  const requested = plan();
  runCommandCenterPlan({ id: requested.id, userId, domain: 'personal', orgId: '', manual: true });
  const parent = new AbortController();
  const running = dispatchManualCommandCenterPlanTasks(io, getters, { userId, signal: parent.signal });
  try {
    await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
    parent.abort();
    let idle = false;
    const draining = runtimeBackgroundWork.waitForIdle().then(() => { idle = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(idle).toBe(false);
    release(); await running; await draining;
    expect(getTaskHistory(50, 0, userId)[0]).toMatchObject({ status: 'cancelled', actions: [{ state: 'settled' }] });
    expect(handler).toHaveBeenCalledOnce();
  } finally { release?.(); await running; }
});
