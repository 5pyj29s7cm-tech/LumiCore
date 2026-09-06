import './helpers';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import sqlite3 from 'sqlite3';

const mocks = vi.hoisted(() => ({ model: vi.fn(), generate: vi.fn() }));
vi.mock('../server/llm/providers', async () => ({
  ...await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers'), makeLLMCall: mocks.model,
}));
vi.mock('../server/llm/user_preferences', async () => ({
  ...await vi.importActual<typeof import('../server/llm/user_preferences')>('../server/llm/user_preferences'),
  getUserPreferredLLMConfig: () => ({ provider: 'deepseek', model: 'synthetic-model' }),
}));
vi.mock('../server/autonomy/task_generator', () => ({ generateAutonomousTasks: mocks.generate }));

import { JWT_SECRET, makeApp } from './helpers';
import { closeDatabase, flushDBOrThrow, initDatabase, querySQL, readDB, runSQL, writeDB } from '../db_layer';
import { addMember, createOrg, getMember, setMemberStatus, updateMemberRole } from '../server/org/db';
import { mountOrgRoutes } from '../server/org/routes';
import { mountCommandCenterPlanRoutes } from '../server/routes/command_center_plan_routes';
import { registerScheduledTasks, scheduler, type ScheduledTask } from '../server/scheduler';
import { getTaskHistory, getTaskQueue, hydrateAutonomousTasksFromDb, resetAutonomousTaskQueueForTest } from '../server/autonomy/task_queue';
import { resetRealtimeUserActivityForTests, isRealtimeUserActive } from '../server/autonomy/foreground_activity';
import { saveGateConfig } from '../server/autonomy/safety_gate';
import { resetExternalCommitRuntimeCacheForTests, toolRegistry } from '../server/tools/registry';
import { runtimeBackgroundWork } from '../server/runtime/shutdown_work';
import { retryAutonomousTaskFinalizations } from '../server/autonomy/task_executor';
import { listCommandCenterPlans } from '../server/command_center/plans';
import { MIGRATIONS, runMigrations } from '../server/db/migrations';
import type { ToolContext } from '../server/tools/types';

const userId = 'round6-synthetic-schedule-user';
const ownerId = 'round6-synthetic-org-owner';
const getters = { getDeepSeek: () => null, getGemini: () => null };
const emit = vi.fn();
const io = { to: () => ({ emit }) } as any;
const handler = vi.fn(async (_args: Record<string, unknown>, _context?: ToolContext) => JSON.stringify({ status: 'completed', items: [{ url: 'https://example.invalid/synthetic' }] }));
const definitions: ScheduledTask[] = [];
let url: string;
let closeServer: () => Promise<void>;
let sequence = 0;
const headers = (orgId = '', uid = userId) => ({ 'Content-Type': 'application/json',
  Authorization: `Bearer ${jwt.sign({ uid, username: uid, role: 'user', ...(orgId ? { orgId } : {}) }, JWT_SECRET)}` });

beforeAll(async () => {
  const app = await makeApp(); url = app.url;
  closeServer = () => new Promise<void>(resolve => app.server.close(() => resolve()));
  mountCommandCenterPlanRoutes(app.apiRouter, { io, getters });
  mountOrgRoutes(app.apiRouter);
  const register = vi.spyOn(scheduler, 'register').mockImplementation(task => { definitions.push(task); });
  try { registerScheduledTasks(getters.getDeepSeek, getters.getGemini); } finally { register.mockRestore(); }
  scheduler.setIO(io);
});
afterAll(async () => { await closeServer(); });
beforeEach(() => {
  sequence++;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 10, 8, 59, 0));
  resetRealtimeUserActivityForTests();
  resetAutonomousTaskQueueForTest({ clearPersisted: true, markHydrated: true });
  resetExternalCommitRuntimeCacheForTests();
  const db = readDB();
  db.commandCenterPlans = [];
  db.users = [userId, ownerId].map(uid => ({ uid, username: uid, password: '', role: 'user', createdAt: new Date().toISOString() }));
  db.settings = [{ key: `op_mode_${userId}`, value: JSON.stringify('assistant') }];
  writeDB(db);
  saveGateConfig({ maxConsecutiveTasks: 1 }, userId);
  emit.mockClear(); handler.mockReset().mockResolvedValue(JSON.stringify({ status: 'completed', items: [{ url: 'https://example.invalid/synthetic' }] })); mocks.model.mockReset(); mocks.generate.mockReset().mockResolvedValue(0);
  mocks.model.mockResolvedValueOnce({ text: '', toolCalls: [{ id: 'synthetic-search', name: 'web_search', arguments: { query: 'public standard' } }] })
    .mockResolvedValue({ text: 'Research completed with a synthetic public source: https://example.invalid/synthetic.', toolCalls: [] });
  toolRegistry.register({ name: 'web_search', description: 'Synthetic public source; no network.', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, handler });
});
afterEach(async () => {
  await runtimeBackgroundWork.waitForIdle();
  await runSQL('PRAGMA query_only=OFF');
  await retryAutonomousTaskFinalizations(io);
  await flushDBOrThrow();
  toolRegistry.unregister('web_search');
  resetExternalCommitRuntimeCacheForTests(); resetRealtimeUserActivityForTests();
  resetAutonomousTaskQueueForTest({ clearPersisted: true, markHydrated: true });
  vi.useRealTimers();
});

function mode(value: 'assistant' | 'autonomous') {
  const db = readDB();
  db.settings.find((row: any) => row.key === `op_mode_${userId}`).value = JSON.stringify(value);
  writeDB(db);
}
async function tick(id: 'command_center_plan_dispatch' | 'autonomous_work_cycle') {
  expect(isRealtimeUserActive(userId)).toBe(false);
  return definitions.find(task => task.id === id)!.handler();
}
async function createPlan(orgId = '') {
  const response = await fetch(`${url}/api/command-center/plans`, { method: 'POST', headers: headers(orgId),
    body: JSON.stringify({ title: 'Research public standards', instruction: 'Research a public standard and summarize the source.', kind: 'daily_task', cadence: 'daily', timeOfDay: '09:00' }) });
  expect(response.status).toBe(201);
  return (await response.json()).plan;
}
async function editPlan(plan: any, patch: Record<string, unknown>, orgId = '') {
  const response = await fetch(`${url}/api/command-center/plans/${plan.id}`, { method: 'PUT', headers: headers(orgId), body: JSON.stringify(patch) });
  expect(response.status).toBe(200);
  return (await response.json()).plan;
}
function due(plan: any) { vi.setSystemTime(new Date(Date.parse(plan.nextRunAt) + 30_000)); }
function newOrg() {
  const org = createOrg('Synthetic scheduled work', `round6-schedule-${sequence}`, ownerId);
  addMember(org.id, ownerId, 'owner'); addMember(org.id, userId, 'member');
  return org.id;
}

describe('scheduled plans through authenticated routes, real scheduler handlers, executor and SQLite', () => {
  it('control: dispatches one due occurrence, preserves deduplication through rehydration, and actually executes it in autonomous mode', async () => {
    const plan = await createPlan(); due(plan); mode('autonomous');
    await tick('command_center_plan_dispatch');
    const task = getTaskQueue(userId)[0];
    expect(task).toMatchObject({ source: 'scheduler', planId: plan.id, status: 'pending' });
    await flushDBOrThrow();
    resetAutonomousTaskQueueForTest();
    await closeDatabase();
    await initDatabase();
    hydrateAutonomousTasksFromDb(true);
    await tick('command_center_plan_dispatch');
    expect(getTaskQueue(userId).map(item => item.id)).toEqual([task.id]);
    await tick('autonomous_work_cycle');
    expect(handler).toHaveBeenCalledOnce(); expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(getTaskHistory(50, 0, userId)[0]).toMatchObject({ id: task.id, status: 'completed', verified: true });
    expect(await querySQL('SELECT status FROM autonomous_tasks WHERE id = ?', [task.id])).toEqual([{ status: 'completed' }]);
    console.info('CONTROL', { singleTaskAcrossDatabaseReopen: true, singleTaskAcrossRehydration: true, modelCalls: 2, tools: 1, state: 'completed' });
  });

  it('preserves the assistant-mode gate and executes the same waiting slot only after explicit mode change', async () => {
    const plan = await createPlan(); due(plan);
    await tick('command_center_plan_dispatch');
    const task = getTaskQueue(userId)[0];
    for (let i = 0; i < 2; i++) { await tick('command_center_plan_dispatch'); await tick('autonomous_work_cycle'); }
    expect(getTaskQueue(userId)[0]).toMatchObject({ id: task.id, status: 'pending', source: 'scheduler' });
    expect(mocks.model).not.toHaveBeenCalled(); expect(handler).not.toHaveBeenCalled(); expect(mocks.generate).not.toHaveBeenCalled();
    mode('autonomous'); await tick('autonomous_work_cycle');
    expect(getTaskHistory(50, 0, userId)[0]).toMatchObject({ id: task.id, status: 'completed' });
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([false, true])('allows only still-authorized scheduled work (removed=%s)', async removed => {
    const orgId = newOrg(); const plan = await createPlan(orgId); due(plan);
    await tick('command_center_plan_dispatch');
    const task = getTaskQueue(userId)[0];
    expect(task).toMatchObject({ source: 'scheduler', domain: 'work', orgId });
    expect(task.membershipAuthorization).toEqual(plan.membershipAuthorization);
    expect(task.membershipAuthorization?.membershipId).toBe(getMember(orgId, userId)!.id);
    if (removed) {
      const response = await fetch(`${url}/api/org/org/${orgId}/members/${userId}`, { method: 'DELETE', headers: headers(orgId, ownerId) });
      expect(response.status).toBe(200);
      expect((await fetch(`${url}/api/command-center/plans`, { headers: headers(orgId) })).status).toBe(403);
    }
    mode('autonomous'); await tick('autonomous_work_cycle');
    if (removed) {
      expect(handler).not.toHaveBeenCalled(); expect(mocks.model).not.toHaveBeenCalled();
      expect(getTaskHistory(50, 0, userId)[0]).toMatchObject({ id: task.id, status: 'cancelled', verified: false });
      expect(await querySQL('SELECT status FROM autonomous_tasks WHERE id = ?', [task.id])).toEqual([{ status: 'cancelled' }]);
    } else {
      expect(handler).toHaveBeenCalledOnce(); expect(mocks.model).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[0][1]).toMatchObject({ userId, domain: 'work', orgId });
      expect(getTaskHistory(50, 0, userId)[0]).toMatchObject({ id: task.id, status: 'completed', verified: true });
    }
  });

  it.each([false, true])('due slot dispatch after a metadata-only edit before the next tick (edited=%s)', async edited => {
    const plan = await createPlan(); due(plan); mode('autonomous');
    let updated = plan;
    if (edited) updated = await editPlan(plan, { title: 'Research updated public standards', instruction: 'Research the public standard and summarize the updated source.' });
    await tick('command_center_plan_dispatch'); await tick('autonomous_work_cycle');
    expect(updated.nextRunAt).toBe(plan.nextRunAt);
    expect(handler).toHaveBeenCalledOnce();
    expect(getTaskHistory(50, 0, userId)[0].status).toBe('completed');
  });

  it.each(['pause', 'delete', 'reschedule'] as const)('keeps existing task receipts separate from future schedule %s', async change => {
    const plan = await createPlan(); due(plan);
    await tick('command_center_plan_dispatch'); const task = getTaskQueue(userId)[0];
    if (change === 'delete') {
      expect((await fetch(`${url}/api/command-center/plans/${plan.id}`, { method: 'DELETE', headers: headers() })).status).toBe(200);
    } else await editPlan(plan, change === 'pause' ? { status: 'paused' } : { timeOfDay: '15:00' });
    mode('autonomous'); await tick('autonomous_work_cycle');
    expect(handler).toHaveBeenCalledOnce(); expect(getTaskHistory(50, 0, userId)[0]).toMatchObject({ id: task.id, status: 'completed' });
  });

  it('persists the plan identity through real database reopen before dispatch', async () => {
    const orgId = newOrg(); const plan = await createPlan(orgId);
    await flushDBOrThrow(); await closeDatabase(); await initDatabase();
    const loaded = listCommandCenterPlans({ userId, domain: 'work', orgId })[0];
    expect(loaded.membershipAuthorization).toEqual(plan.membershipAuthorization);
    due(loaded); mode('autonomous');
    await tick('command_center_plan_dispatch'); await tick('autonomous_work_cycle');
    expect(handler).toHaveBeenCalledOnce();
    expect(getTaskHistory(50, 0, userId)[0]).toMatchObject({ status: 'completed', membershipAuthorization: plan.membershipAuthorization });
  });

  it.each(['missing', 'removed-and-rejoined', 'viewer', 'suspended'] as const)('pauses invalid plans before dispatch and exposes the reason (%s)', async change => {
    const orgId = newOrg(); const plan = await createPlan(orgId); due(plan);
    if (change === 'missing') {
      delete readDB().commandCenterPlans.find((p: any) => p.id === plan.id).membershipAuthorization;
      writeDB(readDB());
      await flushDBOrThrow(); await closeDatabase(); await initDatabase();
    } else if (change === 'viewer') updateMemberRole(orgId, userId, 'viewer');
    else if (change === 'suspended') setMemberStatus(orgId, userId, 'suspended');
    else {
      expect((await fetch(`${url}/api/org/org/${orgId}/members/${userId}`, { method: 'DELETE', headers: headers(orgId, ownerId) })).status).toBe(200);
      addMember(orgId, userId, 'member');
    }
    await tick('command_center_plan_dispatch'); mode('autonomous'); await tick('autonomous_work_cycle');
    expect(getTaskQueue(userId)).toEqual([]); expect(mocks.model).not.toHaveBeenCalled();
    expect(listCommandCenterPlans({ userId, domain: 'work', orgId })[0]).toMatchObject({ status: 'paused', nextRunAt: '',
      authorizationBlockedReason: change === 'missing' ? 'membership_missing' : 'membership_changed' });
    await flushDBOrThrow(); await closeDatabase(); await initDatabase();
    expect(listCommandCenterPlans({ userId, domain: 'work', orgId })[0].authorizationBlockedReason).toBeTruthy();
    if (change === 'missing' || change === 'removed-and-rejoined') {
      const denied = await fetch(`${url}/api/command-center/plans/${plan.id}/run`, { method: 'POST', headers: headers(orgId) });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'plan_authorization_required' });
      const unchanged = await editPlan(plan, { title: 'Research a new public standard', status: 'active' }, orgId);
      expect(unchanged.status).toBe('paused');
      const renewed = await editPlan(plan, { reauthorize: true, status: 'active' }, orgId);
      expect(renewed.authorizationBlockedReason).toBe('');
      expect(renewed.membershipAuthorization.membershipId).toBe(getMember(orgId, userId)!.id);
      due(renewed); await tick('command_center_plan_dispatch'); await tick('autonomous_work_cycle');
      expect(handler).toHaveBeenCalledOnce();
    } else if (change === 'viewer') {
      const denied = await fetch(`${url}/api/command-center/plans/${plan.id}`, { method: 'PUT', headers: headers(orgId), body: JSON.stringify({ reauthorize: true, status: 'active' }) });
      expect(denied.status).toBe(400);
      expect(listCommandCenterPlans({ userId, domain: 'work', orgId })[0].membershipAuthorization).toEqual(plan.membershipAuthorization);
    } else {
      setMemberStatus(orgId, userId, 'active');
      const stillPaused = await editPlan(plan, { status: 'active' }, orgId);
      expect(stillPaused).toMatchObject({ status: 'paused', authorizationBlockedReason: 'membership_changed' });
      const renewed = await editPlan(plan, { reauthorize: true, status: 'active' }, orgId);
      expect(renewed.status).toBe('active');
    }
  });

  it('rejects old queued tasks without assigning current membership', async () => {
    const orgId = newOrg(); const plan = await createPlan(orgId); due(plan);
    await tick('command_center_plan_dispatch');
    const task = getTaskQueue(userId)[0];
    delete readDB().autonomousTasks.find((row: any) => row.id === task.id).membershipAuthorization;
    writeDB(readDB());
    await flushDBOrThrow();
    resetAutonomousTaskQueueForTest();
    await closeDatabase(); await initDatabase(); hydrateAutonomousTasksFromDb(true);
    mode('autonomous'); await tick('autonomous_work_cycle');
    expect(mocks.model).not.toHaveBeenCalled();
    expect(getTaskHistory(50, 0, userId)[0]).toMatchObject({ id: task.id, status: 'cancelled' });
    expect(getTaskHistory(50, 0, userId)[0].membershipAuthorization).toBeUndefined();
  });

  it('aborts a running scheduled tool after revocation and waits for its original receipt without replay', async () => {
    const orgId = newOrg(); const plan = await createPlan(orgId); due(plan); mode('autonomous');
    await tick('command_center_plan_dispatch');
    const task = getTaskQueue(userId)[0];
    let release!: () => void;
    handler.mockImplementation(() => new Promise<string>(resolve => { release = () => resolve(JSON.stringify({ status: 'completed', items: [{ url: 'https://example.invalid/synthetic' }] })); }));
    const running = tick('autonomous_work_cycle');
    try {
      await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
      expect((await fetch(`${url}/api/org/org/${orgId}/members/${userId}`, { method: 'DELETE', headers: headers(orgId, ownerId) })).status).toBe(200);
      await vi.waitFor(() => expect(handler.mock.calls[0][1]?.executionSignal?.aborted).toBe(true));
      release(); await running;
      expect(getTaskHistory(50, 0, userId)[0]).toMatchObject({ id: task.id, status: 'cancelled', verified: false, actions: [{ state: 'settled' }] });
      addMember(orgId, userId, 'member');
      await tick('command_center_plan_dispatch'); await tick('autonomous_work_cycle');
      expect(handler).toHaveBeenCalledOnce();
      expect(emit.mock.calls.some(([name]) => name === 'autonomous:task_completed')).toBe(false);
    } finally { release?.(); await running; }
  });

  it('rechecks scheduled authorization when retrying a failed final save without replaying work', async () => {
    const orgId = newOrg(); const plan = await createPlan(orgId); due(plan); mode('autonomous');
    await tick('command_center_plan_dispatch'); const task = getTaskQueue(userId)[0];
    mocks.model.mockReset().mockResolvedValueOnce({ text: '', toolCalls: [{ id: 'synthetic-search', name: 'web_search', arguments: { query: 'public standard' } }] })
      .mockImplementation(async () => { await runSQL('PRAGMA query_only=ON'); return { text: 'Research completed: https://example.invalid/synthetic.', toolCalls: [] }; });
    // The registered scheduler contains the error; the task remains pending final save.
    await tick('autonomous_work_cycle');
    expect(getTaskHistory(50, 0, userId)[0]).toMatchObject({ id: task.id, status: 'blocked', finalizationPending: true });
    expect(handler).toHaveBeenCalledOnce();
    await runSQL('PRAGMA query_only=OFF');
    expect((await fetch(`${url}/api/org/org/${orgId}/members/${userId}`, { method: 'DELETE', headers: headers(orgId, ownerId) })).status).toBe(200);
    await retryAutonomousTaskFinalizations(io);
    expect(await querySQL('SELECT status FROM autonomous_tasks WHERE id = ?', [task.id])).toEqual([{ status: 'cancelled' }]);
    expect(handler).toHaveBeenCalledOnce(); expect(mocks.model).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.some(([name]) => name === 'autonomous:task_completed')).toBe(false);
  });

  it('uses edit time only for changed schedules and resumes, preserving unchanged and metadata-only slots', async () => {
    const plan = await createPlan(); due(plan);
    expect((await editPlan(plan, { timeOfDay: '09:00', status: 'active', dayOfWeek: 5, dayOfMonth: 14 })).nextRunAt).toBe(plan.nextRunAt);
    const rescheduled = await editPlan(plan, { timeOfDay: '15:00' });
    expect(new Date(rescheduled.nextRunAt).getHours()).toBe(15);
    await tick('command_center_plan_dispatch'); expect(getTaskQueue(userId)).toEqual([]);
    expect((await editPlan(rescheduled, { status: 'paused' })).nextRunAt).toBe('');
    vi.setSystemTime(new Date(2026, 8, 10, 16));
    const resumed = await editPlan(rescheduled, { status: 'active' });
    expect(new Date(resumed.nextRunAt).getDate()).toBe(11);
    expect(new Date(resumed.nextRunAt).getHours()).toBe(15);
  });

  it('adds empty authority columns to a real legacy SQLite table without assigning membership', async () => {
    const legacyDb = new sqlite3.Database(':memory:');
    const exec = (sql: string) => new Promise<void>((resolve, reject) => legacyDb.exec(sql, error => error ? reject(error) : resolve()));
    try {
      await exec(MIGRATIONS.find(migration => migration.version === 37)!.sql);
      await exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, appliedAt TEXT NOT NULL); INSERT INTO schema_version VALUES (44, 'synthetic'); INSERT INTO command_center_plans (id,userId,kind,title,instruction,createdAt,updatedAt,domain,orgId) VALUES ('legacy','synthetic','daily_task','Legacy title','Synthetic only','synthetic','synthetic','work','synthetic-org')");
      expect(await runMigrations(legacyDb)).toEqual([45, 46]);
      const row = await new Promise<any>((resolve, reject) => legacyDb.get('SELECT title,membershipAuthorization,authorizationBlockedReason FROM command_center_plans', (error, row) => error ? reject(error) : resolve(row)));
      expect(row).toEqual({ title: 'Legacy title', membershipAuthorization: '', authorizationBlockedReason: '' });
    } finally { await new Promise<void>((resolve, reject) => legacyDb.close(error => error ? reject(error) : resolve())); }
  });
});
