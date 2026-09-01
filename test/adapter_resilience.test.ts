import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beforeAdapterExecution,
  classifyAdapterResilienceFamily,
  getAdapterRetryPolicy,
  getAdapterResilienceSnapshot,
  recordAdapterExecutionFailure,
  recordAdapterExecutionSuccess,
  resetAdapterResilienceForTests,
} from '../server/tools/adapter_resilience';
import {
  ToolRegistry,
  resetExternalCommitRuntimeCacheForTests,
} from '../server/tools/registry';
import { configureExternalCommitJournal } from '../server/tools/external_commit_journal';
import { getToolRuntimeMetrics, resetToolRuntimeMetricsForTests } from '../server/runtime/tool_metrics';

const observeCapability: any = {
  operation: 'observe',
  sideEffects: [{ type: 'network_read', scope: 'target', reversible: true }],
};

const externalCommitCapability: any = {
  operation: 'communicate',
  sideEffects: [{ type: 'external_communication', scope: 'recipient', reversible: false }],
};

function registerDesktopExternalCommit(
  registry: ToolRegistry,
  name: string,
  handler: () => Promise<string>,
): void {
  registry.register({
    name,
    description: 'Test-only desktop external commit adapter.',
    parameters: { type: 'object', properties: {} },
    permission: 'public',
    securityLevel: 'confirm',
    capability: {
      lane: 'desktop',
      operation: 'communicate',
      risk: 'medium',
      sideEffects: [{ type: 'external_communication', scope: 'test target', reversible: false }],
      verification: {
        strategy: 'terminal_receipt',
        required: true,
        requiredFields: ['verified'],
        successSignals: ['verified provider receipt'],
        limitations: [],
      },
    },
    handler,
  });
}

afterEach(() => {
  resetAdapterResilienceForTests();
  configureExternalCommitJournal(null);
  resetExternalCommitRuntimeCacheForTests();
  resetToolRuntimeMetricsForTests();
  vi.useRealTimers();
});

describe('adapter resilience circuits', () => {
  it('classifies the client, desktop, WeChat, CAD and MCP adapter families', () => {
    expect(classifyAdapterResilienceFamily('client_action')).toBe('client');
    expect(classifyAdapterResilienceFamily('desktop_active_window')).toBe('desktop');
    expect(classifyAdapterResilienceFamily('wechat_send_message')).toBe('wechat');
    expect(classifyAdapterResilienceFamily('mcp_cad-drafting_autocad_playback_file')).toBe('cad');
    expect(classifyAdapterResilienceFamily('mcp_playwright_browser_snapshot')).toBe('mcp');
    expect(classifyAdapterResilienceFamily('read_file')).toBeNull();
  });

  it('opens after the configured failures and only admits a read-only half-open probe', () => {
    const context = { userId: 'wechat-circuit-user' };
    const first = beforeAdapterExecution({
      toolName: 'wechat_read_recent_chat', capability: observeCapability, context, now: 100,
    });
    recordAdapterExecutionFailure(first, new Error('socket disconnected'), { now: 100 });
    const second = beforeAdapterExecution({
      toolName: 'wechat_read_recent_chat', capability: observeCapability, context, now: 200,
    });
    recordAdapterExecutionFailure(second, new Error('connection timeout'), { now: 200 });

    expect(beforeAdapterExecution({
      toolName: 'wechat_read_recent_chat', capability: observeCapability, context, now: 1_000,
    })).toMatchObject({ allowed: false, reason: 'adapter circuit cooldown is active' });
    expect(beforeAdapterExecution({
      toolName: 'wechat_send_message', capability: externalCommitCapability, context, now: 31_000,
    })).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('external commits cannot probe'),
    });

    const probe = beforeAdapterExecution({
      toolName: 'wechat_read_recent_chat', capability: observeCapability, context, now: 31_000,
    });
    expect(probe).toMatchObject({ allowed: true, recoveryProbe: true });
    recordAdapterExecutionSuccess(probe, 31_100);
    expect(beforeAdapterExecution({
      toolName: 'wechat_send_message', capability: externalCommitCapability, context, now: 31_200,
    })).toMatchObject({ allowed: true, recoveryProbe: false });
  });

  it('keeps failures isolated by adapter family and owner', () => {
    const failing = { userId: 'owner-a' };
    for (let index = 0; index < 3; index += 1) {
      const permit = beforeAdapterExecution({
        toolName: 'desktop_active_window', capability: observeCapability, context: failing, now: 100 + index,
      });
      recordAdapterExecutionFailure(permit, new Error('desktop process exited'), { now: 100 + index });
    }
    expect(beforeAdapterExecution({
      toolName: 'desktop_active_window', capability: observeCapability, context: failing, now: 500,
    }).allowed).toBe(false);
    expect(beforeAdapterExecution({
      toolName: 'client_get_state', capability: observeCapability, context: failing, now: 500,
    }).allowed).toBe(true);
    expect(beforeAdapterExecution({
      toolName: 'desktop_active_window', capability: observeCapability, context: { userId: 'owner-b' }, now: 500,
    }).allowed).toBe(true);
  });

  it('retries only transient idempotent reads with bounded jitter', async () => {
    expect(getAdapterRetryPolicy('wechat_read_recent_chat', observeCapability)).toMatchObject({
      maxAttempts: 2,
      retryTransientOnly: true,
    });
    expect(getAdapterRetryPolicy('wechat_send_message', externalCommitCapability)).toMatchObject({
      maxAttempts: 1,
      jitterMs: 0,
    });

    const handler = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(JSON.stringify({ read: true, verificationStatus: 'verified' }));
    const registry = new ToolRegistry();
    registry.register({
      name: 'wechat_read_retry_test',
      description: 'Retry-safe read test.',
      parameters: { type: 'object', properties: {} },
      permission: 'user',
      securityLevel: 'safe',
      capability: {
        lane: 'messaging', operation: 'observe', risk: 'low',
        sideEffects: [{ type: 'network_read', scope: 'chat', reversible: true }],
        verification: {
          strategy: 'provider_ack', required: true, requiredFields: ['read'],
          successSignals: ['read receipt'], limitations: [],
        },
      },
      handler,
    });

    await expect(registry.execute('wechat_read_retry_test', {}, { userId: 'retry-user' }))
      .resolves.toContain('"read":true');
    expect(handler).toHaveBeenCalledTimes(2);
    expect(getToolRuntimeMetrics().tools.wechat_read_retry_test).toMatchObject({ retries: 1 });
  });

  it('blocks the real registry handler while a family circuit is open and exposes health state', async () => {
    const userId = 'registry-circuit-user';
    const now = Date.now();
    for (let index = 0; index < 2; index += 1) {
      const permit = beforeAdapterExecution({
        toolName: 'wechat_read_recent_chat',
        capability: observeCapability,
        context: { userId },
        now: now + index,
      });
      recordAdapterExecutionFailure(permit, new Error('ECONNRESET'), { now: now + index });
    }

    const handler = vi.fn(async () => JSON.stringify({ read: true }));
    const registry = new ToolRegistry();
    registry.register({
      name: 'wechat_read_circuit_probe_test',
      description: 'Test WeChat read adapter circuit.',
      parameters: { type: 'object', properties: {} },
      permission: 'user',
      securityLevel: 'safe',
      capability: {
        lane: 'messaging',
        operation: 'observe',
        risk: 'low',
        sideEffects: [{ type: 'network_read', scope: 'chat', reversible: true }],
        verification: {
          strategy: 'provider_ack', required: true, requiredFields: ['read'],
          successSignals: ['read receipt'], limitations: [],
        },
      },
      handler,
    });

    await expect(registry.execute('wechat_read_circuit_probe_test', {}, { userId }))
      .rejects.toThrow(/adapter circuit is open.*cooldown/i);
    expect(handler).not.toHaveBeenCalled();
    expect((getAdapterResilienceSnapshot().families as any).wechat).toMatchObject({
      openCircuits: 1,
      trackedOwners: 1,
    });
  });

  it('keeps fulfilled but unverified external outcomes out of the adapter circuit', async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => JSON.stringify({
      status: 'submitted_unverified',
      submitted: true,
    }));
    registerDesktopExternalCommit(registry, 'desktop_fulfilled_unverified_commit_test', handler);

    for (let index = 0; index < 3; index += 1) {
      await expect(registry.execute('desktop_fulfilled_unverified_commit_test', {}, {
        userId: 'fulfilled-unverified-owner',
        userConfirmed: true,
        idempotencyKey: `fulfilled-unverified-${index}`,
      })).resolves.toContain('submitted_unverified');
    }

    expect(handler).toHaveBeenCalledTimes(3);
    expect((getAdapterResilienceSnapshot().families as any).desktop).toMatchObject({
      openCircuits: 0,
      trackedOwners: 1,
    });
  });

  it('does not turn local durable-settlement failure into an adapter outage', async () => {
    configureExternalCommitJournal({
      async lookup() { return null; },
      async claim(entry) { return { claimed: true, entry }; },
      async settle(input) { return input.state === 'running'; },
    });
    const registry = new ToolRegistry();
    const handler = vi.fn(async () => JSON.stringify({
      status: 'sent',
      sent: true,
      verificationStatus: 'verified',
    }));
    registerDesktopExternalCommit(registry, 'desktop_durable_settlement_failure_test', handler);

    for (let index = 0; index < 3; index += 1) {
      await expect(registry.execute('desktop_durable_settlement_failure_test', {}, {
        userId: 'durable-settlement-owner',
        userConfirmed: true,
        idempotencyKey: `durable-settlement-${index}`,
      })).rejects.toThrow(/outcome is unknown.*terminal state could not be persisted/i);
    }

    expect(handler).toHaveBeenCalledTimes(3);
    expect((getAdapterResilienceSnapshot().families as any).desktop).toMatchObject({
      openCircuits: 0,
      trackedOwners: 1,
    });
  });

  it('counts transient handler failures but not business rejections against the circuit', async () => {
    const businessRegistry = new ToolRegistry();
    const businessHandler = vi.fn(async () => {
      throw new Error('provider rejected the request by policy');
    });
    registerDesktopExternalCommit(businessRegistry, 'desktop_business_rejection_test', businessHandler);
    for (let index = 0; index < 3; index += 1) {
      await expect(businessRegistry.execute('desktop_business_rejection_test', {}, {
        userId: 'business-rejection-owner',
        userConfirmed: true,
        idempotencyKey: `business-rejection-${index}`,
      })).rejects.toThrow(/outcome is unknown/i);
    }
    expect((getAdapterResilienceSnapshot().families as any).desktop.openCircuits).toBe(0);

    const transientRegistry = new ToolRegistry();
    const transientHandler = vi.fn(async () => {
      throw new Error('ECONNRESET while calling desktop adapter');
    });
    registerDesktopExternalCommit(transientRegistry, 'desktop_transient_commit_failure_test', transientHandler);
    for (let index = 0; index < 3; index += 1) {
      await expect(transientRegistry.execute('desktop_transient_commit_failure_test', {}, {
        userId: 'transient-failure-owner',
        userConfirmed: true,
        idempotencyKey: `transient-failure-${index}`,
      })).rejects.toThrow(/outcome is unknown/i);
    }

    expect(transientHandler).toHaveBeenCalledTimes(3);
    expect(beforeAdapterExecution({
      toolName: 'desktop_active_window',
      capability: observeCapability,
      context: { userId: 'transient-failure-owner' },
    })).toMatchObject({
      allowed: false,
      reason: 'adapter circuit cooldown is active',
    });
  });
});
