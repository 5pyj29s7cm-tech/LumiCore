import { afterEach, describe, expect, it } from 'vitest';
import { withCloudResilience, CloudResilienceTimeoutError } from '../server/cloud/resilience';
import {
  getCircuitStatus,
  resetCircuit,
  setCircuitBreakerConfig,
} from '../server/cloud/circuit_breaker';

afterEach(() => {
  resetCircuit();
  setCircuitBreakerConfig({
    failureThreshold: 5,
    halfOpenSuccessThreshold: 2,
    cooldownMs: 30_000,
    failureWindowMs: 60_000,
  });
});

describe('cloud resilience hard boundaries', () => {
  it('settles at the outer deadline when an SDK promise ignores AbortSignal', async () => {
    const startedAt = Date.now();
    await expect(withCloudResilience(
      () => new Promise<never>(() => {}),
      { provider: 'hung-provider', model: 'hung-model', maxRetries: 0, timeoutMs: 20 },
    )).rejects.toBeInstanceOf(CloudResilienceTimeoutError);

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(getCircuitStatus()).toContainEqual(expect.objectContaining({
      key: 'hung-provider:hung-model',
      failureCount: 1,
    }));
  });

  it('does not count caller cancellation as provider ill-health', async () => {
    const controller = new AbortController();
    const pending = withCloudResilience(
      () => new Promise<never>(() => {}),
      { provider: 'cancelled-provider', model: 'cancelled-model', maxRetries: 0, signal: controller.signal },
    );
    setTimeout(() => controller.abort(new DOMException('user stopped', 'AbortError')), 10);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(getCircuitStatus().some(status => status.key === 'cancelled-provider:cancelled-model')).toBe(false);
  });
});
