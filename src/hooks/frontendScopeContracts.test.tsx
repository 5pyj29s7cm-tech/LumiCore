// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRuntimeStatus } from './useRuntimeStatus';
import { useFocusThreads } from './useFocusThreads';
import { useLumiScene } from './useLumiScene';
import { createLumiSceneSnapshot } from '../../shared/lumi_scene';

const mocks = vi.hoisted(() => ({ api: vi.fn(), emit: vi.fn(), on: vi.fn(), off: vi.fn() }));
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
  it('reloads on reconnect while leaving user authorization to the server', () => {
    renderHook(() => useFocusThreads({ userId: 'local-cache-owner', domain: 'work', orgId: 'A' }));
    expect(mocks.emit.mock.calls[0][1]).toEqual({ domain: 'work', orgId: 'A' });
    const reconnect = mocks.on.mock.calls.find(([event]) => event === 'connect')![1];
    act(() => reconnect());
    expect(mocks.emit).toHaveBeenCalledTimes(2);
    expect(mocks.emit.mock.calls[1][1]).toEqual({ domain: 'work', orgId: 'A' });
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

  it('clears focus data on organization switch, rejects old ack and handles transport timeout', async () => {
    const acks: Array<(...args: any[]) => void> = [];
    mocks.emit.mockImplementation((_name, _payload, ack) => { acks.push(ack); });
    const hook = renderHook(({ orgId }) => useFocusThreads({ userId: 'user', domain: 'work', orgId }), { initialProps: { orgId: 'A' } });
    act(() => acks[0](null, { ok: true, domain: 'work', orgId: 'A', threads: [{ taskId: 'A', updatedAt: '' }] }));
    expect(hook.result.current.threads[0].taskId).toBe('A');
    hook.rerender({ orgId: 'B' });
    expect(hook.result.current.threads).toEqual([]);
    act(() => acks[0](null, { ok: true, domain: 'work', orgId: 'A', threads: [{ taskId: 'old' }] }));
    expect(hook.result.current.threads).toEqual([]);
    act(() => acks[1](new Error('timeout')));
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
});
