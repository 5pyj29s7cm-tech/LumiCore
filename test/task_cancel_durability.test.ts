import './helpers';
import { beforeAll, afterAll, afterEach, expect, it, vi } from 'vitest';
const barriers = vi.hoisted(() => ({ gate: null as Promise<void> | null, entered: null as (() => void) | null }));
vi.mock('../db_layer', async original => {
  const actual = await original<typeof import('../db_layer')>();
  return { ...actual, flushDBOrThrow: async () => { barriers.entered?.(); await barriers.gate; await actual.flushDBOrThrow(); } };
});
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { makeApp, JWT_SECRET } from './helpers';
import { autonomyRoutes } from '../server/routes/autonomy_routes';
import { enqueue, getTaskHistory, persistAutonomousTaskQueue, recoverPersistedTask, resetAutonomousTaskQueueForTest, claimAutonomousTask, registerAutonomousTaskExecutor, releaseAutonomousTaskExecutor, markCancelled } from '../server/autonomy/task_queue';
import { flushDBOrThrow, querySQL, runSQL, closeDatabase, initDatabase } from '../db_layer';

let app: Awaited<ReturnType<typeof makeApp>>;
beforeAll(async () => { app = await makeApp(); app.apiRouter.use('/autonomy', autonomyRoutes()); });
afterEach(async () => { barriers.gate = null; barriers.entered = null; await runSQL('PRAGMA query_only=OFF'); await flushDBOrThrow(); });
afterAll(async () => { await new Promise<void>(resolve => app.server.close(() => resolve())); });

async function fixture() {
  const userId = `audit10-control-${randomUUID()}`;
  const task = enqueue({ userId, title: 'Synthetic offline task', description: 'Inspect a synthetic public fixture.',
    source: 'user_request', domain: 'personal', orgId: '', priority: 5, mode: 'analysis' })!;
  await persistAutonomousTaskQueue();
  const headers = { Authorization: `Bearer ${jwt.sign({ uid: userId, role: 'user' }, JWT_SECRET)}` };
  return { userId, task, headers };
}

it('normal task cancellation is retained after the normal persistence barrier', async () => {
  const f = await fixture();
  const response = await fetch(`${app.url}/api/autonomy/tasks/${f.task.id}/cancel`, { method: 'POST', headers: f.headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'cancelled', cancelled: true });
  await flushDBOrThrow();
  expect(await querySQL('SELECT status FROM autonomous_tasks WHERE id = ?', [f.task.id])).toEqual([{ status: 'cancelled' }]);
  await closeDatabase();
  await initDatabase();
  resetAutonomousTaskQueueForTest();
  expect(getTaskHistory(200, 0, f.userId).find(row => row.id === f.task.id)?.status).toBe('cancelled');
});

it('concurrent cancellation endpoints wait for the save and retry exactly the same retained task', async () => {
  const f = await fixture();
  let release!: () => void;
  barriers.gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const saving = new Promise<void>(resolve => { entered = resolve; });
  barriers.entered = entered;
  let replies = 0;
  const calls = ['tasks', 'work'].map(surface => fetch(`${app.url}/api/autonomy/${surface}/${f.task.id}/cancel`, { method: 'POST', headers: f.headers }).then(response => { replies++; return response; }));
  try {
    await saving;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(replies).toBe(0);
  } finally { barriers.gate = null; release(); }
  for (const response of await Promise.all(calls)) {
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'cancelled', cancelled: true });
  }
  expect(getTaskHistory(200, 0, f.userId).filter(task => task.id === f.task.id)).toHaveLength(1);
});

it('an active executor receives stop but cancellation does not claim physical completion', async () => {
  const f = await fixture();
  const running = claimAutonomousTask(f.task.id, { owner: 'synthetic-owner' })!;
  const stopped = vi.fn();
  expect(registerAutonomousTaskExecutor(running.id, running.leaseId!, stopped)).toBe(true);
  try {
    const response = await fetch(`${app.url}/api/autonomy/tasks/${f.task.id}/cancel`, { method: 'POST', headers: f.headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'running', cancelRequested: true, cancelled: false });
    expect(stopped).toHaveBeenCalledOnce();
    const rows = await querySQL<any>('SELECT payload FROM autonomous_tasks WHERE id = ?', [running.id]);
    expect(JSON.parse(rows[0].payload).cancelRequestedAt).toBeTruthy();
  } finally { markCancelled(running.id); releaseAutonomousTaskExecutor(running.id, running.leaseId!); }
});

it.each(['tasks', 'work'])('%s fails honestly when SQLite is readonly and the same cancellation can be retried', async surface => {
  const f = await fixture();
  await runSQL('PRAGMA query_only=ON');
  const response = await fetch(`${app.url}/api/autonomy/${surface}/${f.task.id}/cancel`, { method: 'POST', headers: f.headers });
  const result = await response.json();
  expect(response.status).toBe(503);
  expect(result).toMatchObject({ code: 'CANCELLATION_PERSISTENCE_PENDING', cancelled: false, retryable: true });
  await expect(flushDBOrThrow()).rejects.toThrow(/readonly/i);
  const rows = await querySQL<any>('SELECT status, payload FROM autonomous_tasks WHERE id = ?', [f.task.id]);
  expect(rows[0].status).toBe('pending');
  expect(getTaskHistory(20, 0, f.userId).find(task => task.id === f.task.id)?.status).toBe('cancelled');
  // Production restart normalization accepts the persisted row as pending;
  // this is not an actual process crash/restart and starts no executor.
  expect(recoverPersistedTask(JSON.parse(rows[0].payload)).status).toBe('pending');
  const retry = await fetch(`${app.url}/api/autonomy/${surface}/${f.task.id}/cancel`, { method: 'POST', headers: f.headers });
  expect(retry.status).toBe(503);
  await runSQL('PRAGMA query_only=OFF');
  const recovered = await fetch(`${app.url}/api/autonomy/${surface}/${f.task.id}/cancel`, { method: 'POST', headers: f.headers });
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({ status: 'cancelled', cancelled: true });
  expect(await querySQL('SELECT status FROM autonomous_tasks WHERE id = ?', [f.task.id])).toEqual([{ status: 'cancelled' }]);
  const wrongOwner = { Authorization: `Bearer ${jwt.sign({ uid: `other-${f.userId}`, role: 'user' }, JWT_SECRET)}` };
  expect((await fetch(`${app.url}/api/autonomy/${surface}/${f.task.id}/cancel`, { method: 'POST', headers: wrongOwner })).status).toBe(404);
});
