import './helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, flushDB, initDatabase, readDB } from '../db_layer';
import {
  checkpointBackgroundTask,
  getBackgroundTask,
  hydrateBackgroundTasksFromDb,
  markBackgroundTaskRunning,
  registerBackgroundTask,
  resetBackgroundTasksForTest,
} from '../server/agents/background_tasks';
import {
  checkpointAutonomousTask,
  enqueue,
  getTaskQueue,
  hydrateAutonomousTasksFromDb,
  markRunning,
  resetAutonomousTaskQueueForTest,
} from '../server/autonomy/task_queue';

describe('durable background task queues', () => {
  beforeEach(async () => {
    await initDatabase();
    resetBackgroundTasksForTest({ clearPersisted: true, markHydrated: true });
    resetAutonomousTaskQueueForTest({ clearPersisted: true, markHydrated: true });
    await flushDB();
  });

  afterEach(async () => {
    resetBackgroundTasksForTest({ clearPersisted: true, markHydrated: true });
    resetAutonomousTaskQueueForTest({ clearPersisted: true, markHydrated: true });
    await flushDB();
  });

  it('round-trips running tasks through SQLite and requeues stale leases after restart', async () => {
    const background = registerBackgroundTask({
      id: 'durable-background',
      userId: 'durable-owner',
      title: 'Durable background',
      prompt: 'Continue safely after restart',
      context: {
        conversationId: 'durable-conversation',
        actionTaskId: 'durable-action',
        provider: 'ollama',
        model: 'exact-local-model',
        selectionMode: 'pinned',
      },
    });
    const claimedBackground = markBackgroundTaskRunning(background.id)!;
    checkpointBackgroundTask(background.id, {
      phase: 'tool_execution',
      receiptIds: ['receipt-a'],
    }, claimedBackground.leaseId);

    const autonomous = enqueue({
      userId: 'durable-owner',
      title: 'Durable autonomy',
      description: 'Continue autonomous work after restart',
      source: 'user_request',
      priority: 8,
      mode: 'analysis',
    })!;
    const claimedAutonomous = markRunning(autonomous.id)!;
    checkpointAutonomousTask(autonomous.id, {
      phase: 'tool_loop',
      iteration: 3,
      receiptIds: ['receipt-b'],
    }, claimedAutonomous.leaseId);

    await flushDB();
    await closeDatabase();
    resetBackgroundTasksForTest();
    resetAutonomousTaskQueueForTest();
    await initDatabase();

    expect(hydrateBackgroundTasksFromDb(true)).toBe(1);
    expect(hydrateAutonomousTasksFromDb(true)).toBe(1);
    expect(getBackgroundTask(background.id, 'durable-owner')).toMatchObject({
      status: 'queued',
      recoveryCount: 1,
      checkpoint: { phase: 'tool_execution', receiptIds: ['receipt-a'] },
      context: { provider: 'ollama', model: 'exact-local-model', selectionMode: 'pinned' },
    });
    expect(getBackgroundTask(background.id, 'durable-owner')?.leaseId).toBeUndefined();
    expect(getTaskQueue('durable-owner')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: autonomous.id,
        status: 'pending',
        recoveryCount: 1,
        checkpoint: expect.objectContaining({ phase: 'tool_loop', receiptIds: ['receipt-b'] }),
      }),
    ]));

    const db = readDB();
    expect(db.backgroundDelegationTasks).toHaveLength(1);
    expect(db.autonomousTasks).toHaveLength(1);
  });
});
