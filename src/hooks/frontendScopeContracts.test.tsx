// @vitest-environment jsdom
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRuntimeStatus } from './useRuntimeStatus';
import { useLumiScene } from './useLumiScene';
import { AutonomousFeed } from '../components/AutonomousFeed';
import { createLumiSceneSnapshot } from '../../shared/lumi_scene';

const mocks = vi.hoisted(() => ({ api: vi.fn(), emit: vi.fn(), on: vi.fn(), off: vi.fn(), notify: vi.fn(), toast: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: mocks.toast, error: mocks.toast } }));
vi.mock('@/hooks/useSocket', () => ({ useSocket: () => mocks }));
vi.mock('@/contexts/AppContext', () => ({ useApp: () => ({ addNotification: mocks.notify, workDomain: 'personal', orgConnection: null }) }));
vi.mock('@/services/apiClient', () => ({ apiFetch: mocks.api }));
vi.mock('@/services/socketService', () => {
  const socket = { ...mocks, timeout: () => socket };
  return { socketService: { connect: () => socket } };
});
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const response = (payload: any, status = 200) => ({ ok: status < 400, status, json: async () => payload });
const snapshot = (orgId: string) => ({ scope: { domain: 'work', orgId }, tasks: [{ taskId: orgId }] });
beforeEach(() => { for (const fn of Object.values(mocks)) fn.mockReset(); });
afterEach(cleanup);

describe('task snapshots belong to their current owner', () => {
  it.each(['switch', 'disable', 'unmount'] as const)('rejects retained runtime refreshes after %s without invalidating the new request', async action => {
    const old = deferred<any>(), current = deferred<any>();
    mocks.api.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const hook = renderHook(props => useRuntimeStatus({ userId: 'user', ...props }),
      { initialProps: { enabled: true, scopeKey: 'work:A' } });
    const oldRefresh = hook.result.current.refresh;
    if (action === 'unmount') hook.unmount();
    else hook.rerender({ enabled: action !== 'disable', scopeKey: action === 'switch' ? 'work:B' : 'work:A' });
    await act(async () => { await oldRefresh(); });
    expect(mocks.api).toHaveBeenCalledTimes(action === 'switch' ? 2 : 1);
    await act(async () => { old.resolve(response(snapshot('A'))); current.resolve(response(snapshot('B'))); });
    if (action === 'switch') expect(hook.result.current).toMatchObject({ status: snapshot('B'), loading: false, error: '' });
    if (action === 'disable') {
      expect(hook.result.current).toMatchObject({ status: null, loading: false, error: '' });
      mocks.api.mockReset().mockResolvedValue(response(snapshot('A')));
      hook.rerender({ enabled: true, scopeKey: 'work:A' });
      await waitFor(() => expect(hook.result.current.status).toEqual(snapshot('A')));
    }
  });
  it('keeps the newest runtime success when an older refresh fails and retries a current failure', async () => {
    mocks.api.mockResolvedValue(response(snapshot('A')));
    const hook = renderHook(() => useRuntimeStatus({ userId: 'user', scopeKey: 'work:A' }));
    await waitFor(() => expect(hook.result.current.status).toEqual(snapshot('A')));
    const held = deferred<any>(); mocks.api.mockReturnValueOnce(held.promise);
    let pending: Promise<void>; act(() => { pending = hook.result.current.refresh(); });
    expect(hook.result.current.loading).toBe(false);
    await act(async () => { await hook.result.current.refresh(); held.resolve(response({ error: 'old failure' }, 503)); await pending; });
    expect(hook.result.current).toMatchObject({ status: snapshot('A'), loading: false, error: '' });
    mocks.api.mockResolvedValueOnce(response({ error: 'current failure' }, 503));
    await act(async () => { await hook.result.current.refresh(); });
    expect(hook.result.current).toMatchObject({ status: null, loading: false, error: 'current failure' });
    await act(async () => { await hook.result.current.refresh(); });
    expect(hook.result.current).toMatchObject({ status: snapshot('A'), loading: false, error: '' });
  });
  it('reloads one runtime snapshot on reconnect without a second focus request', async () => {
    mocks.api.mockResolvedValue(response(snapshot('A')));
    const hook = renderHook(() => useRuntimeStatus({ userId: 'local-cache-owner', scopeKey: 'work:A' }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(1));
    act(() => {
      for (const name of ['connect', 'agent:progress', 'chat:conversation_updated', 'focus:updated']) mocks.on.mock.calls.find(([event]) => event === name)![1]();
    });
    await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
    expect(mocks.emit).not.toHaveBeenCalled();
    hook.unmount();
    expect(mocks.off.mock.calls.map(([name]) => name)).toEqual(mocks.on.mock.calls.map(([name]) => name));
  });
  it('clears runtime data when the new organization fails and rejects a stale payload scope', async () => {
    mocks.api.mockResolvedValue(response(snapshot('A')));
    const hook = renderHook(({ scopeKey }) => useRuntimeStatus({ userId: 'user', scopeKey }), { initialProps: { scopeKey: 'work:A' } });
    await waitFor(() => expect(hook.result.current.status?.tasks[0].taskId).toBe('A'));
    mocks.api.mockResolvedValue(response({ error: 'offline' }, 503));
    hook.rerender({ scopeKey: 'work:B' });
    expect(hook.result.current.status).toBeNull();
    await waitFor(() => expect(hook.result.current.error).toBe('offline'));
    mocks.api.mockResolvedValue(response(snapshot('A')));
    await act(async () => { await hook.result.current.refresh(); });
    expect(hook.result.current.status).toBeNull();
    expect(hook.result.current.error).toBe('runtime_status_scope_mismatch');
  });

  it('ignores late runtime reads from a previous user in the same domain', async () => {
    const old = deferred<any>();
    mocks.api.mockReturnValueOnce(old.promise).mockResolvedValue(response(snapshot('A')));
    const hook = renderHook(({ userId }) => useRuntimeStatus({ userId, scopeKey: 'work:A' }), { initialProps: { userId: 'old' } });
    hook.rerender({ userId: 'new' });
    await waitFor(() => expect(hook.result.current.status?.tasks[0].taskId).toBe('A'));
    await act(async () => { old.resolve(response({ ...snapshot('A'), tasks: [{ taskId: 'old-user-secret' }] })); });
    expect(hook.result.current.status?.tasks[0].taskId).toBe('A');
  });

  it('clears task focus on organization switch, rejects the old response and reports timeout', async () => {
    const old = deferred<any>(), current = deferred<any>();
    mocks.api.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const hook = renderHook(({ scopeKey }) => useRuntimeStatus({ userId: 'user', scopeKey }), { initialProps: { scopeKey: 'work:A' } });
    hook.rerender({ scopeKey: 'work:B' });
    expect(hook.result.current.status).toBeNull();
    await act(async () => { old.resolve(response(snapshot('A'))); });
    expect(hook.result.current.status).toBeNull();
    await act(async () => { current.resolve(response({ error: 'timeout' }, 504)); });
    expect(hook.result.current.error).toBe('timeout');
    expect(hook.result.current.loading).toBe(false);
  });

  it('starts a new scene scope from revision zero and ignores old callbacks', () => {
    const acks: Array<(...args: any[]) => void> = [];
    mocks.emit.mockImplementation((_name, _payload, ack) => { acks.push(ack); });
    const hook = renderHook(({ scopeKey }) => useLumiScene({ userId: 'user', scopeKey }), { initialProps: { scopeKey: 'work:A' } });
    const scene = createLumiSceneSnapshot({ sceneId: 'scene-a', revision: 3, nodes: [] });
    act(() => acks[0]({ ok: true, kind: 'snapshot', snapshot: scene }));
    expect(hook.result.current.scene?.revision).toBe(3);
    hook.rerender({ scopeKey: 'work:B' });
    expect(hook.result.current.scene).toBeNull();
    expect(mocks.emit.mock.calls[1][1].currentRevision).toBe(0);
    act(() => acks[0]({ ok: true, kind: 'snapshot', snapshot: scene }));
    expect(hook.result.current.scene).toBeNull();
  });

  it.each(['verified', 'failed', 'unverified'])('keeps one %s terminal card, notifies without a popup, and releases listeners on unmount', async outcome => {
    mocks.api.mockImplementation(async (route: string) => response(route.includes('history') ? { tasks: [] } : { queue: [] }));
    const view = render(<AutonomousFeed expanded />);
    await waitFor(() => expect(mocks.api).toHaveBeenCalledTimes(2));
    const emit = (name: string, data: any) => mocks.on.mock.calls.find(([event]) => event === name)![1](data);
    const task = { taskId: 'fixture-task', title: 'Verified fixture task', timestamp: new Date().toISOString(), mode: 'analysis' };
    act(() => emit('autonomous:task_started', task));
    expect(view.getAllByText(task.title)).toHaveLength(1);
    act(() => { for (let i = 0; i < 2; i++) emit(outcome === 'failed' ? 'autonomous:task_failed' : 'autonomous:task_completed', {
      ...task, finalized: true, blocked: false, verified: outcome === 'verified', toolCallsCount: 1, tokensUsed: 0, result: 'Saved', error: 'Could not finish',
    }); });
    expect(mocks.notify).toHaveBeenLastCalledWith(expect.objectContaining({ type: outcome === 'verified' ? 'success' : 'warning' }));
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(view.getAllByText(task.title)).toHaveLength(1);
    view.unmount();
    expect(mocks.off.mock.calls.map(([name]) => name)).toEqual(mocks.on.mock.calls.map(([name]) => name));
  });
});
