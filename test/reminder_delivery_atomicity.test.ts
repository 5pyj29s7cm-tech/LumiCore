import './helpers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, flushDBOrThrow, initDatabase, querySQL, readDB, runSQL, writeDB } from '../db_layer';
import { addReminder } from '../server/memory';
import { createReminderCheckTask, Scheduler } from '../server/scheduler';

const schedulers: Scheduler[] = [];
const now = '2026-09-10T09:00:00.000Z';
function dueReminder(overrides: Record<string, unknown> = {}) {
  return addReminder({ userId: 'synthetic-reminder-user', content: 'Synthetic reminder', dueAt: '2026-09-10T08:59:00.000Z',
    sourceInteractionId: 'synthetic-source', domain: 'personal', orgId: '', ...overrides });
}
function setup(flush: () => Promise<void> = flushDBOrThrow, writer = writeDB, attachIO = true) {
  const scheduler = new Scheduler(flush, writer);
  schedulers.push(scheduler);
  const emit = vi.fn();
  const to = vi.fn(() => ({ emit }));
  if (attachIO) scheduler.setIO({ to } as any);
  const task = createReminderCheckTask();
  scheduler.register(task);
  const run = () => (scheduler as any).runTask(task) as Promise<void>;
  return { scheduler, task, emit, to, run };
}
const deliveryRows = () => (readDB().interactions || []).filter((row: any) => row.mode === 'proactive');

describe('scheduled reminder atomic delivery', () => {
  beforeAll(initDatabase);
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    const db = readDB();
    db.reminders = []; db.interactions = []; db.settings = [];
    db.conversationActionTasks = []; db.conversationActionReceipts = [];
    writeDB(db);
  });
  afterEach(async () => {
    for (const scheduler of schedulers.splice(0)) scheduler.stop();
    vi.useRealTimers();
    await flushDBOrThrow();
  });

  it('selects without firing, checks each minute, and durably commits the receipt and reminders before emission', async () => {
    const first = dueReminder();
    const second = dueReminder({ content: 'Another synthetic reminder' });
    const future = dueReminder({ dueAt: '2026-09-11T00:00:00.000Z' });
    const { task, run, emit } = setup();
    expect(task.cron).toBe('every_1m');
    const selected = await task.handler();
    expect(selected).toEqual([expect.objectContaining({ reminderIds: [first.id, second.id] })]);
    expect(readDB().reminders.every((row: any) => row.status === 'pending')).toBe(true);
    await run();
    expect(emit).toHaveBeenCalledTimes(1);
    const event = emit.mock.calls[0][1];
    const [stored] = await querySQL<any>('SELECT * FROM interactions WHERE id = ?', [event.interactionId]);
    expect(stored).toMatchObject({ mode: 'proactive', role: 'assistant', timestamp: now });
    expect(JSON.parse(stored.toolCalls)).toMatchObject({ scheduledTaskId: 'reminder_check', reminderIds: [first.id, second.id] });
    const persisted = await querySQL<any>('SELECT id, status, firedAt FROM reminders');
    expect(persisted.find(row => row.id === first.id)).toMatchObject({ status: 'fired', firedAt: stored.timestamp });
    expect(persisted.find(row => row.id === future.id)).toMatchObject({ status: 'pending', firedAt: null });
    vi.setSystemTime(new Date('2026-09-10T09:01:01.000Z'));
    await run();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(deliveryRows()).toHaveLength(1);
  });

  it('rolls back both reminder claims and the complete delivery batch when the writer throws after swapping the candidate', async () => {
    const reminder = dueReminder();
    let fail = true;
    const writer = (candidate: any) => {
      writeDB(candidate);
      if (fail && candidate.interactions.some((row: any) => row.mode === 'proactive')) {
        fail = false;
        throw new Error('synthetic write-after-swap failure');
      }
    };
    const { scheduler, run, emit } = setup(flushDBOrThrow, writer);
    await run();
    expect(readDB().reminders.find((row: any) => row.id === reminder.id)).toMatchObject({ status: 'pending', firedAt: null });
    expect(deliveryRows()).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
    await flushDBOrThrow();
    expect(await querySQL('SELECT id FROM interactions WHERE mode = ?', ['proactive'])).toHaveLength(0);
    // Preserve the existing unknown-outcome gate; the test inspects the durable
    // rollback before explicitly reconciling and admitting a new minute slot.
    await expect(scheduler.reconcileTask('reminder_check', 'confirmed_no_side_effect')).resolves.toMatchObject({ reconciled: true });
    vi.setSystemTime(new Date('2026-09-10T09:01:01.000Z'));
    await run();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('keeps both SQLite reminder state and client emission behind the actual delivery durability gate', async () => {
    const reminder = dueReminder();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const admission = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    const flush = async () => {
      if (++calls === 2) { entered(); await gate; }
      await flushDBOrThrow();
    };
    const { run, emit } = setup(flush);
    const running = run();
    await admission;
    try {
      expect(emit).not.toHaveBeenCalled();
      expect(await querySQL('SELECT status FROM reminders WHERE id = ?', [reminder.id])).toEqual([{ status: 'pending' }]);
      expect(await querySQL('SELECT id FROM interactions WHERE mode = ?', ['proactive'])).toHaveLength(0);
    } finally { release(); }
    await running;
    expect(emit).toHaveBeenCalledTimes(1);
    expect(await querySQL('SELECT status FROM reminders WHERE id = ?', [reminder.id])).toEqual([{ status: 'fired' }]);
    expect(await querySQL('SELECT id FROM interactions WHERE mode = ?', ['proactive'])).toHaveLength(1);
  });

  it.each([true, false])('restores pending reminders after a delivery flush fails even with a connected client = %s', async connected => {
    const reminder = dueReminder();
    let calls = 0;
    const flush = async () => {
      await flushDBOrThrow();
      if (++calls === 2) throw new Error('synthetic failure after durable delivery commit');
    };
    const { run, emit } = setup(flush, writeDB, connected);
    await run();
    expect(emit).not.toHaveBeenCalled();
    expect(deliveryRows()).toHaveLength(0);
    expect(await querySQL('SELECT status, firedAt FROM reminders WHERE id = ?', [reminder.id])).toEqual([{ status: 'pending', firedAt: null }]);
    expect(await querySQL('SELECT id FROM interactions WHERE mode = ?', ['proactive'])).toHaveLength(0);
  });

  it('fences concurrent runs and rolls back cancelled delivery only after the late flush settles', async () => {
    const reminder = dueReminder();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const admission = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0;
    const flush = async () => {
      if (++calls === 2) { entered(); await gate; }
      await flushDBOrThrow();
    };
    const { scheduler, run, emit } = setup(flush);
    const running = run();
    await admission;
    await run();
    expect(deliveryRows()).toHaveLength(1);
    scheduler.disableTask('reminder_check');
    await running;
    expect(emit).not.toHaveBeenCalled();
    expect(readDB().reminders.find((row: any) => row.id === reminder.id)?.status).toBe('pending');
    expect(scheduler.listTasks()[0]).toMatchObject({ requiresReconciliation: true, settlementPending: true });
    release();
    await vi.waitFor(() => expect(scheduler.listTasks()[0]).toMatchObject({ requiresReconciliation: true, settlementPending: false }));
    expect(await querySQL('SELECT status FROM reminders WHERE id = ?', [reminder.id])).toEqual([{ status: 'pending' }]);
    expect(await querySQL('SELECT id FROM interactions WHERE mode = ?', ['proactive'])).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('never resurrects a reminder deleted during a failing flush', async () => {
    dueReminder();
    let calls = 0;
    const flush = async () => {
      if (++calls === 2) {
        const db = readDB(); db.reminders = []; writeDB(db);
        throw new Error('synthetic cancellation and delivery failure');
      }
      await flushDBOrThrow();
    };
    const { run, emit } = setup(flush);
    await run();
    expect(readDB().reminders).toEqual([]);
    expect(deliveryRows()).toHaveLength(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejects reminder claims that were moved to another scope before delivery', async () => {
    const reminder = dueReminder();
    const { task, run, emit } = setup();
    const select = task.handler;
    task.handler = async context => {
      const selected = await select(context);
      const db = readDB();
      db.reminders.find((row: any) => row.id === reminder.id).userId = 'different-user';
      writeDB(db);
      return selected;
    };
    await run();
    expect(deliveryRows()).toHaveLength(0);
    expect(readDB().reminders[0].status).toBe('pending');
    expect(emit).not.toHaveBeenCalled();
  });

  it('withholds the notification if a reminder is deleted during a successful delivery flush', async () => {
    dueReminder();
    let calls = 0;
    const flush = async () => {
      if (++calls === 2) {
        const db = readDB(); db.reminders = []; writeDB(db);
      }
      await flushDBOrThrow();
    };
    const { run, emit } = setup(flush);
    await run();
    expect(readDB().reminders).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('migrates a real legacy reminder table and preserves work scope through a database close and reopen', async () => {
    dueReminder();
    await flushDBOrThrow();
    await runSQL('ALTER TABLE reminders DROP COLUMN domain');
    await runSQL('ALTER TABLE reminders DROP COLUMN orgId');
    await closeDatabase();
    await initDatabase();
    expect(readDB().reminders[0]).toMatchObject({ content: 'Synthetic reminder', status: 'pending', domain: 'personal', orgId: '' });
    const work = dueReminder({ userId: 'work-reminder-user', domain: 'work', orgId: 'synthetic-org' });
    await flushDBOrThrow();
    await closeDatabase();
    await initDatabase();
    expect(readDB().reminders.find((row: any) => row.id === work.id)).toMatchObject({ domain: 'work', orgId: 'synthetic-org', status: 'pending' });
    const { run, to, emit } = setup();
    await run();
    expect(to).toHaveBeenCalledWith('user:work-reminder-user:org:synthetic-org');
    expect(to).not.toHaveBeenCalledWith('user:work-reminder-user:personal');
    expect(emit.mock.calls.map(call => call[1])).toContainEqual(expect.objectContaining({ domain: 'work', orgId: 'synthetic-org', interactionId: expect.any(String) }));
    const workEvent = emit.mock.calls.map(call => call[1]).find(event => event.domain === 'work');
    await closeDatabase();
    await initDatabase();
    const stored = readDB().interactions.find((row: any) => row.id === workEvent.interactionId);
    expect(JSON.parse(stored.toolCalls)).toMatchObject({ scheduledTaskId: 'reminder_check', reminderIds: [work.id] });
    const metadata = JSON.parse(stored.toolCalls);
    stored.toolCalls = JSON.stringify({ ...metadata, proactiveVoiceDispatch: { reservation: 'synthetic-reservation', reservedAt: now }, untrustedExtra: 'must not survive' });
    writeDB(readDB());
    await closeDatabase();
    await initDatabase();
    const restoredMetadata = JSON.parse(readDB().interactions.find((row: any) => row.id === workEvent.interactionId).toolCalls);
    expect(restoredMetadata.proactiveVoiceDispatch).toEqual({ reservation: 'synthetic-reservation', reservedAt: now });
    expect(restoredMetadata).not.toHaveProperty('untrustedExtra');
  });
});
