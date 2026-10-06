import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatExecutionWatch } from '../src/lib/chatExecutionWatch';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function watch(firstProbeMs = 120000) {
  const onEvent = vi.fn(), probe = vi.fn();
  const watcher = new ChatExecutionWatch({ requestId: 'A', source: 'chat', firstProbeMs, onEvent, probe });
  return { watcher, onEvent, probe };
}
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  ok: true, snapshot: { requestId: 'A', source: 'chat', terminal: false, status: 'executing', ...overrides },
});
it('distinguishes an acknowledgement delay from a terminal rejection', () => {
  const w = watch();
  vi.advanceTimersByTime(5000); expect(w.onEvent).toHaveBeenCalledWith('ack_timeout');
  w.watcher.acknowledge({ ok: true }); expect(w.onEvent).toHaveBeenLastCalledWith('acknowledged');
  vi.advanceTimersByTime(115000); expect(w.probe).toHaveBeenCalledOnce();
  w.watcher.dispose(); expect(vi.getTimerCount()).toBe(0);
});
it.each([120000, 180000])('settles missing acknowledgement after %i without probing another execution', delay => {
  const w = watch(delay);
  vi.advanceTimersByTime(delay); expect(w.onEvent).toHaveBeenLastCalledWith('no_ack', undefined);
  expect(w.probe).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  w.watcher.acknowledge({ ok: true }); expect(w.onEvent).toHaveBeenCalledTimes(2);
});
it('clears all timers on rejection and ignores a late positive acknowledgement', () => {
  const w = watch(); w.watcher.acknowledge({ ok: false, error: 'Synthetic rejected' });
  expect(w.onEvent).toHaveBeenCalledWith('rejected', 'Synthetic rejected');
  w.watcher.acknowledge({ ok: true }); vi.advanceTimersByTime(300000);
  expect(w.onEvent).toHaveBeenCalledOnce(); expect(w.probe).not.toHaveBeenCalled();
});
it.each([{ requestId: 'B' }, { source: 'voice' }])('rejects an unrelated resume snapshot %j', mismatch => {
  const w = watch(); w.watcher.acknowledge({ ok: true }); vi.advanceTimersByTime(120000);
  w.probe.mock.calls[0][0](snapshot(mismatch));
  expect(w.onEvent).toHaveBeenLastCalledWith('lost', undefined); expect(vi.getTimerCount()).toBe(0);
});
it('ignores a late probe reply after timeout while continuing the next probe', () => {
  const w = watch(); w.watcher.acknowledge({ ok: true }); vi.advanceTimersByTime(130000);
  expect(w.onEvent).toHaveBeenLastCalledWith('probe_timeout');
  w.probe.mock.calls[0][0]({ ok: false, error: 'Late error' });
  expect(w.onEvent).toHaveBeenLastCalledWith('probe_timeout');
  vi.advanceTimersByTime(30000); expect(w.probe).toHaveBeenCalledTimes(2);
  w.probe.mock.calls[1][0](snapshot()); expect(w.onEvent).toHaveBeenLastCalledWith('working');
  w.watcher.dispose();
});
it('does not mistake a terminal snapshot for a delivered receipt', () => {
  const w = watch(); w.watcher.acknowledge({ ok: true }); vi.advanceTimersByTime(120000);
  w.probe.mock.calls[0][0](snapshot({ terminal: true, status: 'completed' }));
  expect(w.onEvent).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(30000); expect(w.probe).toHaveBeenCalledTimes(2);
  w.watcher.dispose();
});
it('disposal blocks acknowledgements, probe replies and all future timers', () => {
  const w = watch(); w.watcher.acknowledge({ ok: true }); vi.advanceTimersByTime(120000);
  w.watcher.dispose(); w.probe.mock.calls[0][0](snapshot()); w.watcher.acknowledge({ ok: false });
  vi.advanceTimersByTime(300000);
  expect(w.onEvent).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});
