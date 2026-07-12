import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyCloudError } from '../server/cloud/core';
import {
  getCircuitStatus,
  isCircuitClosed,
  isCircuitHealthy,
  recordFailure,
  resetCircuit,
  setCircuitBreakerConfig,
} from '../server/cloud/circuit_breaker';
import * as cosyvoice from '../server/tts/providers/cosyvoice';
import { synthesizeSpeech as synthesizeWithAdapter } from '../server/tts/adapter';

afterEach(() => {
  vi.unstubAllGlobals();
  resetCircuit();
  setCircuitBreakerConfig({
    failureThreshold: 5,
    halfOpenSuccessThreshold: 2,
    cooldownMs: 30_000,
    failureWindowMs: 60_000,
  });
});

describe('cloud provider failure feedback', () => {
  it('classifies overdue account responses as quota failures', () => {
    const result = classifyCloudError(new Error('Access denied: overdue-payment'));
    expect(result.category).toBe('quota');
    expect(result.isRetryable).toBe(true);
  });

  it('can open a provider circuit immediately for account failures', () => {
    recordFailure('test-provider', undefined, new Error('invalid credentials'), { openImmediately: true });
    expect(isCircuitClosed('test-provider')).toBe(false);
    expect(getCircuitStatus()).toContainEqual(expect.objectContaining({ key: 'test-provider', state: 'open' }));
  });

  it('reopens a half-open circuit when its recovery probe fails', () => {
    setCircuitBreakerConfig({ failureThreshold: 1, cooldownMs: 0 });
    recordFailure('recovery-provider', undefined, new Error('first failure'));
    expect(isCircuitClosed('recovery-provider')).toBe(true);
    recordFailure('recovery-provider', undefined, new Error('probe failure'));
    expect(getCircuitStatus()).toContainEqual(expect.objectContaining({ key: 'recovery-provider', state: 'open' }));
  });

  it('does not report an open circuit healthy just because cooldown elapsed', () => {
    setCircuitBreakerConfig({ failureThreshold: 1, cooldownMs: 0 });
    recordFailure('status-provider', undefined, new Error('offline'));
    expect(isCircuitHealthy('status-provider')).toBe(false);
    expect(getCircuitStatus()).toContainEqual(expect.objectContaining({ key: 'status-provider', state: 'open' }));
  });

  it('marks an HTTP-level CosyVoice account failure unhealthy', async () => {
    const previousKey = process.env.DASHSCOPE_API_KEY;
    process.env.DASHSCOPE_API_KEY = 'test-dashscope-key';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'Access denied: overdue-payment' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )));

    try {
      await expect(cosyvoice.synthesizeSpeech('test')).rejects.toThrow('overdue-payment');
      expect(isCircuitClosed('cosyvoice')).toBe(false);
    } finally {
      if (previousKey === undefined) delete process.env.DASHSCOPE_API_KEY;
      else process.env.DASHSCOPE_API_KEY = previousKey;
    }
  });

  it('marks a failed local TTS adapter call unavailable immediately', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('local TTS offline')));
    await expect(synthesizeWithAdapter('test', {
      provider: 'local-cosyvoice',
      voiceId: 'default',
    })).rejects.toThrow();
    expect(isCircuitClosed('local-cosyvoice')).toBe(false);
  });
});
