import './helpers';
import { beforeAll, describe, expect, it } from 'vitest';
import { initDatabase } from '../db_layer';
import {
  acceptConversationActionTurn,
  acquireConversationActionTurnLease,
  bindConversationActionTurnTask,
  finalizeConversationActionTurn,
  getConversationActionTurn,
  reconcileConversationActionTurnLease,
  reconcileConversationActionTurnLeases,
  releaseConversationActionTurnLease,
  type ConversationActionTurnIdentity,
} from '../server/conversation/action_turn_ledger';

function identity(label: string): ConversationActionTurnIdentity {
  const nonce = `${Date.now()}-${Math.random()}`;
  return {
    conversationId: `conversation-${label}-${nonce}`,
    userId: `user-${label}-${nonce}`,
    requestId: `request-${label}-${nonce}`,
  };
}

function accept(identityValue: ConversationActionTurnIdentity, userMessageId = 'user-message-1') {
  return acceptConversationActionTurn({
    ...identityValue,
    userMessageId,
    domain: 'personal',
    channel: 'chat',
    source: 'test',
    now: '2026-08-27T00:00:00.000Z',
  });
}

describe('conversation action turn ledger', () => {
  beforeAll(async () => {
    await initDatabase();
  });

  it('accepts an exact request/message identity idempotently and rejects request reuse', () => {
    const key = identity('accept');
    const created = accept(key);
    expect(created).toMatchObject({ accepted: true, created: true });
    expect(created.turn).toMatchObject({
      ...key,
      userMessageId: 'user-message-1',
      status: 'accepted',
      revision: 1,
    });

    const repeated = accept(key);
    expect(repeated).toMatchObject({ accepted: true, created: false });
    expect(repeated.turn.id).toBe(created.turn.id);
    expect(repeated.turn.revision).toBe(1);

    const conflict = accept(key, 'different-user-message');
    expect(conflict).toMatchObject({
      accepted: false,
      created: false,
      reason: 'identity_conflict',
    });
    expect(getConversationActionTurn(key)?.userMessageId).toBe('user-message-1');
  });

  it('fences concurrent owners, renews the same owner, and recovers an expired lease', () => {
    const key = identity('lease');
    accept(key);

    const acquired = acquireConversationActionTurnLease({
      ...key,
      leaseOwnerId: 'worker-a',
      processEpoch: 'epoch-a',
      ttlMs: 1_000,
      now: '2026-08-27T00:00:01.000Z',
    });
    expect(acquired).toMatchObject({ acquired: true, recovered: false, renewed: false });
    expect(acquired.turn.leaseExpiresAt).toBe('2026-08-27T00:00:02.000Z');

    const busy = acquireConversationActionTurnLease({
      ...key,
      leaseOwnerId: 'worker-b',
      processEpoch: 'epoch-a',
      ttlMs: 1_000,
      now: '2026-08-27T00:00:01.500Z',
    });
    expect(busy).toMatchObject({ acquired: false, reason: 'busy' });

    const renewed = acquireConversationActionTurnLease({
      ...key,
      leaseOwnerId: 'worker-a',
      processEpoch: 'epoch-a',
      ttlMs: 1_000,
      now: '2026-08-27T00:00:01.750Z',
    });
    expect(renewed).toMatchObject({ acquired: true, recovered: false, renewed: true });
    expect(renewed.turn.leaseAcquiredAt).toBe('2026-08-27T00:00:01.000Z');
    expect(renewed.turn.leaseExpiresAt).toBe('2026-08-27T00:00:02.750Z');

    const recovered = acquireConversationActionTurnLease({
      ...key,
      leaseOwnerId: 'worker-b',
      processEpoch: 'epoch-a',
      ttlMs: 1_000,
      now: '2026-08-27T00:00:02.750Z',
    });
    expect(recovered).toMatchObject({ acquired: true, recovered: true, renewed: false });
    expect(recovered.turn).toMatchObject({
      status: 'leased',
      leaseOwnerId: 'worker-b',
      recoveryReason: 'lease_expired',
    });
  });

  it('releases a lease immediately when the process epoch changes', () => {
    const key = identity('epoch');
    accept(key);
    acquireConversationActionTurnLease({
      ...key,
      leaseOwnerId: 'old-worker',
      processEpoch: 'old-epoch',
      ttlMs: 60_000,
      now: '2026-08-27T00:00:00.000Z',
    });

    const result = reconcileConversationActionTurnLease({
      ...key,
      processEpoch: 'new-epoch',
      now: '2026-08-27T00:00:01.000Z',
    });
    expect(result).toMatchObject({
      reconciled: true,
      action: 'released',
      reason: 'process_epoch_changed',
      turn: {
        status: 'accepted',
        leaseOwnerId: '',
        leaseEpoch: '',
        taskId: '',
      },
    });
  });

  it('binds exactly one task and never rewrites the binding', () => {
    const key = identity('task');
    accept(key);
    const bound = bindConversationActionTurnTask({
      ...key,
      taskId: 'task-a',
      now: '2026-08-27T00:00:01.000Z',
    });
    expect(bound).toMatchObject({ bound: true, changed: true, turn: { taskId: 'task-a' } });

    expect(bindConversationActionTurnTask({ ...key, taskId: 'task-a' }))
      .toMatchObject({ bound: true, changed: false });
    expect(bindConversationActionTurnTask({ ...key, taskId: 'task-b' }))
      .toMatchObject({ bound: false, reason: 'task_conflict', turn: { taskId: 'task-a' } });
  });

  it('yields the request lease while keeping a blocked or confirmation-waiting task bound', () => {
    const key = identity('yield');
    accept(key);
    acquireConversationActionTurnLease({
      ...key,
      leaseOwnerId: 'worker-a',
      processEpoch: 'epoch-a',
      now: '2026-08-27T00:00:01.000Z',
    });
    bindConversationActionTurnTask({ ...key, taskId: 'task-waiting' });

    expect(releaseConversationActionTurnLease({
      ...key,
      leaseOwnerId: 'worker-b',
      processEpoch: 'epoch-a',
      reason: 'waiting_confirmation',
    })).toMatchObject({ released: false, reason: 'lease_mismatch' });

    const released = releaseConversationActionTurnLease({
      ...key,
      leaseOwnerId: 'worker-a',
      processEpoch: 'epoch-a',
      reason: 'waiting_confirmation',
      now: '2026-08-27T00:00:02.000Z',
    });
    expect(released).toMatchObject({
      released: true,
      changed: true,
      turn: {
        status: 'accepted',
        taskId: 'task-waiting',
        leaseOwnerId: '',
        recoveryReason: 'waiting_confirmation',
      },
    });
  });

  it('requires the current lease fence and durable assistant id before terminal finalization', () => {
    const key = identity('terminal');
    accept(key);
    acquireConversationActionTurnLease({
      ...key,
      leaseOwnerId: 'worker-a',
      processEpoch: 'epoch-a',
      ttlMs: 10_000,
      now: '2026-08-27T00:00:01.000Z',
    });

    expect(finalizeConversationActionTurn({
      ...key,
      status: 'terminal',
      terminalMessageId: 'assistant-1',
      leaseOwnerId: 'worker-b',
      processEpoch: 'epoch-a',
    })).toMatchObject({ finalized: false, reason: 'lease_mismatch' });

    expect(finalizeConversationActionTurn({
      ...key,
      status: 'terminal',
      leaseOwnerId: 'worker-a',
      processEpoch: 'epoch-a',
    })).toMatchObject({ finalized: false, reason: 'terminal_message_required' });

    const finalized = finalizeConversationActionTurn({
      ...key,
      status: 'terminal',
      terminalMessageId: 'assistant-1',
      reason: 'assistant transcript persisted',
      leaseOwnerId: 'worker-a',
      processEpoch: 'epoch-a',
      now: '2026-08-27T00:00:02.000Z',
    });
    expect(finalized).toMatchObject({
      finalized: true,
      changed: true,
      turn: { status: 'terminal', terminalMessageId: 'assistant-1', leaseOwnerId: '' },
    });
    expect(finalizeConversationActionTurn({
      ...key,
      status: 'terminal',
      terminalMessageId: 'assistant-1',
    })).toMatchObject({ finalized: true, changed: false });
    expect(acquireConversationActionTurnLease({
      ...key,
      leaseOwnerId: 'worker-c',
      processEpoch: 'epoch-a',
    })).toMatchObject({ acquired: false, reason: 'terminal' });
  });

  it('quarantines uncertain persistence and only resolves it from durable evidence', () => {
    const key = identity('unknown');
    accept(key);
    acquireConversationActionTurnLease({
      ...key,
      leaseOwnerId: 'worker-a',
      processEpoch: 'epoch-a',
      now: '2026-08-27T00:00:01.000Z',
    });
    expect(finalizeConversationActionTurn({
      ...key,
      status: 'persistence_unknown',
      reason: 'assistant persistence acknowledgement was lost',
      leaseOwnerId: 'worker-a',
      processEpoch: 'epoch-a',
      now: '2026-08-27T00:00:02.000Z',
    })).toMatchObject({ finalized: true, turn: { status: 'persistence_unknown' } });
    expect(acquireConversationActionTurnLease({
      ...key,
      leaseOwnerId: 'worker-b',
      processEpoch: 'epoch-a',
    })).toMatchObject({ acquired: false, reason: 'terminal' });
    expect(finalizeConversationActionTurn({
      ...key,
      status: 'terminal',
      terminalMessageId: 'assistant-delayed-replay',
      force: true,
    })).toMatchObject({
      finalized: false,
      reason: 'terminal_conflict',
      turn: { status: 'persistence_unknown', terminalMessageId: '' },
    });

    const reconciled = reconcileConversationActionTurnLease({
      ...key,
      processEpoch: 'epoch-a',
      observedStatus: 'terminal',
      terminalMessageId: 'assistant-durable-1',
      reason: 'assistant transcript found during recovery',
      now: '2026-08-27T00:00:03.000Z',
    });
    expect(reconciled).toMatchObject({
      reconciled: true,
      action: 'terminal',
      turn: { status: 'terminal', terminalMessageId: 'assistant-durable-1' },
    });
  });

  it('batch recovery releases only stale leases and preserves live leases', () => {
    const stale = identity('batch-stale');
    const live = identity('batch-live');
    accept(stale);
    accept(live);
    acquireConversationActionTurnLease({
      ...stale,
      leaseOwnerId: 'stale-worker',
      processEpoch: 'old-epoch',
      ttlMs: 60_000,
      now: '2026-08-27T00:00:00.000Z',
    });
    acquireConversationActionTurnLease({
      ...live,
      leaseOwnerId: 'live-worker',
      processEpoch: 'current-epoch',
      ttlMs: 60_000,
      now: '2026-08-27T00:00:00.000Z',
    });

    const result = reconcileConversationActionTurnLeases({
      processEpoch: 'current-epoch',
      now: '2026-08-27T00:00:01.000Z',
    });
    expect(result.released).toBeGreaterThanOrEqual(1);
    expect(result.turns).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: getConversationActionTurn(stale)?.id, status: 'accepted' }),
    ]));
    expect(getConversationActionTurn(live)).toMatchObject({
      status: 'leased',
      leaseOwnerId: 'live-worker',
    });
  });
});
