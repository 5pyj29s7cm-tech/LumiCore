import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../server/tools/registry';

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

afterEach(() => {
  vi.useRealTimers();
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
});
