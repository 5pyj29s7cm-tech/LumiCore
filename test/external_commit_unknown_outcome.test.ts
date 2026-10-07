import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { OfficialApiHttpError } from '../server/llm/official_api';
import {
  ToolRegistry,
  externalCommitInputDigest,
  resetExternalCommitRuntimeCacheForTests,
} from '../server/tools/registry';
import { executeToolCall } from '../server/tools/execution_engine';
import {
  configureExternalCommitJournal,
  resetVolatileExternalCommitJournalForTests,
  type ExternalCommitJournalAdapter,
  type ExternalCommitJournalEntry,
} from '../server/tools/external_commit_journal';

function registerExternalCommit(
  registry: ToolRegistry,
  name: string,
  handler: (args: Record<string, any>) => Promise<string>,
  reconcileExternalCommit?: (
    args: Record<string, any>,
    context: any,
    idempotencyKey: string,
  ) => Promise<string | null>,
) {
  registry.register({
    name,
    description: 'Test-only external commit with an immutable idempotency key.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        payload: { type: 'string' },
      },
      required: ['target', 'payload'],
    },
    permission: 'public',
    securityLevel: 'confirm',
    capability: {
      id: `test.${name}`,
      family: 'messaging',
      lane: 'messaging',
      operation: 'mutate',
      risk: 'high',
      sideEffects: [{
        type: 'external_communication',
        scope: 'test recipient',
        reversible: false,
      }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['verified'],
        requiredValues: { verified: true },
        successSignals: ['provider receipt'],
        limitations: [],
      },
    },
    handler,
    reconcileExternalCommit,
  });
}

function confirmedContext(idempotencyKey: string) {
  return {
    userId: 'external-commit-test-user',
    taskId: 'external-commit-test-task',
    userConfirmed: true,
    idempotencyKey,
  };
}

function durableJournalAdapter(): {
  adapter: ExternalCommitJournalAdapter;
  rows: Map<string, ExternalCommitJournalEntry>;
} {
  const rows = new Map<string, ExternalCommitJournalEntry>();
  return {
    rows,
    adapter: {
      async lookup(idempotencyKey) {
        const existing = rows.get(idempotencyKey);
        return existing ? { ...existing } : null;
      },
      async claim(entry) {
        const existing = rows.get(entry.idempotencyKey);
        if (existing) return { claimed: false, entry: { ...existing } };
        rows.set(entry.idempotencyKey, { ...entry });
        return { claimed: true, entry: { ...entry } };
      },
      async settle(input) {
        const existing = rows.get(input.idempotencyKey);
        if (!existing) return false;
        if (!input.recoverExisting && existing.claimToken !== input.claimToken) return false;
        rows.set(input.idempotencyKey, {
          ...existing,
          state: input.state,
          replayResult: input.replayResult,
          updatedAt: input.updatedAt,
        });
        return true;
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  configureExternalCommitJournal(null);
  resetVolatileExternalCommitJournalForTests();
  resetExternalCommitRuntimeCacheForTests();
});

describe('external commit unknown-outcome safety', () => {
  it('keeps a definite official image rejection retryable but a timeout uncertain', async () => {
    const durable = durableJournalAdapter();
    configureExternalCommitJournal(durable.adapter);
    const registry = new ToolRegistry();
    const handler = vi.fn().mockRejectedValueOnce(new OfficialApiHttpError(400, '/images/generations', 'request rejected'))
      .mockRejectedValueOnce(new Error('Lumi Official API request timed out after 120000ms'));
    registerExternalCommit(registry, 'generate_image', handler);
    const context = confirmedContext('official-image-rejection-retry');
    const args = { target: 'image', payload: 'blue cup' };
    await expect(registry.execute('generate_image', args, context)).rejects.toThrow('request rejected');
    expect(durable.rows.get(context.idempotencyKey)?.state).toBe('not_started');
    await expect(registry.execute('generate_image', args, context)).rejects.toThrow('outcome is unknown');
    expect(handler).toHaveBeenCalledTimes(2);
    expect(durable.rows.get(context.idempotencyKey)?.state).toBe('unknown');
    await expect(registry.execute('generate_image', args, context)).rejects.toThrow();
    expect(handler).toHaveBeenCalledTimes(2);
  });
  it('uses an installation-keyed digest for low-entropy external commit inputs', () => {
    const name = 'external_commit_low_entropy_test';
    const args = { target: '13800138000', payload: '1234' };
    const publicDigest = createHash('sha256').update(JSON.stringify({ name, args })).digest('hex');
    expect(externalCommitInputDigest(name, args)).not.toBe(publicDigest);
  });

  it.each([
    {
      name: 'external_commit_plain_text_receipt_test',
      idempotencyKey: 'plain-text-receipt-key',
      result: 'Provider says the message was sent.',
    },
    {
      name: 'external_commit_missing_verification_fields_test',
      idempotencyKey: 'missing-verification-fields-key',
      result: JSON.stringify({ ok: true, status: 'sent', sent: true, providerReceipt: 'provider-claim-only' }),
    },
  ])('keeps an unverifiable external result unknown and blocks resend: $name', async ({
    name,
    idempotencyKey,
    result,
  }) => {
    const durable = durableJournalAdapter();
    configureExternalCommitJournal(durable.adapter);
    const handler = vi.fn(async () => result);
    const args = { target: 'Unverified Recipient', payload: 'Never resend automatically' };
    const context = confirmedContext(idempotencyKey);

    const firstRegistry = new ToolRegistry();
    registerExternalCommit(firstRegistry, name, handler);
    await expect(firstRegistry.execute(name, args, context)).resolves.toBe(result);

    expect(durable.rows.get(idempotencyKey)?.state).toBe('unknown');
    expect(durable.rows.get(idempotencyKey)?.replayResult || '').toBe('');

    resetExternalCommitRuntimeCacheForTests();
    const restartedRegistry = new ToolRegistry();
    registerExternalCommit(restartedRegistry, name, handler);
    await expect(restartedRegistry.execute(name, args, context))
      .rejects.toThrow(/prior running or unknown attempt.*could not be verified/i);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('marks a timed-out commit unknown but keeps both callers behind the same live handler fence', async () => {
    vi.useFakeTimers();
    const registry = new ToolRegistry();
    let rejectHandler!: (error: Error) => void;
    const handler = vi.fn(() => new Promise<string>((_resolve, reject) => {
      rejectHandler = reject;
    }));
    registerExternalCommit(registry, 'external_commit_timeout_test', handler);
    const args = { target: 'Alice', payload: 'Only once' };
    const context = confirmedContext('timeout-no-resend-key');

    const first = registry.execute('external_commit_timeout_test', args, context);
    let firstSettled = false;
    void first.finally(() => { firstSettled = true; }).catch(() => {});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(firstSettled).toBe(false);

    const duplicate = registry.execute('external_commit_timeout_test', args, context);
    let duplicateSettled = false;
    void duplicate.finally(() => { duplicateSettled = true; }).catch(() => {});
    await Promise.resolve();
    expect(duplicateSettled).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);

    rejectHandler(new Error('adapter acknowledged cancellation'));
    await expect(first).rejects.toThrow(/outcome is unknown.*timed out after 30s.*settled as rejected/i);
    await expect(duplicate).rejects.toThrow(/outcome is unknown.*timed out after 30s.*settled as rejected/i);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('accepts the exact late handler settlement without resending the commit', async () => {
    vi.useFakeTimers();
    const registry = new ToolRegistry();
    let resolveHandler!: (result: string) => void;
    const handler = vi.fn(() => new Promise<string>(resolve => {
      resolveHandler = resolve;
    }));
    registerExternalCommit(registry, 'external_commit_late_result_test', handler);
    const args = { target: 'Bob', payload: 'Do not duplicate' };
    const context = confirmedContext('late-result-no-resend-key');

    const first = registry.execute('external_commit_late_result_test', args, context);
    await vi.advanceTimersByTimeAsync(30_000);
    const duplicate = registry.execute('external_commit_late_result_test', args, context);
    const receipt = JSON.stringify({ verified: true, providerReceipt: 'late-receipt' });
    resolveHandler(receipt);

    await expect(first).resolves.toBe(receipt);
    await expect(duplicate).resolves.toBe(receipt);
    await expect(registry.execute('external_commit_late_result_test', args, context)).resolves.toBe(receipt);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('accepts a verified read-only reconciliation and deduplicates later retries', async () => {
    vi.useFakeTimers();
    const reconciled = JSON.stringify({
      verified: true,
      providerReceipt: 'provider-42',
      status: 'sent',
    });
    const reconcile = vi.fn(async () => reconciled);
    const args = { target: 'Carol', payload: 'Reconcile me' };
    const context = confirmedContext('verified-reconciliation-key');

    let rejectHandler!: (error: Error) => void;
    const waitingHandler = vi.fn(() => new Promise<string>((_resolve, reject) => {
      rejectHandler = reject;
    }));
    const reconciledRegistry = new ToolRegistry();
    registerExternalCommit(reconciledRegistry, 'external_commit_reconcile_test', waitingHandler, reconcile);

    const first = reconciledRegistry.execute('external_commit_reconcile_test', args, context);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconcile).not.toHaveBeenCalled();
    rejectHandler(new Error('adapter cancelled after timeout'));
    await expect(first).resolves.toBe(reconciled);
    await expect(reconciledRegistry.execute('external_commit_reconcile_test', args, context))
      .resolves.toBe(reconciled);

    expect(waitingHandler).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(args, context, 'verified-reconciliation-key');
  });

  it('replays a verified receipt after a simulated backend restart without resending', async () => {
    const durable = durableJournalAdapter();
    configureExternalCommitJournal(durable.adapter);
    const handler = vi.fn(async () => JSON.stringify({
      sent: true,
      verificationStatus: 'verified',
      providerReceipt: 'provider-restart-1',
      counts: { completed: 1, apiToken: 'sk-super-secret-provider-token' },
      message: 'sensitive body must not be journaled',
    }));
    const args = { target: 'Restart Recipient', payload: 'Only once across restart' };
    const context = confirmedContext('verified-across-restart-key');

    const firstRegistry = new ToolRegistry();
    registerExternalCommit(firstRegistry, 'external_commit_restart_verified_test', handler);
    await expect(firstRegistry.execute('external_commit_restart_verified_test', args, context))
      .resolves.toContain('provider-restart-1');

    resetExternalCommitRuntimeCacheForTests();
    const restartedRegistry = new ToolRegistry();
    registerExternalCommit(restartedRegistry, 'external_commit_restart_verified_test', handler);
    const replay = await restartedRegistry.execute('external_commit_restart_verified_test', args, context);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(JSON.parse(replay)).toMatchObject({
      verified: true,
      verificationStatus: 'verified',
      providerReceipt: 'provider-restart-1',
      deduplicated: true,
    });
    expect(replay).not.toContain('sensitive body must not be journaled');
    expect(replay).not.toContain('sk-super-secret-provider-token');
    expect(JSON.parse(replay).counts.apiToken).toBe('[redacted]');
    expect(durable.rows.get('verified-across-restart-key')?.state).toBe('verified');
  });

  it('keeps an unknown commit blocked after a simulated backend restart', async () => {
    vi.useFakeTimers();
    const durable = durableJournalAdapter();
    configureExternalCommitJournal(durable.adapter);
    let rejectHandler!: (error: Error) => void;
    const handler = vi.fn(() => new Promise<string>((_resolve, reject) => {
      rejectHandler = reject;
    }));
    const args = { target: 'Restart Recipient', payload: 'Unknown across restart' };
    const context = confirmedContext('unknown-across-restart-key');

    const firstRegistry = new ToolRegistry();
    registerExternalCommit(firstRegistry, 'external_commit_restart_unknown_test', handler);
    const first = firstRegistry.execute('external_commit_restart_unknown_test', args, context);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(durable.rows.get('unknown-across-restart-key')?.state).toBe('unknown');
    rejectHandler(new Error('adapter cancelled after timeout'));
    await expect(first).rejects.toThrow(/outcome is unknown.*timed out after 30s/i);

    resetExternalCommitRuntimeCacheForTests();
    const restartedRegistry = new ToolRegistry();
    registerExternalCommit(restartedRegistry, 'external_commit_restart_unknown_test', handler);
    await expect(restartedRegistry.execute('external_commit_restart_unknown_test', args, context))
      .rejects.toThrow(/prior running or unknown attempt.*could not be verified/i);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(durable.rows.get('unknown-across-restart-key')?.state).toBe('unknown');
  });

  it('projects an uncertain external failure as unknown_outcome in the canonical envelope', async () => {
    vi.useFakeTimers();
    const registry = new ToolRegistry();
    let rejectHandler!: (error: Error) => void;
    registerExternalCommit(
      registry,
      'external_commit_envelope_unknown_test',
      () => new Promise<string>((_resolve, reject) => {
        rejectHandler = reject;
      }),
    );
    const recordPromise = executeToolCall({
      registry,
      name: 'external_commit_envelope_unknown_test',
      arguments: { target: 'Envelope Recipient', payload: 'Envelope body' },
      context: confirmedContext('envelope-unknown-key'),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    rejectHandler(new Error('adapter cancelled after timeout'));
    const record = await recordPromise;

    expect(record.error).toMatch(/outcome is unknown.*timed out after 30s/i);
    expect(record.envelope?.status).toBe('unknown_outcome');
  });
  it('rejects a different target while an external commit with the same key is still running', async () => {
    const durable = durableJournalAdapter();
    configureExternalCommitJournal(durable.adapter);
    const registry = new ToolRegistry();
    let release!: (result: string) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const handler = vi.fn(() => new Promise<string>(resolve => { release = resolve; entered(); }));
    registerExternalCommit(registry, 'external_commit_live_target_binding', handler);
    const context = confirmedContext('live-target-binding');
    const first = registry.execute('external_commit_live_target_binding', { target: 'Alice', payload: 'Only once' }, context);
    await started;
    const changed = registry.execute('external_commit_live_target_binding', { target: 'Bob', payload: 'Only once' }, context)
      .then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
    release(JSON.stringify({ verified: true, providerReceipt: 'alice-once' }));
    await first;
    expect((await changed).error?.message).toMatch(/target mismatch/i);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects a different target before replaying a verified in-process receipt', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => JSON.stringify({ verified: true, providerReceipt: 'alice-verified' }));
    registerExternalCommit(registry, 'external_commit_verified_target_binding', handler);
    const context = confirmedContext('verified-target-binding');
    await registry.execute('external_commit_verified_target_binding', { target: 'Alice', payload: 'Only once' }, context);
    await expect(registry.execute('external_commit_verified_target_binding', { target: 'Bob', payload: 'Only once' }, context))
      .rejects.toThrow(/target mismatch/i);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects another tool reusing an already verified external commit key', async () => {
    const registry = new ToolRegistry();
    const firstHandler = vi.fn(async () => JSON.stringify({ verified: true, providerReceipt: 'first-tool-receipt' }));
    const otherHandler = vi.fn(async () => JSON.stringify({ verified: true, providerReceipt: 'other-tool-receipt' }));
    registerExternalCommit(registry, 'external_commit_first_key_owner', firstHandler);
    registerExternalCommit(registry, 'external_commit_other_key_owner', otherHandler);
    const context = confirmedContext('cross-tool-key-binding');
    const args = { target: 'Alice', payload: 'Only once' };
    await registry.execute('external_commit_first_key_owner', args, context);
    await expect(registry.execute('external_commit_other_key_owner', args, context))
      .rejects.toThrow(/target mismatch/i);
    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(otherHandler).not.toHaveBeenCalled();
  });

  it('keeps a recovered verified receipt unknown when its durable terminal write fails', async () => {
    const durable = durableJournalAdapter();
    const name = 'external_commit_recovery_persistence_failure';
    const args = { target: 'Alice', payload: 'Already submitted' };
    const context = confirmedContext('recovery-write-failure');
    durable.rows.set(context.idempotencyKey, {
      idempotencyKey: context.idempotencyKey, taskId: context.taskId, userId: context.userId,
      toolName: name, inputDigest: externalCommitInputDigest(name, args), state: 'unknown',
      replayResult: '', claimToken: 'prior-attempt', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    configureExternalCommitJournal({ ...durable.adapter, async settle() { return false; } });
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => JSON.stringify({ verified: true }));
    const reconcile = vi.fn(async () => JSON.stringify({ verified: true, providerReceipt: 'read-only-proof' }));
    registerExternalCommit(registry, name, handler, reconcile);
    await expect(registry.execute(name, args, context)).rejects.toThrow(/outcome is unknown/i);
    await expect(registry.execute(name, args, context)).rejects.toThrow(/unknown prior outcome/i);
    expect(handler).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(durable.rows.get(context.idempotencyKey)?.state).toBe('unknown');
  });

  it('pins detached arguments before an asynchronous preflight yields', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => JSON.stringify({ verified: true, providerReceipt: 'pinned-target' }));
    const name = 'external_commit_preflight_argument_capture';
    registerExternalCommit(registry, name, handler);
    let release!: () => void;
    registry.get(name)!.preflight = async () => new Promise<void>(resolve => { release = resolve; });
    const args = { target: 'Alice', payload: 'Approved input' };
    const accepted = registry.execute(name, args, confirmedContext('preflight-argument-capture'));
    args.target = 'Bob';
    release();
    await accepted;
    expect(handler).toHaveBeenCalledWith({ target: 'Alice', payload: 'Approved input' }, expect.any(Object));
  });

  it('pins the external effect classification before asynchronous preflight can mutate registry metadata', async () => {
    const durable = durableJournalAdapter();
    configureExternalCommitJournal({ ...durable.adapter, async claim() { throw new Error('journal unavailable'); } });
    const registry = new ToolRegistry();
    const name = 'external_commit_preflight_capability_capture';
    const handler = vi.fn(async () => JSON.stringify({ verified: true, providerReceipt: 'must-not-send' }));
    registerExternalCommit(registry, name, handler);
    let release!: () => void;
    registry.get(name)!.preflight = async () => new Promise<void>(resolve => { release = resolve; });
    const accepted = registry.execute(name, { target: 'Alice', payload: 'No bypass' }, confirmedContext('capability-capture'));
    registry.get(name)!.capability!.sideEffects![0].type = 'local_read';
    release();
    await expect(accepted).rejects.toThrow(/durable idempotency journal is unavailable/i);
    expect(handler).not.toHaveBeenCalled();
  });

  it('pins accepted task and user identity before asynchronous preflight', async () => {
    const durable = durableJournalAdapter();
    configureExternalCommitJournal(durable.adapter);
    const registry = new ToolRegistry();
    const name = 'external_commit_preflight_identity_capture';
    const handler = vi.fn(async (_args: Record<string, any>, _context?: unknown) => JSON.stringify({ verified: true, providerReceipt: 'accepted-identity' }));
    registerExternalCommit(registry, name, handler);
    let release!: () => void;
    registry.get(name)!.preflight = async () => new Promise<void>(resolve => { release = resolve; });
    const context = confirmedContext('accepted-identity-key');
    const accepted = registry.execute(name, { target: 'Alice', payload: 'Original scope' }, context);
    context.idempotencyKey = 'replacement-key';
    context.userId = 'replacement-user';
    context.taskId = 'replacement-task';
    release();
    await accepted;
    expect(durable.rows.get('accepted-identity-key')).toMatchObject({
      userId: 'external-commit-test-user', taskId: 'external-commit-test-task', state: 'verified',
    });
    expect(durable.rows.has('replacement-key')).toBe(false);
    expect(handler.mock.calls[0][1]).toMatchObject({
      userId: 'external-commit-test-user', taskId: 'external-commit-test-task', idempotencyKey: 'accepted-identity-key',
    });
  });

  it('does not submit when cancellation arrives while the durable handler-entry fence is arming', async () => {
    const durable = durableJournalAdapter();
    const controller = new AbortController();
    let entered!: () => void;
    let release!: () => void;
    const arming = new Promise<void>(resolve => { entered = resolve; });
    configureExternalCommitJournal({
      ...durable.adapter,
      async settle(input) {
        if (input.state === 'running') await new Promise<void>(resolve => { release = resolve; entered(); });
        return durable.adapter.settle(input);
      },
    });
    const registry = new ToolRegistry();
    const name = 'external_commit_cancelled_at_durable_entry';
    const handler = vi.fn(async () => JSON.stringify({ verified: true, providerReceipt: 'must-not-submit' }));
    registerExternalCommit(registry, name, handler);
    const context = { ...confirmedContext('cancelled-at-durable-entry'), executionSignal: controller.signal, isCancelled: () => false };
    const accepted = registry.execute(name, { target: 'Alice', payload: 'No cancelled submission' }, context);
    await arming;
    controller.abort(new Error('execution revoked while arming'));
    release();
    await expect(accepted).rejects.toThrow('execution revoked while arming');
    expect(handler).not.toHaveBeenCalled();
    expect(durable.rows.get(context.idempotencyKey)?.state).toBe('not_started');
  });

});
