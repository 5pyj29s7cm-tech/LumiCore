
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const members = vi.hoisted(() => new Map<string, any>());
vi.mock('../server/org/db', () => ({ getMember: (org: string, uid: string) => members.get(org + ':' + uid) }));
vi.mock('../server/org/membership_authorization', () => ({
 captureOrganizationMembershipAuthorization: (org: string, uid: string) => { const m = members.get(org + ':' + uid); if (!m || m.status !== 'active') throw Error('inactive'); return { ...m }; },
 isOrganizationMembershipAuthorizationCurrent: (saved: any, org: string, uid: string) => { const m = members.get(org + ':' + uid); return !!m && m.status === 'active' && m.id === saved?.id && m.role === saved?.role; },
}));
vi.mock('../server/external_control/native_ui', () => ({ captureNativeUiSnapshot: vi.fn(), runNativeUiAction: vi.fn() }));
import { deviceRegistry } from '../server/devices';
import { resetDesktopControlLeasesForTests } from '../server/desktop/control_lease';
import { createDesktopRelay, handleDesktopRelayResult, registerDesktopRelayRecoveryHandlers, getPendingDesktopRelayCount } from '../server/socket/desktop_relay';
let serial = 0;
const cleanups: Array<() => void> = [];
function fixture(org = '') {
 const uid = 'recovery-owner-' + (++serial);
 const identity = { schemaVersion: 1, clientKind: 'tauri', pid: serial + 100, startedAtUnixMs: Date.now(), executablePath: 'D:/synthetic/Lumi.exe', executableSha256: 'a'.repeat(64), binaryHashUnavailable: false, buildId: 'b'.repeat(40), buildIdSemantics: 'baseline_commit', sourceFingerprint: 'c'.repeat(64), sourceDirty: false, appVersion: '3.1.0' };
 if (org) members.set(org + ':' + uid, { id: 'member-original', role: 'member', status: 'active' });
 const sockets = new Map<string, any>(); const events: any[] = []; let offerHeld = false; let ackOffer: (() => void) | undefined;
 function socket(id: string, user = uid, tokenOrg = org, nativeIdentity: any = identity) {
  const handlers = new Map<string, Function>();
  const s: any = { id, connected: true, data: { trustedLocalExecution: true, authenticatedUserId: user, authenticatedOrgId: tokenOrg, nativeClientIdentity: nativeIdentity },
   on: (event: string, fn: Function) => handlers.set(event, fn), once: () => {}, off: () => {},
   emit: (event: string, payload: any, ack?: Function) => { events.push({ id, event, payload }); if (event === 'tool:desktop_offer') { const accept = () => ack?.({ accepted: true, correlationId: payload.correlationId }); if (offerHeld) ackOffer = accept; else accept(); } },
   call: (event: string, payload = {}) => { let response: any; handlers.get(event)?.(payload, (r: any) => response = r); return response; },
  };
  sockets.set(id, s); registerDesktopRelayRecoveryHandlers(s, () => user); return s;
 }
 const original = socket('original-' + serial);
 deviceRegistry.register(uid, original.id, { name: 'Synthetic', type: 'desktop', domain: org ? 'work' : 'personal', orgId: org, deviceFingerprint: uid });
 const io: any = { sockets: { sockets, adapter: { rooms: new Map() } }, to: () => ({ emit() {} }) };
 const lifecycle: any[] = [];
 const relay = (extra: any = {}) => createDesktopRelay({ io, userId: uid, domain: org ? 'work' : 'personal', orgId: org, source: 'test', timeoutMs: 100, cancellationGraceMs: 20, emitToolLifecycle: e => lifecycle.push(e), ...extra });
 const cid = () => events.find(e => e.event === 'tool:desktop_exec')?.payload.correlationId;
 cleanups.push(() => { if (cid()) { original.connected = true; handleDesktopRelayResult(cid(), { error: 'test cleanup' }, original.id); for (const s of sockets.values()) handleDesktopRelayResult(cid(), { error: 'test cleanup' }, s.id); } });
 return { uid, identity, org, original, sockets, events, io, socket, relay, cid, lifecycle, holdOffer: () => offerHeld = true, acceptOffer: () => ackOffer?.() };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); resetDesktopControlLeasesForTests(); members.clear(); vi.useRealTimers(); });
describe('desktop native recovery and cancellation', () => {
 it('requests cancellation at relay deadline and retains an unknown hold until the real receipt', async () => {
  const f = fixture(); const run = f.relay()('desktop_run_command', { command: 'synthetic' }).catch(e => e);
  await vi.advanceTimersByTimeAsync(101); expect(f.events.some(e => e.event === 'tool:desktop_cancel')).toBe(true); expect(getPendingDesktopRelayCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(20); expect((await run).message).toContain('outcome_unknown');
  await expect(f.relay()('desktop_active_window')).rejects.toThrow('outcome_unknown');
  expect(handleDesktopRelayResult(f.cid(), { output: 'late actual result' }, f.original.id)).toBe(true);
  expect(f.lifecycle.filter(e => e.result)).toEqual([]); expect(getPendingDesktopRelayCount()).toBe(0);
 });
 it('waits for a confirmed terminal on cancellation and does not pretend a stop request is a terminal', async () => {
  const f = fixture(); const controller = new AbortController(); const run = f.relay({ signal: controller.signal })('desktop_run_command').catch(e => e);
  await vi.advanceTimersByTimeAsync(1); controller.abort(); expect(getPendingDesktopRelayCount()).toBe(1);
  expect(handleDesktopRelayResult(f.cid(), { error: '[outcome_unknown] pending', stopped: false }, f.original.id)).toBe(false);
  expect(getPendingDesktopRelayCount()).toBe(1); handleDesktopRelayResult(f.cid(), { error: 'cancelled, native exit confirmed', stopped: true }, f.original.id);
  expect((await run).message).toContain('exit confirmed'); expect(getPendingDesktopRelayCount()).toBe(0);
 });
 it('rebinds only the same authenticated native identity and acknowledges repeated result without repeating the action', async () => {
  const f = fixture(); const run = f.relay()('desktop_run_command'); await vi.advanceTimersByTimeAsync(1); f.original.connected = false;
  const stranger = f.socket('stranger', f.uid, '', { ...f.identity, pid: 99999 }); expect(stranger.call('tool:desktop_resume').executions).toEqual([]);
  expect(handleDesktopRelayResult(f.cid(), { output: 'forged' }, stranger.id)).toBe(false);
  const again = f.socket('reconnected'); expect(again.call('tool:desktop_resume').executions[0].correlationId).toBe(f.cid());
  expect(handleDesktopRelayResult(f.cid(), { output: 'original completed output' }, again.id)).toBe(true); await expect(run).resolves.toBe('original completed output');
  expect(handleDesktopRelayResult(f.cid(), { output: 'retry cannot change it' }, again.id)).toBe(true);
  expect(f.events.filter(e => e.event === 'tool:desktop_exec')).toHaveLength(1);
 });
 it('does not let a revoked work socket fall back into personal receipt recovery', async () => {
  const f = fixture(); const run = f.relay()('desktop_run_command'); await vi.advanceTimersByTimeAsync(1);
  const oldWork = f.socket('expired-org-token', f.uid, 'old-org');
  expect(oldWork.call('tool:desktop_resume').executions).toEqual([]);
  expect(oldWork.call('tool:desktop_confirm_stopped', { correlationId: f.cid(), confirmation: 'I_HAVE_VERIFIED_THE_COMMAND_HAS_STOPPED' }).ok).toBe(false);
  handleDesktopRelayResult(f.cid(), { output: 'normal' }, f.original.id); await expect(run).resolves.toBe('normal');
 });
 it('revocation permits a separate stop-only projection but never old organization output or execution', async () => {
  const f = fixture('org-a'); const run = f.relay()('desktop_run_command', { command: 'PRIVATE' }).catch(e => e); await vi.advanceTimersByTimeAsync(1);
  members.delete('org-a:' + f.uid); f.original.connected = false; const personal = f.socket('after-revocation', f.uid, '');
  expect(personal.call('tool:desktop_resume').executions).toEqual([]);
  const drain = personal.call('tool:desktop_drain_resume'); expect(drain.executions[0]).toEqual({ correlationId: f.cid(), nativeCommand: true, unknown: false });
  expect(JSON.stringify(drain)).not.toContain('PRIVATE'); expect(handleDesktopRelayResult(f.cid(), { output: 'PRIVATE' }, personal.id)).toBe(false);
  expect(personal.call('tool:desktop_drain_result', { correlationId: f.cid(), stopped: true, output: 'PRIVATE' }).ok).toBe(true);
  expect((await run).message).toContain('authorization ended'); expect(f.lifecycle.filter(e => e.result)).toEqual([]); expect(f.events.filter(e => e.event === 'tool:desktop_exec')).toHaveLength(1);
 });
 it('requires explicit unknown confirmation and keeps its old outcome unverified', async () => {
  const f = fixture(); const run = f.relay()('desktop_run_command').catch(e => e); await vi.advanceTimersByTimeAsync(121); await run;
  expect(f.original.call('tool:desktop_authorize_stop_ack', { correlationId: f.cid() })).toEqual({ ok: true, nativeCommand: true });
  const foreign = f.socket('foreign-confirmation', 'foreign-user'); expect(foreign.call('tool:desktop_authorize_stop_ack', { correlationId: f.cid() })).toEqual({ ok: false });
  expect(f.original.call('tool:desktop_confirm_stopped', { correlationId: f.cid() }).ok).toBe(false);
  expect(f.original.call('tool:desktop_confirm_stopped', { correlationId: f.cid(), confirmation: 'I_HAVE_VERIFIED_THE_COMMAND_HAS_STOPPED' }).ok).toBe(true);
  expect(getPendingDesktopRelayCount()).toBe(0); expect(f.lifecycle.filter(e => e.result)).toEqual([]);
 });
 it('rechecks membership at delayed offer acceptance before dispatch', async () => {
  const f = fixture('org-offer'); f.holdOffer(); const run = f.relay()('desktop_run_command').catch(e => e); await vi.advanceTimersByTimeAsync(1);
  members.delete('org-offer:' + f.uid); f.acceptOffer(); expect((await run).message).toContain('authorization changed'); expect(f.cid()).toBeUndefined();
 });
 it('keeps a physical native hold across an account switch including direct UI adapters without exposing the old identity', async () => {
  const f = fixture(); const run = f.relay()('desktop_run_command').catch(e => e); await vi.advanceTimersByTimeAsync(121); await run;
  const other = f.socket('other-account', 'another-owner');
  const otherRelay = f.relay({ userId: 'another-owner', requestSocket: other });
  for (const name of ['desktop_run_command', 'desktop_ui_click']) { const error = await otherRelay(name).catch(e => e); expect(error.message).toContain('native device'); expect(error.message).not.toContain(f.uid); expect(error.message).not.toContain(f.cid()); }
  expect(other.call('tool:desktop_resume').executions).toEqual([]); expect(other.call('tool:desktop_drain_resume').executions).toEqual([]);
  handleDesktopRelayResult(f.cid(), { error: 'original stopped' }, f.original.id);
 });
});
