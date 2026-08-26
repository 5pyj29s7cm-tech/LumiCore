import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { initDatabase, readDB } from '../db_layer';
import { listBackgroundTasks, registerBackgroundTask, resetBackgroundTasksForTest } from '../server/agents/background_tasks';
import {
  createCommandCenterPlan,
  dispatchDueCommandCenterPlans,
  nextCommandCenterPlanRun,
  runCommandCenterPlan,
} from '../server/command_center/plans';
import { mountCommandCenterPlanRoutes } from '../server/routes/command_center_plan_routes';
import { JWT_SECRET, makeApp } from './helpers';

describe('command center durable plans', () => {
  const userId = `command-center-plan-${Date.now()}`;

  beforeAll(async () => {
    await initDatabase();
  });

  it('computes wall-clock daily, weekly and monthly schedules', () => {
    const now = new Date(2026, 7, 13, 10, 0, 0, 0);
    expect(nextCommandCenterPlanRun({ cadence: 'daily', timeOfDay: '11:00', dayOfWeek: 1, dayOfMonth: 1 }, now))
      .toBe(new Date(2026, 7, 13, 11, 0, 0, 0).toISOString());
    expect(nextCommandCenterPlanRun({ cadence: 'weekly', timeOfDay: '09:00', dayOfWeek: 5, dayOfMonth: 1 }, now))
      .toBe(new Date(2026, 7, 14, 9, 0, 0, 0).toISOString());
    expect(nextCommandCenterPlanRun({ cadence: 'monthly', timeOfDay: '09:00', dayOfWeek: 1, dayOfMonth: 20 }, now))
      .toBe(new Date(2026, 7, 20, 9, 0, 0, 0).toISOString());
  });

  it('binds each run to one background task and one durable action row', () => {
    const plan = createCommandCenterPlan({ userId, domain: 'personal', orgId: '' }, {
      kind: 'daily_task',
      title: 'Daily verified desk review',
      instruction: 'Review active durable tasks and report only verified state.',
      cadence: 'daily',
      timeOfDay: '09:00',
      conversationId: 'conversation-command-center-plan',
    }, new Date('2026-08-13T00:00:00.000Z'));
    const result = runCommandCenterPlan({ id: plan.id, userId, domain: 'personal', orgId: '', manual: true }, new Date('2026-08-13T00:01:00.000Z'));
    expect(result?.task.status).toBe('queued');
    expect(result?.reused).toBe(false);
    expect(result?.task.context?.actionTaskId).toMatch(/^cc_plan_/);
    expect(result?.task.id).toBe(result?.task.context?.actionTaskId);
    const duplicateWindowRun = runCommandCenterPlan({ id: plan.id, userId, domain: 'personal', orgId: '', manual: true }, new Date('2026-08-13T00:01:01.000Z'));
    expect(duplicateWindowRun).toMatchObject({ reused: true, task: { id: result?.task.id, status: 'queued' } });
    const db = readDB();
    expect(db.commandCenterPlans.find((candidate: any) => candidate.id === plan.id)?.lastRuntimeTaskId).toBe(result?.task.id);
    expect(db.conversationActionTasks.find((candidate: any) => candidate.id === result?.task.context?.actionTaskId)).toMatchObject({
      conversationId: 'conversation-command-center-plan',
      status: 'executing',
      activeRequestId: expect.stringContaining(`command-center:${plan.id}:`),
    });
    expect(db.conversationActionTasks.filter((candidate: any) => candidate.id === result?.task.context?.actionTaskId)).toHaveLength(1);
    const storedPlan = db.commandCenterPlans.find((candidate: any) => candidate.id === plan.id);
    storedPlan.status = 'completed';
    storedPlan.nextRunAt = '';
  });

  it('dispatches one due schedule slot and moves its next run forward', () => {
    const plan = createCommandCenterPlan({ userId, domain: 'personal', orgId: '' }, {
      kind: 'periodic_report',
      title: 'Weekly receipt report',
      instruction: 'Summarize verified work.',
      cadence: 'weekly',
      timeOfDay: '09:00',
      dayOfWeek: 4,
    }, new Date('2026-08-12T00:00:00.000Z'));
    const db = readDB();
    const stored = db.commandCenterPlans.find((candidate: any) => candidate.id === plan.id);
    stored.nextRunAt = '2026-08-13T01:00:00.000Z';

    expect(dispatchDueCommandCenterPlans(new Date('2026-08-13T01:01:00.000Z'))).toBe(1);
    expect(dispatchDueCommandCenterPlans(new Date('2026-08-13T01:01:30.000Z'))).toBe(0);
    expect(new Date(stored.nextRunAt).getTime()).toBeGreaterThan(new Date('2026-08-13T01:01:30.000Z').getTime());
    const dispatchedTask = listBackgroundTasks(userId)
      .find(candidate => candidate.id === stored.lastRuntimeTaskId);
    expect(dispatchedTask).toMatchObject({
      id: dispatchedTask?.context?.actionTaskId,
      context: {
        conversationId: `command-center-plan:${plan.id}`,
        actionTaskId: dispatchedTask?.id,
      },
    });
    expect(readDB().conversationActionTasks.find((candidate: any) => candidate.id === dispatchedTask?.id))
      .toMatchObject({ conversationId: `command-center-plan:${plan.id}` });
  });

  it('returns the existing active manual run across repeated HTTP requests', async () => {
    resetBackgroundTasksForTest({ markHydrated: true });
    const routeUser = `command-center-route-${Date.now()}`;
    const plan = createCommandCenterPlan({ userId: routeUser, domain: 'personal', orgId: '' }, {
      kind: 'daily_task',
      title: 'One active run only',
      instruction: 'Do not dispatch a duplicate while the first run is active.',
      cadence: 'none',
    });
    const fixture = await makeApp();
    mountCommandCenterPlanRoutes(fixture.apiRouter);
    const token = jwt.sign({ uid: routeUser, username: routeUser, role: 'user' }, JWT_SECRET);
    const request = () => fetch(`${fixture.url}/api/command-center/plans/${plan.id}/run`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    try {
      const first = await request();
      const firstPayload = await first.json() as any;
      expect(first.status).toBe(202);
      expect(firstPayload).toMatchObject({ reused: false, task: { status: 'queued' } });

      const second = await request();
      const secondPayload = await second.json() as any;
      expect(second.status).toBe(200);
      expect(secondPayload).toMatchObject({ reused: true, task: { id: firstPayload.task.id, status: 'queued' } });
    } finally {
      fixture.cleanup();
    }
  });

  it('reuses a plan-scoped active run even if a retry occurs before the plan row records its task id', () => {
    resetBackgroundTasksForTest({ markHydrated: true });
    const retryUser = `command-center-retry-${Date.now()}`;
    const plan = createCommandCenterPlan({ userId: retryUser, domain: 'work', orgId: 'org-retry' }, {
      kind: 'long_term_goal',
      title: 'Recover interrupted dispatch',
      instruction: 'Continue the active plan run without duplicating it.',
      cadence: 'none',
    });
    const storedBeforeRetry = readDB().commandCenterPlans.find((candidate: any) => candidate.id === plan.id);
    storedBeforeRetry.lastRunAt = '2026-08-01T00:00:00.000Z';
    const existing = registerBackgroundTask({
      userId: retryUser,
      title: plan.title,
      prompt: plan.instruction,
      idempotencyKey: `command-center-plan:${plan.id}:interrupted-window`,
      context: { domain: 'work', orgId: 'org-retry' },
    });

    const retried = runCommandCenterPlan({
      id: plan.id,
      userId: retryUser,
      domain: 'work',
      orgId: 'org-retry',
      manual: true,
    });

    expect(retried).toMatchObject({ reused: true, task: { id: existing.id, status: 'queued' } });
    expect(retried?.plan.lastRuntimeTaskId).toBe(existing.id);
    expect(readDB().commandCenterPlans.find((candidate: any) => candidate.id === plan.id)).toMatchObject({
      lastRuntimeTaskId: existing.id,
      lastRunAt: existing.createdAt,
    });
  });
});
