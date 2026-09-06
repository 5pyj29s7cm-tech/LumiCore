
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ socket: null as any, invoke: vi.fn(), gate: Promise.resolve() as Promise<void>, toast: Object.assign(vi.fn(), { warning: vi.fn(), dismiss: vi.fn() }), confirm: vi.fn() }));
vi.mock('@/services/apiBridge', () => ({ isTauriRuntime: () => true }));
vi.mock('@/services/socketService', () => ({ socketService: { connect: () => mock.socket } }));
vi.mock('@/services/nativeClientIdentity', () => ({ getNativeClientIdentity: async () => ({ synthetic: true }) }));
vi.mock('@/services/desktopAutomationActivity', () => ({ beginDesktopAutomationActivity() {}, endDesktopAutomationActivity() {} }));
vi.mock('sonner', () => ({ toast: mock.toast }));
vi.mock('@/lib/appConfirm', () => ({ appConfirm: mock.confirm }));
vi.mock('@/i18n/runtime', () => ({ getLocale: () => 'en' }));
function socket() {
 const handlers = new Map<string, Function>(); const emitted: any[] = [];
 const s: any = { id: 'connection-a', connected: true, resume: [] as any[], drains: [] as any[], autoAck: false,
  on: (event: string, fn: Function) => handlers.set(event, fn), off: (event: string, fn: Function) => { if (handlers.get(event) === fn) handlers.delete(event); },
  emit: (event: string, payload: any, ack?: Function) => { emitted.push({ event, payload, ack }); if (event === 'tool:desktop_resume') { if (s.holdNormal) s.normalReply = () => ack?.({ ok: true, executions: s.resume }); else ack?.({ ok: true, executions: s.resume }); } if (event === 'tool:desktop_drain_resume') { if (s.holdDrain) s.drainReply = () => ack?.({ ok: true, executions: s.drains }); else ack?.({ ok: true, executions: s.drains }); } if (event === 'tool:desktop_authorize_stop_ack') ack?.(s.stopAuthorization || { ok: true, nativeCommand: false }); if (event.startsWith('tool:desktop_result:') && s.autoAck) ack?.({ accepted: true }); },
  fire: (event: string, payload?: any) => handlers.get(event)?.(payload), emitted,
 }; return s;
}
async function mount() { const module = await import('../src/hooks/useSocket'); module.initializeSharedSocketRuntime(); await vi.advanceTimersByTimeAsync(0); return mock.socket; }
beforeEach(async () => {
 vi.resetModules(); vi.useFakeTimers(); delete (globalThis as any).__lumicoreSharedDesktopSocketRuntimeV1;
 vi.stubGlobal('window', { setTimeout, clearTimeout, innerWidth: 100, innerHeight: 100, __TAURI_INTERNALS__: { invoke: mock.invoke }, dispatchEvent: vi.fn() }); vi.stubGlobal('navigator', { platform: 'Synthetic' });
 mock.socket = socket(); mock.invoke.mockReset(); mock.toast.warning.mockReset(); mock.toast.dismiss.mockReset(); mock.confirm.mockReset(); mock.gate = Promise.resolve();
 vi.doMock('@tauri-apps/api/core', async () => { await mock.gate; return { invoke: mock.invoke }; });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); delete (globalThis as any).__lumicoreSharedDesktopSocketRuntimeV1; });
describe('native WebView command lifecycle', () => {
 it.each(['desktop_run_command', 'desktop_set_wallpaper_mode'])('does not dispatch %s when cancellation arrives during bridge loading', async name => {
  let release!: () => void; mock.gate = new Promise<void>(resolve => release = resolve); const s = await mount();
  s.fire('tool:desktop_exec', { correlationId: 'import-race', name, arguments: { command: 'synthetic', source: 'computer_use', enabled: true } });
  s.fire('tool:desktop_cancel', { correlationId: 'import-race', name: 'desktop_run_command' }); release(); await vi.advanceTimersByTimeAsync(0);
  expect(mock.invoke.mock.calls.map(c => c[0])).not.toContain('run_command'); expect(window.dispatchEvent).not.toHaveBeenCalled();
  expect(s.emitted.find((e: any) => e.event === 'tool:desktop_result:import-race').payload.error).toContain('before native dispatch');
 });
 it('retains the real cancelled terminal instead of dropping the result after cancellation', async () => {
  let finish!: (value: any) => void; mock.invoke.mockImplementation(name => name === 'run_command' ? new Promise(resolve => finish = resolve) : true);
  const s = await mount(); s.fire('tool:desktop_exec', { correlationId: 'running', name: 'desktop_run_command', arguments: { command: 'synthetic' } }); await vi.advanceTimersByTimeAsync(0);
  s.fire('tool:desktop_cancel', { correlationId: 'running', name: 'desktop_run_command' }); finish({ success: false, output: 'native exit confirmed' }); await vi.advanceTimersByTimeAsync(0);
  expect(s.emitted.find((e: any) => e.event === 'tool:desktop_result:running').payload).toMatchObject({ error: 'native exit confirmed', stopped: true });
 });
 it('buffers a disconnected completion and resends only after server-authorized same-identity resume, without executing again', async () => {
  let finish!: (value: any) => void; mock.invoke.mockImplementation(name => name === 'run_command' ? new Promise(resolve => finish = resolve) : null);
  const s = await mount(); s.fire('tool:desktop_exec', { correlationId: 'reconnect', name: 'desktop_run_command', arguments: { command: 'synthetic' } }); await vi.advanceTimersByTimeAsync(0);
  s.connected = false; finish({ success: true, output: 'synthetic completion' }); await vi.advanceTimersByTimeAsync(0); expect(s.emitted.filter((e: any) => e.event === 'tool:desktop_result:reconnect')).toEqual([]);
  s.id = 'connection-b'; s.connected = true; s.resume = [{ correlationId: 'reconnect', name: 'desktop_run_command', state: 'pending' }]; s.autoAck = true; s.fire('connect'); await vi.advanceTimersByTimeAsync(0);
  expect(s.emitted.filter((e: any) => e.event === 'tool:desktop_result:reconnect')).toHaveLength(1);
  s.fire('tool:desktop_exec', { correlationId: 'reconnect', name: 'desktop_run_command', arguments: { command: 'must not repeat' } }); await vi.advanceTimersByTimeAsync(0);
  expect(mock.invoke.mock.calls.filter(c => c[0] === 'run_command')).toHaveLength(1);
 });
 it('queries native receipts after a lost IPC response and removes recovery prompt once acknowledged', async () => {
  mock.invoke.mockImplementation(name => name === 'run_command' ? Promise.reject(Error('lost IPC response')) : name === 'get_command_result' ? { success: true, output: 'recovered' } : true);
  const s = await mount(); s.fire('tool:desktop_exec', { correlationId: 'lost-response', name: 'desktop_run_command', arguments: { command: 'synthetic' } }); await vi.advanceTimersByTimeAsync(0);
  expect(s.emitted.find((e: any) => e.event === 'tool:desktop_result:lost-response').payload.stopped).toBe(false);
  s.resume = [{ correlationId: 'lost-response', name: 'desktop_run_command', state: 'outcome_unknown', cancel: true }]; s.autoAck = true; await vi.advanceTimersByTimeAsync(5000);
  await vi.waitFor(() => expect(mock.invoke.mock.calls.some(c => c[0] === 'get_command_result'), JSON.stringify({ calls: mock.invoke.mock.calls, events: s.emitted.map((e: any) => ({event: e.event, payload: e.payload})) })).toBe(true)); expect(mock.invoke.mock.calls.filter(c => c[0] === 'run_command')).toHaveLength(1);
  expect(mock.toast.dismiss).toHaveBeenCalledWith('desktop-recovery-lost-response');
 });
 it('offers explicit manual recovery only for unknown results, and stale confirmation cannot cross reconnect', async () => {
  mock.invoke.mockResolvedValue(null); const s = await mount(); s.resume = [{ correlationId: 'unknown', name: 'desktop_run_command', state: 'outcome_unknown', cancel: true }];
  await vi.advanceTimersByTimeAsync(5000); await vi.waitFor(() => expect(mock.toast.warning).toHaveBeenCalledTimes(1));
  let confirm!: (value: boolean) => void; mock.confirm.mockReturnValue(new Promise(resolve => confirm = resolve)); mock.toast.warning.mock.calls[0][1].action.onClick();
  s.id = 'other-connection'; confirm(true); await vi.advanceTimersByTimeAsync(0); expect(s.emitted.some((e: any) => e.event === 'tool:desktop_confirm_stopped')).toBe(false);
 });
 it.each(['drain-first', 'normal-first'])('keeps stop-only manual recovery available when replies arrive %s', async order => {
  const s = await mount(); s.drains = [{ correlationId: 'drain-only', nativeCommand: false, unknown: true }]; s.holdNormal = true; s.holdDrain = true;
  await vi.advanceTimersByTimeAsync(5000);
  if (order === 'drain-first') { s.drainReply(); s.normalReply(); } else { s.normalReply(); s.drainReply(); }
  expect(mock.toast.warning).toHaveBeenCalledTimes(1); mock.confirm.mockResolvedValue(true); mock.toast.warning.mock.calls[0][1].action.onClick(); await vi.advanceTimersByTimeAsync(0);
  expect(s.emitted.some((e: any) => e.event === 'tool:desktop_drain_confirm_stopped')).toBe(true);
 });
 it.each([true, false])('native unknown acknowledgment %s controls manual recovery without executing a new command', async permitted => {
  mock.invoke.mockImplementation(name => name === 'acknowledge_unknown_command_stop' ? permitted : null);
  const s = await mount(); s.resume = [{ correlationId: 'native-unknown', name: 'desktop_run_command', state: 'outcome_unknown' }]; s.stopAuthorization = { ok: true, nativeCommand: true }; mock.confirm.mockResolvedValue(true);
  await vi.advanceTimersByTimeAsync(5000); await vi.waitFor(() => expect(mock.toast.warning).toHaveBeenCalled());
  mock.toast.warning.mock.calls[0][1].action.onClick(); await vi.advanceTimersByTimeAsync(0);
  await vi.waitFor(() => expect(mock.invoke.mock.calls.some(c => c[0] === 'acknowledge_unknown_command_stop')).toBe(true));
  expect(s.emitted.some((e: any) => e.event === 'tool:desktop_confirm_stopped')).toBe(permitted); expect(mock.invoke.mock.calls.some(c => c[0] === 'run_command')).toBe(false);
 });
 it('does not write native stop acknowledgment when server authorization expired', async () => {
  mock.invoke.mockResolvedValue(null); const s = await mount(); s.resume = [{ correlationId: 'auth-ended', name: 'desktop_run_command', state: 'outcome_unknown' }]; s.stopAuthorization = { ok: false }; mock.confirm.mockResolvedValue(true);
  await vi.advanceTimersByTimeAsync(5000); await vi.waitFor(() => expect(mock.toast.warning).toHaveBeenCalled());
  mock.toast.warning.mock.calls[0][1].action.onClick(); await vi.advanceTimersByTimeAsync(0); expect(mock.invoke.mock.calls.some(c => c[0] === 'acknowledge_unknown_command_stop')).toBe(false);
 });
 it('stop-only reconciliation never sends native output or executes an old-scope command', async () => {
  mock.invoke.mockImplementation(name => name === 'get_command_result' ? { success: true, output: 'PRIVATE OLD SCOPE' } : true);
  const s = await mount(); s.drains = [{ correlationId: 'old-scope', nativeCommand: true, unknown: true }]; await vi.advanceTimersByTimeAsync(5000);
  expect(s.emitted.find((e: any) => e.event === 'tool:desktop_drain_result').payload).toEqual({ correlationId: 'old-scope', stopped: true });
  expect(JSON.stringify(s.emitted)).not.toContain('PRIVATE OLD SCOPE'); expect(mock.invoke.mock.calls.some(c => c[0] === 'run_command')).toBe(false);
 });
});
