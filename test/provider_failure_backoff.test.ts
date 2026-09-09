import { afterEach, describe, expect, it, vi } from 'vitest';
import { withCloudResilience } from '../server/cloud/resilience';
import { getCircuitStatus, isCircuitClosed, resetCircuit } from '../server/cloud/circuit_breaker';

afterEach(() => {
  resetCircuit();
  vi.useRealTimers();
});

describe('unavailable model recovery windows', () => {
  it.each([403, 402])('backs off a rejected account (%s) longer than the next chat turn, then permits recovery', async status => {
    vi.useFakeTimers();
    const request = vi.fn(async () => { throw Object.assign(new Error('account rejected'), { status }); });
    await expect(withCloudResilience(request, { provider: 'relay', model: 'official-model', maxRetries: 0 })).rejects.toThrow('account rejected');
    await vi.advanceTimersByTimeAsync(31_000);
    expect(isCircuitClosed('relay', 'official-model')).toBe(false);
    const before = getCircuitStatus();
    await expect(withCloudResilience(request, { provider: 'relay', model: 'official-model' })).rejects.toMatchObject({ cloudCategory: 'circuit_open' });
    expect(getCircuitStatus()).toEqual(before);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(269_000);
    expect(isCircuitClosed('relay', 'official-model')).toBe(true);
    await withCloudResilience(async () => 'recovered', { provider: 'relay', model: 'official-model' });
    await withCloudResilience(async () => 'still recovered', { provider: 'relay', model: 'official-model' });
    expect(getCircuitStatus()).toEqual([]);
  });

  it('does not repeatedly spend a minute on a hung local fallback and allows it to recover', async () => {
    vi.useFakeTimers();
    await expect(withCloudResilience(async () => { throw new Error('inference timed out'); }, {
      provider: 'lmstudio', model: 'local-chat', maxRetries: 0,
    })).rejects.toMatchObject({ cloudCategory: 'timeout' });
    expect(isCircuitClosed('lmstudio', 'local-chat')).toBe(false);
    expect(isCircuitClosed('lmstudio', 'other-local-model')).toBe(true);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(isCircuitClosed('lmstudio', 'local-chat')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await withCloudResilience(async () => 'ready', { provider: 'lmstudio', model: 'local-chat' });
    await withCloudResilience(async () => 'ready', { provider: 'lmstudio', model: 'local-chat' });
    expect(getCircuitStatus()).toEqual([]);
  });

  it('does not quarantine the main model when an auxiliary caller cancels its own budget', async () => {
    const controller = new AbortController();
    const pending = withCloudResilience(async () => new Promise<never>(() => {}), {
      provider: 'lmstudio', model: 'same-main-model', signal: controller.signal, maxRetries: 0,
    });
    controller.abort(new DOMException('auxiliary deadline', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(getCircuitStatus()).toEqual([]);
    await expect(withCloudResilience(async () => 'main answer', {
      provider: 'lmstudio', model: 'same-main-model', maxRetries: 0,
    })).resolves.toBe('main answer');
  });

  it('keeps transient cloud timeouts and retryable rate limits on the existing short policy', async () => {
    vi.useFakeTimers();
    await expect(withCloudResilience(async () => { throw new Error('request timed out'); }, {
      provider: 'relay', model: 'transient', maxRetries: 0,
    })).rejects.toMatchObject({ cloudCategory: 'timeout' });
    expect(isCircuitClosed('relay', 'transient')).toBe(true);
    await expect(withCloudResilience(async () => { throw Object.assign(new Error('rate limited'), { status: 429 }); }, {
      provider: 'relay', model: 'rate-limit', maxRetries: 0,
    })).rejects.toMatchObject({ cloudCategory: 'quota' });
    expect(isCircuitClosed('relay', 'rate-limit')).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(isCircuitClosed('relay', 'rate-limit')).toBe(true);
  });
});
