import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, resetExternalCommitRuntimeCacheForTests } from '../server/tools/registry';
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
  it('marks a timed-out commit unknown and never invokes it again with the same key', async () => {
    vi.useFakeTimers();
    const registry = new ToolRegistry();
    const handler = vi.fn(() => new Promise<string>(() => {}));
    registerExternalCommit(registry, 'external_commit_timeout_test', handler);
    const args = { target: 'Alice', payload: 'Only once' };
    const context = confirmedContext('timeout-no-resend-key');

    const first = registry.execute('external_commit_timeout_test', args, context);
    const firstRejection = expect(first).rejects.toThrow(/timed out after 30s/i);
    await vi.advanceTimersByTimeAsync(30_000);
    await firstRejection;

    await expect(registry.execute('external_commit_timeout_test', args, context))
      .rejects.toThrow(/unknown prior outcome.*automatic resend was stopped/i);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not let a late handler result turn an unknown commit into an implicit resend', async () => {
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
    const firstRejection = expect(first).rejects.toThrow(/timed out after 30s/i);
    await vi.advanceTimersByTimeAsync(30_000);
    await firstRejection;

    resolveHandler(JSON.stringify({ verified: true, providerReceipt: 'late-receipt' }));
    await Promise.resolve();

    await expect(registry.execute('external_commit_late_result_test', args, context))
      .rejects.toThrow(/unknown prior outcome.*automatic resend was stopped/i);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('accepts a verified read-only reconciliation and deduplicates later retries', async () => {
    vi.useFakeTimers();
    const registry = new ToolRegistry();
    const handler = vi.fn(() => new Promise<string>(() => {}));
    const reconciled = JSON.stringify({
      verified: true,
      providerReceipt: 'provider-42',
      status: 'sent',
    });
    const reconcile = vi.fn(async () => reconciled);
    registerExternalCommit(registry, 'external_commit_reconcile_test', handler, reconcile);
    const args = { target: 'Carol', payload: 'Reconcile me' };
    const context = confirmedContext('verified-reconciliation-key');

    const first = registry.execute('external_commit_reconcile_test', args, context);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(first).resolves.toBe(reconciled);
    await expect(registry.execute('external_commit_reconcile_test', args, context))
      .resolves.toBe(reconciled);

    expect(handler).toHaveBeenCalledTimes(1);
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
    expect(durable.rows.get('verified-across-restart-key')?.state).toBe('verified');
  });

  it('keeps an unknown commit blocked after a simulated backend restart', async () => {
    vi.useFakeTimers();
    const durable = durableJournalAdapter();
    configureExternalCommitJournal(durable.adapter);
    const handler = vi.fn(() => new Promise<string>(() => {}));
    const args = { target: 'Restart Recipient', payload: 'Unknown across restart' };
    const context = confirmedContext('unknown-across-restart-key');

    const firstRegistry = new ToolRegistry();
    registerExternalCommit(firstRegistry, 'external_commit_restart_unknown_test', handler);
    const first = firstRegistry.execute('external_commit_restart_unknown_test', args, context);
    const firstRejection = expect(first).rejects.toThrow(/outcome is unknown.*timed out after 30s/i);
    await vi.advanceTimersByTimeAsync(30_000);
    await firstRejection;

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
    registerExternalCommit(
      registry,
      'external_commit_envelope_unknown_test',
      () => new Promise<string>(() => {}),
    );
    const recordPromise = executeToolCall({
      registry,
      name: 'external_commit_envelope_unknown_test',
      arguments: { target: 'Envelope Recipient', payload: 'Envelope body' },
      context: confirmedContext('envelope-unknown-key'),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const record = await recordPromise;

    expect(record.error).toMatch(/outcome is unknown.*timed out after 30s/i);
    expect(record.envelope?.status).toBe('unknown_outcome');
  });
});
