// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useApp } from './AppContext';
import { createEmptyLegalCase, readLegalCaseFiles, writeLegalCaseFiles, getLegalConsultationCaseId, setLegalConsultationCaseId } from '../lib/legalCaseStore';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), error: vi.fn(), success: vi.fn(), disconnect: vi.fn(), me: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: mocks.error, success: mocks.success, info: vi.fn(), warning: vi.fn() } }));
vi.mock('../services/authService', async () => ({
  ...await vi.importActual<any>('../services/authService'),
  isNativeDesktopRuntime: () => false,
  getMe: mocks.me,
}));
vi.mock('../services/socketService', () => ({ socketService: { disconnect: mocks.disconnect, refreshAuth: vi.fn() } }));
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function initialRead(url: string) {
  if (url.endsWith('/api/notifications')) return reply({ notifications: [], unreadCount: 0 });
  if (url.endsWith('/api/preferences/vision')) return reply({ provider: 'openai', model: 'old-vision', models: { openai: 'old-vision' } });
  if (url.endsWith('/api/preferences/llm')) return reply({ provider: 'deepseek', model: 'old-reasoning', models: { deepseek: 'old-reasoning', ollama: 'account-a-local' }, selectionMode: 'ordered_fallback', fallbackCandidates: [{ provider: 'ollama', model: 'backup' }], allowCloudFallback: false });
  if (url.endsWith('/api/preferences/operation_mode')) return reply({ mode: 'assistant' });
  if (url.endsWith('/api/settings/tool_overrides')) return reply({ read_file: { enabled: true } });
  return reply({});
}
beforeEach(() => {
  localStorage.clear(); for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.me.mockResolvedValue({ user: { uid: 'synthetic-user', username: 'Tester', role: 'user' } });
  mocks.fetch.mockImplementation(async (url: string) => initialRead(url));
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function app() {
  const hook = renderHook(() => useApp(), { wrapper: ({ children }) => <AppProvider>{children}</AppProvider> });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await waitFor(() => expect(hook.result.current.visionConfig.model).toBe('old-vision'));
  return hook;
}

describe('settings share confirmed context state', () => {
  it.each([false, true])('confirms notification changes, preserves new arrivals, and invalidates older reads (clear=%s)', async clear => {
    const hook = await app(), write = deferred<any>(), oldRead = deferred<any>();
    act(() => hook.result.current.addNotification({ type: 'info', title: 'Before', message: 'before' })); const before = hook.result.current.notifications[0];
    mocks.fetch.mockImplementation((url: string, init: RequestInit) => url.includes('/api/notifications') ? init.method ? write.promise : oldRead.promise : Promise.resolve(initialRead(url)));
    let refreshing!: Promise<void>, saving!: Promise<boolean>;
    act(() => { refreshing = hook.result.current.refreshUser(); }); await waitFor(() => expect(mocks.fetch.mock.calls.filter(([url]) => url.endsWith('/api/notifications')).length).toBeGreaterThan(1));
    const action = () => clear ? hook.result.current.clearNotifications() : hook.result.current.markAllNotificationsRead();
    act(() => { saving = action(); }); expect(hook.result.current.notifications).toEqual([before]); expect(hook.result.current.notificationsBusy).toBe(true);
    await act(async () => { expect(await action()).toBe(false); }); act(() => hook.result.current.addNotification({ type: 'info', title: 'During', message: 'during' }));
    await act(async () => { write.resolve(reply({ success: true, ids: [before.id] })); expect(await saving).toBe(true); });
    await act(async () => { oldRead.resolve(reply({ notifications: [{ ...before, userId: 'synthetic-user' }], unreadCount: 1 })); await refreshing; });
    expect(hook.result.current.notifications.map(item => [item.title, item.read])).toEqual(clear ? [['During', false]] : [['During', false], ['Before', true]]);
    expect(hook.result.current.notificationsBusy).toBe(false); expect(localStorage.getItem('lumi_notifications_cleared_at_synthetic-user')).toBeNull();
    for (const response of [reply({ error: 'Notification denied' }, 403), reply({ success: true })]) {
      mocks.fetch.mockResolvedValueOnce(response); const snapshot = hook.result.current.notifications;
      await act(async () => { expect(await action()).toBe(false); }); expect(hook.result.current.notifications).toEqual(snapshot);
    }
    expect(mocks.error).toHaveBeenCalledTimes(2);
  });

  it('isolates notification writes and lists when changing accounts and carries desktop credentials', async () => {
    const hook = await app(), pending = deferred<any>(); act(() => hook.result.current.addNotification({ type: 'info', title: 'Private A', message: 'a' }));
    localStorage.setItem('lumi_auth_token', 'synthetic-token'); localStorage.setItem('lumi_desktop_session_proof', 'synthetic-proof');
    mocks.fetch.mockImplementation((url: string, init: RequestInit) => init?.method === 'DELETE' ? pending.promise : Promise.resolve(initialRead(url)));
    let saving!: Promise<boolean>; act(() => { saving = hook.result.current.clearNotifications(); }); const init = mocks.fetch.mock.calls.at(-1)![1];
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer synthetic-token'); expect(new Headers(init.headers).get('x-lumi-desktop-session')).toBe('synthetic-proof');
    mocks.me.mockResolvedValue({ user: { uid: 'account-b', username: 'B', role: 'user' } }); await act(async () => { await hook.result.current.refreshUser(); });
    expect(hook.result.current.notifications).toEqual([]); expect(init.signal.aborted).toBe(true); expect(hook.result.current.notificationsBusy).toBe(false);
    act(() => hook.result.current.addNotification({ type: 'info', title: 'Private B', message: 'b' }));
    await act(async () => { pending.resolve(reply({ success: true, ids: [] })); expect(await saving).toBe(false); }); expect(hook.result.current.notifications[0].title).toBe('Private B'); expect(mocks.error).not.toHaveBeenCalled();
  });

  it('binds personal cases to the authenticated session before account rendering and clears access on logout', async () => {
    const hook = await app(); act(() => { writeLegalCaseFiles([{ ...createEmptyLegalCase(), id: 'A', title: 'Private A' }], 'A'); setLegalConsultationCaseId('A'); });
    mocks.me.mockResolvedValue({ user: { uid: 'account-b', username: 'B', role: 'user' } }); await act(async () => { await hook.result.current.refreshUser(); }); expect(readLegalCaseFiles()).toEqual([]); expect(getLegalConsultationCaseId()).toBe('');
    act(() => writeLegalCaseFiles([{ ...createEmptyLegalCase(), id: 'B' }], 'B')); mocks.me.mockResolvedValue({ user: { uid: 'synthetic-user', username: 'A', role: 'user' } }); await act(async () => { await hook.result.current.refreshUser(); }); expect(readLegalCaseFiles()[0].title).toBe('Private A'); expect(getLegalConsultationCaseId()).toBe('A');
    await act(async () => { await hook.result.current.logout(); }); expect(readLegalCaseFiles()).toEqual([]); expect(getLegalConsultationCaseId()).toBe('');
  });
  it('keeps vision and tool settings unchanged after a rejected save', async () => {
    const hook = await app();
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => init.method === 'GET' || !init.method ? initialRead(url) : reply({ error: 'denied' }, 403));
    await act(async () => { expect(await hook.result.current.updateVisionConfig({ model: 'new-vision' })).toBe(false); });
    expect(hook.result.current.visionConfig.model).toBe('old-vision');
    expect(hook.result.current.visionConfig).toMatchObject({ models: { openai: 'old-vision' } });
    act(() => hook.result.current.setToolOverride('read_file', { enabled: false }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledTimes(2));
    expect(hook.result.current.toolOverrides.read_file.enabled).toBe(true);
    expect(JSON.parse(localStorage.getItem('lumi_tool_overrides')!).read_file.enabled).toBe(true);
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it('serializes vision writes and commits each actual server confirmation', async () => {
    const hook = await app(); const first = deferred<any>(); const writes: any[] = [];
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method === 'PUT' && url.endsWith('/vision')) {
        const body = JSON.parse(String(init.body)); writes.push(body);
        return writes.length === 1 ? first.promise : reply(body);
      }
      if (url.endsWith('/vision') && writes.length) return reply(writes[writes.length - 1]);
      return initialRead(url);
    });
    let one!: Promise<boolean>, two!: Promise<boolean>;
    act(() => { one = hook.result.current.updateVisionConfig({ model: 'first' }); two = hook.result.current.updateVisionConfig({ model: 'last' }); });
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(hook.result.current.visionConfig.model).toBe('old-vision');
    await act(async () => { first.resolve(reply(writes[0])); await one; await two; });
    expect(writes.map(write => write.model)).toEqual(['first', 'last']);
    expect(hook.result.current.visionConfig.model).toBe('last');
  });

  it('preserves reasoning fallback selection when saving an inactive provider model', async () => {
    const hook = await app(); let written: any;
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method === 'PUT' && url.endsWith('/llm')) { written = JSON.parse(String(init.body)); return reply(written); }
      return initialRead(url);
    });
    await act(async () => { await hook.result.current.updateAIConfig({}, { lmstudio: 'standby-model' }); });
    expect(written.selectionMode).toBe('ordered_fallback');
    expect(written.fallbackCandidates).toEqual([{ provider: 'ollama', model: 'backup' }]);
    expect(written.allowCloudFallback).toBe(false);
    expect(written.models.lmstudio).toBe('standby-model');
    expect(hook.result.current.aiConfig.provider).toBe('deepseek');
  });

  it('finishes local logout and prevents an in-flight save from restoring local settings', async () => {
    const hook = await app(); const pending = deferred<any>();
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.endsWith('/logout')) throw new Error('offline');
      if (init.method === 'PUT' && url.endsWith('/vision')) return pending.promise;
      return initialRead(url);
    });
    let save!: Promise<boolean>; act(() => { save = hook.result.current.updateVisionConfig({ model: 'late' }); });
    await waitFor(() => expect(mocks.fetch.mock.calls.some(([url, init]) => String(url).endsWith('/vision') && init.method === 'PUT')).toBe(true));
    await act(async () => { await hook.result.current.logout(); });
    expect(hook.result.current.user).toBeNull(); expect(mocks.disconnect).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve(reply({ provider: 'openai', model: 'late' })); expect(await save).toBe(false); });
    expect(hook.result.current.visionConfig.model).toBe('gpt-4o'); expect(hook.result.current.visionConfig.models).toEqual({});
  });

  it('ignores unowned browser models on startup and carries only server-confirmed inactive choices', async () => {
    for (const key of ['lumi_ai_config', 'lumi_vision_config']) localStorage.setItem(key, JSON.stringify({ provider: 'openai', model: 'foreign-model', apiKey: 'foreign-key' }));
    for (const key of ['lumi_llm_models', 'lumi_vision_models']) localStorage.setItem(key, JSON.stringify({ openai: 'foreign-model', ext_foreign: 'foreign-only' }));
    const read = deferred<any>(); let written: any;
    mocks.fetch.mockImplementation(async (url: string) => url.includes('/preferences/llm') ? read.promise : initialRead(url));
    const hook = renderHook(() => useApp(), { wrapper: ({ children }) => <AppProvider>{children}</AppProvider> });
    await waitFor(() => expect(hook.result.current.loading).toBe(false)); expect(hook.result.current.aiConfig.model).toBe('deepseek-v4-flash'); expect(hook.result.current.aiConfig.apiKey).toBe('');
    await act(async () => read.resolve(initialRead('/api/preferences/llm')));
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method === 'PUT' && url.endsWith('/llm')) { written = JSON.parse(String(init.body)); return reply(written); } return initialRead(url);
    });
    await act(async () => { expect(await hook.result.current.updateAIConfig({ model: 'new-reasoning' })).toBe(true); });
    expect(written.models.ollama).toBe('account-a-local'); expect(written.models.ext_foreign).toBeUndefined(); expect(JSON.stringify(written)).not.toContain('foreign');
    expect(hook.result.current.aiConfig.apiKey).toBe(''); expect(hook.result.current.visionConfig.model).toBe('old-vision');
  });

  it('resets account model state, drops old queued saves and allows new-account writes immediately', async () => {
    const hook = await app(), old = deferred<any>(), oldRead = deferred<any>(), loading = deferred<any>(); let first!: Promise<boolean>, queued!: Promise<boolean>, accountB = false; const writes: any[] = [];
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => {
      if (init.method === 'PUT' && url.endsWith('/llm')) { const body = JSON.parse(String(init.body)); writes.push(body); return writes.length === 1 ? old.promise : reply(body); }
      if (url.includes('/preferences/')) return accountB ? loading.promise : oldRead.promise; return initialRead(url);
    });
    act(() => { first = hook.result.current.updateAIConfig({ model: 'old-pending' }); queued = hook.result.current.updateAIConfig({ model: 'old-queued' }); }); await waitFor(() => expect(writes).toHaveLength(1));
    act(() => window.dispatchEvent(new CustomEvent('lumi:model-configuration-changed'))); accountB = true;
    mocks.me.mockResolvedValue({ user: { uid: 'account-b', username: 'B', role: 'user' } }); await act(async () => { await hook.result.current.refreshUser(); });
    expect(hook.result.current.aiConfig.models).toEqual({}); expect(hook.result.current.aiConfig.fallbackCandidates).toEqual([]); expect(hook.result.current.visionConfig.models).toEqual({});
    await act(async () => { expect(await hook.result.current.updateAIConfig({ provider: 'openai', model: 'b-model' })).toBe(false); }); expect(writes).toHaveLength(1);
    await act(async () => loading.resolve(reply({ provider: 'openai', model: 'b-read', models: { openai: 'b-read' } }))); expect(hook.result.current.aiConfig.ready).toBe(true);
    await act(async () => { expect(await hook.result.current.updateAIConfig({ provider: 'openai', model: 'b-model' })).toBe(true); }); expect(writes).toHaveLength(2); expect(writes[1].models).toEqual({ openai: 'b-model' });
    await act(async () => { old.resolve(reply(writes[0])); expect(await first).toBe(false); expect(await queued).toBe(false); oldRead.resolve(initialRead('/api/preferences/llm')); loading.resolve(reply({})); });
    expect(hook.result.current.aiConfig.model).toBe('b-model'); expect(writes).toHaveLength(2); expect(mocks.success).toHaveBeenCalledOnce();
  });

  it.each(['llm', 'vision'] as const)('%s exposes read errors, refuses unconfirmed saves and retries independently', async role => {
    let response = reply({ error: 'read denied' }, 403); mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => url.endsWith(`/preferences/${role}`) ? (init.method === 'PUT' ? reply(JSON.parse(String(init.body))) : response) : initialRead(url));
    const hook = renderHook(() => useApp(), { wrapper: ({ children }) => <AppProvider>{children}</AppProvider> }); const config = () => role === 'llm' ? hook.result.current.aiConfig : hook.result.current.visionConfig;
    await waitFor(() => expect(config().loadError).toBe('read denied')); expect(config().ready).toBe(false); expect((role === 'llm' ? hook.result.current.visionConfig : hook.result.current.aiConfig).ready).toBe(true);
    await act(async () => { expect(await (role === 'llm' ? hook.result.current.updateAIConfig : hook.result.current.updateVisionConfig)({ model: 'unsafe-default-save' })).toBe(false); }); expect(mocks.fetch.mock.calls.some(([, init]) => init.method === 'PUT')).toBe(false);
    response = reply({ provider: 'openai', model: 'bad', models: { openai: 42 } }); await act(async () => { await hook.result.current.reloadModelPreferences(role); }); expect(config().loadError).toContain('invalid'); expect(config().ready).toBe(false);
    if (role === 'llm') { response = reply({ provider: 'openai', model: 'bad', models: {}, legacyMigration: { migratedAt: 'today', entries: [null] } }); await act(async () => { await hook.result.current.reloadModelPreferences(role); }); expect(config().ready).toBe(false); expect(config().loadError).toContain('invalid'); }
    const reads = mocks.fetch.mock.calls.length; response = reply({ provider: 'openai', model: 'confirmed', models: { openai: 'confirmed' } }); await act(async () => { await hook.result.current.reloadModelPreferences(role); }); expect(config()).toMatchObject({ ready: true, loadError: '', model: 'confirmed' }); expect(mocks.fetch.mock.calls.slice(reads).map(([url]) => String(url).split('/').at(-1))).toEqual([role]);
    await act(async () => { expect(await (role === 'llm' ? hook.result.current.updateAIConfig : hook.result.current.updateVisionConfig)({ model: 'saved' })).toBe(true); }); expect(config().model).toBe('saved');
  });

  it('cancels superseded model reads and ignores late responses after retry or logout', async () => {
    const hook = await app(), old = deferred<any>(); let pending!: Promise<void>; mocks.fetch.mockReturnValueOnce(old.promise);
    act(() => { pending = hook.result.current.reloadModelPreferences('llm'); }); await waitFor(() => expect(mocks.fetch.mock.calls.at(-1)![0]).toContain('/preferences/llm')); const signal = mocks.fetch.mock.calls.at(-1)![1].signal;
    mocks.fetch.mockResolvedValueOnce(reply({ provider: 'openai', model: 'latest', models: {} })); await act(async () => { await hook.result.current.reloadModelPreferences('llm'); }); expect(signal.aborted).toBe(true);
    await act(async () => { old.resolve(reply({ provider: 'openai', model: 'obsolete', models: {} })); await pending; }); expect(hook.result.current.aiConfig.model).toBe('latest');
    const late = deferred<any>(); mocks.fetch.mockReturnValueOnce(late.promise); act(() => { pending = hook.result.current.reloadModelPreferences('llm'); }); await waitFor(() => expect(hook.result.current.aiConfig.ready).toBe(false)); await act(async () => { await hook.result.current.logout(); late.resolve(reply({ provider: 'openai', model: 'signed-out', models: {} })); await pending; }); expect(hook.result.current.aiConfig.ready).toBe(false); expect(hook.result.current.aiConfig.loadError).toBe(''); expect(hook.result.current.aiConfig.model).not.toBe('signed-out');
  });

  it('ends a stalled model read at its deadline and permits a successful retry', async () => {
    const hook = await app(), deadline = new AbortController(); const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline.signal); let pending!: Promise<void>;
    try {
      mocks.fetch.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })));
      act(() => { pending = hook.result.current.reloadModelPreferences('vision'); }); await waitFor(() => expect(timeout).toHaveBeenCalledWith(15_000)); await act(async () => { deadline.abort(new Error('Read timed out')); await pending; }); expect(hook.result.current.visionConfig).toMatchObject({ ready: false, loadError: 'Read timed out' }); expect(hook.result.current.aiConfig.ready).toBe(true);
      await act(async () => { await hook.result.current.reloadModelPreferences('vision'); }); expect(hook.result.current.visionConfig).toMatchObject({ ready: true, loadError: '' });
    } finally { timeout.mockRestore(); }
  });
});
