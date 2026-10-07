import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireCircuitCall, getCircuitStatus, isCircuitClosed, isCircuitHealthy, recordFailure, recordSuccess, releaseCircuitCall, resetCircuit, setCircuitBreakerConfig } from '../server/cloud/circuit_breaker';
import { withCloudResilience } from '../server/cloud/resilience';
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const options = { provider: 'epoch-provider', model: 'epoch-model', maxRetries: 0 };
afterEach(() => {
  vi.restoreAllMocks(); resetCircuit();
  setCircuitBreakerConfig({ failureThreshold: 5, halfOpenSuccessThreshold: 2, cooldownMs: 30000, failureWindowMs: 60000 });
});
function recovering() {
  setCircuitBreakerConfig({ cooldownMs: 0 });
  recordFailure(options.provider, options.model, new Error('offline'), { openImmediately: true });
}
describe('model call ownership across configuration and recovery', () => {
  it.each(['success', 'auth', 'timeout'] as const)('ignores an old %s after credentials reset', async kind => {
    const pending = deferred<string>();
    const old = withCloudResilience(() => pending.promise, { ...options, ...(kind === 'timeout' ? { timeoutMs: 15 } : {}) }).catch(error => error);
    await tick(); resetCircuit(options.provider);
    if (kind === 'success') pending.resolve('old result');
    if (kind === 'auth') pending.reject(Object.assign(new Error('invalid API key'), { status: 401 }));
    await old;
    const next = vi.fn(async () => 'new configuration');
    await expect(withCloudResilience(next, options)).resolves.toBe('new configuration');
    expect(next).toHaveBeenCalledOnce(); expect(isCircuitHealthy(options.provider, options.model)).toBe(true);
    pending.resolve('late ignored result');
  });
  it('admits one half-open call and requires two fresh sequential successes', async () => {
    recovering(); const pending = deferred<string>(); const entered = vi.fn(() => pending.promise);
    const first = withCloudResilience(entered, options);
    const others = Array.from({ length: 3 }, () => withCloudResilience(entered, options).catch(error => error));
    await tick(); expect(entered).toHaveBeenCalledOnce();
    expect((await Promise.all(others)).every(error => error.cloudCategory === 'circuit_open')).toBe(true);
    pending.resolve('probe one'); await first;
    expect(isCircuitHealthy(options.provider, options.model)).toBe(false);
    await withCloudResilience(async () => 'probe two', options);
    expect(isCircuitHealthy(options.provider, options.model)).toBe(true);
  });
  it('retains normal closed-state concurrency', async () => {
    const pending = deferred<string>(); const entered = vi.fn(() => pending.promise);
    const calls = Array.from({ length: 4 }, () => withCloudResilience(entered, options));
    await tick(); expect(entered).toHaveBeenCalledTimes(4); pending.resolve('OK'); await Promise.all(calls);
  });
  it('never counts pre-failure successes as recovery probes', async () => {
    const pending = deferred<string>();
    const old = Array.from({ length: 2 }, () => withCloudResilience(() => pending.promise, options));
    await tick(); recovering(); expect(isCircuitClosed(options.provider, options.model)).toBe(true);
    pending.resolve('old success'); await Promise.all(old);
    expect(getCircuitStatus()).toContainEqual(expect.objectContaining({ key: 'epoch-provider:epoch-model', state: 'half-open' }));
    expect(isCircuitHealthy(options.provider, options.model)).toBe(false);
    await withCloudResilience(async () => 'fresh one', options);
    await withCloudResilience(async () => 'fresh two', options);
    expect(isCircuitHealthy(options.provider, options.model)).toBe(true);
  });
  it('releases an aborted probe without counting it and ignores late completion', async () => {
    recovering(); const pending = deferred<string>(); const controller = new AbortController();
    const stopped = withCloudResilience(() => pending.promise, { ...options, signal: controller.signal }).catch(error => error);
    await tick(); controller.abort(); await stopped;
    await withCloudResilience(async () => 'first actual success', options);
    pending.resolve('cancelled late success'); await tick();
    expect(isCircuitHealthy(options.provider, options.model)).toBe(false);
    await withCloudResilience(async () => 'second actual success', options);
    expect(isCircuitHealthy(options.provider, options.model)).toBe(true);
  });
  it('reopens a timed-out probe and releases its reservation', async () => {
    recovering(); const pending = deferred<string>();
    await expect(withCloudResilience(() => pending.promise, { ...options, timeoutMs: 15 })).rejects.toThrow('timed out');
    expect(getCircuitStatus()).toContainEqual(expect.objectContaining({ state: 'open' }));
    await withCloudResilience(async () => 'fresh one', options); pending.resolve('late'); await tick();
    expect(isCircuitHealthy(options.provider, options.model)).toBe(false);
    await withCloudResilience(async () => 'fresh two', options);
    expect(isCircuitHealthy(options.provider, options.model)).toBe(true);
  });
  it('checks and recovers a provider-wide gate across different model callers', async () => {
    recordFailure(options.provider, undefined, new Error('global auth'), { openImmediately: true, cooldownMs: 0 });
    const pending = deferred<string>(); const first = withCloudResilience(() => pending.promise, options);
    const denied = vi.fn(async () => 'other');
    await expect(withCloudResilience(denied, { ...options, model: 'other-model' })).rejects.toThrow('CircuitBreaker');
    expect(denied).not.toHaveBeenCalled(); pending.resolve('OK'); await first;
    await withCloudResilience(async () => 'second', options);
    expect(isCircuitHealthy(options.provider)).toBe(true);
  });
  it('settles leases once and invalidates model-only resets', () => {
    recovering(); const first = acquireCircuitCall(options.provider, options.model)!;
    recordSuccess(options.provider, options.model, first); recordSuccess(options.provider, options.model, first);
    expect(isCircuitHealthy(options.provider, options.model)).toBe(false);
    const stale = acquireCircuitCall(options.provider, options.model)!; resetCircuit(options.provider, options.model);
    recordFailure(options.provider, options.model, new Error('late auth'), { openImmediately: true }, stale);
    expect(isCircuitHealthy(options.provider, options.model)).toBe(true); releaseCircuitCall(stale);
  });
});
