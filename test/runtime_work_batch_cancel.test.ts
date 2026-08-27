import './helpers';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import {
  registerBackgroundTask,
  resetBackgroundTasksForTest,
} from '../server/agents/background_tasks';
import {
  cancelRuntimeWork,
  getRuntimeWorkSnapshot,
} from '../server/runtime/work_control';

describe('runtime work exact batch cancellation', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  afterEach(() => {
    resetBackgroundTasksForTest({ markHydrated: true });
  });

  it('treats an explicit empty target set as cancel-zero, never cancel-all', () => {
    resetBackgroundTasksForTest({ markHydrated: true });
    const userId = `runtime-empty-batch-${Date.now()}-${Math.random()}`;
    const task = registerBackgroundTask({
      userId,
      title: 'must remain queued',
      prompt: 'isolated',
      context: { domain: 'personal' },
    });
    expect(cancelRuntimeWork({
      userId,
      taskIds: [],
      scope: { domain: 'personal' },
    })).toMatchObject({
      ok: true,
      status: 'idle',
      requestedTaskIds: [],
      matchedCount: 0,
      cancelledCount: 0,
      targetResults: [],
    });
    expect(getRuntimeWorkSnapshot(userId, ['delegation'], { domain: 'personal' }).items)
      .toEqual([expect.objectContaining({ id: task.id, phase: 'queued' })]);
  });

  it('returns per-target cancelled/not_found/already_terminal facts without repeating success', () => {
    resetBackgroundTasksForTest({ markHydrated: true });
    const userId = `runtime-exact-batch-${Date.now()}-${Math.random()}`;
    const selected = registerBackgroundTask({
      userId,
      title: 'selected',
      prompt: 'isolated',
      context: { domain: 'personal' },
    });
    const unselected = registerBackgroundTask({
      userId,
      title: 'unselected',
      prompt: 'must remain queued',
      context: { domain: 'personal' },
    });
    const missing = 'missing-runtime-task';
    expect(cancelRuntimeWork({
      userId,
      taskIds: [selected.id, missing],
      scope: { domain: 'personal' },
    })).toMatchObject({
      ok: false,
      status: 'partial',
      requestedTaskIds: [selected.id, missing],
      cancelledTaskIds: [selected.id],
      notCancelledTaskIds: [missing],
      failedCount: 1,
      targetResults: [
        { taskId: selected.id, status: 'cancelled' },
        { taskId: missing, status: 'not_found' },
      ],
    });

    expect(cancelRuntimeWork({
      userId,
      taskIds: [selected.id],
      scope: { domain: 'personal' },
    })).toMatchObject({
      ok: true,
      status: 'idle',
      cancelledTaskIds: [],
      notCancelledTaskIds: [],
      failedCount: 0,
      targetResults: [
        { taskId: selected.id, status: 'already_terminal' },
      ],
    });
    expect(cancelRuntimeWork({
      userId,
      taskIds: [selected.id, missing],
      scope: { domain: 'personal' },
    })).toMatchObject({
      ok: false,
      status: 'partial',
      cancelledTaskIds: [],
      notCancelledTaskIds: [missing],
      failedCount: 1,
      targetResults: [
        { taskId: selected.id, status: 'already_terminal' },
        { taskId: missing, status: 'not_found' },
      ],
    });
    expect(getRuntimeWorkSnapshot(userId, ['delegation'], { domain: 'personal' }).items
      .find(item => item.id === unselected.id)).toMatchObject({ phase: 'queued' });
  });
});
