import { makeApp, JWT_SECRET } from './helpers';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as database from '../db_layer';
import { autonomyRoutes } from '../server/routes/autonomy_routes';
import { mountCommandCenterPlanRoutes } from '../server/routes/command_center_plan_routes';
import { mountConversationRoutes } from '../server/routes/conversations';
import { mountPlanRoutes } from '../server/routes/plan_explore_routes';
import { enqueue, requestPauseAutonomousTask, resetAutonomousTaskQueueForTest } from '../server/autonomy/task_queue';
import { createCommandCenterPlan } from '../server/command_center/plans';
import { createPlan } from '../server/autonomy/planner';
import { startIsolatedConversation } from '../server/conversation/manager';
import { addMember, createOrg, removeMember } from '../server/org/db';

describe('task, plan, and conversation save acknowledgments', () => {
  let app: Awaited<ReturnType<typeof makeApp>>;
  const uid = 'synthetic-durable-control-owner';
  const scope = { userId: uid, domain: 'personal' as const, orgId: '' };
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ uid, username: uid }, JWT_SECRET)}` };
  beforeAll(async () => {
    app = await makeApp();
    app.apiRouter.use('/autonomy', autonomyRoutes());
    mountCommandCenterPlanRoutes(app.apiRouter);
    mountConversationRoutes(app.apiRouter, JWT_SECRET);
    mountPlanRoutes(app.apiRouter);
  });
  afterAll(() => app.cleanup());
  afterEach(() => {
    vi.restoreAllMocks();
    resetAutonomousTaskQueueForTest({ markHydrated: true });
  });

  const operations = [
    'gate', 'work-pause', 'work-resume', 'task-pause', 'task-resume',
    'command-new', 'command-update', 'command-delete',
    'conversation-new', 'conversation-activate', 'conversation-close',
    'plan-new', 'plan-update', 'plan-step', 'plan-delete',
  ] as const;

  it.each(operations)('%s reports pending instead of success when persistence fails', async operation => {
    let route = '';
    let method = 'POST';
    let body: Record<string, unknown> = {};
    let retryable = true;
    if (operation === 'gate') {
      route = '/autonomy/gate_config'; method = 'PUT'; body = { enabled: true };
    } else if (operation.startsWith('work-') || operation.startsWith('task-')) {
      const task = enqueue({ userId: uid, title: 'Synthetic queued work', description: 'No executor is started.', source: 'user_request', priority: 5, mode: 'analysis' })!;
      const action = operation.endsWith('resume') ? 'resume' : 'pause';
      if (action === 'resume') requestPauseAutonomousTask(task.id, uid);
      route = `/autonomy/${operation.startsWith('work-') ? 'work' : 'tasks'}/${task.id}/${action}`;
      retryable = false;
    } else if (operation.startsWith('command-')) {
      const input = { title: 'Synthetic schedule', instruction: 'Synthetic instruction', cadence: 'none' };
      route = '/command-center/plans'; body = input;
      if (operation !== 'command-new') {
        const plan = createCommandCenterPlan(scope, input);
        route += `/${plan.id}`;
        method = operation === 'command-delete' ? 'DELETE' : 'PUT';
        body = { title: 'Updated synthetic schedule' };
      }
      retryable = operation === 'command-update';
    } else if (operation.startsWith('conversation-')) {
      route = '/conversations/new'; body = { agentId: 'lumi', activation: 'isolated' };
      if (operation !== 'conversation-new') {
        const conversation = startIsolatedConversation(uid, 'lumi', 'personal', '');
        route = `/conversations/${conversation.id}/${operation.endsWith('activate') ? 'activate' : 'close'}`;
      }
      retryable = operation !== 'conversation-new';
    } else {
      route = '/plans'; body = { title: 'Synthetic plan', steps: [{ title: 'Synthetic step' }] };
      if (operation !== 'plan-new') {
        const plan = createPlan('Synthetic plan', '', scope, 'user', 'medium', [{ title: 'Synthetic step' }]);
        route += `/${plan.id}`;
        method = operation === 'plan-delete' ? 'DELETE' : 'PUT';
        body = { title: 'Updated synthetic plan' };
        if (operation === 'plan-step') {
          route += `/steps/${plan.steps[0].id}`;
          body = { status: 'done' };
        }
      }
      retryable = operation === 'plan-update' || operation === 'plan-step';
    }
    const flush = vi.spyOn(database, 'flushDBOrThrow').mockRejectedValueOnce(new Error('Synthetic storage write failed'));
    const response = await fetch(`${app.url}/api${route}`, { method, headers, body: JSON.stringify(body) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE', persistence: 'pending', retryable });
    expect(flush).toHaveBeenCalled();
  });

  it('does not publish the saved work plan after membership is revoked during the save barrier', async () => {
    const org = createOrg('Synthetic pending authorization', 'synthetic-pending-authorization', uid);
    addMember(org.id, uid, 'owner');
    let release!: () => void;
    vi.spyOn(database, 'flushDBOrThrow').mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const responsePromise = fetch(`${app.url}/api/command-center/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ uid, username: uid, orgId: org.id, orgRole: 'owner' }, JWT_SECRET)}` },
      body: JSON.stringify({ title: 'Synthetic private plan', instruction: 'Synthetic private plan text', cadence: 'none' }),
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    removeMember(org.id, uid);
    release();
    const response = await responsePromise;
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty('plan');
  });
});
