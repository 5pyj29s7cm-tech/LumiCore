import './helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ model: vi.fn(), failFlush: false, flushGate: null as Promise<void> | null }));
vi.mock('../server/llm/providers', async () => ({
  ...await vi.importActual<typeof import('../server/llm/providers')>('../server/llm/providers'),
  makeLLMCall: mocks.model,
}));
vi.mock('../server/llm/user_preferences', async () => ({
  ...await vi.importActual<typeof import('../server/llm/user_preferences')>('../server/llm/user_preferences'),
  getUserPreferredLLMConfig: () => ({ provider: 'deepseek', model: 'synthetic-model' }),
}));
vi.mock('../db_layer', async () => {
  const actual = await vi.importActual<typeof import('../db_layer')>('../db_layer');
  return { ...actual, flushDBOrThrow: async () => {
    if (mocks.failFlush) throw new Error('synthetic durability failure');
    if (mocks.flushGate) await mocks.flushGate;
    await actual.flushDBOrThrow();
  } };
});

import { closeDatabase, initDatabase, readDB } from '../db_layer';
import {
  cancelTask, checkpointAutonomousTask, claimAutonomousTask, enqueue, getAutonomousTaskPriorRecords,
  getRunningTask, getTaskHistory, getTaskQueue, heartbeatAutonomousTask, hydrateAutonomousTasksFromDb,
  markPaused, persistAutonomousTaskQueue, prepareAutonomousTaskAction, reconcileExpiredAutonomousTasks,
  recordAutonomousTaskFailure,
  recoverPersistedTask, registerAutonomousTaskExecutor, releaseAutonomousTaskExecutor,
  requestPauseAutonomousTask, resetAutonomousTaskQueueForTest, resumeAutonomousTask,
  settleAutonomousTaskAction, startAutonomousTaskAction,
} from '../server/autonomy/task_queue';
import { executeNextAutonomousTask } from '../server/autonomy/task_executor';
import { runWithTools } from '../server/llm/adapter';
import { resetRealtimeUserActivityForTests, setRealtimeVoiceSessionActive } from '../server/autonomy/foreground_activity';
import { executeToolCall, toolExecutionInputDigests } from '../server/tools/execution_engine';
import { resetExternalCommitRuntimeCacheForTests, ToolRegistry, toolRegistry } from '../server/tools/registry';
import type { ToolContext } from '../server/tools/types';

const owner = 'durable-lifecycle-synthetic-user';
function task() {
  return enqueue({ userId: owner, title: 'Create local reports', description: 'Create a pair of local text reports.', source: 'user_request', priority: 5, mode: 'analysis' })!;
}
function fixture() {
  const running = claimAutonomousTask(task().id)!;
  expect(registerAutonomousTaskExecutor(running.id, running.leaseId!)).toBe(true);
  const registry = new ToolRegistry();
  const handler = vi.fn(async (_args: Record<string, any>, _context?: ToolContext) => JSON.stringify({ ok: true, verified: true }));
  registry.register({ name: 'synthetic_mutation', description: 'Synthetic local step', permission: 'public', securityLevel: 'safe',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    evidence: { capability: 'synthetic.local', operation: 'mutate', assurance: 'verified' },
    capability: { operation: 'mutate', sideEffects: [{ type: 'local_write', scope: 'synthetic state', reversible: true }],
      verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok', 'verified'], requiredValues: { ok: true, verified: true }, successSignals: ['verified'], limitations: [] } },
    handler });
  const context: ToolContext = {
    userId: owner, taskId: running.id, userConfirmed: true,
    resolveToolIdempotencyKey: call => {
      const capability = registry.getCapabilityManifestEntry(call.name);
      return prepareAutonomousTaskAction(running.id, running.leaseId!, {
        callId: call.id, name: call.name, argumentsDigest: toolExecutionInputDigests(call.arguments).argumentsDigest,
        mayHaveSideEffects: !capability || !['observe', 'test'].includes(capability.operation)
          || capability.sideEffects.some(effect => !['none', 'local_read', 'network_read'].includes(effect.type)),
      });
    },
    onAdapterStart: call => startAutonomousTaskAction(running.id, running.leaseId!, call.idempotencyKey!),
  };
  const call = (id: string, value: string) => executeToolCall({ registry, name: 'synthetic_mutation', id, arguments: { value }, context });
  const settle = (record: Awaited<ReturnType<typeof call>>) => settleAutonomousTaskAction(running.id, running.leaseId!, record);
  return { running, registry, handler, call, settle, context };
}

beforeEach(async () => {
  mocks.failFlush = false;
  mocks.flushGate = null;
  mocks.model.mockReset();
  resetRealtimeUserActivityForTests();
  await initDatabase();
  resetAutonomousTaskQueueForTest({ clearPersisted: true, markHydrated: true });
  resetExternalCommitRuntimeCacheForTests();
});
afterEach(() => {
  vi.useRealTimers();
  mocks.failFlush = false;
  mocks.flushGate = null;
  resetExternalCommitRuntimeCacheForTests();
  resetAutonomousTaskQueueForTest({ clearPersisted: true, markHydrated: true });
  toolRegistry.unregister('write_file');
  resetRealtimeUserActivityForTests();
});

describe('autonomous durable action lifecycle', () => {
  it('runs two distinct writes through the actual autonomous executor and persists separate action keys', async () => {
    const handler = vi.fn(async (args: Record<string, any>) => `File written: ${args.path} (${args.content.length} bytes)`);
    toolRegistry.register({ name: 'write_file', description: 'Write a local text report', permission: 'public', securityLevel: 'safe',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] }, handler });
    const queued = task();
    mocks.model.mockResolvedValueOnce({ text: '', toolCalls: [
      { id: 'report-one', name: 'write_file', arguments: { path: 'first.txt', content: 'first' } },
      { id: 'report-two', name: 'write_file', arguments: { path: 'second.txt', content: 'second' } },
    ] }).mockResolvedValue({ text: 'Both reports are ready.', toolCalls: [] });
    const io = { to: () => ({ emit: vi.fn() }) } as any;
    await executeNextAutonomousTask(io, { getDeepSeek: () => null, getGemini: () => null }, owner);
    const stored = [...getTaskQueue(owner), ...getTaskHistory(50, 0, owner)].find(item => item.id === queued.id)!;
    expect(handler, JSON.stringify(stored)).toHaveBeenCalledTimes(2);
    expect(stored.actions?.map(action => action.state)).toEqual(['settled', 'settled']);
    expect(new Set(stored.actions?.map(action => action.id)).size).toBe(2);
    expect(stored.actions?.every(action => action.record?.idempotencyKey === action.id)).toBe(true);
  });

  it('blocks adapter entry when its started barrier fails', async () => {
    const f = fixture();
    mocks.failFlush = true;
    mocks.model.mockResolvedValue({ text: '', toolCalls: [{ id: 'first', name: 'synthetic_mutation', arguments: { value: 'one' } }] });
    await expect(runWithTools([{ role: 'user', content: 'Perform the synthetic step.' }], f.registry,
      { provider: 'deepseek', model: 'synthetic-model' }, f.settle, 1,
      () => null, () => null, () => null, () => null, () => null, undefined, f.context)).rejects.toThrow(/synthetic durability failure/);
    expect(f.handler).not.toHaveBeenCalled();
    expect(recoverPersistedTask(getTaskQueue(owner)[0]).status).toBe('blocked');
  });

  it('retains an unknown started mutation across a real SQLite close/reopen without replay', async () => {
    const f = fixture();
    const record = await f.call('first', 'one');
    expect(record.terminalVerification?.status).toBe('verified');
    expect(record.error).toBeUndefined();
    expect(f.handler).toHaveBeenCalledTimes(1);
    // The started barrier is durable; deliberately omit the terminal callback.
    await closeDatabase();
    resetAutonomousTaskQueueForTest();
    resetExternalCommitRuntimeCacheForTests();
    await initDatabase();
    expect(hydrateAutonomousTasksFromDb(true)).toBe(1);
    expect(getTaskHistory(50, 0, owner)[0]).toMatchObject({ status: 'blocked', actions: [{ state: 'started' }] });
    expect(getTaskQueue(owner)).toHaveLength(0);
    expect(f.handler).toHaveBeenCalledTimes(1);
  });

  it('blocks a transient failure with an empty caller ledger when durable adapter entry is unresolved', async () => {
    const f = fixture();
    const action = prepareAutonomousTaskAction(f.running.id, f.running.leaseId!, {
      callId: 'before-timeout', name: 'synthetic_mutation', argumentsDigest: 'synthetic-digest', mayHaveSideEffects: true,
    });
    await startAutonomousTaskAction(f.running.id, f.running.leaseId!, action);
    const outcome = recordAutonomousTaskFailure(f.running.id, { error: 'terminal observer connection timeout', receiptSnapshots: [] }, f.running.leaseId);
    expect(outcome).toMatchObject({ status: 'blocked', recovery: { lastFailureClass: 'unknown_outcome' } });
    releaseAutonomousTaskExecutor(f.running.id, f.running.leaseId!);
    expect(claimAutonomousTask(f.running.id)).toBeNull();
    expect(f.handler).not.toHaveBeenCalled();
  });

  it.each(['pause', 'cancel', 'expiry'] as const)('revokes handler entry when %s arrives during the strict start flush', async kind => {
    const f = fixture();
    let unblock!: () => void;
    mocks.flushGate = new Promise<void>(resolve => { unblock = resolve; });
    const pending = f.call('first', 'one');
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await vi.waitFor(() => expect(getTaskQueue(owner)[0].actions?.[0].state).toBe('started'));
      if (kind === 'pause') requestPauseAutonomousTask(f.running.id, owner);
      else if (kind === 'cancel') cancelTask(f.running.id, owner);
      else clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
      unblock();
      const result = await pending;
      expect(result.error).toMatch(/admission was revoked/);
      expect(f.handler).not.toHaveBeenCalled();
    } finally {
      unblock();
      await pending;
      clock?.mockRestore();
    }
  });

  it('binds nested canonical actions to their own start and terminal identities', async () => {
    const f = fixture();
    const child = vi.fn(async () => JSON.stringify({ ok: true, verified: true }));
    f.registry.register({ ...f.registry.get('synthetic_mutation')!, name: 'synthetic_child', handler: child });
    f.handler.mockImplementation(async (_args, context) => {
      const nested = await executeToolCall({ registry: f.registry, id: 'child-call', name: 'synthetic_child', arguments: { value: 'child' }, context });
      expect(nested.error).toBeUndefined();
      await f.settle(nested);
      return JSON.stringify({ ok: true, verified: true });
    });
    const outer = await f.call('parent-call', 'parent');
    expect(outer.error).toBeUndefined();
    await f.settle(outer);
    const actions = getTaskQueue(owner)[0].actions!;
    expect(actions.map(action => action.state)).toEqual(['settled', 'settled']);
    expect(actions.map(action => action.record?.name)).toEqual(['synthetic_mutation', 'synthetic_child']);
    expect(actions.every(action => action.record?.id === action.id && action.record.idempotencyKey === action.id)).toBe(true);
    expect(child).toHaveBeenCalledOnce();
  });

  it('saves a late receipt while pausing, preserves it across restart, and fences repeated input', async () => {
    const f = fixture();
    const record = await f.call('first', 'one');
    requestPauseAutonomousTask(f.running.id, owner);
    expect(heartbeatAutonomousTask(f.running.id, f.running.leaseId!)).not.toBeNull();
    await f.settle(record);
    expect(checkpointAutonomousTask(f.running.id, { phase: 'paused-after-receipt', receipts: getTaskQueue(owner)[0].checkpoint?.receipts }, f.running.leaseId)).not.toBeNull();
    markPaused(f.running.id);
    releaseAutonomousTaskExecutor(f.running.id, f.running.leaseId!);
    await persistAutonomousTaskQueue();
    await closeDatabase();
    resetAutonomousTaskQueueForTest();
    resetExternalCommitRuntimeCacheForTests();
    await initDatabase();
    hydrateAutonomousTasksFromDb(true);
    const resumed = resumeAutonomousTask(f.running.id, owner)!;
    expect(resumed.status).toBe('pending');
    expect(getAutonomousTaskPriorRecords(resumed)[0].idempotencyKey).toBe(record.idempotencyKey);
    const next = claimAutonomousTask(resumed.id)!;
    expect(() => prepareAutonomousTaskAction(next.id, next.leaseId!, { callId: 'different-model-id', name: record.name, argumentsDigest: toolExecutionInputDigests({ value: 'one' }).argumentsDigest, mayHaveSideEffects: true })).toThrow(/already owns/);
    expect(f.handler).toHaveBeenCalledTimes(1);
  });

  it('lets cancellation override pausing during settlement and after restart', () => {
    const f = fixture();
    requestPauseAutonomousTask(f.running.id, owner);
    cancelTask(f.running.id, owner);
    expect(recoverPersistedTask(getTaskQueue(owner)[0]).status).toBe('cancelled');
    expect(markPaused(f.running.id)?.status).toBe('cancelled');
    expect(getTaskHistory(50, 0, owner)[0].terminalReceipt?.outcome).toBe('cancelled');
  });

  it('resumes missing read-only verification after a verified write without discarding either receipt', async () => {
    const f = fixture();
    await f.settle(await f.call('write-once', 'one'));
    f.registry.register({ name: 'synthetic_observe', description: 'Read-only synthetic verification', permission: 'public', securityLevel: 'safe',
      parameters: { type: 'object', properties: {} },
      capability: { operation: 'observe', sideEffects: [{ type: 'local_read', scope: 'synthetic state', reversible: true }],
        verification: { strategy: 'terminal_receipt', required: true, requiredFields: ['ok'], requiredValues: { ok: true }, successSignals: [], limitations: [] } },
      handler: async () => JSON.stringify({ ok: false, error: 'Read-only verification temporarily unavailable' }) });
    const observed = await executeToolCall({ registry: f.registry, id: 'verify-later', name: 'synthetic_observe', arguments: {}, context: f.context });
    expect(observed.terminalVerification?.status).toBe('failed');
    await f.settle(observed);
    markPaused(f.running.id);
    releaseAutonomousTaskExecutor(f.running.id, f.running.leaseId!);
    const resumed = resumeAutonomousTask(f.running.id, owner)!;
    expect(resumed.status).toBe('pending');
    expect(getAutonomousTaskPriorRecords(resumed)).toHaveLength(2);
  });

  it('never reclaims an expired live handler, then releases the queue after exact settlement', async () => {
    const f = fixture();
    const pending = task();
    let finish!: (value: string) => void;
    f.handler.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const executing = f.call('first', 'one');
    await vi.waitFor(() => expect(f.handler).toHaveBeenCalledOnce());
    const expiredAt = Date.now() + 61_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiredAt);
    try {
    expect(heartbeatAutonomousTask(f.running.id, f.running.leaseId!)).toBeNull();
    expect(reconcileExpiredAutonomousTasks()).toBe(0);
    expect(claimAutonomousTask(f.running.id)).toBeNull();
    expect(getRunningTask(owner)?.id).toBe(f.running.id);
    expect(await executeNextAutonomousTask({} as any, { getDeepSeek: () => null, getGemini: () => null }, owner))
      .toEqual({ executed: false, result: 'Task already running' });
    finish(JSON.stringify({ ok: true, verified: true }));
    const record = await executing;
    await f.settle(record);
    releaseAutonomousTaskExecutor(f.running.id, f.running.leaseId!);
    expect(getRunningTask(owner)).toBeNull();
    expect(getTaskQueue(owner).find(item => item.id === pending.id)?.status).toBe('pending');
    expect(claimAutonomousTask(pending.id)).not.toBeNull();
    } finally {
      clock.mockRestore();
      finish?.(JSON.stringify({ ok: true, verified: true }));
      await executing;
    }
  });

  it('settles the actual executor as cancelled when pause and cancel arrive during a tool', async () => {
    const queued = task();
    toolRegistry.register({ name: 'write_file', description: 'Write a local text report', permission: 'public', securityLevel: 'safe',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      handler: async () => {
        requestPauseAutonomousTask(queued.id, owner);
        cancelTask(queued.id, owner);
        return 'File written: synthetic.txt (4 bytes)';
      } });
    mocks.model.mockResolvedValue({ text: '', toolCalls: [{ id: 'one', name: 'write_file', arguments: { path: 'synthetic.txt', content: 'text' } }] });
    const result = await executeNextAutonomousTask({ to: () => ({ emit: vi.fn() }) } as any, { getDeepSeek: () => null, getGemini: () => null }, owner);
    expect(result.result).toBe('Cancelled by user');
    expect(getTaskHistory(50, 0, owner)[0]).toMatchObject({ status: 'cancelled', actions: [{ state: 'settled' }] });
  });

  it.each(['pause', 'cancel', 'voice'] as const)('forwards %s immediately to an in-flight adapter signal and records its real settlement', async kind => {
    const queued = task();
    let signal: AbortSignal | undefined;
    let entered = false;
    toolRegistry.register({ name: 'write_file', description: 'Write a local text report', permission: 'public', securityLevel: 'safe',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
      handler: async (_args, context) => {
        signal = context?.executionSignal;
        entered = true;
        await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }));
        return 'unreachable';
      } });
    mocks.model.mockResolvedValue({ text: '', toolCalls: [{ id: 'one', name: 'write_file', arguments: { path: 'synthetic.txt', content: 'text' } }] });
    const pending = executeNextAutonomousTask({ to: () => ({ emit: vi.fn() }) } as any, { getDeepSeek: () => null, getGemini: () => null }, owner);
    await vi.waitFor(() => expect(entered).toBe(true));
    if (kind === 'pause') requestPauseAutonomousTask(queued.id, owner);
    else if (kind === 'cancel') cancelTask(queued.id, owner);
    else setRealtimeVoiceSessionActive(owner, 'synthetic-session', true);
    expect(signal?.aborted).toBe(true);
    await pending;
    const stored = [...getTaskQueue(owner), ...getTaskHistory(50, 0, owner)].find(item => item.id === queued.id)!;
    expect(stored.status).toBe(kind === 'pause' ? 'paused' : 'cancelled');
    expect(stored.actions?.[0].state).toBe('settled');
    expect(stored.actions?.[0].record?.adapterSettlements?.[0].status).toBe('rejected');
    expect(getRunningTask(owner)).toBeNull();
  });

  it('rejects new adapter admission during pause and prevents stale owner settlement after takeover', async () => {
    const f = fixture();
    const record = await f.call('first', 'one');
    requestPauseAutonomousTask(f.running.id, owner);
    await expect(f.call('second', 'two')).rejects.toThrow(/no longer owns/);
    markPaused(f.running.id);
    releaseAutonomousTaskExecutor(f.running.id, f.running.leaseId!);
    expect(resumeAutonomousTask(f.running.id, owner)?.status).toBe('blocked');
    await expect(f.settle(record)).rejects.toThrow(/lost its execution owner/);
    expect(f.handler).toHaveBeenCalledTimes(1);
  });
});
