import './helpers';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), generate: vi.fn() }));
vi.mock('../server/autonomy/task_executor', () => ({ executeNextAutonomousTask: mocks.execute }));
vi.mock('../server/autonomy/task_generator', () => ({ generateAutonomousTasks: mocks.generate }));
import { flushDBOrThrow, initDatabase, readDB, writeDB } from '../db_layer';
import { registerScheduledTasks, scheduler, Scheduler, type ScheduledTask } from '../server/scheduler';
import { saveGateConfig } from '../server/autonomy/safety_gate';

const userId = 'cycle-cancellation-user';
function cycle(): ScheduledTask {
  const registered: ScheduledTask[] = [];
  const spy = vi.spyOn(scheduler, 'register').mockImplementation(task => { registered.push(task); });
  try { registerScheduledTasks(() => null, () => null); } finally { spy.mockRestore(); }
  scheduler.setIO({ to: () => ({ emit: vi.fn() }) } as any);
  return registered.find(task => task.id === 'autonomous_work_cycle')!;
}
beforeEach(async () => {
  await initDatabase();
  const db = readDB();
  db.settings = [{ key: `op_mode_${userId}`, value: JSON.stringify('autonomous') }];
  db.conversationActionTasks = []; db.conversationActionReceipts = [];
  db.users = [{ uid: userId, username: userId, password: '', role: 'user', createdAt: new Date().toISOString() }];
  writeDB(db);
  mocks.execute.mockReset().mockResolvedValue({ executed: true });
  mocks.generate.mockReset().mockResolvedValue(0);
  saveGateConfig({ maxConsecutiveTasks: 2 }, userId);
});
afterEach(async () => { scheduler.stop(); await flushDBOrThrow(); });

it.each(['stop', 'disable'] as const)('stops the actual built-in batch at the current task after %s', async control => {
  let release!: (result: { executed: boolean }) => void;
  mocks.execute.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  const task = cycle();
  const runner = new Scheduler(); runner.register(task);
  const running = (runner as any).runTask(task) as Promise<void>;
  try {
    await vi.waitFor(() => expect(mocks.execute).toHaveBeenCalledOnce());
    const signal = mocks.execute.mock.calls[0][3].signal as AbortSignal;
    if (control === 'stop') runner.stop();
    else expect(runner.disableTask(task.id)).toBe(true);
    expect(signal.aborted).toBe(true);
    release({ executed: true });
    await running;
    await vi.waitFor(() => expect(runner.listTasks()[0].running).toBe(false));
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(task.lastStatus).toBe('unknown'); // The scheduler still quarantines a late non-cooperative handler.
  } finally { release?.({ executed: false }); await running; runner.stop(); }
});

it('does not start an executor after cancellation during task generation', async () => {
  let release!: (count: number) => void;
  mocks.generate.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  const task = cycle();
  const parent = new AbortController();
  const running = task.handler({ signal: parent.signal } as any);
  await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledOnce());
  expect(mocks.generate.mock.calls[0][2]).toBe(parent.signal);
  parent.abort(); release(1);
  await running;
  expect(mocks.execute).not.toHaveBeenCalled();
});
