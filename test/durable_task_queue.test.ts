import './helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, commitDatabaseTables, flushDB, flushDBOrThrow, initDatabase, querySQL, readDB, readDatabaseTables } from '../db_layer';
import {
  checkpointAutonomousTask,
  claimAutonomousTask,
  dequeue,
  enqueue,
  getTaskQueue,
  getTaskHistory,
  getRunningTask,
  hydrateAutonomousTasksFromDb,
  markRunning,
  markCancelled,
  persistAutonomousTaskQueue,
  registerAutonomousTaskExecutor,
  resetAutonomousTaskQueueForTest,
  type AutonomousTask,
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
  it('preserves blocked history beyond age and count limits through SQLite restart without admitting execution', async () => {
    const userId = 'blocked-history-owner';
    const now = Date.now();
    const oldAt = new Date(now - 30 * 86_400_000).toISOString();
    const task = (id: string, status: AutonomousTask['status'], createdAt: string): AutonomousTask => ({
      id, userId, title: id, description: 'Preserve the existing task evidence', status,
      source: 'user_request', priority: 5, mode: 'analysis', createdAt, updatedAt: createdAt,
    });
    const blocked = [
      ...Array.from({ length: 201 }, (_, index) => task('blocked-' + index, 'blocked', new Date(now - 2 * 3_600_000 + index).toISOString())),
      task('blocked-old', 'blocked', oldAt),
    ].map(item => ({ ...item, blocked: true, verified: false, error: 'Existing blocker: ' + item.id,
      checkpoint: { phase: 'manual_review', receiptIds: ['receipt-' + item.id] } }));
    const paused = { ...task('paused-old', 'paused', oldAt), checkpoint: { phase: 'paused', receiptIds: [] } };
    const bounded = Array.from({ length: 205 }, (_, index) => task('bounded-' + index,
      (['completed', 'failed', 'cancelled'] as const)[index % 3], new Date(now - 3_600_000 + index).toISOString()));
    const expired = (['completed', 'failed', 'cancelled'] as const).map(status => task('expired-' + status, status, oldAt));
    const seeded = [...blocked, paused, ...bounded, ...expired];
    const state = readDatabaseTables(['autonomousTasks']);
    state.autonomousTasks = seeded;
    commitDatabaseTables(state);
    await flushDBOrThrow();
    expect((await querySQL<{ total: number }>('SELECT COUNT(*) AS total FROM autonomous_tasks'))[0].total).toBe(seeded.length);
    await closeDatabase();
    resetAutonomousTaskQueueForTest();
    await initDatabase();
    hydrateAutonomousTasksFromDb(true);

    const retainedBlocked = () => getTaskHistory(1_000, 0, userId).filter(item => item.status === 'blocked');
    expect(retainedBlocked()).toHaveLength(blocked.length);
    const cancelled = enqueue({ userId, title: 'New cancelled history', description: 'Exercise ordinary history persistence',
      source: 'user_request', priority: 1, mode: 'analysis' })!;
    expect(markCancelled(cancelled.id)?.status).toBe('cancelled');
    await persistAutonomousTaskQueue();
    expect((await querySQL<{ status: string; total: number }>('SELECT status, COUNT(*) AS total FROM autonomous_tasks GROUP BY status'))
      .find(row => row.status === 'blocked')?.total).toBe(blocked.length);
    await closeDatabase();
    resetAutonomousTaskQueueForTest();
    await initDatabase();
    hydrateAutonomousTasksFromDb(true);

    expect(retainedBlocked().sort((left, right) => left.id.localeCompare(right.id)))
      .toMatchObject(blocked.sort((left, right) => left.id.localeCompare(right.id)));
    expect(retainedBlocked().every(item => item.terminalReceipt === undefined)).toBe(true);
    const history = getTaskHistory(1_000, 0, userId);
    expect(history.filter(item => item.status !== 'blocked')).toHaveLength(200);
    expect(history.some(item => item.id.startsWith('expired-'))).toBe(false);
    expect(getTaskQueue(userId)).toEqual([expect.objectContaining({ id: paused.id, status: 'paused', createdAt: oldAt, checkpoint: paused.checkpoint })]);
    expect(getRunningTask(userId)).toBeNull();
    const executorAdmission = vi.fn(registerAutonomousTaskExecutor);
    const pending = dequeue(userId);
    if (pending) {
      const claimed = claimAutonomousTask(pending.id);
      if (claimed) executorAdmission(claimed.id, claimed.leaseId!);
    }
    expect(pending).toBeNull();
    expect(executorAdmission).not.toHaveBeenCalled();
    for (const item of [...blocked, paused]) expect(claimAutonomousTask(item.id)).toBeNull();
    expect(registerAutonomousTaskExecutor(paused.id, 'foreign-lease')).toBe(false);
    expect(registerAutonomousTaskExecutor(blocked[0].id, 'foreign-lease')).toBe(false);
    expect(readDB().autonomousTasks).toHaveLength(blocked.length + 200 + 1);
  });

});
