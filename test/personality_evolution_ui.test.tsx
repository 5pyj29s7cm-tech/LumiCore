// @vitest-environment jsdom
import React, { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PersonalityEvolution } from '../src/components/PersonalityEvolution';
import { toast } from 'sonner';
const fixture = vi.hoisted(() => ({ net: vi.fn(), notify: vi.fn(), uid: 'first', orgId: '', langCode: 'en', listeners: new Map<string, Set<Function>>() }));
vi.mock('../src/contexts/AppContext', () => ({ useApp: () => ({ user: { uid: fixture.uid }, addNotification: fixture.notify, workDomain: fixture.orgId ? 'work' : 'personal', orgConnection: fixture.orgId ? { orgId: fixture.orgId } : null }) }));
vi.mock('../src/lib/useT', () => ({ useT: () => ({ langCode: fixture.langCode, evolve: 'Evolve', personalityEvolved: 'Evolved', failedToLoadEvolution: 'Load failed' }) }));
vi.mock('../src/i18n/uiMessages', () => ({ uiMessage: (key: string) => key.split('.')[1] }));
vi.mock('../src/services/apiClient', async () => ({ apiJson: (await import('./source_expression')).extractSourceExpression('src/services/apiClient.ts', 'apiJson', { apiFetch: fixture.net }) }));
vi.mock('../src/hooks/useSocket', () => ({ useSocket: () => socket }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
const socket = { on: (event: string, cb: Function) => { if (!fixture.listeners.has(event)) fixture.listeners.set(event, new Set()); fixture.listeners.get(event)!.add(cb); }, off: (event: string, cb: Function) => fixture.listeners.get(event)?.delete(cb) };
const reply = (data: any, status = 200) => ({ ok: status < 400, status, json: async () => data });
const snapshot = (version = 'first', personalityId = 'lumi') => ({ personalityId, version, currentVector: null, evolutionConfig: { plasticity: 0.3, cooldownMs: 86400000, maxMutationsPerStep: 2, minMemoriesForEvolution: 5 }, history: [{ version, auditId: 'audit-1', timestamp: '2026-10-02', trigger: 'manual', mutations: [], narrative: `story-${version}` }], audit: [{ id: 'audit-1', status: 'active', reversible: true, mutationFields: [], affectedLayer: 'growth' }] });
function deferred() { let resolve!: (value: any) => void; const promise = new Promise<any>(done => { resolve = done; }); return { promise, resolve }; }
const page = (id = 'lumi') => <PersonalityEvolution personalityId={id} />;
const event = (extra = {}) => { for (const handler of fixture.listeners.get('personality:evolved') || []) handler({ personalityId: 'lumi', userId: fixture.uid, orgId: fixture.orgId, version: 'event', narrative: 'changed', ...extra }); };
beforeEach(() => { fixture.uid = 'first'; fixture.orgId = ''; fixture.langCode = 'en'; fixture.net.mockImplementation(async (url: string) => reply(snapshot('first', url.split('/')[3]))); vi.stubGlobal('fetch', fixture.net); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); fixture.net.mockReset(); fixture.listeners.clear(); });

it.each(['freeze', 'revert', 'evolve'])('serializes %s through readback, without duplicate writes or premature success', async action => {
  const write = deferred(), readback = deferred(); render(page()); await screen.findByText('story-first');
  fixture.net.mockImplementation((_url: string, init?: RequestInit) => init?.method === 'POST' ? write.promise : readback.promise);
  const name = action === 'freeze' ? 'active' : action === 'revert' ? 'revert-this-step' : 'Evolve';
  const button = screen.getByRole('button', { name });
  act(() => { fireEvent.click(button); fireEvent.click(button); fireEvent.click(screen.getByRole('button', { name: action === 'evolve' ? 'active' : 'Evolve' })); });
  expect(fixture.net.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  const call = fixture.net.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(call[0]).toBe(`/api/personality/lumi/${action === 'evolve' ? 'evolve' : `evolution/${action}`}`);
  if (action !== 'evolve') expect(JSON.parse(call[1].body)).toEqual(action === 'freeze' ? { frozen: true } : { auditId: 'audit-1' });
  await act(async () => { write.resolve(reply({ evolved: true, frozen: true, reverted: true, auditId: 'audit-1' })); });
  expect((screen.getByRole('button', { name: 'Evolve' }) as HTMLButtonElement).disabled).toBe(true);
  expect(toast.success).not.toHaveBeenCalled();
  const updated = { ...snapshot('updated'), evolutionFrozenAt: action === 'freeze' ? '2026-10-02' : null };
  if (action === 'revert') updated.audit[0].status = 'reverted';
  await act(async () => { readback.resolve(reply(updated)); });
  expect(await screen.findByText('story-updated')).toBeTruthy(); expect(toast.success).toHaveBeenCalledTimes(1);
  if (action === 'freeze') expect(screen.getByRole('button', { name: 'frozen' })).toBeTruthy();
  if (action === 'revert') expect((screen.getByRole('button', { name: 'revert-this-step' }) as HTMLButtonElement).disabled).toBe(true);
});

it('isolates personality/account switches, ignores late actions, and cleans listeners on close', async () => {
  const oldRead = deferred(), oldWrite = deferred(); fixture.net.mockReturnValueOnce(oldRead.promise);
  const view = render(page()); view.rerender(page('other')); await screen.findByText('story-first');
  const firstSignal = fixture.net.mock.calls[0][1]?.signal;
  await act(async () => { oldRead.resolve(reply(snapshot('stale'))); }); expect(screen.queryByText('story-stale')).toBeNull();
  fixture.net.mockReturnValueOnce(oldWrite.promise); fireEvent.click(screen.getByRole('button', { name: 'Evolve' }));
  const writeSignal = fixture.net.mock.calls.at(-1)![1].signal;
  fixture.uid = 'second'; fixture.net.mockResolvedValue(reply(snapshot('second', 'other'))); view.rerender(page('other'));
  await screen.findByText('story-second'); const requests = fixture.net.mock.calls.length;
  await act(async () => { oldWrite.resolve(reply({ evolved: true })); });
  expect(fixture.net.mock.calls).toHaveLength(requests); expect(toast.success).not.toHaveBeenCalled();
  expect(firstSignal?.aborted).toBe(true); expect(writeSignal.aborted).toBe(true);
  fixture.orgId = 'team'; fixture.net.mockResolvedValue(reply(snapshot('team', 'other'))); view.rerender(page('other')); await screen.findByText('story-team'); expect(screen.queryByText('story-second')).toBeNull();
  view.unmount(); expect(fixture.listeners.get('personality:evolved')?.size || 0).toBe(0);
});

it('rejects HTTP/readback failures and evolved:false instead of announcing success', async () => {
  const view = render(page()); await screen.findByText('story-first');
  fixture.net.mockResolvedValueOnce(reply({ error: 'permission denied' }, 403)); fireEvent.click(screen.getByRole('button', { name: 'active' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('permission denied')); expect(toast.success).not.toHaveBeenCalled();
  fixture.net.mockResolvedValueOnce(reply({ evolved: false, reason: 'More memories needed' }));
  fireEvent.click(screen.getByRole('button', { name: 'Evolve' })); await waitFor(() => expect(toast.info).toHaveBeenCalledWith('More memories needed'));
  expect(toast.success).not.toHaveBeenCalled();
  fixture.net.mockResolvedValueOnce(reply({ frozen: true })).mockResolvedValueOnce(reply({ error: 'readback failed' }, 500));
  fireEvent.click(screen.getByRole('button', { name: 'active' })); await screen.findByRole('alert');
  expect(toast.success).not.toHaveBeenCalled(); expect((screen.getByRole('button', { name: 'Evolve' }) as HTMLButtonElement).disabled).toBe(true);
  fixture.net.mockResolvedValue(reply(snapshot('recovered'))); fireEvent.click(screen.getByRole('button', { name: /retry/i })); await screen.findByText('story-recovered');
  view.unmount(); fixture.net.mockResolvedValue(reply({ error: 'initial denied' }, 403)); render(page()); await screen.findByRole('alert');
  expect(screen.queryByText('story-recovered')).toBeNull();
});

it('rejects stale refreshes and foreign events, and keeps language changes from cancelling a write', async () => {
  const view = render(<StrictMode>{page()}</StrictMode>); await screen.findByText('story-first');
  const older = deferred(); fixture.net.mockReturnValueOnce(older.promise); act(() => event());
  fixture.net.mockResolvedValueOnce(reply(snapshot('latest'))); act(() => event()); await screen.findByText('story-latest');
  await act(async () => { older.resolve(reply(snapshot('older'))); }); expect(screen.queryByText('story-older')).toBeNull();
  const calls = fixture.net.mock.calls.length; act(() => { event({ userId: 'foreign' }); event({ orgId: 'foreign' }); }); expect(fixture.net.mock.calls).toHaveLength(calls);
  const pending = deferred(); fixture.net.mockReturnValueOnce(pending.promise); fireEvent.click(screen.getByRole('button', { name: 'Evolve' }));
  const signal = fixture.net.mock.calls.at(-1)![1].signal; fixture.langCode = 'zh'; view.rerender(<StrictMode>{page()}</StrictMode>);
  expect(signal.aborted).toBe(false); expect(fixture.listeners.get('personality:evolved')?.size).toBe(1);
  fixture.net.mockResolvedValue(reply(snapshot('finished'))); await act(async () => { pending.resolve(reply({ evolved: true })); });
  await screen.findByText('story-finished'); expect(toast.success).toHaveBeenCalledTimes(1);
});

it('keeps unconfirmed writes disabled until refresh and reads events received during readback', async () => {
  render(page()); await screen.findByText('story-first'); fixture.net.mockResolvedValueOnce(reply({}));
  fireEvent.click(screen.getByRole('button', { name: 'Evolve' })); await screen.findByRole('alert'); expect(toast.success).not.toHaveBeenCalled();
  fixture.net.mockResolvedValue(reply(snapshot('fresh'))); fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await screen.findByText('story-fresh');
  const readback = deferred(); fixture.net.mockResolvedValueOnce(reply({ frozen: true })).mockReturnValueOnce(readback.promise);
  fireEvent.click(screen.getByRole('button', { name: 'active' })); await waitFor(() => expect(fixture.net.mock.calls.at(-1)![1].method).not.toBe('POST'));
  act(() => event()); fixture.net.mockResolvedValue(reply(snapshot('event-after-write')));
  await act(async () => { readback.resolve(reply({ ...snapshot('write-readback'), evolutionFrozenAt: '2026-10-02' })); }); await screen.findByText('story-event-after-write');
  expect(toast.success).toHaveBeenCalledTimes(1);
});

it('does not announce success when the refreshed state contradicts the write receipt', async () => {
  render(page()); await screen.findByText('story-first'); fixture.net.mockResolvedValueOnce(reply({ frozen: true }));
  fireEvent.click(screen.getByRole('button', { name: 'active' })); await screen.findByRole('alert'); expect(toast.success).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Evolve' }) as HTMLButtonElement).disabled).toBe(true);
});
