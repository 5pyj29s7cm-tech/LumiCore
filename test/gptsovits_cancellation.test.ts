import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/config/privacy', () => ({ isStrictPrivacy: () => true, requireLocalEndpoint: vi.fn() }));
vi.mock('../server/tts/gptsovits_runtime', () => ({
  ensureGptSovitsRuntime: vi.fn(), isGptSovitsRuntimeInstalled: () => false,
  isGptSovitsRuntimeReady: () => false, markGptSovitsActivity: vi.fn(),
}));
import { synthesizeSpeech, getRuntimeQueueStatus } from '../server/tts/providers/gptsovits';
import { getCircuitStatus, resetCircuit } from '../server/cloud/circuit_breaker';
afterEach(() => { vi.unstubAllGlobals(); resetCircuit(); });
describe('speech synthesis queue ownership', () => {
  it('cancels a waiting item immediately and lets its successor acquire the released slot', async () => {
    let finish!: (value: any) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
    vi.stubGlobal('fetch', fetch);
    const first = synthesizeSpeech('first');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const second = synthesizeSpeech('second', undefined, controller.signal);
    const third = synthesizeSpeech('third');
    expect(getRuntimeQueueStatus()).toMatchObject({ inFlight: 1, queueLength: 2 });
    const rejected = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(getRuntimeQueueStatus()).toMatchObject({ inFlight: 1, queueLength: 1 });
    finish({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });
    await Promise.all([first, third]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getRuntimeQueueStatus()).toMatchObject({ inFlight: 0, queueLength: 0 });
  });
  it('does not open the provider circuit after repeated in-flight user cancellation', async () => {
    const fetch = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    for (let index = 0; index < 6; index++) {
      const controller = new AbortController();
      const pending = synthesizeSpeech('cancel', undefined, controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(index + 1));
      controller.abort();
      await rejected;
    }
    expect(getCircuitStatus().find(status => status.key === 'gptsovits')).toBeUndefined();
    expect(getRuntimeQueueStatus()).toMatchObject({ inFlight: 0, queueLength: 0 });
  });
});
