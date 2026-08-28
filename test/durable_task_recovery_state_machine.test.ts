import './helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  diagnoseDurableTaskFailure,
  evaluateDurableResumeSafety,
  snapshotDurableToolRecord,
  updateDurableTaskRecovery,
} from '../server/cognition/durable_task_recovery';
import type { ToolExecutionRecord } from '../server/tools/types';
import {
  checkpointAutonomousTask,
  claimAutonomousTask,
  enqueue,
  markCompleted,
  recoverPersistedTask,
  resetAutonomousTaskQueueForTest,
} from '../server/autonomy/task_queue';
import { buildTaskTerminalReceipt } from '../server/cognition/acceptance_evidence';

function toolRecord(input: {
  id?: string;
  status?: 'verified_success' | 'failed' | 'timeout' | 'forbidden' | 'waiting_confirmation' | 'unknown_outcome' | 'target_mismatch';
  operation?: 'observe' | 'test' | 'mutate' | 'create' | 'communicate' | 'unknown';
  sideEffect?: 'network_read' | 'local_write' | 'external_communication' | 'external_state_change' | 'none';
  reversible?: boolean;
  error?: string;
} = {}): ToolExecutionRecord {
  const status = input.status || 'timeout';
  return {
    id: input.id || 'receipt-1',
    taskId: 'task-1',
    requestId: 'request-1',
    turnId: 'turn-1',
    idempotencyKey: 'idem-1',
    name: 'test_capability',
    arguments: { privateText: 'not persisted in the recovery snapshot' },
    result: status === 'verified_success' ? JSON.stringify({ ok: true, status: 'verified' }) : '',
    error: input.error,
    capability: {
      capabilityId: 'test.capability',
      lane: 'general',
      operation: input.operation || 'observe',
      risk: 'low',
      sideEffects: [{
        type: input.sideEffect || 'network_read',
        scope: 'bounded test scope',
        reversible: input.reversible === true,
      }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['ok'],
        successSignals: ['verified receipt'],
        limitations: [],
      },
    },
    terminalVerification: {
      status: status === 'verified_success' ? 'verified' : 'failed',
      strategy: 'terminal_receipt',
      reason: input.error || status,
    },
    envelope: {
      version: 1,
      status,
      toolName: 'test_capability',
      taskId: 'task-1',
      turnId: 'turn-1',
      requestId: 'request-1',
      idempotencyKey: 'idem-1',
      targetIdentity: 'test-target',
      completedAt: '2026-08-02T00:00:00.000Z',
      error: input.error,
      verification: {
        status: status === 'verified_success' ? 'verified' : 'failed',
        reason: input.error || status,
      },
    },
  };
}

describe('durable task recovery classifier', () => {
  it('retries only safe read failures with bounded backoff and then blocks a repeated fingerprint', () => {
    const record = toolRecord({ error: 'provider connection timeout' });
    const first = diagnoseDurableTaskFailure({
      error: record.error,
      toolRecords: [record],
      attempt: 1,
      recoveryCount: 0,
      now: new Date('2026-08-02T00:00:00.000Z'),
      baseDelayMs: 100,
    });
    expect(first).toMatchObject({ failureClass: 'dependency_unavailable', decision: 'retry', retrySafe: true });
    expect(first.nextAttemptAt).toBeTruthy();

    const recovery = updateDurableTaskRecovery(undefined, first, [snapshotDurableToolRecord(record)]);
    const second = diagnoseDurableTaskFailure({
      error: record.error,
      toolRecords: [record],
      attempt: 2,
      recoveryCount: 0,
      previous: recovery,
      now: new Date('2026-08-02T00:00:01.000Z'),
      baseDelayMs: 100,
    });
    expect(second.decision).toBe('retry');

    const third = diagnoseDurableTaskFailure({
      error: record.error,
      toolRecords: [record],
      attempt: 3,
      recoveryCount: 0,
      previous: updateDurableTaskRecovery(recovery, second),
      now: new Date('2026-08-02T00:00:02.000Z'),
      baseDelayMs: 100,
    });
    expect(third).toMatchObject({ decision: 'block', consecutiveCount: 3 });
  });

  it('never retries an external timeout or explicit unknown outcome', () => {
    const external = toolRecord({
      status: 'timeout',
      operation: 'communicate',
      sideEffect: 'external_communication',
      error: 'remote acknowledgement timeout',
    });
    expect(diagnoseDurableTaskFailure({
      error: external.error,
      toolRecords: [external],
      sideEffectClass: 'external_commit',
      attempt: 1,
      recoveryCount: 0,
    })).toMatchObject({ failureClass: 'unknown_outcome', decision: 'block', retrySafe: false });

    const unknown = snapshotDurableToolRecord(toolRecord({ status: 'unknown_outcome' }));
    expect(evaluateDurableResumeSafety([unknown], true)).toMatchObject({
      allowed: false,
      strategy: 'block_unknown_outcome',
    });
  });

  it('replans a verification-only read failure but blocks unverified mutation replay', () => {
    const read = toolRecord({ status: 'verified_success', operation: 'observe', sideEffect: 'network_read' });
    expect(diagnoseDurableTaskFailure({
      error: 'Acceptance evidence is incomplete',
      toolRecords: [read],
      verificationFailure: true,
      attempt: 1,
      recoveryCount: 0,
    }).decision).toBe('replan');

    const write = toolRecord({ status: 'verified_success', operation: 'mutate', sideEffect: 'local_write' });
    expect(diagnoseDurableTaskFailure({
      error: 'Acceptance evidence is incomplete',
      toolRecords: [write],
      verificationFailure: true,
      attempt: 1,
      recoveryCount: 0,
    }).decision).toBe('block');
    expect(evaluateDurableResumeSafety([snapshotDurableToolRecord(write)], false).allowed).toBe(false);
    expect(evaluateDurableResumeSafety([snapshotDurableToolRecord(write)], true)).toMatchObject({
      allowed: true,
      strategy: 'resume_verified_receipts',
    });
  });

  it('persists only redacted evidence metadata, not tool arguments or result bodies', () => {
    const record = toolRecord({ status: 'verified_success' });
    record.result = 'authorization=secret-value private body';
    const serialized = JSON.stringify(snapshotDurableToolRecord(record));
    expect(serialized).not.toContain('privateText');
    expect(serialized).not.toContain('secret-value');
    expect(serialized).not.toContain('private body');
    expect(serialized).toContain('resultDigest');
  });
});

describe('durable queue safety state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-02T00:00:00.000Z'));
    resetAutonomousTaskQueueForTest({ markHydrated: true });
  });

  afterEach(() => {
    resetAutonomousTaskQueueForTest({ markHydrated: true });
    vi.useRealTimers();
  });

  it('deduplicates logical tasks and rejects a stale executor after lease takeover', () => {
    const first = enqueue({
      userId: 'owner',
      title: 'Read report',
      description: 'Read a report safely',
      source: 'user_request',
      priority: 5,
      mode: 'analysis',
      idempotencyKey: 'logical-request-1',
    })!;
    expect(enqueue({
      userId: 'owner',
      title: 'Duplicate report',
      description: 'Same request',
      source: 'user_request',
      priority: 5,
      mode: 'analysis',
      idempotencyKey: 'logical-request-1',
    })?.id).toBe(first.id);

    expect(claimAutonomousTask(first.id, { leaseId: 'lease-a', durationMs: 5_000 })?.leaseId).toBe('lease-a');
    const completionReceipt = buildTaskTerminalReceipt({
      taskId: first.id,
      runtime: 'autonomous',
      outcome: 'completed',
      toolRecords: [toolRecord({ id: `${first.id}:verified`, status: 'verified_success' })],
    });
    vi.advanceTimersByTime(6_000);
    expect(markCompleted(first.id, 'stale result', 1, 1, {
      finalized: true,
      verified: true,
      blocked: false,
      terminalReceipt: completionReceipt,
    }, 'lease-a')).toBeNull();
    expect(claimAutonomousTask(first.id, { leaseId: 'lease-b', durationMs: 5_000 })?.leaseId).toBe('lease-b');
    expect(markCompleted(first.id, 'verified result', 1, 1, {
      finalized: true,
      verified: true,
      blocked: false,
      terminalReceipt: completionReceipt,
    }, 'lease-b')?.status).toBe('completed');
  });

  it('blocks autonomous restart replay when a side effect lacks a reusable persistent ledger', () => {
    const task = enqueue({
      userId: 'owner',
      title: 'Write local artifact',
      description: 'Write once',
      source: 'user_request',
      priority: 5,
      mode: 'analysis',
    })!;
    const claimed = claimAutonomousTask(task.id, { leaseId: 'lease-write' })!;
    const write = toolRecord({ status: 'verified_success', operation: 'mutate', sideEffect: 'local_write' });
    const checkpointed = checkpointAutonomousTask(task.id, {
      phase: 'tool_execution',
      receiptIds: [write.id!],
      receipts: [snapshotDurableToolRecord(write)],
    }, claimed.leaseId)!;
    expect(recoverPersistedTask(checkpointed, '2026-08-02T00:01:00.000Z')).toMatchObject({
      status: 'blocked',
      blocked: true,
      verified: false,
      recoveryCount: 1,
    });
  });
});
