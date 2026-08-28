import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import {
  enqueue,
  markRunning,
  resetAutonomousTaskQueueForTest,
  type AutonomousTask,
} from '../server/autonomy/task_queue';
import {
  autonomyRoutes,
  autonomousTaskMatchesScope,
  projectAutonomousTask,
  runtimeControlHttpOutcome,
  runtimeControlSucceeded,
} from '../server/routes/autonomy_routes';
import { JWT_SECRET, makeApp } from './helpers';
import {
  buildLumiCoreOrbitTasks,
  commandCenterTaskIsActive,
  normalizeCommandCenterTask,
} from '../src/components/CommandCenterPanel';
import { isCurrentScopeRequest } from '../src/components/scopeRequestGuard';

const source = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

function autonomousTask(overrides: Partial<AutonomousTask> = {}): AutonomousTask {
  return {
    id: 'autonomy-1',
    userId: 'owner',
    title: 'Continue the durable task',
    description: 'Use verified receipts and report blockers.',
    status: 'running',
    source: 'user_request',
    priority: 5,
    mode: 'analysis',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:01:00.000Z',
    leaseId: 'private-lease',
    executionPlan: { private: true } as never,
    ...overrides,
  };
}

describe('autonomy route safe projections', () => {
  it('keeps autonomous work inside the supported personal scope', () => {
    const personal = autonomousTask();
    const work = autonomousTask({ domain: 'work', orgId: 'org-a' } as Partial<AutonomousTask>);
    const malformedWork = autonomousTask({ domain: 'work' } as Partial<AutonomousTask>);

    expect(autonomousTaskMatchesScope(personal, { domain: 'personal', orgId: '' })).toBe(true);
    expect(autonomousTaskMatchesScope(personal, { domain: 'work', orgId: 'org-a' })).toBe(false);
    expect(autonomousTaskMatchesScope(work, { domain: 'work', orgId: 'org-a' })).toBe(true);
    expect(autonomousTaskMatchesScope(work, { domain: 'work', orgId: 'org-b' })).toBe(false);
    expect(autonomousTaskMatchesScope(malformedWork, { domain: 'personal', orgId: '' })).toBe(false);
  });

  it('omits prompts, plans, leases, and raw failure details', () => {
    const projection = projectAutonomousTask(autonomousTask({
      title: 'Review password=autonomy-title-secret',
      description: 'private prompt with api_key=private-value',
      status: 'failed',
      error: 'authorization: Bearer autonomy-reason-secret',
    }));

    expect(projection).toMatchObject({
      id: 'autonomy-1',
      kind: 'autonomy',
      status: 'failed',
      controls: { canPause: false, canResume: false, canCancel: false },
    });
    for (const privateField of ['userId', 'description', 'executionPlan', 'leaseId', 'terminalReceipt']) {
      expect(projection).not.toHaveProperty(privateField);
    }
    const payload = JSON.stringify(projection);
    expect(payload).not.toContain('autonomy-title-secret');
    expect(payload).not.toContain('autonomy-reason-secret');
    expect(payload).not.toContain('private-value');
    expect(payload).toContain('[redacted]');
    expect(projection.completionFeedback.blockers.join(' ')).toContain('local runtime logs');
  });

  it('projects a running cancellation request honestly', () => {
    const task = autonomousTask({ cancelRequestedAt: '2026-08-26T00:01:30.000Z' });
    expect(projectAutonomousTask(task)).toMatchObject({ status: 'running', cancelRequested: true });
  });

  it('does not project autonomous prompts or takeover action instructions', () => {
    const privatePrompt = 'private autonomous prompt with password=do-not-project';
    const projection = projectAutonomousTask(autonomousTask({ description: privatePrompt }));
    expect(projection).not.toHaveProperty('description');
    expect(JSON.stringify(projection)).not.toContain('do-not-project');

    const workControl = source('server/runtime/work_control.ts');
    expect(workControl).not.toContain('bounded(task.nextActions[task.currentActionIndex]');
    expect(workControl).toContain("'continue_current_action'");
  });
});

describe('task-center control wiring', () => {
  it('normalizes one LumiCore task and projects it into the orbit', () => {
    const task = normalizeCommandCenterTask({
      id: 'orbit-1',
      kind: 'autonomy',
      title: 'Verify the report',
      status: 'running',
      phase: 'verify',
      toolCallsCount: 4,
      progress: { checkpoint: 'verify', completedUnits: 1, totalUnits: 2, receiptCount: 1, toolCallCount: 4 },
      controls: { canPause: true, canResume: false, canCancel: true },
    });
    expect(task).not.toBeNull();
    expect(buildLumiCoreOrbitTasks([task!])).toEqual([
      expect.objectContaining({ id: 'orbit-1', title: 'Verify the report', state: 'working', active: true }),
    ]);
  });

  it('keeps a running task active even when its checkpoint phase is domain-specific', () => {
    expect(commandCenterTaskIsActive({ id: 'active-1', title: 'Active', status: 'running', phase: 'verify' })).toBe(true);
    expect(commandCenterTaskIsActive({ id: 'terminal-1', title: 'Done', status: 'completed', phase: 'complete' })).toBe(false);
  });

  it('rejects responses from an earlier generation or another scope', () => {
    const personalRequest = { scopeKey: 'personal:', generation: 3 };
    expect(isCurrentScopeRequest(personalRequest, 'personal:', 3)).toBe(true);
    expect(isCurrentScopeRequest(personalRequest, 'personal:', 4)).toBe(false);
    expect(isCurrentScopeRequest(personalRequest, 'work:org-a', 3)).toBe(false);
  });

  it('does not treat a lost race or partial runtime control as success', () => {
    expect(runtimeControlSucceeded({ ok: true, matchedCount: 1 })).toBe(true);
    expect(runtimeControlSucceeded({ ok: true, matchedCount: 0 })).toBe(false);
    expect(runtimeControlSucceeded({ ok: false, matchedCount: 1 })).toBe(false);
    expect(runtimeControlSucceeded({ ok: true, matchedCount: 1, status: 'partial', failedCount: 1 })).toBe(false);
    expect(runtimeControlHttpOutcome('pause', {
      ok: false,
      matchedCount: 2,
      status: 'partial',
      failedCount: 1,
    })).toMatchObject({ accepted: false, httpStatus: 409, error: expect.stringContaining('(partial)') });
    expect(runtimeControlHttpOutcome('resume', {
      ok: true,
      matchedCount: 1,
      status: 'resumed',
      failedCount: 0,
    })).toEqual({ accepted: true, httpStatus: 200 });
  });

  it('uses one canonical LumiCore task projection', () => {
    const panel = source('src/components/CommandCenterPanel.tsx');
    const planner = source('src/components/CommandCenterPlanner.tsx');
    const autonomousFeed = source('src/components/AutonomousFeed.tsx');

    expect(panel).toContain("apiFetch('/api/autonomy/work')");
    expect(panel).toContain('tasks.filter(commandCenterTaskIsActive)');
    expect(panel).toContain('data-command-center-task-controls');
    expect(panel).toContain('data-task-cancel-requested');
    expect(planner).toContain('data-command-center-plan-run-status');
    expect(planner).toContain('runningPlanIdsRef.current.has(plan.id)');
    expect(autonomousFeed).toContain("apiFetch('/api/autonomy/queue')");
    expect(autonomousFeed).toContain('data-autonomous-cancel-requested');
  });

  it('reports cancellation requests without claiming a running task is already cancelled', async () => {
    resetAutonomousTaskQueueForTest({ markHydrated: true });
    const controllable = enqueue({
      userId: 'owner',
      title: 'Controllable task',
      description: 'execute',
      source: 'user_request',
      priority: 5,
      mode: 'analysis',
    })!;
    const running = enqueue({
      userId: 'owner',
      title: 'Running autonomy',
      description: 'execute',
      source: 'user_request',
      priority: 5,
      mode: 'analysis',
    })!;
    expect(markRunning(running.id)?.status).toBe('running');

    const fixture = await makeApp();
    fixture.apiRouter.use('/autonomy', autonomyRoutes());
    const token = jwt.sign({ uid: 'owner', username: 'owner', role: 'user' }, JWT_SECRET);
    const headers = { Authorization: `Bearer ${token}` };
    try {
      const workResponse = await fetch(`${fixture.url}/api/autonomy/work`, { headers });
      const workPayload = await workResponse.json() as any;
      expect(workResponse.status).toBe(200);
      expect(workPayload.items.find((item: any) => item.id === controllable.id)).toMatchObject({
        phase: 'queued',
        controls: { canPause: true, canResume: false, canCancel: true },
      });

      const pauseResponse = await fetch(`${fixture.url}/api/autonomy/work/${controllable.id}/pause`, { method: 'POST', headers });
      expect(await pauseResponse.json()).toMatchObject({ status: 'paused', items: [{ id: controllable.id, phase: 'paused' }] });
      const resumeResponse = await fetch(`${fixture.url}/api/autonomy/work/${controllable.id}/resume`, { method: 'POST', headers });
      expect(await resumeResponse.json()).toMatchObject({ status: 'resumed', items: [{ id: controllable.id, phase: 'queued' }] });

      const runningResponse = await fetch(`${fixture.url}/api/autonomy/tasks/${running.id}/cancel`, { method: 'POST', headers });
      const runningPayload = await runningResponse.json() as any;
      expect(runningResponse.status).toBe(200);
      expect(runningPayload).toMatchObject({ status: 'running', cancelRequested: true, cancelled: false });
    } finally {
      fixture.cleanup();
    }
  });
});
