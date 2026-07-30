import { beforeEach, describe, expect, it } from 'vitest';
import {
  cancelBackgroundTask,
  checkpointBackgroundTask,
  claimBackgroundTask,
  completeBackgroundTask,
  failBackgroundTask,
  getBackgroundTask,
  incrementBackgroundTaskToolCalls,
  isBackgroundTaskCancellationRequested,
  listBackgroundTasks,
  markBackgroundTaskRunning,
  recoverPersistedBackgroundTask,
  registerBackgroundTask,
  requestCancelBackgroundTask,
  requestPauseBackgroundTask,
  resumeBackgroundTask,
  resetBackgroundTasksForTest,
} from '../server/agents/background_tasks';

describe('background task registry', () => {
  beforeEach(() => {
    resetBackgroundTasksForTest();
  });

  it('tracks a delegated task from queue to completion', () => {
    const created = registerBackgroundTask({
      userId: 'u1',
      title: 'Draft a legal memo',
      prompt: 'Read files and draft a memo',
      complexity: 'complex',
      workers: [{ id: 'legal', name: 'Legal Agent', category: 'law' }],
    });

    expect(created.status).toBe('queued');
    expect(created.workerNames).toEqual(['Legal Agent']);
    expect(listBackgroundTasks('u1')).toHaveLength(1);

    expect(markBackgroundTaskRunning(created.id)?.status).toBe('running');
    expect(incrementBackgroundTaskToolCalls(created.id)?.toolCallsCount).toBe(1);

    const completed = completeBackgroundTask(created.id, 'Done');
    expect(completed?.status).toBe('completed');
    expect(completed?.resultPreview).toBe('Done');
    expect(getBackgroundTask(created.id, 'u2')).toBeNull();
  });

  it('preserves cancellation when completion races with cancel', () => {
    const created = registerBackgroundTask({
      userId: 'u1',
      title: 'Background work',
      prompt: 'Do the work',
    });

    const cancelling = requestCancelBackgroundTask(created.id, 'u1');
    expect(cancelling?.status).toBe('cancelled');
    expect(isBackgroundTaskCancellationRequested(created.id)).toBe(true);

    const completed = completeBackgroundTask(created.id, 'Late success');
    expect(completed?.status).toBe('cancelled');
    expect(getBackgroundTask(created.id, 'u1')?.resultPreview).toBeUndefined();
  });

  it('marks failures and explicit cancellations', () => {
    const failed = registerBackgroundTask({
      userId: 'u1',
      title: 'Failure task',
      prompt: 'fail',
    });
    expect(failBackgroundTask(failed.id, 'boom')?.status).toBe('failed');
    expect(getBackgroundTask(failed.id, 'u1')?.error).toBe('boom');

    const cancelled = registerBackgroundTask({
      userId: 'u1',
      title: 'Cancel task',
      prompt: 'cancel',
    });
    expect(cancelBackgroundTask(cancelled.id)?.status).toBe('cancelled');
  });

  it('uses an exclusive lease and retains a durable checkpoint', () => {
    const created = registerBackgroundTask({
      id: 'leased-background-task',
      userId: 'u1',
      title: 'Leased work',
      prompt: 'Do leased work',
    });
    const claimed = claimBackgroundTask(created.id, { leaseId: 'lease-a', owner: 'worker-a' });
    expect(claimed).toMatchObject({ status: 'running', leaseId: 'lease-a', attempt: 1 });
    expect(claimBackgroundTask(created.id, { leaseId: 'lease-b', owner: 'worker-b' })).toBeNull();
    expect(checkpointBackgroundTask(created.id, {
      phase: 'tool_execution',
      receiptIds: ['receipt-1'],
    }, 'lease-a')?.checkpoint).toMatchObject({ phase: 'tool_execution', receiptIds: ['receipt-1'] });
  });

  it('pauses, resumes, and recovers interrupted work without losing its checkpoint', () => {
    const created = registerBackgroundTask({
      userId: 'u1',
      title: 'Pause work',
      prompt: 'Pause then continue',
    });
    expect(requestPauseBackgroundTask(created.id, 'u1')?.status).toBe('paused');
    expect(resumeBackgroundTask(created.id, 'u1')?.status).toBe('queued');
    const running = markBackgroundTaskRunning(created.id)!;
    const checkpointed = checkpointBackgroundTask(created.id, {
      phase: 'model_graph',
      receiptIds: ['graph:node-1'],
    }, running.leaseId)!;
    const recovered = recoverPersistedBackgroundTask(checkpointed, '2026-07-30T00:00:00.000Z');
    expect(recovered).toMatchObject({
      status: 'queued',
      recoveryCount: 1,
      lastRecoveredAt: '2026-07-30T00:00:00.000Z',
      checkpoint: { phase: 'model_graph', receiptIds: ['graph:node-1'] },
    });
    expect(recovered.leaseId).toBeUndefined();
  });
});
