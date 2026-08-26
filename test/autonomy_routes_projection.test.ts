import './helpers';
import fs from 'node:fs';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import {
  claimBackgroundTask,
  registerBackgroundTask,
  resetBackgroundTasksForTest,
  type BackgroundDelegationTask,
} from '../server/agents/background_tasks';
import {
  enqueue,
  markRunning,
  resetAutonomousTaskQueueForTest,
  type AutonomousTask,
} from '../server/autonomy/task_queue';
import {
  autonomyRoutes,
  autonomousTaskMatchesScope,
  backgroundTaskMatchesScope,
  projectAutonomousTask,
  projectBackgroundTask,
  runtimeControlHttpOutcome,
  runtimeControlSucceeded,
} from '../server/routes/autonomy_routes';
import { JWT_SECRET, makeApp } from './helpers';
import {
  commandCenterTaskIsActive,
  mergeCommandCenterTasks,
  normalizeCommandCenterTask,
} from '../src/components/CommandCenterPanel';
import { isCurrentScopeRequest } from '../src/components/scopeRequestGuard';

const source = (relativePath: string) => fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');

function backgroundTask(overrides: Partial<BackgroundDelegationTask> = {}): BackgroundDelegationTask {
  return {
    id: 'background-1',
    userId: 'owner',
    title: 'Deliver the verified report',
    prompt: 'private raw prompt',
    status: 'running',
    workers: [{ id: 'worker-1', name: 'Researcher' }],
    workerNames: ['Researcher'],
    context: { domain: 'personal', provider: 'private-provider', toolPolicy: { allowedTools: ['secret-tool'], requireConfirmation: [], forbiddenTools: [], maxIterations: 4 } },
    checkpoint: { phase: 'verify', completedNodeIds: ['research'], receiptIds: ['receipt-1'], updatedAt: '2026-08-26T00:01:00.000Z' },
    idempotencyKey: 'private-idempotency-key',
    toolCallsCount: 2,
    cancelRequested: false,
    pauseRequested: false,
    attempt: 1,
    recoveryCount: 0,
    leaseId: 'private-lease',
    leaseOwner: 'private-worker',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:01:00.000Z',
    ...overrides,
  };
}

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
  it('keeps background work inside the active personal or exact organization scope', () => {
    const personal = backgroundTask();
    const workA = backgroundTask({ context: { domain: 'work', orgId: 'org-a' } });
    const malformedWork = backgroundTask({ context: { domain: 'work' } });

    expect(backgroundTaskMatchesScope(personal, { domain: 'personal', orgId: '' })).toBe(true);
    expect(backgroundTaskMatchesScope(personal, { domain: 'work', orgId: 'org-a' })).toBe(false);
    expect(backgroundTaskMatchesScope(workA, { domain: 'work', orgId: 'org-a' })).toBe(true);
    expect(backgroundTaskMatchesScope(workA, { domain: 'work', orgId: 'org-b' })).toBe(false);
    expect(backgroundTaskMatchesScope(workA, { domain: 'work', orgId: '' })).toBe(false);
    expect(backgroundTaskMatchesScope(malformedWork, { domain: 'personal', orgId: '' })).toBe(false);
    expect(backgroundTaskMatchesScope(malformedWork, { domain: 'work', orgId: '' })).toBe(false);
  });

  it('returns only task-center fields and omits raw prompts, policies, leases and receipts', () => {
    const projection = projectBackgroundTask(backgroundTask({
      resultPreview: 'Saved with api_key=private-value and Bearer abcdefghijk',
      error: 'authorization: Bearer abcdefghijklmnop',
    }));

    expect(projection).toMatchObject({
      id: 'background-1',
      kind: 'delegation',
      status: 'running',
      phase: 'verify',
      cancelRequested: false,
      controls: { canPause: true, canResume: false, canCancel: true },
    });
    for (const privateField of ['userId', 'prompt', 'context', 'idempotencyKey', 'leaseId', 'leaseOwner', 'terminalReceipt']) {
      expect(projection).not.toHaveProperty(privateField);
    }
    expect(projection.resultPreview).toBe('Saved with api_key=[redacted] and Bearer [redacted]');
    expect(projection.error).toContain('local runtime logs');
    expect(JSON.stringify(projection)).not.toContain('abcdefghijk');
  });

  it('strongly redacts titles and every completion-feedback reason field', () => {
    const backgroundProjection = projectBackgroundTask(backgroundTask({
      title: 'Deploy api_key=sk-background-title-secret',
      status: 'failed',
      error: 'authorization: Bearer background-secret-value',
    }));
    const autonomousProjection = projectAutonomousTask(autonomousTask({
      title: 'Review password=autonomy-title-secret',
      status: 'failed',
      error: 'client_secret=autonomy-reason-secret',
    }));

    const payload = JSON.stringify({ backgroundProjection, autonomousProjection });
    for (const secret of [
      'sk-background-title-secret',
      'background-secret-value',
      'autonomy-title-secret',
      'autonomy-reason-secret',
    ]) {
      expect(payload).not.toContain(secret);
    }
    expect(payload).toContain('[redacted]');
    expect(backgroundProjection.completionFeedback.blockers.join(' ')).toContain('local runtime logs');
    expect(autonomousProjection.completionFeedback.blockers.join(' ')).toContain('local runtime logs');
  });

  it('treats the current autonomous executor as personal-only and projects cancellation honestly', () => {
    const task = autonomousTask({ cancelRequestedAt: '2026-08-26T00:01:30.000Z' });
    expect(autonomousTaskMatchesScope(task, { domain: 'personal', orgId: '' })).toBe(true);
    expect(autonomousTaskMatchesScope(task, { domain: 'work', orgId: 'org-a' })).toBe(false);

    const projection = projectAutonomousTask(task);
    expect(projection).toMatchObject({ status: 'running', cancelRequested: true });
    expect(projection).not.toHaveProperty('description');
    expect(projection).not.toHaveProperty('executionPlan');
    expect(projection).not.toHaveProperty('leaseId');
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
  it('preserves detailed task evidence when canonical work only supplies control fields', () => {
    const detailed = normalizeCommandCenterTask({
      id: 'merge-1',
      kind: 'delegation',
      title: 'Overall task',
      status: 'running',
      workerNames: ['Worker A'],
      toolCallsCount: 4,
      resultPreview: 'draft ready',
      error: 'verification pending',
      completionFeedback: { status: 'working', evidence: ['receipt:1'] },
    })!;
    const canonical = normalizeCommandCenterTask({
      id: 'merge-1',
      kind: 'delegation',
      title: 'Overall task',
      status: 'running',
      phase: 'working',
      progress: { checkpoint: 'verify', completedUnits: 1, totalUnits: 2, receiptCount: 1, toolCallCount: 7 },
      controls: { canPause: true, canResume: false, canCancel: true },
    })!;

    expect(mergeCommandCenterTasks(detailed, canonical)).toMatchObject({
      workerNames: ['Worker A'],
      toolCallsCount: 7,
      resultPreview: 'draft ready',
      error: 'verification pending',
      completionFeedback: { status: 'working', evidence: ['receipt:1'] },
      progress: { checkpoint: 'verify', completedUnits: 1, totalUnits: 2 },
    });
  });

  it('keeps a running task active even when its checkpoint phase is domain-specific', () => {
    expect(commandCenterTaskIsActive({ id: 'active-1', status: 'running', phase: 'wave_completed' })).toBe(true);
    expect(commandCenterTaskIsActive({ id: 'terminal-1', status: 'completed', phase: 'arbitrated' })).toBe(false);
  });

  it('rejects responses from an earlier generation or another scope', () => {
    const personalRequest = { scopeKey: 'personal:', generation: 3 };
    expect(isCurrentScopeRequest(personalRequest, 'personal:', 3)).toBe(true);
    expect(isCurrentScopeRequest(personalRequest, 'personal:', 4)).toBe(false);
    expect(isCurrentScopeRequest(personalRequest, 'work:org-a', 3)).toBe(false);
  });

  it('does not treat a lost-race or partial runtime control as success', () => {
    expect(runtimeControlSucceeded({ ok: true, matchedCount: 1 })).toBe(true);
    expect(runtimeControlSucceeded({ ok: true, matchedCount: 0 })).toBe(false);
    expect(runtimeControlSucceeded({ ok: false, matchedCount: 1 })).toBe(false);
    expect(runtimeControlSucceeded({ ok: true, matchedCount: 1, status: 'partial', failedCount: 1 })).toBe(false);
    expect(runtimeControlSucceeded({ ok: true, matchedCount: 1, status: 'failed' })).toBe(false);
    expect(runtimeControlHttpOutcome('pause', {
      ok: false,
      matchedCount: 2,
      status: 'partial',
      failedCount: 1,
    })).toMatchObject({
      accepted: false,
      httpStatus: 409,
      error: expect.stringContaining('(partial)'),
    });
    expect(runtimeControlHttpOutcome('resume', {
      ok: true,
      matchedCount: 1,
      status: 'resumed',
      failedCount: 0,
    })).toEqual({ accepted: true, httpStatus: 200 });
  });

  it('uses canonical runtime controls and separates plan state from latest run state', () => {
    const panel = source('src/components/CommandCenterPanel.tsx');
    const planner = source('src/components/CommandCenterPlanner.tsx');
    const autonomousFeed = source('src/components/AutonomousFeed.tsx');

    expect(panel).toContain("apiFetch('/api/autonomy/work')");
    expect(panel).toContain('backgroundTasks.filter(commandCenterTaskIsActive)');
    expect(panel).toContain('data-command-center-task-controls');
    expect(panel).toContain('data-task-cancel-requested');
    expect(planner).toContain('data-command-center-plan-run-status');
    expect(planner).toContain('runningPlanIdsRef.current.has(plan.id)');
    expect(planner).not.toContain('const status = task?.status || plan.status');
    expect(autonomousFeed).toContain("const returnedStatus = String(data.status || data.task?.status || task.status)");
    expect(autonomousFeed).toContain('if (!socket || isWork) return');
    expect(autonomousFeed).toContain("apiFetch('/api/autonomy/queue')");
    expect(autonomousFeed).toContain('data-autonomous-cancel-requested');
    expect(autonomousFeed).not.toContain("const cancelledTask = { ...task, status: 'cancelled' as const");
  });

  it('reports cancellation requests without claiming a running task is already cancelled', async () => {
    resetBackgroundTasksForTest({ markHydrated: true });
    resetAutonomousTaskQueueForTest({ markHydrated: true });
    const background = registerBackgroundTask({
      userId: 'owner',
      title: 'Running delegation',
      prompt: 'execute',
      context: { domain: 'personal' },
    });
    expect(claimBackgroundTask(background.id)?.status).toBe('running');
    const controllable = registerBackgroundTask({
      userId: 'owner',
      title: 'Controllable delegation',
      prompt: 'execute',
      context: { domain: 'personal' },
    });
    const autonomous = enqueue({
      userId: 'owner',
      title: 'Running autonomy',
      description: 'execute',
      source: 'user_request',
      priority: 5,
      mode: 'analysis',
    })!;
    expect(markRunning(autonomous.id)?.status).toBe('running');

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
      const cancelResponse = await fetch(`${fixture.url}/api/autonomy/work/${controllable.id}/cancel`, { method: 'POST', headers });
      expect(await cancelResponse.json()).toMatchObject({ status: 'cancelled', cancelRequested: true, cancelled: true });

      const backgroundResponse = await fetch(`${fixture.url}/api/autonomy/background-tasks/${background.id}/cancel`, { method: 'POST', headers });
      const backgroundPayload = await backgroundResponse.json() as any;
      expect(backgroundResponse.status).toBe(200);
      expect(backgroundPayload).toMatchObject({ status: 'cancelling', cancelRequested: true, cancelled: false });

      const autonomousResponse = await fetch(`${fixture.url}/api/autonomy/tasks/${autonomous.id}/cancel`, { method: 'POST', headers });
      const autonomousPayload = await autonomousResponse.json() as any;
      expect(autonomousResponse.status).toBe(200);
      expect(autonomousPayload).toMatchObject({ status: 'running', cancelRequested: true, cancelled: false });
    } finally {
      fixture.cleanup();
    }
  });
});
