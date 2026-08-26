import { describe, expect, it } from 'vitest';
import {
  containsInternalExecutionBlock,
  isVerifiedForcedFailoverProbe,
  isLoopbackBaseUrl,
  parseWorkerReceiptCount,
  validateRoutingTrace,
} from '../scripts/formal-client-e2e.mjs';

describe('formal native-client E2E safety helpers', () => {
  it('allows only loopback API targets', () => {
    expect(isLoopbackBaseUrl('http://127.0.0.1:3000/api')).toBe(true);
    expect(isLoopbackBaseUrl('http://localhost:3000/api')).toBe(true);
    expect(isLoopbackBaseUrl('http://[::1]:3000/api')).toBe(true);
    expect(isLoopbackBaseUrl('https://example.com/api')).toBe(false);
    expect(isLoopbackBaseUrl('file:///tmp/proof')).toBe(false);
  });

  it('detects internal execution-guard copy in natural replies', () => {
    expect(containsInternalExecutionBlock('这一轮没有记录到成功的真实工具执行。')).toBe(true);
    expect(containsInternalExecutionBlock('No successful current-turn tool execution was recorded.')).toBe(true);
    expect(containsInternalExecutionBlock('已经帮你看完了。')).toBe(false);
  });

  it('counts only durable worker evidence', () => {
    expect(parseWorkerReceiptCount({ evidence: ['Worker receipts: 3'] })).toBe(3);
    expect(parseWorkerReceiptCount({ evidence: ['Assigned workers: 5'] })).toBe(0);
  });

  it('requires selected successful route attempts and a fallback reason', () => {
    expect(validateRoutingTrace({
      ok: true,
      provider: 'pinned-provider',
      model: 'pinned-model',
      latencyMs: 12,
    }, { allowProviderProbe: true }).ok).toBe(true);
    expect(validateRoutingTrace({
      ok: true,
      selectedProvider: 'b',
      selectedModel: 'm2',
      fallbackReason: 'primary_failed',
      attempts: [
        { provider: 'a', model: 'm1', status: 'failed' },
        { provider: 'b', model: 'm2', status: 'succeeded' },
      ],
    })).toEqual({ ok: true, fallbackObserved: true, attemptCount: 2 });
    expect(validateRoutingTrace({
      ok: true,
      selectedProvider: 'b',
      selectedModel: 'm2',
      fallbackReason: '',
      attempts: [
        { provider: 'a', model: 'm1', status: 'failed' },
        { provider: 'b', model: 'm2', status: 'succeeded' },
      ],
    }).ok).toBe(false);
  });

  it('accepts only a deterministic failed-primary to successful-alternate probe', () => {
    const probe = {
      ok: true,
      verification: 'live_forced_primary_failure_failover',
      selectedProvider: 'openai',
      selectedModel: 'fallback-model',
      fallbackReason: 'unsupported_provider_or_model',
      attempts: [
        {
          provider: '__lumi_forced_unavailable_primary__',
          model: '__lumi_forced_unavailable_model__',
          status: 'failed',
          reason: 'unsupported_provider_or_model',
        },
        { provider: 'openai', model: 'fallback-model', status: 'succeeded' },
      ],
    };
    expect(isVerifiedForcedFailoverProbe(probe)).toBe(true);
    expect(isVerifiedForcedFailoverProbe({ ...probe, fallbackReason: '' })).toBe(false);
    expect(isVerifiedForcedFailoverProbe({
      ...probe,
      attempts: [{ provider: 'openai', model: 'fallback-model', status: 'succeeded' }],
    })).toBe(false);
  });
});
