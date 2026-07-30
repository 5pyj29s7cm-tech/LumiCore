import './helpers';
import { describe, expect, it } from 'vitest';
import {
  cancelTask,
  checkpointAutonomousTask,
  claimAutonomousTask,
  enqueue,
  getTaskQueue,
  isTaskCancellationRequested,
  markCancelled,
  markRunning,
  requestPauseAutonomousTask,
  recoverPersistedTask,
  resetAutonomousTaskQueueForTest,
  resumeAutonomousTask,
} from '../server/autonomy/task_queue';

describe('Autonomous task queue isolation', () => {
  it('enforces one lease and supports checkpointed pause/resume', () => {
    resetAutonomousTaskQueueForTest({ markHydrated: true });
    const userId = `queue-lease-${Date.now()}`;
    const task = enqueue({ userId, title: 'Leased', description: 'Leased', source: 'user_request', priority: 5, mode: 'analysis' })!;
    const claimed = claimAutonomousTask(task.id, { leaseId: 'autonomy-lease-a', owner: 'worker-a' })!;
    expect(claimed).toMatchObject({ status: 'running', leaseId: 'autonomy-lease-a', attempt: 1 });
    expect(claimAutonomousTask(task.id, { leaseId: 'autonomy-lease-b' })).toBeNull();
    expect(checkpointAutonomousTask(task.id, { phase: 'tool_loop', iteration: 2 }, claimed.leaseId)?.checkpoint)
      .toMatchObject({ phase: 'tool_loop', iteration: 2 });
    expect(requestPauseAutonomousTask(task.id, userId)?.status).toBe('pausing');
    const recovered = recoverPersistedTask(getTaskQueue(userId)[0], '2026-07-30T00:00:00.000Z');
    expect(recovered.status).toBe('paused');
    resetAutonomousTaskQueueForTest({ markHydrated: true });
    const pending = enqueue({ userId, title: 'Pending pause', description: 'Pending pause', source: 'user_request', priority: 5, mode: 'analysis' })!;
    expect(requestPauseAutonomousTask(pending.id, userId)?.status).toBe('paused');
    expect(resumeAutonomousTask(pending.id, userId)?.status).toBe('pending');
  });

  it('lists and cancels tasks only for the owning user', () => {
    const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const userA = `queue-a-${suffix}`;
    const userB = `queue-b-${suffix}`;
    const taskA = enqueue({ userId: userA, title: 'A', description: 'A', source: 'user_request', priority: 5, mode: 'analysis' });
    const taskB = enqueue({ userId: userB, title: 'B', description: 'B', source: 'user_request', priority: 5, mode: 'analysis' });
    expect(taskA).not.toBeNull();
    expect(taskB).not.toBeNull();

    expect(getTaskQueue(userA).map(task => task.userId)).toEqual([userA]);
    expect(getTaskQueue(userB).map(task => task.userId)).toEqual([userB]);
    expect(cancelTask(taskB!.id, userA)).toBe(false);
    expect(cancelTask(taskB!.id, userB)).toBe(true);
    expect(cancelTask(taskA!.id, userA)).toBe(true);
  });

  it('requests cancellation for running work until the executor acknowledges it', () => {
    const userId = `queue-running-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const task = enqueue({ userId, title: 'Running', description: 'Running', source: 'user_request', priority: 5, mode: 'analysis' });
    expect(markRunning(task!.id)?.status).toBe('running');
    expect(cancelTask(task!.id, userId)).toBe(true);
    expect(isTaskCancellationRequested(task!.id, userId)).toBe(true);
    expect(getTaskQueue(userId)[0]).toMatchObject({ status: 'running' });
    expect(markCancelled(task!.id)?.status).toBe('cancelled');
    expect(getTaskQueue(userId)).toEqual([]);
  });

  it('recovers interrupted work without keeping a stale running lock', () => {
    const base = {
      id: 'recover-me', userId: 'owner', title: 'Task', description: 'Task',
      status: 'running' as const, source: 'scheduler' as const, priority: 5,
      mode: 'analysis' as const, createdAt: '2026-01-01T00:00:00.000Z',
      startedAt: '2026-01-01T00:01:00.000Z',
    };
    expect(recoverPersistedTask(base, '2026-01-01T00:02:00.000Z')).toMatchObject({
      status: 'pending',
      startedAt: undefined,
      recoveryCount: 1,
      lastRecoveredAt: '2026-01-01T00:02:00.000Z',
    });
    expect(recoverPersistedTask({ ...base, cancelRequestedAt: '2026-01-01T00:01:30.000Z' }, '2026-01-01T00:02:00.000Z')).toMatchObject({
      status: 'cancelled',
      completedAt: '2026-01-01T00:02:00.000Z',
    });
  });
});
