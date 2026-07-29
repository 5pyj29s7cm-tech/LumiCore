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
import { ToolRegistry } from '../server/tools/registry';
import { getToolRuntimeMetrics, resetToolRuntimeMetricsForTests } from '../server/runtime/tool_metrics';

const observeCapability: any = {
  operation: 'observe',
  sideEffects: [{ type: 'network_read', scope: 'target', reversible: true }],
};

const externalCommitCapability: any = {
  operation: 'communicate',
  sideEffects: [{ type: 'external_communication', scope: 'recipient', reversible: false }],
};

afterEach(() => {
  resetAdapterResilienceForTests();
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
});
