// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useApp } from './AppContext';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), error: vi.fn(), success: vi.fn(), disconnect: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: mocks.error, success: mocks.success, info: vi.fn(), warning: vi.fn() } }));
vi.mock('../services/authService', async () => ({
  ...await vi.importActual<any>('../services/authService'),
  isNativeDesktopRuntime: () => false,
  getMe: async () => ({ user: { uid: 'synthetic-user', username: 'Tester', role: 'user' } }),
}));
vi.mock('../services/notificationService', () => ({ fetchNotifications: async () => ({ notifications: [] }) }));
vi.mock('../services/socketService', () => ({ socketService: { disconnect: mocks.disconnect, refreshAuth: vi.fn() } }));
const reply = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function initialRead(url: string) {
  if (url.endsWith('/api/preferences/vision')) return reply({ provider: 'openai', model: 'old-vision', models: { openai: 'old-vision' } });
  if (url.endsWith('/api/preferences/llm')) return reply({ provider: 'deepseek', model: 'old-reasoning', selectionMode: 'ordered_fallback', fallbackCandidates: [{ provider: 'ollama', model: 'backup' }], allowCloudFallback: false });
  if (url.endsWith('/api/preferences/operation_mode')) return reply({ mode: 'assistant' });
  if (url.endsWith('/api/settings/tool_overrides')) return reply({ read_file: { enabled: true } });
  return reply({});
}
beforeEach(() => {
  localStorage.clear(); for (const mock of Object.values(mocks)) mock.mockReset();
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
  it('keeps vision and tool settings unchanged after a rejected save', async () => {
    const hook = await app();
    mocks.fetch.mockImplementation(async (url: string, init: RequestInit) => init.method === 'GET' || !init.method ? initialRead(url) : reply({ error: 'denied' }, 403));
    await act(async () => { expect(await hook.result.current.updateVisionConfig({ model: 'new-vision' })).toBe(false); });
    expect(hook.result.current.visionConfig.model).toBe('old-vision');
    expect(JSON.parse(localStorage.getItem('lumi_vision_models')!).openai).toBe('old-vision');
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
    expect(hook.result.current.visionConfig.model).toBe('old-vision');
  });
});
