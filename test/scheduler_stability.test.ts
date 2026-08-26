import './helpers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  getScheduledTaskExecutionContract,
  getScheduledTaskTimeoutMs,
  parseSchedule,
  redactSchedulerDiagnostic,
  requiresStrictScheduledPersistence,
  runAgentAutonomousAnalysis,
  Scheduler,
  type ScheduledTask,
  type ScheduledTaskExecutionContext,
} from '../server/scheduler';
import {
  resetRealtimeUserActivityForTests,
  setRealtimeVoiceSessionActive,
} from '../server/autonomy/foreground_activity';
import { saveGateConfig } from '../server/autonomy/safety_gate';

describe('scheduler stability', () => {
  beforeAll(async () => {
    const { initDatabase } = await import('../db_layer');
    await initDatabase();
  });
  afterEach(() => resetRealtimeUserActivityForTests());

  it('maps every built-in alias to its intended cadence', () => {
    expect(parseSchedule('every_10s')).toEqual({ type: 'interval', intervalMs: 10_000 });
    expect(parseSchedule('every_1m')).toEqual({ type: 'interval', intervalMs: 60_000 });
    expect(parseSchedule('every_10m')).toEqual({ type: 'interval', intervalMs: 600_000 });
    expect(parseSchedule('every_hour')).toEqual({ type: 'interval', intervalMs: 3_600_000 });
    expect(parseSchedule('every_24h')).toEqual({ type: 'interval', intervalMs: 86_400_000 });
  });

  it('uses wall-clock schedules for morning and evening jobs', () => {
    expect(parseSchedule('daily_9am')).toEqual({ type: 'cron', fields: [0, 9, -1, -1, -1] });
    expect(parseSchedule('evening_8pm')).toEqual({ type: 'cron', fields: [0, 20, -1, -1, -1] });
  });

  it('rejects invalid schedules instead of silently running them hourly', () => {
    expect(() => parseSchedule('every_sometime')).toThrow(/Unsupported schedule/);
    expect(() => parseSchedule('99 24 * * *')).toThrow(/out of range/);
    expect(() => parseSchedule('*/5 * * * *')).toThrow(/Unsupported cron field/);
  });

  it('declares bounded execution, evidence, retry, stopping, and concurrency contracts', () => {
    expect(getScheduledTaskTimeoutMs('client_probe')).toBe(30_000);
    expect(getScheduledTaskTimeoutMs('maintenance')).toBe(300_000);
    expect(getScheduledTaskTimeoutMs('autonomous_orchestration')).toBe(900_000);
    expect(getScheduledTaskTimeoutMs('maintenance', 75)).toBe(75);

    const contract = getScheduledTaskExecutionContract({
      executionClass: 'autonomous_orchestration',
      timeoutMs: 125,
    });
    expect(contract).toMatchObject({
      timeoutMs: 125,
      outcome: 'durable_terminal_receipt',
      retry: { maxRetriesPerSlot: 0, onUnknownOutcome: 'reconcile_then_stop' },
      concurrency: { maxConcurrentRuns: 1, policy: 'skip_while_running' },
      finalAcceptance: 'scheduler_persisted_verified_terminal_receipt',
    });
    expect(contract.successCriteria).toContain('verified_terminal_receipt_persisted');
    expect(contract.evidence).toContain('scheduler_task_handler_terminal_receipt');
    expect(contract.stopping).toContain('wall_clock_timeout');
  });

  it('keeps the in-flight fence when a timed-out legacy handler ignores abort', async () => {
    // Keep the deadline focused on the deliberately non-cooperative handler;
    // the real database flush can legitimately take longer on a busy CI host.
    const scheduler = new Scheduler(async () => {});
    const taskId = `test_scheduler_timeout_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    let handlerSignal: AbortSignal | null = null;
    let settle!: () => void;
    const legacyHandlerGate = new Promise<void>(resolve => { settle = resolve; });
    const handler = vi.fn(async (context?: ScheduledTaskExecutionContext) => {
      handlerSignal = context!.signal;
      await legacyHandlerGate;
      return null;
    });
    const task: ScheduledTask = {
      id: taskId,
      cron: 'every_hour',
      lastRun: null,
      executionClass: 'maintenance',
      timeoutMs: 25,
      handler,
    };
    try {
      scheduler.register(task);
      await (scheduler as any).runTask(task);

      expect(handlerSignal?.aborted).toBe(true);
      expect((scheduler as any).runningTasks.has(taskId)).toBe(true);
      expect(scheduler.listTasks()).toEqual([
        expect.objectContaining({
          id: taskId,
          lastStatus: 'unknown',
          running: true,
          active: false,
          settlementPending: true,
          requiresReconciliation: true,
          timeoutMs: 25,
          persistenceStatus: 'coalesced',
        }),
      ]);
      await (scheduler as any).runTask(task);
      expect(handler).toHaveBeenCalledOnce();

      const { readDB } = await import('../db_layer');
      const db = readDB();
      const setting = (db.settings || []).find((candidate: any) => (
        candidate.key === 'scheduler_task_runtime_state_v1'
      ));
      const persisted = JSON.parse(setting.value)[taskId];
      expect(persisted).toMatchObject({
        lastStatus: 'unknown',
      });
      expect(persisted.lastRun).toBeNull();
      expect(persisted.lastDurationMs).toBeGreaterThanOrEqual(20);
      const ledgerTask = (db.conversationActionTasks || []).find((candidate: any) => candidate.target === taskId);
      expect(ledgerTask).toMatchObject({ status: 'executing' });
      expect(ledgerTask.blocker).toContain('wall-clock deadline');
      expect(ledgerTask.blocker).toContain('outcome remains unknown');

      const recoveredHandler = vi.fn(async () => null);
      const recoveredScheduler = new Scheduler(async () => {});
      try {
        recoveredScheduler.register({ ...task, handler: recoveredHandler });
        expect(recoveredScheduler.listTasks()[0]).toMatchObject({
          lastStatus: 'unknown',
          active: false,
          requiresReconciliation: true,
        });
        await (recoveredScheduler as any).runTask((recoveredScheduler as any).tasks[0]);
        expect(recoveredHandler).not.toHaveBeenCalled();
      } finally {
        recoveredScheduler.stop();
      }

      settle();
      await vi.waitFor(() => expect((scheduler as any).runningTasks.has(taskId)).toBe(false));
      expect(scheduler.listTasks()[0]).toMatchObject({
        lastStatus: 'unknown',
        running: false,
        active: false,
        requiresReconciliation: true,
        lastRun: expect.any(String),
        lastError: expect.stringContaining('late result was discarded'),
      });
      expect(ledgerTask).toMatchObject({ status: 'blocked' });
      await expect(scheduler.reconcileTask(taskId, 'accepted_unknown_outcome')).resolves.toMatchObject({
        reconciled: true,
        reason: 'reconciled',
      });
      expect(scheduler.listTasks()[0]).toMatchObject({
        active: true,
        requiresReconciliation: false,
        reconciliationResolution: 'accepted_unknown_outcome',
      });
    } finally {
      settle?.();
      scheduler.stop();
    }
  });

  it('keeps non-cooperative handlers cancelling after stop until they truly settle', async () => {
    const scheduler = new Scheduler();
    const taskId = `test_scheduler_stop_fence_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    let started!: () => void;
    let settle!: () => void;
    const didStart = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { settle = resolve; });
    const handler = vi.fn(async () => {
      started();
      await gate;
      return null;
    });
    const task: ScheduledTask = {
      id: taskId,
      cron: 'every_hour',
      lastRun: null,
      executionClass: 'maintenance',
      timeoutMs: 1_000,
      handler,
    };
    try {
      scheduler.register(task);
      const run = (scheduler as any).runTask(task);
      await didStart;
      scheduler.stop();
      await run;

      expect(handler).toHaveBeenCalledOnce();
      expect(scheduler.listTasks()[0]).toMatchObject({
        lastStatus: 'cancelling',
        running: true,
        lastRun: null,
        lastError: expect.stringContaining('side-effect outcome remains unknown'),
      });
      const { readDB } = await import('../db_layer');
      let db = readDB();
      let ledgerTask = (db.conversationActionTasks || []).find((candidate: any) => candidate.target === taskId);
      expect(ledgerTask).toMatchObject({ status: 'executing' });

      settle();
      await vi.waitFor(() => expect(scheduler.listTasks()[0]).toMatchObject({
        lastStatus: 'unknown',
        running: false,
        lastRun: expect.any(String),
        lastError: expect.stringContaining('after cancellation was requested'),
      }));
      db = readDB();
      ledgerTask = (db.conversationActionTasks || []).find((candidate: any) => candidate.target === taskId);
      expect(ledgerTask).toMatchObject({ status: 'blocked' });
      expect(ledgerTask.blocker).toContain('side-effect outcome remains unknown');
    } finally {
      settle?.();
      scheduler.stop();
    }
  });

  it('keeps the same settlement fence when a running task is disabled or replaced', async () => {
    for (const mode of ['disable', 'replace'] as const) {
      const scheduler = new Scheduler();
      const taskId = `test_scheduler_${mode}_fence_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      let started!: () => void;
      let settle!: () => void;
      const didStart = new Promise<void>(resolve => { started = resolve; });
      const gate = new Promise<void>(resolve => { settle = resolve; });
      const task: ScheduledTask = {
        id: taskId,
        cron: 'every_hour',
        lastRun: null,
        executionClass: 'maintenance',
        timeoutMs: 1_000,
        handler: async () => {
          started();
          await gate;
          return null;
        },
      };
      const replacementHandler = vi.fn(async () => null);
      try {
        scheduler.register(task);
        const run = (scheduler as any).runTask(task);
        await didStart;
        if (mode === 'disable') {
          expect(scheduler.disableTask(taskId)).toBe(true);
        } else {
          scheduler.register({ ...task, lastRun: null, handler: replacementHandler });
        }
        await run;
        expect(scheduler.listTasks()[0]).toMatchObject({
          lastStatus: 'cancelling',
          running: true,
        });
        await (scheduler as any).runTask((scheduler as any).tasks[0]);
        expect(replacementHandler).not.toHaveBeenCalled();

        settle();
        await vi.waitFor(() => expect(scheduler.listTasks()[0]).toMatchObject({
          lastStatus: 'unknown',
          running: false,
          lastError: expect.stringContaining('side-effect outcome remains unknown'),
        }));
      } finally {
        settle?.();
        scheduler.stop();
      }
    }
  });

  it('does not let a stopped cron closure schedule another generation', async () => {
    const scheduler = new Scheduler();
    const taskId = `test_scheduler_cron_stop_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    let started!: () => void;
    let settle!: () => void;
    const didStart = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { settle = resolve; });
    const task: ScheduledTask = {
      id: taskId,
      cron: '0 0 * * *',
      lastRun: null,
      executionClass: 'maintenance',
      timeoutMs: 1_000,
      handler: async () => {
        started();
        await gate;
        return null;
      },
    };
    try {
      scheduler.register(task);
      const timer = (scheduler as any).timers.get(taskId) as NodeJS.Timeout;
      expect(timer).toBeTruthy();
      (timer as any)._onTimeout();
      await didStart;
      scheduler.stop();
      settle();
      await vi.waitFor(() => expect((scheduler as any).runningTasks.has(taskId)).toBe(false));
      await Promise.resolve();
      expect((scheduler as any).timers.size).toBe(0);
    } finally {
      settle?.();
      scheduler.stop();
    }
  });

  it('invalidates an old cron closure across same-object registration and disable-enable', async () => {
    for (const mode of ['register', 'disable-enable'] as const) {
      const scheduler = new Scheduler(async () => {});
      const taskId = `test_scheduler_cron_revision_${mode}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      let started!: () => void;
      let settle!: () => void;
      const didStart = new Promise<void>(resolve => { started = resolve; });
      const gate = new Promise<void>(resolve => { settle = resolve; });
      const task: ScheduledTask = {
        id: taskId,
        cron: '0 0 * * *',
        lastRun: null,
        executionClass: 'maintenance',
        timeoutMs: 1_000,
        handler: async () => {
          started();
          await gate;
          return null;
        },
      };
      const scheduleSpy = vi.spyOn(scheduler as any, 'setTaskTimeout');
      try {
        scheduler.register(task);
        const firstTimer = (scheduler as any).timers.get(taskId) as NodeJS.Timeout;
        (firstTimer as any)._onTimeout();
        await didStart;

        if (mode === 'register') {
          scheduler.register(task);
        } else {
          expect(scheduler.disableTask(taskId)).toBe(true);
          expect(scheduler.enableTask(taskId)).toBe(true);
        }
        settle();
        await vi.waitFor(() => expect(scheduler.listTasks()[0]).toMatchObject({
          running: false,
          active: false,
          requiresReconciliation: true,
        }));

        await expect(scheduler.reconcileTask(taskId, 'accepted_unknown_outcome')).resolves.toMatchObject({
          reconciled: true,
        });
        const reconciledTimer = (scheduler as any).timers.get(taskId);
        expect(reconciledTimer).toBeTruthy();
        await Promise.resolve();
        expect((scheduler as any).timers.get(taskId)).toBe(reconciledTimer);
        // The old closure must never append an extra timer after settlement.
        // Re-registration hydrates the durable quarantine before scheduling;
        // disable-enable briefly schedules once, then the pending fence clears it.
        expect(scheduleSpy).toHaveBeenCalledTimes(mode === 'register' ? 2 : 3);
      } finally {
        settle?.();
        scheduler.stop();
      }
    }
  });

  it('keeps admission persistence failed and closes the executing ledger when strict flush rejects', async () => {
    const flush = vi.fn(async () => { throw new Error('strict flush failed token=admission-secret'); });
    const scheduler = new Scheduler(flush);
    const taskId = `test_scheduler_admission_failure_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const handler = vi.fn(async () => null);
    const task: ScheduledTask = {
      id: taskId,
      cron: 'every_hour',
      lastRun: null,
      executionClass: 'maintenance',
      handler,
    };
    try {
      scheduler.register(task);
      await (scheduler as any).runTask(task);
      expect(flush).toHaveBeenCalledOnce();
      expect(handler).not.toHaveBeenCalled();
      expect(scheduler.listTasks()[0]).toMatchObject({
        lastStatus: 'blocked',
        persistenceStatus: 'failed',
        lastPersistenceError: expect.stringContaining('[REDACTED]'),
        lastError: expect.stringContaining('handler was not started'),
        running: false,
      });
      // A later coalesced metadata write (for example nextRun/disable state)
      // cannot falsely heal a failed strict durability boundary.
      (scheduler as any).persistRuntimeState(task);
      expect(scheduler.listTasks()[0]).toMatchObject({
        persistenceStatus: 'failed',
        lastPersistenceError: expect.stringContaining('[REDACTED]'),
      });
      const { readDB } = await import('../db_layer');
      const db = readDB();
      const ledgerTask = (db.conversationActionTasks || []).find((candidate: any) => candidate.target === taskId);
      expect(ledgerTask).toMatchObject({ status: 'blocked' });
      expect(ledgerTask.blocker).toContain('handler was not started');
      const setting = (db.settings || []).find((candidate: any) => (
        candidate.key === 'scheduler_task_runtime_state_v1'
      ));
      expect(JSON.parse(setting.value)[taskId]).toMatchObject({
        lastStatus: 'blocked',
        persistenceStatus: 'failed',
        lastPersistenceError: expect.stringContaining('[REDACTED]'),
      });
      const restoredScheduler = new Scheduler(async () => {});
      try {
        restoredScheduler.register({ ...task, handler: vi.fn(async () => null) });
        expect(restoredScheduler.listTasks()[0]).toMatchObject({
          lastStatus: 'blocked',
          persistenceStatus: 'failed',
          lastPersistenceError: expect.stringContaining('[REDACTED]'),
        });
      } finally {
        restoredScheduler.stop();
      }
    } finally {
      scheduler.stop();
    }
  });

  it('bounds delivery persistence, suppresses late emission, and records unknown outcome', async () => {
    let flushCount = 0;
    let releaseDeliveryFlush!: () => void;
    const deliveryFlushGate = new Promise<void>(resolve => { releaseDeliveryFlush = resolve; });
    const scheduler = new Scheduler(async () => {
      flushCount += 1;
      if (flushCount === 2) await deliveryFlushGate;
    });
    const emit = vi.fn();
    scheduler.setIO({ to: vi.fn(() => ({ emit })) } as any);
    const taskId = `test_scheduler_delivery_deadline_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const task: ScheduledTask = {
      id: taskId,
      cron: 'every_hour',
      lastRun: null,
      executionClass: 'proactive_delivery',
      timeoutMs: 60,
      handler: vi.fn(async () => [{
        userId: 'scheduler-user',
        message: 'Good morning. It may rain today, so take an umbrella.',
        domain: 'personal' as const,
        modelGenerated: true,
      }]),
    };
    try {
      scheduler.register(task);
      await (scheduler as any).runTask(task);
      expect(flushCount).toBe(2);
      expect(emit).not.toHaveBeenCalled();
      expect(scheduler.listTasks()[0]).toMatchObject({
        lastStatus: 'unknown',
        running: true,
        settlementPending: true,
        requiresReconciliation: true,
        lastError: expect.stringContaining('durable delivery persistence is still settling'),
      });
      await expect(scheduler.reconcileTask(taskId, 'accepted_unknown_outcome')).resolves.toMatchObject({
        reconciled: false,
        reason: 'durable_operation_still_settling',
      });
      await (scheduler as any).runTask(task);
      expect(task.handler).toHaveBeenCalledOnce();
      const { readDB } = await import('../db_layer');
      let db = readDB();
      expect((db.interactions || []).some((candidate: any) => candidate.message?.includes(`[${taskId}]`))).toBe(false);
      releaseDeliveryFlush();
      await vi.waitFor(() => expect(scheduler.listTasks()[0]).toMatchObject({
        lastStatus: 'unknown',
        running: false,
        settlementPending: false,
        requiresReconciliation: true,
        lastError: expect.stringContaining('late result was discarded'),
      }));
      expect(flushCount).toBe(3);
      db = readDB();
      expect((db.interactions || []).some((candidate: any) => candidate.message?.includes(`[${taskId}]`))).toBe(false);
      const ledgerTask = (db.conversationActionTasks || []).find((candidate: any) => candidate.target === taskId);
      expect(ledgerTask).toMatchObject({ status: 'blocked' });
    } finally {
      releaseDeliveryFlush?.();
      scheduler.stop();
    }
  });

  it('bounds terminal strict persistence and rolls back a premature completed ledger', async () => {
    let flushCount = 0;
    let releaseTerminalFlush!: () => void;
    const terminalFlushGate = new Promise<void>(resolve => { releaseTerminalFlush = resolve; });
    const scheduler = new Scheduler(async () => {
      flushCount += 1;
      if (flushCount === 2) await terminalFlushGate;
    });
    const taskId = `test_scheduler_terminal_deadline_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const task: ScheduledTask = {
      id: taskId,
      cron: 'every_hour',
      lastRun: null,
      executionClass: 'maintenance',
      timeoutMs: 60,
      handler: vi.fn(async () => null),
      auditMode: 'full',
    };
    try {
      scheduler.register(task);
      await (scheduler as any).runTask(task);
      expect(flushCount).toBe(2);
      expect(scheduler.listTasks()[0]).toMatchObject({
        lastStatus: 'unknown',
        running: true,
        settlementPending: true,
        requiresReconciliation: true,
        lastError: expect.stringContaining('durable terminal persistence is still settling'),
      });
      await expect(scheduler.reconcileTask(taskId, 'accepted_unknown_outcome')).resolves.toMatchObject({
        reconciled: false,
        reason: 'durable_operation_still_settling',
      });
      await (scheduler as any).runTask(task);
      expect(task.handler).toHaveBeenCalledOnce();
      const { readDB } = await import('../db_layer');
      let db = readDB();
      let ledgerTask = (db.conversationActionTasks || []).find((candidate: any) => (
        candidate.id.startsWith('scheduler_') && candidate.target === taskId
      ));
      expect(ledgerTask.status).not.toBe('completed');
      releaseTerminalFlush();
      await vi.waitFor(() => expect(scheduler.listTasks()[0]).toMatchObject({
        lastStatus: 'unknown',
        running: false,
        settlementPending: false,
        requiresReconciliation: true,
        lastError: expect.stringContaining('late result was discarded'),
      }));
      db = readDB();
      ledgerTask = (db.conversationActionTasks || []).find((candidate: any) => (
        candidate.id.startsWith('scheduler_') && candidate.target === taskId
      ));
      expect(ledgerTask).toMatchObject({ status: 'blocked', completionSource: '' });
      expect(ledgerTask.completedAt).toBe('');
    } finally {
      releaseTerminalFlush?.();
      scheduler.stop();
    }
  });

  it('does not publish completed until the strict terminal boundary resolves', async () => {
    let flushCount = 0;
    let terminalFlushStarted!: () => void;
    let releaseTerminalFlush!: () => void;
    const didStartTerminalFlush = new Promise<void>(resolve => { terminalFlushStarted = resolve; });
    const terminalFlushGate = new Promise<void>(resolve => { releaseTerminalFlush = resolve; });
    const scheduler = new Scheduler(async () => {
      flushCount += 1;
      if (flushCount === 2) {
        terminalFlushStarted();
        await terminalFlushGate;
      }
    });
    const task: ScheduledTask = {
      id: `test_scheduler_terminal_publication_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      cron: 'every_hour',
      lastRun: null,
      executionClass: 'maintenance',
      timeoutMs: 1_000,
      handler: async () => null,
    };
    try {
      scheduler.register(task);
      const run = (scheduler as any).runTask(task);
      await didStartTerminalFlush;
      expect(scheduler.listTasks()[0]).toMatchObject({
        lastStatus: 'executing',
        running: true,
      });
      releaseTerminalFlush();
      await run;
      expect(scheduler.listTasks()[0]).toMatchObject({
        lastStatus: 'completed',
        running: false,
      });
    } finally {
      releaseTerminalFlush?.();
      scheduler.stop();
    }
  });

  it('persists a proactive delivery batch atomically and leaves every row retryable after commit failure', async () => {
    const { readDB, writeDB } = await import('../db_layer');
    const taskId = `test_scheduler_atomic_delivery_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const executionId = `${taskId}:execution`;
    let failedCandidateOnce = false;
    const targetCounts: number[] = [];
    const databaseWriter = vi.fn((candidateDb: any) => {
      const targetCount = (candidateDb.interactions || []).filter((candidate: any) => (
        candidate.message?.startsWith(`[${taskId}]`)
      )).length;
      targetCounts.push(targetCount);
      writeDB(candidateDb);
      if (!failedCandidateOnce && targetCount === 2) {
        failedCandidateOnce = true;
        throw new Error('simulated batch commit failure after candidate swap');
      }
    });
    const scheduler = new Scheduler(async () => {}, databaseWriter);
    const deliveries = [
      {
        deliveryIndex: 0,
        delivery: { userId: 'atomic-user', message: 'first atomic result', domain: 'personal' as const },
      },
      {
        deliveryIndex: 1,
        delivery: { userId: 'atomic-user', message: 'second atomic result', domain: 'personal' as const },
      },
    ];
    try {
      expect(() => (scheduler as any).persistProactiveMessageBatch(
        taskId,
        executionId,
        deliveries,
        new Date().toISOString(),
      )).toThrow('simulated batch commit failure');
      expect((readDB().interactions || []).filter((candidate: any) => (
        candidate.message?.startsWith(`[${taskId}]`)
      ))).toHaveLength(0);
      expect(targetCounts).not.toContain(1);

      const retry = (scheduler as any).persistProactiveMessageBatch(
        taskId,
        executionId,
        deliveries,
        new Date().toISOString(),
      );
      expect(retry.createdInteractionIds).toHaveLength(2);
      expect([...retry.createdDeliveryIndexes]).toEqual([0, 1]);
      expect((readDB().interactions || []).filter((candidate: any) => (
        candidate.message?.startsWith(`[${taskId}]`)
      ))).toHaveLength(2);
      (scheduler as any).rollbackProactiveMessageBatch(retry.createdInteractionIds);
    } finally {
      scheduler.stop();
    }
  });

  it('delivers work-scoped proactive results only to the addressed user inside the organization', async () => {
    const scheduler = new Scheduler(async () => {});
    const emit = vi.fn();
    const to = vi.fn((_room: string) => ({ emit }));
    scheduler.setIO({ to } as any);
    const taskId = `test_scheduler_work_delivery_room_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const task: ScheduledTask = {
      id: taskId,
      cron: 'every_hour',
      lastRun: null,
      executionClass: 'proactive_delivery',
      handler: async () => [{
        userId: 'work-user-a',
        message: 'Private work result for user A.',
        domain: 'work',
        orgId: 'shared-org',
      }],
    };
    try {
      scheduler.register(task);
      await (scheduler as any).runTask(task);
      const rooms = to.mock.calls.map(call => call[0]);
      expect(rooms).toContain('user:work-user-a:org:shared-org');
      expect(rooms).not.toContain('org:shared-org');
      expect(rooms).not.toContain('user:work-user-b:org:shared-org');
      expect(emit).toHaveBeenCalledWith('agent:proactive', expect.objectContaining({
        taskId,
        domain: 'work',
        orgId: 'shared-org',
      }));
    } finally {
      scheduler.stop();
    }
  });

  it('redacts secrets before errors reach runtime state, persistence, listTasks, or logs', async () => {
    const scheduler = new Scheduler();
    const taskId = `test_scheduler_redaction_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const secrets = [
      'bearer-value-123',
      'basic-value-234',
      'sk-live-secret123',
      'api-value-456',
      'password-value-789',
      'session-cookie-value',
      'generic-token-value',
      'url-password-value',
      'pem-private-value',
    ];
    const rawError = [
      `Bearer ${secrets[0]}`,
      `Authorization: Basic ${secrets[1]}`,
      secrets[2],
      `apiKey=${secrets[3]}`,
      `password=${secrets[4]}`,
      `cookie=${secrets[5]}`,
      `token=${secrets[6]}`,
      `postgres://service:${secrets[7]}@db.internal:5432/lumi`,
      `-----BEGIN PRIVATE KEY-----\n${secrets[8]}\n-----END PRIVATE KEY-----`,
    ].join(' ');
    const redacted = redactSchedulerDiagnostic(rawError);
    expect(redacted).toContain('[REDACTED]');
    expect(redactSchedulerDiagnostic(redacted)).toBe(redacted);
    for (const secret of secrets) expect(redacted).not.toContain(secret);

    const task: ScheduledTask = {
      id: taskId,
      cron: 'every_hour',
      lastRun: null,
      executionClass: 'maintenance',
      handler: async () => { throw new Error(rawError); },
    };
    try {
      scheduler.register(task);
      await (scheduler as any).runTask(task);
      const listed = JSON.stringify(scheduler.listTasks()[0]);
      for (const secret of secrets) expect(listed).not.toContain(secret);
      expect(listed).toContain('[REDACTED]');

      const { readDB } = await import('../db_layer');
      const db = readDB();
      const setting = (db.settings || []).find((candidate: any) => (
        candidate.key === 'scheduler_task_runtime_state_v1'
      ));
      const snapshot = JSON.stringify(JSON.parse(setting.value)[taskId]);
      for (const secret of secrets) expect(snapshot).not.toContain(secret);
      const logged = JSON.stringify(warning.mock.calls);
      for (const secret of secrets) expect(logged).not.toContain(secret);
    } finally {
      warning.mockRestore();
      scheduler.stop();
    }
  });

  it('blocks completion in every execution class when all declared deliveries are withheld', async () => {
    const scheduler = new Scheduler();
    const taskId = `test_scheduler_withheld_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const task: ScheduledTask = {
      id: taskId,
      cron: 'every_hour',
      lastRun: null,
      executionClass: 'client_probe',
      deliveryPolicy: 'scoped',
      handler: async () => [{
        userId: 'scheduler-user',
        message: 'I have already opened WeChat and sent the message.',
        domain: 'personal',
        modelGenerated: true,
      }],
    };
    try {
      scheduler.register(task);
      await (scheduler as any).runTask(task);
      expect(scheduler.listTasks()[0]).toMatchObject({
        lastStatus: 'blocked',
        lastError: 'Every declared proactive delivery was withheld by terminal output verification.',
      });
      const { readDB } = await import('../db_layer');
      const db = readDB();
      const ledgerTask = (db.conversationActionTasks || []).find((candidate: any) => candidate.target === taskId);
      expect(ledgerTask).toMatchObject({ status: 'blocked' });
      expect(ledgerTask.blocker).toContain('Every declared proactive delivery was withheld');
      const receiptEnvelope = (db.conversationActionReceipts || [])
        .map((candidate: any) => JSON.parse(candidate.envelope))
        .find((candidate: any) => candidate.result?.scheduledTaskId === taskId);
      expect(receiptEnvelope).toMatchObject({
        status: 'failed',
        result: {
          status: 'blocked',
          verified: false,
          successCriteriaMet: [],
          stoppingReason: 'delivery_verification_blocked',
        },
      });
      expect((db.interactions || []).some((candidate: any) => candidate.message?.includes(`[${taskId}]`))).toBe(false);
    } finally {
      scheduler.stop();
    }
  });

  it('rejects malformed and unscoped work deliveries before any persistence or emission', async () => {
    for (const delivery of [
      { userId: 'scheduler-user', message: 'work result', domain: 'work' },
      { userId: '', message: 'missing recipient', domain: 'personal' },
      { userId: 'scheduler-user', message: '', domain: 'personal' },
    ] as any[]) {
      const scheduler = new Scheduler(async () => {});
      const emit = vi.fn();
      const to = vi.fn(() => ({ emit }));
      scheduler.setIO({ to } as any);
      const taskId = `test_scheduler_invalid_delivery_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const task: ScheduledTask = {
        id: taskId,
        cron: 'every_hour',
        lastRun: null,
        executionClass: 'proactive_delivery',
        handler: async () => [delivery],
      };
      try {
        scheduler.register(task);
        await (scheduler as any).runTask(task);
        expect(scheduler.listTasks()[0]).toMatchObject({
          lastStatus: 'blocked',
          lastError: expect.stringContaining('recipient, message, or scope was invalid'),
        });
        expect(to).not.toHaveBeenCalled();
        expect(emit).not.toHaveBeenCalled();
        const { readDB } = await import('../db_layer');
        expect((readDB().interactions || []).some((candidate: any) => (
          candidate.message?.includes(`[${taskId}]`)
        ))).toBe(false);
      } finally {
        scheduler.stop();
      }
    }

    const scheduler = new Scheduler(async () => {});
    const emit = vi.fn();
    scheduler.setIO({ to: vi.fn(() => ({ emit })) } as any);
    const taskId = `test_scheduler_mixed_invalid_delivery_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const task: ScheduledTask = {
      id: taskId,
      cron: 'every_hour',
      lastRun: null,
      executionClass: 'proactive_delivery',
      handler: async () => [
        { userId: 'scheduler-user', message: 'valid personal result', domain: 'personal' },
        { userId: 'scheduler-user', message: 'invalid work result', domain: 'work' },
      ] as any,
    };
    try {
      scheduler.register(task);
      await (scheduler as any).runTask(task);
      expect(scheduler.listTasks()[0].lastStatus).toBe('blocked');
      expect(emit).not.toHaveBeenCalled();
      const { readDB } = await import('../db_layer');
      expect((readDB().interactions || []).some((candidate: any) => (
        candidate.message?.includes(`[${taskId}]`)
      ))).toBe(false);
    } finally {
      scheduler.stop();
    }
  });

  it('keeps high-frequency client probes within a zero strict-flush budget', async () => {
    let strictFlushCount = 0;
    const scheduler = new Scheduler(async () => { strictFlushCount += 1; });
    const taskId = `test_scheduler_probe_budget_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const task: ScheduledTask = {
      id: taskId,
      cron: 'every_10s',
      lastRun: null,
      executionClass: 'client_probe',
      handler: async () => null,
    };
    try {
      expect(requiresStrictScheduledPersistence('client_probe')).toBe(false);
      expect(requiresStrictScheduledPersistence('client_probe', true)).toBe(true);
      expect(requiresStrictScheduledPersistence('proactive_delivery')).toBe(true);
      scheduler.register(task);
      await (scheduler as any).runTask(task);
      expect(strictFlushCount).toBe(0);
      expect(scheduler.listTasks()[0]).toMatchObject({
        lastStatus: 'completed',
        persistenceStatus: 'coalesced',
        executionContract: {
          outcome: 'coalesced_probe_receipt',
          finalAcceptance: 'scheduler_coalesced_verified_probe_receipt',
        },
      });
    } finally {
      scheduler.stop();
    }

    let businessFlushCount = 0;
    const businessScheduler = new Scheduler(async () => { businessFlushCount += 1; });
    const businessTask: ScheduledTask = {
      id: `test_scheduler_durable_budget_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      cron: 'every_hour',
      lastRun: null,
      executionClass: 'maintenance',
      handler: async () => null,
    };
    try {
      businessScheduler.register(businessTask);
      await (businessScheduler as any).runTask(businessTask);
      expect(businessFlushCount).toBe(2);
      expect(businessScheduler.listTasks()[0]).toMatchObject({
        lastStatus: 'completed',
        persistenceStatus: 'ok',
      });
    } finally {
      businessScheduler.stop();
    }
  });

  it('fixes a client-probe delivery contract before admission instead of upgrading it afterward', async () => {
    let flushCount = 0;
    let handlerContract: ScheduledTaskExecutionContext['contract'] | null = null;
    const scheduler = new Scheduler(async () => { flushCount += 1; });
    scheduler.setIO({ to: vi.fn(() => ({ emit: vi.fn() })) } as any);
    const task: ScheduledTask = {
      id: `test_scheduler_probe_delivery_contract_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      cron: 'every_hour',
      lastRun: null,
      executionClass: 'client_probe',
      deliveryPolicy: 'scoped',
      handler: async context => {
        handlerContract = context!.contract;
        return [{
          userId: 'scheduler-user',
          message: 'Scoped probe result.',
          domain: 'personal',
        }];
      },
    };
    try {
      scheduler.register(task);
      expect(scheduler.listTasks()[0].executionContract).toMatchObject({
        outcome: 'durable_terminal_receipt',
        finalAcceptance: 'scheduler_persisted_verified_terminal_receipt',
      });
      await (scheduler as any).runTask(task);
      expect(handlerContract).toMatchObject({
        outcome: 'durable_terminal_receipt',
        finalAcceptance: 'scheduler_persisted_verified_terminal_receipt',
      });
      expect(scheduler.listTasks()[0]).toMatchObject({
        lastStatus: 'completed',
        persistenceStatus: 'ok',
      });
      // Admission, delivery, and terminal acceptance share the same strict contract.
      expect(flushCount).toBe(3);
    } finally {
      scheduler.stop();
    }
  });

  it('blocks an undeclared client-probe delivery without emitting it', async () => {
    const scheduler = new Scheduler(async () => {});
    const emit = vi.fn();
    scheduler.setIO({ to: vi.fn(() => ({ emit })) } as any);
    const task: ScheduledTask = {
      id: `test_scheduler_probe_undeclared_delivery_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      cron: 'every_hour',
      lastRun: null,
      executionClass: 'client_probe',
      handler: async () => [{
        userId: 'scheduler-user',
        message: 'Undeclared result.',
        domain: 'personal',
      }],
    };
    try {
      scheduler.register(task);
      await (scheduler as any).runTask(task);
      expect(scheduler.listTasks()[0]).toMatchObject({
        lastStatus: 'blocked',
        lastError: expect.stringContaining('deliveryPolicy="scoped"'),
      });
      expect(emit).not.toHaveBeenCalled();
    } finally {
      scheduler.stop();
    }
  });

  it('accepts completion only with a persisted terminal receipt and restores runtime status', async () => {
    const scheduler = new Scheduler();
    const taskId = `test_scheduler_terminal_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const handler = vi.fn(async () => null);
    const task: ScheduledTask = {
      id: taskId,
      cron: 'every_hour',
      lastRun: null,
      executionClass: 'maintenance',
      handler,
    };
    scheduler.register(task);
    await (scheduler as any).runTask(task);

    const completed = scheduler.listTasks()[0];
    expect(completed).toMatchObject({
      id: taskId,
      lastStatus: 'completed',
      lastError: null,
      running: false,
      persistenceStatus: 'ok',
    });
    expect(completed.lastRun).toEqual(expect.any(String));
    expect(completed.lastDurationMs).toEqual(expect.any(Number));
    expect(completed.nextRun).toEqual(expect.any(String));
    expect(handler).toHaveBeenCalledOnce();
    scheduler.stop();
    expect(scheduler.listTasks()[0].nextRun).toBeNull();

    const { readDB } = await import('../db_layer');
    const db = readDB();
    const ledgerTask = (db.conversationActionTasks || []).find((candidate: any) => candidate.target === taskId);
    expect(ledgerTask).toMatchObject({ status: 'completed', completionSource: 'tool_receipt' });
    const audit = JSON.parse(ledgerTask.context).schedulerAudit;
    expect(audit.lastOutcome).toBe('verified');

    const restoredScheduler = new Scheduler();
    const restoredTask: ScheduledTask = { ...task, lastRun: null, handler: vi.fn(async () => null) };
    try {
      restoredScheduler.register(restoredTask);
      expect(restoredScheduler.listTasks()[0]).toMatchObject({
        id: taskId,
        lastStatus: 'completed',
        lastRun: completed.lastRun,
        lastDurationMs: completed.lastDurationMs,
      });
    } finally {
      restoredScheduler.stop();
    }
  });

  it('admits only one concurrent run for a task', async () => {
    const scheduler = new Scheduler();
    const taskId = `test_scheduler_concurrency_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const handler = vi.fn(async () => {
      started();
      await gate;
      return null;
    });
    const task: ScheduledTask = {
      id: taskId,
      cron: 'every_hour',
      lastRun: null,
      executionClass: 'maintenance',
      timeoutMs: 1_000,
      handler,
    };
    try {
      scheduler.register(task);
      const first = (scheduler as any).runTask(task);
      await didStart;
      await (scheduler as any).runTask(task);
      expect(handler).toHaveBeenCalledOnce();
      expect(scheduler.listTasks()[0]).toMatchObject({ lastStatus: 'executing', running: true });
      release();
      await first;
      expect(scheduler.listTasks()[0]).toMatchObject({ lastStatus: 'completed', running: false });
    } finally {
      release?.();
      scheduler.stop();
    }
  });

  it('does not start an autonomous analysis while live voice is active', async () => {
    const userId = 'scheduler-live-voice-active';
    saveGateConfig({ autonomyLevel: 'full' }, userId);
    setRealtimeVoiceSessionActive(userId, 'socket-live', true);
    const analyze = vi.fn(async () => 'should not run');

    await expect(runAgentAutonomousAnalysis(userId, analyze)).resolves.toBe('');
    expect(analyze).not.toHaveBeenCalled();
  });

  it('aborts an in-flight autonomous analysis when live voice starts', async () => {
    const userId = 'scheduler-live-voice-race';
    saveGateConfig({ autonomyLevel: 'full' }, userId);
    let started!: () => void;
    const didStart = new Promise<void>(resolve => { started = resolve; });
    let providerSignal: AbortSignal | undefined;

    const analysis = runAgentAutonomousAnalysis(userId, signal => {
      providerSignal = signal;
      started();
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    await didStart;
    setRealtimeVoiceSessionActive(userId, 'socket-live', true);

    await expect(analysis).resolves.toBe('');
    expect(providerSignal?.aborted).toBe(true);
  });
});
