import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  acquireDesktopControlLease,
  getDesktopControlLease,
  getDesktopControlQueueLength,
  getDesktopControlRuntimeSnapshot,
  reportDesktopUserActivity,
  resetDesktopControlLeasesForTests,
} from '../server/desktop/control_lease';

describe('global desktop control lease', () => {
  afterEach(() => {
    resetDesktopControlLeasesForTests();
    vi.useRealTimers();
  });

  it('serializes different tasks and releases the next waiter in order', async () => {
    const first = await acquireDesktopControlLease({
      userId: 'lease-user-a',
      taskId: 'task-a',
      source: 'chat',
    });
    let secondResolved = false;
    const secondPromise = acquireDesktopControlLease({
      userId: 'lease-user-a',
      taskId: 'task-b',
      source: 'task',
    }).then(handle => {
      secondResolved = true;
      return handle;
    });

    await Promise.resolve();
    expect(secondResolved).toBe(false);
    expect(getDesktopControlQueueLength('lease-user-a')).toBe(1);
    expect(getDesktopControlRuntimeSnapshot()).toMatchObject({ active: 1, waiting: 1 });

    first.release('first_complete');
    const second = await secondPromise;
    expect(second.snapshot()).toMatchObject({ taskId: 'task-b', status: 'active' });
    expect(getDesktopControlQueueLength('lease-user-a')).toBe(0);
    second.release();
  });

  it('lets a voice turn preempt and pause autonomous desktop work', async () => {
    const pauses: string[] = [];
    const autonomous = await acquireDesktopControlLease({
      userId: 'lease-user-b',
      taskId: 'autonomy-a',
      source: 'autonomous',
      onPause: reason => pauses.push(reason),
    });
    autonomous.bindWindow({
      title: 'Draft',
      processName: 'wps.exe',
      fingerprint: 'window-a',
      observedAt: new Date().toISOString(),
    });

    const voice = await acquireDesktopControlLease({
      userId: 'lease-user-b',
      taskId: 'voice-a',
      source: 'voice',
    });

    expect(autonomous.signal.aborted).toBe(true);
    expect(autonomous.snapshot()).toMatchObject({
      status: 'paused',
      reason: 'desktop_control_preempted_by_voice',
    });
    expect(autonomous.snapshot().windowBinding).toBeUndefined();
    expect(pauses).toEqual(['desktop_control_preempted_by_voice']);
    expect(getDesktopControlLease('lease-user-b')).toMatchObject({ taskId: 'voice-a', source: 'voice' });
    voice.release();
  });

  it('pauses automation for physical user activity and invalidates its window binding', async () => {
    vi.useFakeTimers();
    const active = await acquireDesktopControlLease({
      userId: 'lease-user-c',
      taskId: 'chat-a',
      source: 'chat',
    });
    active.bindWindow({
      title: 'Settings',
      processName: 'lumi.exe',
      fingerprint: 'window-c',
      observedAt: new Date().toISOString(),
    });

    const paused = reportDesktopUserActivity('lease-user-c', 500);
    expect(paused).toMatchObject({
      taskId: 'chat-a',
      status: 'paused',
      reason: 'desktop_control_paused_for_user_activity',
    });
    expect(paused?.windowBinding).toBeUndefined();
    expect(active.signal.aborted).toBe(true);

    const nextPromise = acquireDesktopControlLease({
      userId: 'lease-user-c',
      taskId: 'chat-b',
      source: 'chat',
    });
    expect(getDesktopControlQueueLength('lease-user-c')).toBe(1);
    await vi.advanceTimersByTimeAsync(501);
    const next = await nextPromise;
    expect(next.snapshot()).toMatchObject({ taskId: 'chat-b', status: 'active' });
    next.release();
  });

  it('ignores a delayed idle-reset report for the input that started the foreground lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T12:00:05.000Z'));
    const active = await acquireDesktopControlLease({
      userId: 'lease-user-prompt-input',
      taskId: 'foreground-task',
      source: 'voice',
    });

    const paused = reportDesktopUserActivity(
      'lease-user-prompt-input',
      2_500,
      '2026-08-08T12:00:04.000Z',
    );
    expect(paused).toBeNull();
    expect(active.snapshot()).toMatchObject({ status: 'active', taskId: 'foreground-task' });
    expect(getDesktopControlRuntimeSnapshot().userActivityHolds).toBe(0);
    active.release();
  });

  it('supports same-task reentrancy without exposing the desktop to another task', async () => {
    const first = await acquireDesktopControlLease({
      userId: 'lease-user-d',
      taskId: 'shared-task',
      source: 'task',
    });
    const nested = await acquireDesktopControlLease({
      userId: 'lease-user-d',
      taskId: 'shared-task',
      source: 'task',
    });
    expect(nested.leaseId).toBe(first.leaseId);

    first.release('outer_complete');
    expect(getDesktopControlLease('lease-user-d')).toMatchObject({ taskId: 'shared-task', status: 'active' });
    nested.release('nested_complete');
    expect(getDesktopControlLease('lease-user-d')).toBeNull();
  });

  it('rejects an already cancelled acquisition without creating a lease', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(acquireDesktopControlLease({
      userId: 'lease-user-e',
      taskId: 'cancelled-task',
      source: 'chat',
      signal: controller.signal,
    })).rejects.toThrow(/cancelled before acquiring/i);
    expect(getDesktopControlLease('lease-user-e')).toBeNull();
  });

  it('expires an abandoned lease and automatically dispatches the next task', async () => {
    vi.useFakeTimers();
    const abandoned = await acquireDesktopControlLease({
      userId: 'lease-user-f',
      taskId: 'abandoned-task',
      source: 'chat',
      leaseMs: 10_000,
    });
    const nextPromise = acquireDesktopControlLease({
      userId: 'lease-user-f',
      taskId: 'recovered-task',
      source: 'task',
    });

    await vi.advanceTimersByTimeAsync(10_001);
    expect(abandoned.signal.aborted).toBe(true);
    expect(abandoned.snapshot()).toMatchObject({ status: 'expired' });
    const next = await nextPromise;
    expect(next.snapshot()).toMatchObject({ taskId: 'recovered-task', status: 'active' });
    next.release();
  });

  it('removes timed-out and cancelled waiters without disturbing the active task', async () => {
    vi.useFakeTimers();
    const active = await acquireDesktopControlLease({
      userId: 'lease-user-g',
      taskId: 'active-task',
      source: 'chat',
    });
    const timedOut = acquireDesktopControlLease({
      userId: 'lease-user-g',
      taskId: 'timeout-task',
      source: 'task',
      timeoutMs: 1_000,
    });
    const controller = new AbortController();
    const cancelled = acquireDesktopControlLease({
      userId: 'lease-user-g',
      taskId: 'cancelled-waiter',
      source: 'task',
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).rejects.toThrow(/cancelled while waiting/i);
    expect(getDesktopControlQueueLength('lease-user-g')).toBe(1);

    const timedOutExpectation = expect(timedOut).rejects.toThrow(/timed out/i);
    await vi.advanceTimersByTimeAsync(1_001);
    await timedOutExpectation;
    expect(getDesktopControlQueueLength('lease-user-g')).toBe(0);
    expect(getDesktopControlLease('lease-user-g')).toMatchObject({ taskId: 'active-task' });
    active.release();
  });

  it('arbitrates a burst of waiters by priority and FIFO order without overlap', async () => {
    const active = await acquireDesktopControlLease({
      userId: 'lease-user-h',
      taskId: 'initial-task',
      source: 'chat',
    });
    const specs = [
      ['autonomy-1', 'autonomous'],
      ['background-1', 'background'],
      ['task-1', 'task'],
      ['voice-1', 'voice'],
      ['task-2', 'chat'],
      ['messaging-1', 'messaging'],
    ] as const;
    const granted: string[] = [];
    const promises = specs.map(([taskId, source]) => acquireDesktopControlLease({
      userId: 'lease-user-h',
      taskId,
      source,
    }).then(handle => {
      granted.push(taskId);
      handle.release(`${taskId}_complete`);
      return taskId;
    }));

    expect(getDesktopControlRuntimeSnapshot()).toMatchObject({ active: 1, waiting: specs.length });
    active.release('initial_complete');
    await Promise.all(promises);
    expect(granted).toEqual([
      'voice-1',
      'task-1',
      'task-2',
      'messaging-1',
      'background-1',
      'autonomy-1',
    ]);
    expect(getDesktopControlRuntimeSnapshot()).toMatchObject({ active: 0, waiting: 0 });
  });
});
