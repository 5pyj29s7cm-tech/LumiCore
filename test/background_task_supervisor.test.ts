import { describe, expect, it } from 'vitest';
import {
  claimBackgroundTask,
  completeBackgroundTask,
  registerBackgroundTask,
  resetBackgroundTasksForTest,
} from '../server/agents/background_tasks';
import { startDurableBackgroundTaskSupervisor } from '../server/agents/background_task_supervisor';
import { buildTaskTerminalReceipt } from '../server/cognition/acceptance_evidence';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('durable background task supervisor', () => {
  it('does not dispatch a queued task twice and respects bounded concurrency', async () => {
    resetBackgroundTasksForTest({ markHydrated: true });
    registerBackgroundTask({ id: 'supervisor-a', userId: 'owner', title: 'A', prompt: 'A' });
    registerBackgroundTask({ id: 'supervisor-b', userId: 'owner', title: 'B', prompt: 'B' });
    const firstGate = deferred();
    const secondGate = deferred();
    const started: string[] = [];
    const supervisor = startDurableBackgroundTaskSupervisor({
      io: {} as any,
      llmGetters: {} as any,
      concurrency: 1,
      pollMs: 60_000,
      claimAgeMs: 0,
      taskExecutor: async task => {
        expect(claimBackgroundTask(task.id)).not.toBeNull();
        started.push(task.id);
        await (task.id === 'supervisor-a' ? firstGate.promise : secondGate.promise);
        completeBackgroundTask(task.id, 'done', buildTaskTerminalReceipt({
          taskId: task.id,
          runtime: 'background',
          outcome: 'completed',
          toolRecords: [{
            id: `${task.id}:controlled-receipt`,
            name: 'controlled_supervisor_probe',
            arguments: {},
            result: JSON.stringify({ ok: true }),
            terminalVerification: {
              status: 'verified',
              strategy: 'terminal_receipt',
              reason: 'Controlled supervisor probe verified.',
            },
          }],
        }));
      },
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(started).toEqual(['supervisor-a']);
    expect(await supervisor.tick()).toBe(0);
    expect(started).toEqual(['supervisor-a']);

    firstGate.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await supervisor.tick()).toBe(1);
    expect(started).toEqual(['supervisor-a', 'supervisor-b']);
    expect(await supervisor.tick()).toBe(0);

    secondGate.resolve();
    supervisor.stop();
    resetBackgroundTasksForTest({ markHydrated: true });
  });
});
