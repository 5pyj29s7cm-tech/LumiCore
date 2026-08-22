import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase, readDB } from '../db_layer';
import {
  createCommandCenterPlan,
  dispatchDueCommandCenterPlans,
  nextCommandCenterPlanRun,
  runCommandCenterPlan,
} from '../server/command_center/plans';

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
    expect(result?.task.context?.actionTaskId).toMatch(/^cc_plan_/);
    const db = readDB();
    expect(db.commandCenterPlans.find((candidate: any) => candidate.id === plan.id)?.lastRuntimeTaskId).toBe(result?.task.id);
    expect(db.conversationActionTasks.find((candidate: any) => candidate.id === result?.task.context?.actionTaskId)).toMatchObject({
      conversationId: 'conversation-command-center-plan',
      status: 'executing',
      activeRequestId: expect.stringContaining(`command-center:${plan.id}:`),
    });
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
  });
});
