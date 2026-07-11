import './helpers';
import { describe, expect, it } from 'vitest';
import { cancelTask, enqueue, getTaskQueue } from '../server/autonomy/task_queue';

describe('Autonomous task queue isolation', () => {
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
});
