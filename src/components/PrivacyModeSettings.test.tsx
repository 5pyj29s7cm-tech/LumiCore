// @vitest-environment jsdom
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrivacyModeSettings } from './PrivacyModeSettings';
import type { PrivacySettingsState } from '@/services/privacyService';

const api = vi.hoisted(() => vi.fn());
vi.mock('../services/apiClient', () => ({ apiFetch: api }));

const standard: PrivacySettingsState = {
  mode: 'standard', configuredMode: 'standard', locked: false, canManage: true, restartRequired: false,
};
const response = (value: Partial<PrivacySettingsState> = {}, status = 200) => ({
  ok: status >= 200 && status < 300, status, json: async () => ({ ...standard, ...value }),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function view(workspace: 'personal' | 'work' = 'personal', sessionId = 'synthetic-admin') {
  return <PrivacyModeSettings locale="en" workspace={workspace} sessionId={sessionId} />;
}
function toggle() { return screen.getByRole('switch', { name: 'Strict mode' }) as HTMLButtonElement; }

beforeEach(() => { api.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('backend-owned privacy settings', () => {
  it('loads the real saved and current modes and stays disabled during loading', async () => {
    const request = deferred<any>();
    api.mockReturnValue(request.promise);
    render(view());
    expect(toggle().disabled).toBe(true);
    expect(api).toHaveBeenCalledWith('/api/privacy', expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
    await act(async () => { request.resolve(response()); });
    expect(toggle().disabled).toBe(false);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Currently active: Standard mode')).toBeTruthy();
    expect(screen.getByText('Off by default · Takes effect after restart')).toBeTruthy();
  });

  it('saves the configured mode without claiming that the running mode already changed', async () => {
    const pending = deferred<any>();
    api.mockResolvedValueOnce(response()).mockReturnValueOnce(pending.promise);
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    render(view());
    await waitFor(() => expect(toggle().disabled).toBe(false));
    fireEvent.click(toggle());
    expect(toggle().disabled).toBe(true);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    const [url, init] = api.mock.calls[1];
    expect(url).toBe('/api/privacy');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ mode: 'strict' });
    await act(async () => { pending.resolve(response({ configuredMode: 'strict', restartRequired: true })); });
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Currently active: Standard mode')).toBeTruthy();
    expect(screen.getByText(/Fully quit and restart the main application/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^restart/i })).toBeNull();
    expect(storage).not.toHaveBeenCalled();
  });

  it('can cancel a pending strict configuration while the running mode remains standard', async () => {
    api.mockResolvedValueOnce(response({ configuredMode: 'strict', restartRequired: true })).mockResolvedValueOnce(response());
    render(view());
    await waitFor(() => expect(toggle().disabled).toBe(false));
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
    expect(JSON.parse(api.mock.calls[1][1].body)).toEqual({ mode: 'standard' });
    expect(screen.getByText(/no restart is needed/)).toBeTruthy();
  });

  it('keeps the last confirmed value on a save failure and requires a fresh read', async () => {
    api.mockResolvedValueOnce(response()).mockResolvedValueOnce(response({}, 500))
      .mockResolvedValueOnce(response({ configuredMode: 'strict', restartRequired: true }));
    render(view());
    await waitFor(() => expect(toggle().disabled).toBe(false));
    fireEvent.click(toggle());
    await screen.findByRole('alert');
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(toggle().disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('save could not be confirmed');
    fireEvent.click(screen.getByRole('button', { name: 'Reload settings' }));
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    expect(toggle().disabled).toBe(false);
  });

  it('cannot disable strict mode when the runtime environment locks it', async () => {
    api.mockResolvedValue(response({ mode: 'strict', configuredMode: 'strict', locked: true }));
    render(view());
    await screen.findByText(/enforced by the runtime environment/);
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(toggle().disabled).toBe(true);
    fireEvent.click(toggle());
    expect(api).toHaveBeenCalledTimes(1);
  });

  it.each([
    { workspace: 'personal' as const, canManage: false },
    { workspace: 'work' as const, canManage: true },
  ])('is read-only for $workspace workspace with canManage=$canManage', async ({ workspace, canManage }) => {
    api.mockResolvedValue(response({ canManage }));
    render(view(workspace));
    await screen.findByText(/Your view is read-only/);
    expect(toggle().disabled).toBe(true);
    fireEvent.click(toggle());
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('does not guess a default or permit a change if the initial request fails', async () => {
    api.mockResolvedValue(response({}, 403));
    render(view());
    await screen.findByRole('alert');
    expect(toggle().disabled).toBe(true);
    expect(screen.getByText('Current status is unknown')).toBeTruthy();
    expect(screen.queryByText('Currently active: Standard mode')).toBeNull();
  });

  it('rejects a malformed backend payload rather than presenting its strings as permissions', async () => {
    api.mockResolvedValue({ ok: true, json: async () => ({ ...standard, canManage: 'false' }) });
    render(view());
    await screen.findByRole('alert');
    expect(toggle().disabled).toBe(true);
  });

  it('ignores stale state from another user or workspace even if transport ignores abort', async () => {
    const stale = deferred<any>();
    api.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(response({ mode: 'strict', configuredMode: 'strict', canManage: false }));
    const screenView = render(view());
    const signal = api.mock.calls[0][1].signal as AbortSignal;
    screenView.rerender(view('work', 'synthetic-org-user'));
    expect(signal.aborted).toBe(true);
    await screen.findByText('Currently active: Strict mode');
    await act(async () => { stale.resolve(response()); });
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(toggle().disabled).toBe(true);
  });

  it('shows the effects and restart requirement in Chinese without absolute privacy claims', async () => {
    api.mockResolvedValue(response({ configuredMode: 'strict', restartRequired: true }));
    render(<PrivacyModeSettings locale="zh" workspace="personal" sessionId="synthetic-admin" />);
    await screen.findByText(/完全退出并重新启动主程序后生效/);
    expect(screen.getByText(/官网 API、云端 AI 和联网语音/)).toBeTruthy();
    expect(screen.getByText(/暂停自动工具执行，包括本地文件操作/)).toBeTruthy();
    expect(screen.getByText(/不转到云端/)).toBeTruthy();
    expect(screen.getByText(/不会启动 LM Studio/)).toBeTruthy();
    expect(screen.getByText(/不限制其他程序的网络访问/)).toBeTruthy();
  });

  it('is wired into the actual privacy section and removes the old absolute privacy claim', () => {
    const settings = fs.readFileSync(path.join(process.cwd(), 'src/components/Settings.tsx'), 'utf8');
    const section = settings.slice(settings.indexOf("case 'security':"), settings.indexOf("case 'hardware':"));
    expect(section).toContain('<PrivacyModeSettings locale={lang} workspace={workDomain} sessionId={user?.uid');
    const translations = fs.readFileSync(path.join(process.cwd(), 'src/lib/translations.ts'), 'utf8');
    expect(translations).not.toContain('Our protocol strictly enforces local-only processing.');
  });
});
