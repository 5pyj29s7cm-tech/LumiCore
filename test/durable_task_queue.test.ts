import './helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, flushDB, initDatabase, readDB } from '../db_layer';
import {
  checkpointAutonomousTask,
  enqueue,
  getTaskQueue,
  hydrateAutonomousTasksFromDb,
  markRunning,
  resetAutonomousTaskQueueForTest,
} from '../server/autonomy/task_queue';

describe('durable LumiCore task queue', () => {
  beforeEach(async () => {
    await initDatabase();
    resetAutonomousTaskQueueForTest({ clearPersisted: true, markHydrated: true });
    await flushDB();
  });

  afterEach(async () => {
    resetAutonomousTaskQueueForTest({ clearPersisted: true, markHydrated: true });
    await flushDB();
  });

  it('round-trips a running task through SQLite and requeues its stale lease after restart', async () => {
    const autonomous = enqueue({
      userId: 'durable-owner',
      title: 'Durable autonomy',
      description: 'Continue autonomous work after restart',
      source: 'user_request',
      priority: 8,
      mode: 'analysis',
    })!;
    const claimed = markRunning(autonomous.id)!;
    checkpointAutonomousTask(autonomous.id, {
      phase: 'tool_loop',
      iteration: 3,
      receiptIds: ['receipt-b'],
    }, claimed.leaseId);

    await flushDB();
    await closeDatabase();
    resetAutonomousTaskQueueForTest();
    await initDatabase();

    expect(hydrateAutonomousTasksFromDb(true)).toBe(1);
    expect(getTaskQueue('durable-owner')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: autonomous.id,
        status: 'pending',
        recoveryCount: 1,
        checkpoint: expect.objectContaining({ phase: 'tool_loop', receiptIds: ['receipt-b'] }),
      }),
    ]));
    expect(getTaskQueue('durable-owner')[0].leaseId).toBeUndefined();
    expect(readDB().autonomousTasks).toHaveLength(1);
  });
});
