// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ fetch: vi.fn(), me: vi.fn() }));
vi.mock('../src/services/authService', async () => ({ ...await vi.importActual<any>('../src/services/authService'), isNativeDesktopRuntime: () => false, getMe: f.me }));
vi.mock('../src/services/socketService', () => ({ socketService: { disconnect: vi.fn(), refreshAuth: vi.fn(), getSocket: () => ({ on: vi.fn(), off: vi.fn() }) } }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
import { AppProvider, useApp } from '../src/contexts/AppContext';
const response = (data: any, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => data });
const initial = (url: string) => response(url.endsWith('/api/notifications') ? { notifications: [], unreadCount: 0 } : url.includes('/preferences/operation_mode') ? { mode: 'assistant' } : url.includes('/preferences/') ? { provider: 'openai', model: 'fixture', models: {} } : {});
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); f.me.mockResolvedValue({ user: { uid: 'one', username: 'Fixture', role: 'user' } }); vi.stubGlobal('fetch', f.fetch); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('actual notification context reports HTTP/schema failure and recovers through its dedicated read', async () => {
  f.fetch.mockImplementation(async url => url.endsWith('/api/notifications') ? response({}, false) : initial(url));
  const hook = renderHook(() => useApp(), { wrapper: ({ children }) => <AppProvider>{children}</AppProvider> }); await waitFor(() => expect(hook.result.current.notificationsError).toBeTruthy()); expect(hook.result.current.notificationsLoading).toBe(false);
  f.fetch.mockImplementation(async url => url.endsWith('/api/notifications') ? response({ notifications: 'wrong' }) : initial(url)); await act(async () => hook.result.current.refreshNotifications()); expect(hook.result.current.notificationsError).toBeTruthy();
  f.fetch.mockImplementation(async url => initial(url)); await act(async () => hook.result.current.refreshNotifications()); expect(hook.result.current.notificationsError).toBe(''); expect(hook.result.current.notifications).toEqual([]);
});
it('an old account read cannot restore private notifications after changing accounts', async () => {
  f.fetch.mockImplementation(async url => initial(url)); const hook = renderHook(() => useApp(), { wrapper: ({ children }) => <AppProvider>{children}</AppProvider> }); await waitFor(() => expect(hook.result.current.loading).toBe(false));
  let resolve!: (v: any) => void; const old = new Promise(r => { resolve = r; }); f.fetch.mockImplementation(url => url.endsWith('/api/notifications') ? old : Promise.resolve(initial(url)));
  let pending!: Promise<void>; act(() => { pending = hook.result.current.refreshNotifications(); }); await waitFor(() => expect(hook.result.current.notificationsLoading).toBe(true));
  f.me.mockResolvedValue({ user: { uid: 'two', username: 'Other', role: 'user' } }); f.fetch.mockImplementation(async url => initial(url)); await act(async () => hook.result.current.refreshUser());
  await act(async () => { resolve(response({ notifications: [{ id: 'old', timestamp: 1, read: false, type: 'info', title: 'Private', message: 'old' }] })); await pending; }); expect(hook.result.current.user?.uid).toBe('two'); expect(hook.result.current.notifications).toEqual([]); expect(hook.result.current.notificationsError).toBe('');
});
